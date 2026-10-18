import { describe, expect, it } from 'vitest';
import type { PullFacts } from '../src/engine-pulls.ts';
import { type IngestedEvent, reviewMergeHold, type WakeEvent } from '../src/events.ts';
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

  it('PR 镜像记下提醒谁在处理要的几样：开的时刻、正文挂的单和修的提醒；合了记合并提交', async () => {
    const { gh, ledger } = setup();
    const sink = gh.eventSink({ wake: async () => {} });
    const body = [
      '**需求**：#342',
      '**修提醒**：`watchdog:job:backup:after-12`',
      'Closes acme/widgets#343',
    ].join('\n');
    await sink.accept(
      event({
        event: 'pull_request',
        payload: prPayload({
          created_at: '2026-09-25T11:50:00Z',
          title: 'fix: 备份',
          body,
          merge_commit_sha: B, // 没合的 PR 也带试合提交：不记
        }),
      }),
    );
    expect(await ledger.getPullRequest(REPO_ID, 5)).toMatchObject({
      openedAt: new Date('2026-09-25T11:50:00Z'),
      mergedAt: null,
      mergeSha: null,
      title: 'fix: 备份',
      links: { issues: [342, 343], alerts: ['watchdog:job:backup:after-12'] },
    });
    await sink.accept(
      event({
        event: 'pull_request',
        payload: prPayload({
          state: 'closed',
          merged: true,
          merged_at: '2026-09-25T12:10:00Z',
          merge_commit_sha: B,
          updated_at: '2026-09-25T12:10:00Z',
          title: 'fix: 备份',
          body,
        }),
      }),
    );
    expect(await ledger.getPullRequest(REPO_ID, 5)).toMatchObject({
      state: 'merged',
      mergedAt: new Date('2026-09-25T12:10:00Z'),
      mergeSha: B,
    });
  });

  it('事件里没带标题：镜像里旧标题留着', async () => {
    const { gh, ledger } = setup();
    const sink = gh.eventSink({ wake: async () => {} });
    await sink.accept(event({ event: 'pull_request', payload: prPayload({ title: 'fix: 备份' }) }));
    await sink.accept(
      event({ event: 'pull_request', payload: prPayload({ updated_at: '2026-09-25T12:01:00Z' }) }),
    );
    expect((await ledger.getPullRequest(REPO_ID, 5))?.title).toBe('fix: 备份');
  });

  it('【故意造出的失败】事件里没带正文（只有号和头）：不把镜像里的链接清空', async () => {
    const { gh, ledger } = setup();
    const sink = gh.eventSink({ wake: async () => {} });
    await sink.accept(
      event({ event: 'pull_request', payload: prPayload({ body: '**修提醒**：pool-hold:x', title: 't' }) }),
    );
    await sink.accept(
      event({ event: 'pull_request', payload: prPayload({ updated_at: '2026-09-25T12:01:00Z' }) }),
    );
    expect((await ledger.getPullRequest(REPO_ID, 5))?.links).toEqual({ issues: [], alerts: ['pool-hold:x'] });
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

  it('叫醒失败就抛：后端把这条投递记成出错、原文留着，对账时按原文重放', async () => {
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

  it('重投名额不够时老的优先：新失败的不该把老的挤出去，不然老的等 since 窗口一过就永久补不回来', async () => {
    const { gh, fake } = setup();
    // 翻页新的在前（GitHub 真接口就是这个顺序）：先给最新失败的，最后给最老的
    fake.deliveries = [
      { id: 3, guid: 'g-new', delivered_at: '2026-09-25T11:30:00Z', status_code: 502, event: 'issues' },
      { id: 2, guid: 'g-mid', delivered_at: '2026-09-25T11:20:00Z', status_code: 502, event: 'issues' },
      { id: 1, guid: 'g-old', delivered_at: '2026-09-25T11:10:00Z', status_code: 502, event: 'issues' },
    ];
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId, maxRedeliveries: 2 })
      .redeliverFailed(new Date('2026-09-25T10:00:00Z'));
    // 一轮只够重投 2 个：该保离窗口边界最近的两个（g-old、g-mid），把离过期还早的 g-new 留到下一轮
    expect(fake.redelivered).toEqual([1, 2]);
    expect(report).toMatchObject({ outcome: 'partial', checked: 3, recovered: 2 });
    expect(report.why).toContain('还有 1 个没重投（一次最多 2 个）');
  });

  it('重投：19 位的投递编号按原文拼路径，不丢精度（法国实测 …928 被改成 …000，重投全 404）', async () => {
    const { gh, fake } = setup();
    // 原文里的数字超出 JS 安全整数：只能手写 JSON 文本，JSON.stringify 一个 number 已经丢了精度
    const raw =
      '[{"id":3844860628254588928,"guid":"g-big","delivered_at":"2026-09-25T11:00:00Z","status_code":502,"event":"issues"},' +
      '{"id":7,"guid":"g-small","delivered_at":"2026-09-25T11:00:00Z","status_code":500,"event":"issues"}]';
    fake.before.push((req) =>
      req.path === '/app/hook/deliveries' && req.method === 'GET'
        ? new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } })
        : undefined,
    );
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId })
      .redeliverFailed(new Date('2026-09-25T10:00:00Z'));
    expect(report).toMatchObject({ outcome: 'ok', recovered: 2 });
    expect(fake.calls('POST', /attempts$/).map((r) => r.path)).toEqual([
      '/app/hook/deliveries/3844860628254588928/attempts',
      '/app/hook/deliveries/7/attempts',
    ]);
  });

  it('投递编号认不出（负数、小数、不是数字）：报「没查成」，一个都不重投', async () => {
    for (const id of ['-1', '1.5', '"abc"', 'null']) {
      const { gh, fake } = setup();
      const raw = `[{"id":${id},"guid":"g-x","delivered_at":"2026-09-25T11:00:00Z","status_code":502,"event":"issues"}]`;
      fake.before.push((req) =>
        req.path === '/app/hook/deliveries' && req.method === 'GET'
          ? new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } })
          : undefined,
      );
      const { intake } = fakeIntake(() => true);
      const report = await gh.reconciler({ intake, pollDeliveryId }).redeliverFailed(new Date(0));
      expect(report.outcome, `id=${id}`).toBe('unscanned');
      expect(fake.calls('POST', /attempts$/), `id=${id}`).toEqual([]);
    }
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

  it('重投前先问后端库里有没有：原文已经在库里的不叫 GitHub 重投，交给后端按原文重放', async () => {
    const { gh, fake } = setup();
    fake.deliveries = [
      { id: 11, guid: 'g-stored', delivered_at: '2026-09-25T11:00:00Z', status_code: 500, event: 'issues' },
      { id: 12, guid: 'g-missing', delivered_at: '2026-09-25T11:00:00Z', status_code: 502, event: 'issues' },
    ];
    const { intake } = fakeIntake(() => true);
    const asked: string[][] = [];
    const storedDeliveries = async (guids: readonly string[]) => {
      asked.push([...guids]);
      return new Set(['g-stored']);
    };
    const report = await gh
      .reconciler({ intake, pollDeliveryId, storedDeliveries })
      .redeliverFailed(new Date('2026-09-25T10:00:00Z'));
    expect(asked.map((guids) => guids.sort())).toEqual([['g-missing', 'g-stored']]);
    expect(fake.redelivered).toEqual([12]);
    expect(report).toEqual({ outcome: 'ok', checked: 2, recovered: 1, why: undefined });
  });

  it('查后端库有没有这些投递失败：重投这一步报 failed，一条都不重投（宁可不重投，也不让 GitHub 送第二遍）', async () => {
    const { gh, fake } = setup();
    fake.deliveries = [
      { id: 12, guid: 'g-missing', delivered_at: '2026-09-25T11:00:00Z', status_code: 502, event: 'issues' },
    ];
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({
        intake,
        pollDeliveryId,
        storedDeliveries: async () => {
          throw new Error('库连不上');
        },
      })
      .redeliverFailed(new Date('2026-09-25T10:00:00Z'));
    expect(report).toMatchObject({ outcome: 'failed', checked: 1, recovered: 0 });
    expect(report.why).toContain('库连不上');
    expect(fake.redelivered).toEqual([]);
  });

  it('轮询：PR 逐条过后端那道门；同一版本只收一次；issue 和评论不拉', async () => {
    const { gh, fake } = setup();
    fake.addIssue({ title: '人开的' });
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    const issue = fake.issues.get(1);
    issue?.comments.push({ id: 77, body: '补充', user: fake.human, updated_at: '2026-09-25T12:00:00Z' });
    const { intake, ingested } = fakeIntake(() => true);
    const rec = gh.reconciler({ intake, pollDeliveryId });
    const first = await rec.poll('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(first).toEqual({ outcome: 'ok', checked: 1, recovered: 1 });
    expect(ingested.map((i) => i.event)).toEqual(['pull_request']);
    expect(ingested.find((i) => i.event === 'pull_request')?.deliveryId).toBe(
      `poll:acme/widgets:pull:${pr.number}:${pr.updated_at}`,
    );
    const second = await rec.poll('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(second).toEqual({ outcome: 'ok', checked: 1, recovered: 0 });
  });

  it('轮询认得出自家的回声：引擎开和合的 PR 都不叫醒', async () => {
    const { gh, fake } = setup();
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
    expect(
      seen
        .filter(
          (s) =>
            s.event === 'pull_request' &&
            (s.payload.pull_request as { number: number }).number === opened.number,
        )
        .map((s) => s.wake),
    ).toEqual([false]);
  });

  it('我们机器人开的、合并的 PR：镜像里没记的补上；不是「引擎」合的报出来（C21/C22）', async () => {
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
    await ledger.idempotency.claim(
      { key, action: 'github.merge_pr', target: `acme/widgets#${byEngine.number}` },
      new Date(),
    );
    await ledger.idempotency.complete(
      key,
      {
        number: byEngine.number,
        head: A,
        mergeCommit: sha('c'),
        mergedBy: fake.bots.engine.login,
      },
      new Date(),
    );
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(report).toMatchObject({ outcome: 'ok', scanned: 2, found: 4, fixed: 1 });
    expect([...report.problems].sort()).toEqual(
      [
        `#${byEngine.number} 合并了但镜像里没有（已补）`,
        `#${byAgent.number} 不是「引擎」机器人合的（合并人 fleet-test-agent[bot]）`,
        `#${byAgent.number} 合并了，但账上没有合并队列的合并记录`,
        `#${byAgent.number} 按合并回执补上了合并记录（实际合并人 fleet-test-agent[bot]，未经合并队列）`,
      ].sort(),
    );
    // 每小时对账按种类分（不认上面那几句字）：种类和 PR 号要对得上
    expect(report.findings.map((f) => `${f.number} ${f.kind}`).sort()).toEqual(
      [
        `${byEngine.number} mirror_fixed`,
        `${byAgent.number} not_merged_by_engine`,
        `${byAgent.number} no_merge_record`,
        `${byAgent.number} backfill_merge_record`,
      ].sort(),
    );
    expect(report.problems).toEqual(report.findings.map((f) => f.text));
    expect((await ledger.getPullRequest(REPO_ID, byEngine.number))?.state).toBe('merged');
    // #440：手动合的机器人 PR，按合并回执补上幂等账——账要反映事实（实际合并人、合并提交），
    // 下一轮认得出补过账，但补账不证明曾经走过合并队列。
    const backfilled = await ledger.idempotency.peek(mergeKey(repo, byAgent.number, B));
    expect(backfilled?.completedAt).toBeTruthy();
    expect(backfilled?.result).toMatchObject({
      number: byAgent.number,
      head: B,
      mergedBy: 'fleet-test-agent[bot]',
    });
  });

  it('真实队列回执匹配才进 cleanPrs；手合和 backfill 连续两轮都不进，也不升级来源', async () => {
    const { gh, fake, ledger } = setup();
    const C = sha('e');
    const landed = fake.addPull({
      head: { ref: 'fleet/1-abcd1234', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: sha('c'),
      merged_by: fake.bots.engine,
    });
    const byHand = fake.addPull({
      head: { ref: 'fleet/2-abcd1234', sha: B },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:10:00Z',
      merge_commit_sha: sha('d'),
      merged_by: fake.human,
    });
    const missing = fake.addPull({
      head: { ref: 'fleet/3-abcd1234', sha: C },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:20:00Z',
      merge_commit_sha: sha('f'),
      merged_by: fake.bots.engine,
    });
    // 前两张账上已有合并记录（人合的那张是上一轮补的账）；第三张没有
    for (const [number, head, action, commit, actor] of [
      [landed.number, A, 'github.merge_pr', sha('c'), fake.bots.engine.login],
      [byHand.number, B, 'github.merge_pr_backfill', sha('d'), fake.human.login],
    ] as const) {
      const key = mergeKey(repo, number, head);
      await ledger.idempotency.claim({ key, action, target: `acme/widgets#${number}` }, new Date());
      await ledger.idempotency.complete(
        key,
        { number, head, mergeCommit: commit, mergedBy: actor },
        new Date(),
      );
    }
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(report.cleanPrs).toEqual([landed.number]);
    expect(report.findings.some((f) => f.number === missing.number && f.kind === 'no_merge_record')).toBe(
      true,
    );
    const backfill = await ledger.idempotency.peek(mergeKey(repo, missing.number, C));
    expect(backfill).toMatchObject({
      action: 'github.merge_pr_backfill',
      target: `acme/widgets#${missing.number}`,
      result: { number: missing.number, head: C, mergeCommit: sha('f'), mergedBy: fake.bots.engine.login },
    });
    // 下一轮补账仍不是合法队列来源，提醒继续保留。
    const again = await gh
      .reconciler({ intake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(again.cleanPrs).toEqual([landed.number]);
    expect(
      again.findings
        .filter((f) => f.kind === 'no_merge_record')
        .map((f) => f.number)
        .sort(),
    ).toEqual([byHand.number, missing.number].sort());
    expect(await ledger.idempotency.peek(mergeKey(repo, missing.number, C))).toEqual(backfill);
  });

  it('真实队列占用的同 head 回执晚到：先报风险，完成后才进入 cleanPrs', async () => {
    const { gh, fake, ledger } = setup();
    const pr = fake.addPull({
      head: { ref: 'fleet/1-abcd1234', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: B,
      merged_by: fake.bots.engine,
    });
    const key = mergeKey(repo, pr.number, A);
    await ledger.idempotency.claim(
      { key, action: 'github.merge_pr', target: `acme/widgets#${pr.number}` },
      new Date(),
    );
    const { intake } = fakeIntake(() => true);
    const rec = gh.reconciler({ intake, pollDeliveryId });
    const first = await rec.auditMergedPrs('acme/widgets', new Date(0));
    expect(first.cleanPrs).toEqual([]);
    expect(first.findings.some((f) => f.kind === 'no_merge_record')).toBe(true);
    await ledger.idempotency.complete(
      key,
      { number: pr.number, head: A, mergeCommit: B, mergedBy: fake.bots.engine.login },
      new Date(),
    );
    const next = await rec.auditMergedPrs('acme/widgets', new Date(0));
    expect(next.cleanPrs).toEqual([pr.number]);
    expect(next.findings.some((f) => f.kind === 'no_merge_record')).toBe(false);
  });

  it.each([
    'backfill',
    'wrong-action',
    'missing-target',
    'wrong-repo',
    'wrong-target-number',
    'number-only',
    'missing-number',
    'missing-head',
    'missing-mergeCommit',
    'missing-mergedBy',
    'wrong-number',
    'wrong-head',
    'wrong-mergeCommit',
    'wrong-mergedBy',
    'null-receipt',
    'array-receipt',
    'null-mergeCommit',
    'null-mergedBy',
    'short-head',
    'incomplete',
    'human-actor',
    'agent-actor',
    'missing-real-mergeCommit',
  ])('无效队列证据 %s 不能撤风险，也不能重写已有来源', async (scenario) => {
    const { gh, fake, ledger } = setup();
    const pr = fake.addPull({
      head: { ref: 'fleet/1-abcd1234', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: scenario === 'missing-real-mergeCommit' ? null : B,
      merged_by:
        scenario === 'human-actor'
          ? fake.human
          : scenario === 'agent-actor'
            ? fake.bots.agent
            : fake.bots.engine,
    });
    const key = mergeKey(repo, pr.number, A);
    const action =
      scenario === 'backfill'
        ? 'github.merge_pr_backfill'
        : scenario === 'wrong-action'
          ? 'github.open_pr'
          : 'github.merge_pr';
    const target =
      scenario === 'missing-target'
        ? undefined
        : scenario === 'wrong-repo'
          ? `other/widgets#${pr.number}`
          : scenario === 'wrong-target-number'
            ? `acme/widgets#${pr.number + 1}`
            : `acme/widgets#${pr.number}`;
    await ledger.idempotency.claim({ key, action, ...(target === undefined ? {} : { target }) }, new Date());
    const receipt: Record<string, unknown> = {
      number: pr.number,
      head: A,
      mergeCommit: B,
      mergedBy: fake.bots.engine.login,
    };
    if (
      scenario.startsWith('missing-') &&
      scenario !== 'missing-target' &&
      scenario !== 'missing-real-mergeCommit'
    )
      delete receipt[scenario.slice('missing-'.length)];
    if (scenario === 'wrong-number') receipt.number = pr.number + 1;
    if (scenario === 'wrong-head') receipt.head = sha('c');
    if (scenario === 'wrong-mergeCommit') receipt.mergeCommit = sha('d');
    if (scenario === 'wrong-mergedBy') receipt.mergedBy = fake.human.login;
    if (scenario === 'null-mergeCommit') receipt.mergeCommit = null;
    if (scenario === 'null-mergedBy') receipt.mergedBy = null;
    if (scenario === 'short-head') receipt.head = 'abc';
    if (scenario !== 'incomplete')
      await ledger.idempotency.complete(
        key,
        scenario === 'number-only'
          ? { number: pr.number }
          : scenario === 'null-receipt'
            ? null
            : scenario === 'array-receipt'
              ? [receipt]
              : receipt,
        new Date(),
      );
    const before = await ledger.idempotency.peek(key);
    const { intake } = fakeIntake(() => true);
    const rec = gh.reconciler({ intake, pollDeliveryId });
    for (let round = 0; round < 2; round += 1) {
      const report = await rec.auditMergedPrs('acme/widgets', new Date(0));
      expect(report.cleanPrs).toEqual([]);
      expect(report.findings.some((f) => f.number === pr.number && f.kind === 'no_merge_record')).toBe(true);
      expect(await ledger.idempotency.peek(key)).toEqual(before);
    }
  });

  it('幂等账 peek 抛错：partial/unchecked，不能当作没有风险或尝试补账', async () => {
    const { gh, fake, ledger } = setup();
    const pr = fake.addPull({
      head: { ref: 'fleet/1-abcd1234', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: B,
      merged_by: fake.bots.engine,
    });
    let claims = 0;
    ledger.idempotency.claim = async () => {
      claims += 1;
      return { status: 'claimed' };
    };
    ledger.idempotency.peek = async () => {
      throw new Error('幂等账读失败');
    };
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date(0));
    expect(report).toMatchObject({ outcome: 'partial', cleanPrs: [] });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        number: pr.number,
        kind: 'unchecked',
        text: expect.stringContaining('幂等账读失败'),
      }),
    );
    expect(claims).toBe(0);
  });

  it('「引擎」自己开、自己合的 PR（定时任务的数据 PR）：不报没有合并记录，只补账（#2175）', async () => {
    const { gh, fake, ledger } = setup();
    const own = fake.addPull({
      user: fake.bots.engine,
      head: { ref: 'ci-timings/2026-10-14', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: sha('c'),
      merged_by: fake.bots.engine,
    });
    // 干活的机器人开的、同样由「引擎」合、没有合并记录：照报
    const task = fake.addPull({
      head: { ref: 'task/3', sha: B },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:30:00Z',
      merge_commit_sha: sha('d'),
      merged_by: fake.bots.engine,
    });
    for (const [number, ref, head] of [
      [own.number, 'ci-timings/2026-10-14', A],
      [task.number, 'task/3', B],
    ] as const) {
      await ledger.upsertPullRequest({
        repoId: REPO_ID,
        number,
        state: 'merged',
        headRef: ref,
        headSha: head,
        updatedAt: new Date('2026-09-25T11:30:00Z'),
      });
    }
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(report.outcome).toBe('ok');
    expect(report.findings.map((f) => `${f.number} ${f.kind}`).sort()).toEqual(
      [
        `${own.number} backfill_merge_record`,
        `${task.number} no_merge_record`,
        `${task.number} backfill_merge_record`,
      ].sort(),
    );
    expect((await ledger.idempotency.peek(mergeKey(repo, own.number, A)))?.completedAt).toBeTruthy();
  });

  it('创始人引导记录 PR：只新增引导记录文件且必过检查全绿才不报；换文件、检查红、非 directive/ 分支、读不到文件的照报', async () => {
    const { gh, fake, ledger } = setup();
    const docFile = { filename: 'docs/directives/2026-10/20261017132726.md', status: 'added' };
    const filesOf = new Map<number, { filename: string; status: string }[]>();
    fake.before.push((req) => {
      const m = /\/pulls\/(\d+)\/files$/.exec(req.path);
      if (req.method !== 'GET' || !m) return undefined;
      const files = filesOf.get(Number(m[1]));
      return files ? json(200, files) : json(500, { message: 'boom' });
    });
    const heads = [sha('1'), sha('2'), sha('3'), sha('4'), sha('5'), sha('6')] as const;
    const add = (ref: string, head: string, hour: number) =>
      fake.addPull({
        head: { ref, sha: head },
        state: 'closed',
        merged: true,
        merged_at: `2026-09-25T${String(hour).padStart(2, '0')}:00:00Z`,
        merge_commit_sha: sha('c'),
        merged_by: fake.human,
      });
    const good = add('directive/20261017132726', heads[0] as string, 1);
    const wrongFile = add('directive/20261017132727', heads[1] as string, 2);
    const modified = add('directive/20261017132728', heads[2] as string, 3);
    const red = add('directive/20261017132729', heads[3] as string, 4);
    const plain = add('task/5', heads[4] as string, 5);
    const unreadable = add('directive/20261017132730', heads[5] as string, 6);
    filesOf.set(good.number, [docFile]);
    filesOf.set(wrongFile.number, [docFile, { filename: 'packages/api/src/a.ts', status: 'added' }]);
    filesOf.set(modified.number, [{ ...docFile, status: 'modified' }]);
    filesOf.set(red.number, [docFile]);
    filesOf.set(plain.number, [docFile]);
    for (const [pr, head, result] of [
      [good, heads[0], 'success'],
      [wrongFile, heads[1], 'success'],
      [modified, heads[2], 'success'],
      [red, heads[3], 'failure'],
      [plain, heads[4], 'success'],
      [unreadable, heads[5], 'success'],
    ] as const) {
      fake.addCheck(head, 'check', result);
      await ledger.upsertPullRequest({
        repoId: REPO_ID,
        number: pr.number,
        state: 'merged',
        headRef: pr.head.ref,
        headSha: head,
        updatedAt: new Date('2026-09-25T11:30:00Z'),
      });
    }
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(report.outcome).toBe('ok');
    expect(report.directiveRecordPrs).toEqual([good.number]);
    const reported = (n: number) =>
      report.findings.filter((f) => f.number === n && f.kind !== 'backfill_merge_record');
    expect(reported(good.number)).toEqual([]);
    for (const pr of [wrongFile, modified, red, plain, unreadable]) {
      expect(
        reported(pr.number)
          .map((f) => f.kind)
          .sort(),
      ).toEqual(['no_merge_record', 'not_merged_by_engine']);
    }
    // 补账照做：不能因为不报就当它走过合并队列
    expect(
      (await ledger.idempotency.peek(mergeKey(repo, good.number, heads[0] as string)))?.completedAt,
    ).toBeTruthy();
  });

  it('耗时表不报没经合并队列；人手合的、fleet/ 上引擎自己合但没经队列的照报', async () => {
    const { gh, fake, ledger } = setup();
    const C = sha('e');
    const timings = fake.addPull({
      user: fake.bots.engine,
      head: { ref: 'ci-timings/2026-10-14', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: sha('c'),
      merged_by: fake.bots.engine,
    });
    // 分支虽是 ci-timings/，合并的是人：仍报没经合并队列
    const byHand = fake.addPull({
      user: fake.bots.engine,
      head: { ref: 'ci-timings/handed', sha: B },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:10:00Z',
      merge_commit_sha: sha('d'),
      merged_by: fake.human,
    });
    const fleet = fake.addPull({
      user: fake.bots.engine,
      head: { ref: 'fleet/13-abcd1234', sha: C },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:20:00Z',
      merge_commit_sha: sha('f'),
      merged_by: fake.bots.engine,
    });
    for (const [number, ref, head] of [
      [timings.number, 'ci-timings/2026-10-14', A],
      [byHand.number, 'ci-timings/handed', B],
      [fleet.number, 'fleet/13-abcd1234', C],
    ] as const) {
      await ledger.upsertPullRequest({
        repoId: REPO_ID,
        number,
        state: 'merged',
        headRef: ref,
        headSha: head,
        updatedAt: new Date('2026-09-25T11:30:00Z'),
      });
    }
    const { intake } = fakeIntake(() => true);
    const report = await gh
      .reconciler({ intake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(report.outcome).toBe('ok');
    expect(report.engineCiTimingsPrs).toEqual([timings.number]);
    expect(report.findings.map((f) => `${f.number} ${f.kind}`).sort()).toEqual(
      [
        `${timings.number} backfill_merge_record`,
        `${byHand.number} not_merged_by_engine`,
        `${byHand.number} no_merge_record`,
        `${byHand.number} backfill_merge_record`,
        `${fleet.number} no_merge_record`,
        `${fleet.number} backfill_merge_record`,
      ].sort(),
    );
    const fleetGap = report.findings.find((f) => f.number === fleet.number && f.kind === 'no_merge_record');
    expect(fleetGap).toMatchObject({
      headRef: 'fleet/13-abcd1234',
      openedByEngine: true,
      mergedByEngine: true,
    });
  });

  it('人开的 PR：镜像没记的照样补上；不报合并人、也不报没有合并记录', async () => {
    const { gh, fake, ledger } = setup();
    const byHuman = fake.addPull({
      user: fake.human,
      head: { ref: 'task/9', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: sha('c'),
      merged_by: fake.human,
    });
    const report = await gh.auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(report).toMatchObject({ outcome: 'ok', scanned: 1, found: 1, fixed: 1 });
    expect(report.problems).toEqual([`#${byHuman.number} 合并了但镜像里没有（已补）`]);
    expect(report.findings).toEqual([
      { number: byHuman.number, kind: 'mirror_fixed', text: `#${byHuman.number} 合并了但镜像里没有（已补）` },
    ]);
    expect((await ledger.getPullRequest(REPO_ID, byHuman.number))?.state).toBe('merged');
    expect((await ledger.getPullRequest(REPO_ID, byHuman.number))?.title).toBe(`PR ${byHuman.number}`);
  });

  it('镜像里已是合并、只缺标题的旧行：对账补上标题，不记发现（#1744）', async () => {
    const { gh, fake, ledger } = setup();
    const pr = fake.addPull({
      user: fake.human,
      title: '本机做的单',
      head: { ref: 'local/9-x', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: sha('c'),
      merged_by: fake.human,
    });
    await ledger.upsertPullRequest({
      repoId: REPO_ID,
      number: pr.number,
      state: 'merged',
      headRef: 'local/9-x',
      headSha: A,
      updatedAt: new Date(pr.updated_at),
    });
    expect((await ledger.getPullRequest(REPO_ID, pr.number))?.title ?? null).toBeNull();
    const report = await gh.auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(report.findings).toEqual([]);
    expect((await ledger.getPullRequest(REPO_ID, pr.number))?.title).toBe('本机做的单');
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

  it('【故意造出的失败】「引擎」只有 statuses:read（App 设置里改了、安装处没点接受）：自检报缺 statuses:write——贴不了「认领对得上」（#299）', async () => {
    const { gh, fake } = setup();
    fake.permissions.engine = { ...fake.permissions.engine, statuses: 'read' };
    const [, engine] = await gh.selfCheck([repo]);
    expect(engine).toEqual({
      role: 'engine',
      repo: 'acme/widgets',
      ok: false,
      missing: ['statuses:write'],
      extra: [],
    });
    const { statuses: _gone, ...without } = fake.permissions.engine;
    fake.permissions.engine = without;
    expect((await gh.selfCheck([repo]))[1]).toMatchObject({ ok: false, missing: ['statuses:write'] });
  });
});

describe('正式评审要求改：撤引擎任务 PR 的自动合并（#2991，reviewMergeHold）', () => {
  const FLOW = 'fleet/2975-t0123abcd';
  function claims(pulls: Record<number, Partial<PullFacts>>, failDisable = false) {
    const reads: number[] = [];
    const disabled: number[] = [];
    return {
      reads,
      disabled,
      claims: {
        async readPull(_r: unknown, n: number): Promise<PullFacts> {
          reads.push(n);
          return {
            number: n,
            nodeId: `PR_${n}`,
            state: 'open',
            merged: false,
            draft: false,
            title: '',
            body: '',
            headSha: A,
            headRef: FLOW,
            fromFork: false,
            author: null,
            autoMerge: true,
            ...pulls[n],
          };
        },
        async disableAutoMerge(_r: unknown, pull: Pick<PullFacts, 'number'>) {
          if (failDisable) throw new Error('HTTP 502');
          disabled.push(pull.number);
        },
      },
    };
  }
  const review = (state: string, action = 'submitted', ref = FLOW) =>
    event({
      event: 'pull_request_review',
      action,
      payload: { action, pull_request: { number: 5, head: { ref, sha: A } }, review: { state } },
    });

  it('认可的要求改（交了、改了正文）：回 GitHub 重读、开着挂着才撤', async () => {
    const { gh } = setup();
    const c = claims({ 5: {} });
    const sink = gh.eventSink(reviewMergeHold(c.claims));
    await sink.accept(review('changes_requested'));
    await sink.accept(review('changes_requested', 'edited'));
    expect(c.reads).toEqual([5, 5]);
    expect(c.disabled).toEqual([5, 5]);
  });

  it('普通 COMMENTED、通过、撤销、人开的分支、自家机器人的回声：不读不撤', async () => {
    const { gh } = setup();
    const c = claims({ 5: {} });
    const sink = gh.eventSink(reviewMergeHold(c.claims));
    await sink.accept(review('commented'));
    await sink.accept(review('approved'));
    await sink.accept(review('dismissed', 'dismissed'));
    await sink.accept(review('changes_requested', 'submitted', 'feature/x'));
    await sink.accept({ ...review('changes_requested'), wake: false });
    expect(c.reads).toEqual([]);
    expect(c.disabled).toEqual([]);
  });

  it('已经合了、关了、没挂自动合并（终态、或别处先撤了）：读了不撤，不报错', async () => {
    for (const pull of [{ merged: true }, { state: 'closed' as const }, { autoMerge: false }]) {
      const { gh } = setup();
      const c = claims({ 5: pull });
      await gh.eventSink(reviewMergeHold(c.claims)).accept(review('changes_requested'));
      expect(c.reads).toEqual([5]);
      expect(c.disabled).toEqual([]);
    }
  });

  it('评审到的时候 PR 已经合了：不撤，留未送达的明账（带 review id、审查者、审的提交、投递编号）；明账写不成就抛，不当成处理了', async () => {
    const { gh } = setup();
    const c = claims({ 5: { merged: true } });
    const notes: unknown[] = [];
    const ev = event({
      deliveryId: 'd-merged',
      event: 'pull_request_review',
      action: 'submitted',
      payload: {
        action: 'submitted',
        pull_request: { number: 5, head: { ref: FLOW, sha: A } },
        review: { id: 777, state: 'changes_requested', user: { login: 'boss' }, commit_id: B },
      },
    });
    await gh.eventSink(reviewMergeHold(c.claims, undefined, async (n) => void notes.push(n))).accept(ev);
    expect(c.disabled).toEqual([]);
    expect(notes).toEqual([
      {
        repo: 'acme/widgets',
        prNumber: 5,
        deliveryId: 'd-merged',
        review: { id: 777, reviewer: 'boss', commitId: B },
      },
    ]);
    await expect(
      gh
        .eventSink(
          reviewMergeHold(c.claims, undefined, async () => {
            throw new Error('库写不进');
          }),
        )
        .accept(ev),
    ).rejects.toThrow('库写不进');
  });

  it('【故意造出的失败】撤不成：抛出去（这条投递记成出错、对账按原文重放），不当成撤了', async () => {
    const { gh } = setup();
    const c = claims({ 5: {} }, true);
    await expect(gh.eventSink(reviewMergeHold(c.claims)).accept(review('changes_requested'))).rejects.toThrow(
      'HTTP 502',
    );
  });
});
