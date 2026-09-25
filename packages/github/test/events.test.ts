import { describe, expect, it } from 'vitest';
import type { IngestedEvent, WakeEvent } from '../src/events.ts';
import { mergeKey } from '../src/pulls.ts';
import type { Intake } from '../src/reconcile.ts';
import { json, REPO_ID, repo, setup, sha } from './helpers.ts';

const A = sha('a');
const B = sha('b');

function event(over: Partial<IngestedEvent> & Pick<IngestedEvent, 'event' | 'payload'>): IngestedEvent {
  return {
    deliveryId: `d-${Math.random()}`,
    source: 'webhook',
    repo: 'acme/widgets',
    wake: true,
    receivedAt: '2026-09-25T12:00:00Z',
    ...over,
  };
}

function prPayload(over: Record<string, unknown> = {}) {
  return {
    action: 'synchronize',
    pull_request: {
      number: 5,
      state: 'open',
      merged: false,
      updated_at: '2026-09-25T12:00:00Z',
      head: { ref: 'task/5', sha: A },
      ...over,
    },
  };
}

describe('事件之后的处理', () => {
  it('PR 事件写镜像、叫醒对应的工作流', async () => {
    const { gh, ledger } = setup();
    const woke: WakeEvent[] = [];
    const sink = gh.eventSink({ wake: async (e) => void woke.push(e) });
    await sink.accept(event({ event: 'pull_request', action: 'synchronize', payload: prPayload() }));
    expect(await ledger.getPullRequest(REPO_ID, 5)).toMatchObject({
      state: 'open',
      headSha: A,
      checks: 'pending',
    });
    expect(woke).toEqual([
      expect.objectContaining({ event: 'pull_request', prNumbers: [5], headSha: A, headRef: 'task/5' }),
    ]);
  });

  it('合并的 PR 记成 merged；晚到的旧事件不把它改回 open', async () => {
    const { gh, ledger } = setup();
    const sink = gh.eventSink({ wake: async () => {} });
    await sink.accept(
      event({
        event: 'pull_request',
        payload: prPayload({ state: 'closed', merged: true, updated_at: '2026-09-25T12:10:00Z' }),
      }),
    );
    await sink.accept(
      event({ event: 'pull_request', payload: prPayload({ updated_at: '2026-09-25T12:05:00Z' }) }),
    );
    expect((await ledger.getPullRequest(REPO_ID, 5))?.state).toBe('merged');
  });

  it('CI 跑完：回 GitHub 重读这个头的检查写进镜像（不信事件里带的结论），再叫醒', async () => {
    const { gh, fake, ledger } = setup();
    const sink = gh.eventSink({ wake: async () => {} });
    await sink.accept(event({ event: 'pull_request', payload: prPayload() }));
    fake.addCheck(A, 'check', 'failure');
    await sink.accept(
      event({
        event: 'check_suite',
        action: 'completed',
        payload: {
          action: 'completed',
          check_suite: { head_sha: A, conclusion: 'success', pull_requests: [] },
        },
      }),
    );
    expect((await ledger.getPullRequest(REPO_ID, 5))?.checks).toBe('failure');
  });

  it('自家机器人的回声：只同步镜像，不叫醒（防自己叫醒自己）', async () => {
    const { gh, ledger } = setup();
    const woke: WakeEvent[] = [];
    const sink = gh.eventSink({ wake: async (e) => void woke.push(e) });
    await sink.accept(event({ event: 'pull_request', wake: false, payload: prPayload() }));
    expect(woke).toEqual([]);
    expect(await ledger.getPullRequest(REPO_ID, 5)).not.toBeNull();
  });

  it('issue、评论事件按 issue 号叫醒；PR 上的评论按 PR 号', async () => {
    const { gh } = setup();
    const woke: WakeEvent[] = [];
    const sink = gh.eventSink({ wake: async (e) => void woke.push(e) });
    await sink.accept(
      event({ event: 'issues', action: 'opened', payload: { action: 'opened', issue: { number: 12 } } }),
    );
    await sink.accept(
      event({
        event: 'issue_comment',
        payload: { action: 'created', issue: { number: 31, pull_request: {} } },
      }),
    );
    expect(woke.map((w) => [w.issueNumber, w.prNumbers])).toEqual([
      [12, undefined],
      [undefined, [31]],
    ]);
  });

  it('叫醒失败就抛：后端会撤掉投递登记，让重投或补收再来', async () => {
    const { gh } = setup();
    const sink = gh.eventSink({ wake: async () => Promise.reject(new Error('Temporal 连不上')) });
    await expect(sink.accept(event({ event: 'issues', payload: { issue: { number: 1 } } }))).rejects.toThrow(
      'Temporal',
    );
  });
});

function fakeIntake(trusted: (payload: Record<string, unknown>) => boolean) {
  const seen = new Set<string>();
  const ingested: { deliveryId: string; event: string; payload: Record<string, unknown> }[] = [];
  const intake: Intake = {
    async ingest({ deliveryId, event, payload }) {
      if (seen.has(deliveryId)) return { verdict: 'duplicate' };
      seen.add(deliveryId);
      const p = payload as Record<string, unknown>;
      ingested.push({ deliveryId, event, payload: p });
      return trusted(p)
        ? { verdict: 'accepted', wake: true }
        : { verdict: 'ignored', reason: 'author_not_whitelisted' };
    },
  };
  return { intake, ingested };
}

const pollDeliveryId = (r: string, kind: string, id: number | string, updatedAt: string) =>
  `poll:${r.toLowerCase()}:${kind}:${id}:${updatedAt}`;

describe('对账与补漏', () => {
  it('重投：同一次投递一次都没成功的才重投；后来成功过的不动', async () => {
    const { gh, fake } = setup();
    fake.deliveries = [
      { id: 5, guid: 'g-ok-later', delivered_at: '2026-09-25T11:30:00Z', status_code: 200, event: 'issues' },
      { id: 4, guid: 'g-failed', delivered_at: '2026-09-25T11:20:00Z', status_code: 502, event: 'issues' },
      { id: 3, guid: 'g-ok-later', delivered_at: '2026-09-25T11:10:00Z', status_code: 504, event: 'issues' },
      { id: 2, guid: 'g-failed', delivered_at: '2026-09-25T11:00:00Z', status_code: 0, event: 'issues' },
      { id: 1, guid: 'g-old', delivered_at: '2026-09-20T11:00:00Z', status_code: 500, event: 'issues' },
    ];
    const { intake } = fakeIntake(() => true);
    const rec = gh.reconciler({ intake, pollDeliveryId });
    const report = await rec.redeliverFailed(new Date('2026-09-25T10:00:00Z'));
    expect(report).toEqual({ outcome: 'ok', checked: 4, recovered: 1, why: undefined });
    expect(fake.redelivered).toEqual([4]);
    expect(fake.calls('POST', /attempts$/).map((r) => r.as)).toEqual(['app:engine']);
  });

  it('投递日志读不到：报「没查成」，不报 ok', async () => {
    const { gh, fake } = setup();
    fake.permissions.engine = {};
    fake.before.push((req) =>
      req.path === '/app/hook/deliveries'
        ? new Response(JSON.stringify({ message: 'nope' }), { status: 403 })
        : undefined,
    );
    const { intake } = fakeIntake(() => true);
    const report = await gh.reconciler({ intake, pollDeliveryId }).redeliverFailed(new Date(0));
    expect(report.outcome).toBe('unscanned');
  });

  it('重投失败如实报：一个都没重投成是 failed，成了一部分是 partial，不报 ok', async () => {
    const failing = (ids: number[]) => {
      const { gh, fake } = setup();
      fake.deliveries = ids.map((id) => ({
        id,
        guid: `g-${id}`,
        delivered_at: '2026-09-25T11:00:00Z',
        status_code: 502,
        event: 'issues',
      }));
      fake.before.push((req) =>
        req.path === '/app/hook/deliveries/1/attempts' || req.path === '/app/hook/deliveries/2/attempts'
          ? json(422, { message: 'Validation Failed' })
          : undefined,
      );
      const { intake } = fakeIntake(() => true);
      return gh.reconciler({ intake, pollDeliveryId }).redeliverFailed(new Date('2026-09-25T10:00:00Z'));
    };
    expect(await failing([1, 2])).toMatchObject({
      outcome: 'failed',
      recovered: 0,
      why: expect.stringContaining('重投失败 2 个'),
    });
    expect(await failing([1, 3])).toMatchObject({
      outcome: 'partial',
      recovered: 1,
      why: expect.stringContaining('重投失败 1 个'),
    });
  });

  it('轮询：issue、评论、PR 逐条过后端那道门；同一版本只收一次', async () => {
    const { gh, fake } = setup();
    fake.addIssue({ title: '人开的' });
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    const issue = fake.issues.get(1);
    issue?.comments.push({ id: 77, body: '补充', user: fake.human, updated_at: '2026-09-25T12:00:00Z' });
    const { intake, ingested } = fakeIntake(() => true);
    const rec = gh.reconciler({ intake, pollDeliveryId });
    const first = await rec.poll('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(first).toEqual({ outcome: 'ok', checked: 3, recovered: 3 });
    expect(ingested.map((i) => i.event).sort()).toEqual(['issue_comment', 'issues', 'pull_request']);
    expect(ingested.find((i) => i.event === 'issue_comment')?.payload.issue).toEqual({ number: 1 });
    expect(ingested.find((i) => i.event === 'pull_request')?.deliveryId).toBe(
      `poll:acme/widgets:pull:${pr.number}:${pr.updated_at}`,
    );
    const second = await rec.poll('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(second).toEqual({ outcome: 'ok', checked: 3, recovered: 0 });
  });

  it('轮询把 issue、评论整条原样送进门：标题、正文、开关状态、建立时刻都在（后端建任务、认回答要用）', async () => {
    const { gh, fake } = setup();
    const opened = fake.addIssue({ title: '人开的', body: '原话' });
    opened.comments.push({
      id: 78,
      body: '5 分钟',
      user: fake.human,
      created_at: '2026-09-25T11:00:00Z',
      updated_at: '2026-09-25T12:00:00Z',
    });
    const { intake, ingested } = fakeIntake(() => true);
    await gh.reconciler({ intake, pollDeliveryId }).poll('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(ingested.find((i) => i.event === 'issues')?.payload.issue).toMatchObject({
      number: opened.number,
      title: '人开的',
      body: '原话',
      state: 'open',
      created_at: opened.created_at,
      user: fake.human,
    });
    expect(ingested.find((i) => i.event === 'issue_comment')?.payload.comment).toMatchObject({
      id: 78,
      body: '5 分钟',
      created_at: '2026-09-25T11:00:00Z',
      user: fake.human,
    });
  });

  it('轮询认得出自家的回声：引擎改进度段、关单、发的评论、开和合的 PR 都不叫醒；人改的、人写的照样叫醒', async () => {
    const { gh, fake, clock } = setup();
    const progress = { state: 'running', current: 'x', done: 0, total: 1, subtasks: [], docs: {} };
    const edited = fake.addIssue({ body: '原话' });
    await gh.updateIssueProgress({ repo, issueNumber: edited.number, progress });
    const closed = fake.addIssue();
    await gh.closeIssue({ repo, issueNumber: closed.number, reason: 'completed', comment: '去向：并入 #9' });
    const touched = fake.addIssue({ body: '原话' });
    await gh.updateIssueProgress({ repo, issueNumber: touched.number, progress });
    clock.advance(5000);
    fake.editBody(touched, '原话\n人后来补的一句', fake.human);
    edited.comments.push({
      id: 88,
      body: '人问了一句',
      user: fake.human,
      updated_at: clock.now().toISOString(),
    });
    fake.refs.set('task/9', A);
    const opened = await gh.openPr({ repo, branch: 'task/9', head: A, title: 't', body: 'b' });
    fake.addCheck(A, 'check', 'success');
    await gh.mergePr({ repo, prNumber: opened.number, expectedHead: A });

    // 照后端 screenGithubEvent 的规矩判要不要叫醒：sender 是自家机器人就不叫醒
    const botIds = new Set([fake.bots.agent.id, fake.bots.engine.id]);
    const seen: { event: string; wake: boolean; payload: Record<string, unknown> }[] = [];
    const intake: Intake = {
      async ingest({ event, payload }) {
        const p = payload as Record<string, unknown> & { sender?: { id: number; type: string } };
        const wake = !(p.sender?.type === 'Bot' && botIds.has(p.sender.id));
        seen.push({ event, wake, payload: p });
        return { verdict: 'accepted', wake };
      },
    };
    const report = await gh.reconciler({ intake, pollDeliveryId }).poll('acme/widgets', new Date(0));
    expect(report.outcome).toBe('ok');
    const wakeOf = (event: string, match: (p: Record<string, unknown>) => boolean) =>
      seen.filter((s) => s.event === event && match(s.payload)).map((s) => s.wake);
    const issueNo = (p: Record<string, unknown>) => (p.issue as { number?: number } | undefined)?.number;
    expect(wakeOf('issues', (p) => issueNo(p) === edited.number)).toEqual([false]);
    expect(wakeOf('issues', (p) => issueNo(p) === closed.number)).toEqual([false]);
    expect(wakeOf('issues', (p) => issueNo(p) === touched.number)).toEqual([true]);
    expect(wakeOf('issue_comment', (p) => issueNo(p) === closed.number)).toEqual([false]);
    expect(wakeOf('issue_comment', (p) => issueNo(p) === edited.number)).toEqual([true]);
    expect(
      wakeOf('pull_request', (p) => (p.pull_request as { number: number }).number === opened.number),
    ).toEqual([false]);
  });

  it('白名单作者开的开放 issue 没有工作流：重新送进引擎；陌生人的不算问题', async () => {
    const { gh, fake, ledger } = setup();
    const withTask = fake.addIssue();
    ledger.tasks.set(`${REPO_ID}#${withTask.number}`, { id: 't1', state: 'running' });
    const orphan = fake.addIssue();
    fake.addIssue({ user: { login: 'stranger', id: 666, type: 'User' } });
    const { intake, ingested } = fakeIntake((p) => (p.issue as { user: { id: number } }).user.id !== 666);
    const report = await gh.reconciler({ intake, pollDeliveryId }).auditOpenIssues('acme/widgets');
    expect(report).toMatchObject({ outcome: 'ok', scanned: 3, found: 1, fixed: 1 });
    expect(report.problems).toEqual([`#${orphan.number} 是白名单作者开的，却没有工作流（已重新送进引擎）`]);
    expect(ingested.map((i) => i.payload.action)).toEqual(['reconcile', 'reconcile']);
  });

  it('合并的 PR：镜像里没记的补上；不是「引擎」合的报出来（C21/C22）', async () => {
    const { gh, fake, ledger } = setup();
    const byEngine = fake.addPull({
      head: { ref: 'task/1', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: sha('c'),
      merged_by: fake.bots.engine,
    });
    const byAgent = fake.addPull({
      head: { ref: 'task/2', sha: B },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:30:00Z',
      merge_commit_sha: sha('d'),
      merged_by: fake.bots.agent,
    });
    await ledger.upsertPullRequest({
      repoId: REPO_ID,
      number: byAgent.number,
      state: 'merged',
      headRef: 'task/2',
      headSha: B,
      updatedAt: new Date('2026-09-25T11:30:00Z'),
    });
    // 引擎合的那张在账上有合并记录（合并队列合的）；另一张没有
    const key = mergeKey(repo, byEngine.number, A);
    await ledger.idempotency.claim({ key, action: 'github.merge_pr' }, new Date());
    await ledger.idempotency.complete(key, { number: byEngine.number }, new Date());
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(report).toMatchObject({ outcome: 'ok', scanned: 2, found: 3, fixed: 1 });
    expect([...report.problems].sort()).toEqual(
      [
        `#${byEngine.number} 合并了但镜像里没有（已补）`,
        `#${byAgent.number} 不是「引擎」机器人合的（合并人 fleet-test-agent[bot]）`,
        `#${byAgent.number} 合并了，但账上没有合并队列的合并记录`,
      ].sort(),
    );
    expect((await ledger.getPullRequest(REPO_ID, byEngine.number))?.state).toBe('merged');
  });

  it('自检：两个机器人的权限够不够；「干活的」能改 issue 要标出来；读不到算没查成', async () => {
    const { gh, fake } = setup();
    fake.permissions.agent = { ...fake.permissions.agent, issues: 'write' };
    fake.permissions.engine = { ...fake.permissions.engine, administration: 'read' };
    const report = await gh.selfCheck([repo]);
    expect(report).toEqual([
      { role: 'agent', repo: 'acme/widgets', ok: true, missing: [], extra: ['issues:write'] },
      { role: 'engine', repo: 'acme/widgets', ok: false, missing: ['administration:write'], extra: [] },
    ]);
    fake.installed.engine = false;
    const [, engine] = await gh.selfCheck([repo]);
    expect(engine).toMatchObject({ ok: false, why: expect.stringContaining('没装到') });
  });
});
