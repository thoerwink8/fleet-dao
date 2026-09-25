// issue 进来 → 任务行、需求工作流；关了、重开、改了、评论了 → 按设计发信号（specs/43-接活入口/方案.md）。
// 走真的 webhook 接口（验签、落库、白名单），工作流用 harness 里记录调用的假的。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import { createGitHubIntake } from '../src/github.ts';
import { dispatchDecision } from '../src/issue-intake.ts';
import type { MemoryData } from '../src/memory-store.ts';
import {
  type AskRecord,
  type RequirementWorkflows,
  type TaskSignal,
  type WorkflowControl,
  WorkflowGoneError,
  WorkflowUnavailableError,
} from '../src/ports.ts';
import { deliverGithub as deliver, type HarnessOptions, harness, T0 } from './harness.ts';

const REPO = { full_name: 'example/canary' };
const founderA = { login: 'founder-a', id: 1001, type: 'User' };
/** 白名单里只登记了登录名。 */
const founderB = { login: 'Founder-B', id: 5555, type: 'User' };
const stranger = { login: 'stranger', id: 4242, type: 'User' };
const engineBot = { login: 'fleet-engine[bot]', id: 9002, type: 'Bot' };

const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString().replace('.000Z', 'Z');
/** 巡检仓的自动派活开关在 T0 前一小时打开。 */
const SWITCH_ON = at(-60);

const PROGRESS =
  '\n\n<!-- fleet:progress:start as-of=2026-09-25T08:00:00.000Z -->\n**进度**：0/0 · 排队中\n<!-- fleet:progress:end -->\n';

function issue(over: Record<string, unknown> = {}) {
  return {
    number: 40,
    title: '给 README 加一行当前时间',
    body: `在 README 末尾加一行当前时间${PROGRESS}`,
    state: 'open',
    user: founderA,
    created_at: at(-30),
    updated_at: at(-30),
    ...over,
  };
}

const issuesEvent = (action: string, iss: object = issue(), sender: object = founderA) => ({
  action,
  issue: iss,
  sender,
  repository: REPO,
});

function setup(options: HarnessOptions & { switchOn?: string | null; asks?: AskRecord[] } = {}) {
  const { switchOn, asks, ...rest } = options;
  const data: Partial<MemoryData> = devFixtures(T0);
  const since = switchOn === undefined ? SWITCH_ON : switchOn;
  data.repos = (data.repos ?? []).map((r) => ({ ...r, ...(since ? { autoDispatchSince: since } : {}) }));
  data.asks = asks ?? [];
  const h = harness({ ...rest, data });
  const task = (n = 40) => h.store.findTaskByIssue(IDS.repo, n);
  const auditsOf = async (taskId: string) =>
    (await h.store.listAudit({ target: `task:${taskId}`, limit: 50 })).items.map((a) => ({
      action: a.action,
      actor: a.actor,
      via: a.via,
      reason: a.reason,
    }));
  return { h, task, auditsOf };
}

async function json(res: Response | Promise<Response>) {
  const r = await res;
  expect(r.status).toBe(200);
  return (await r.json()) as { verdict: string; note?: string; reason?: string };
}

describe('issue 进来：建任务行、拉起需求工作流', () => {
  it('白名单作者开的单：建一行任务（原话去掉进度段、排在这个仓最后），拉起需求工作流，都记进操作记录', async () => {
    const { h, task, auditsOf } = setup();
    expect(await json(deliver(h, 'issues', issuesEvent('opened')))).toMatchObject({
      verdict: 'accepted',
      note: 'task=created, workflow=started',
    });
    const t = await task();
    expect(t).toMatchObject({
      repoId: IDS.repo,
      issueNumber: 40,
      title: '给 README 加一行当前时间',
      rawRequest: '在 README 末尾加一行当前时间',
      requestedBy: IDS.founderA,
      state: 'queued',
      priority: 3,
    });
    if (!t) throw new Error('没建任务');
    // 输入和引擎 contract.ts 的 RequirementInput 同形；仓不带自动派活开关（开关不进工作流的历史）
    expect(h.starts).toEqual([
      {
        schemaVersion: 1,
        taskId: t.id,
        repo: {
          id: IDS.repo,
          owner: 'example',
          name: 'canary',
          defaultBranch: 'main',
          testCommand: 'pnpm check',
        },
        issueNumber: 40,
        title: '给 README 加一行当前时间',
        rawRequest: '在 README 末尾加一行当前时间',
        requestedBy: 'founder-a',
      },
    ]);
    expect(await auditsOf(t.id)).toEqual([
      {
        action: 'task.start',
        actor: { kind: 'engine', id: 'github-intake' },
        via: 'github',
        reason: undefined,
      },
      { action: 'task.create', actor: { kind: 'user', id: IDS.founderA }, via: 'github', reason: undefined },
    ]);
  });

  it('同一个投递编号来两次（GitHub 重投）：只建一行任务、只拉起一次', async () => {
    const { h } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened'), { delivery: 'same' }));
    expect(await json(deliver(h, 'issues', issuesEvent('opened'), { delivery: 'same' }))).toEqual({
      ok: true,
      verdict: 'duplicate',
    });
    expect(h.store.data.tasks.filter((t) => t.issueNumber === 40)).toHaveLength(1);
    expect(h.starts).toHaveLength(1);
  });

  it('不同投递说同一张 issue（开单后马上贴标签）：不重复建任务；工作流已经在跑就不起第二条', async () => {
    const { h } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const labeled = issuesEvent('labeled', issue({ updated_at: at(-29) }));
    expect(await json(deliver(h, 'issues', labeled))).toMatchObject({
      note: 'task=exists, workflow=already_running',
    });
    expect(h.store.data.tasks.filter((t) => t.issueNumber === 40)).toHaveLength(1);
    expect(h.starts).toHaveLength(1);
  });

  it('自动派活开关关着：只收单（建任务行）不拉起；开关打开以前就开着的 issue 也不自动拉起', async () => {
    const off = setup({ switchOn: null });
    expect(await json(deliver(off.h, 'issues', issuesEvent('opened')))).toMatchObject({
      note: 'task=created, workflow=dispatch_off',
    });
    expect((await off.task())?.state).toBe('queued');
    expect(off.h.starts).toEqual([]);

    const on = setup();
    const old = issuesEvent('opened', issue({ created_at: at(-120) }));
    expect(await json(deliver(on.h, 'issues', old))).toMatchObject({
      note: 'task=created, workflow=opened_before_switch',
    });
    expect(on.h.starts).toEqual([]);
  });

  it('陌生人开的单：不建任务、不拉起', async () => {
    const { h, task } = setup();
    expect(
      await json(deliver(h, 'issues', issuesEvent('opened', issue({ user: stranger }), stranger))),
    ).toMatchObject({ verdict: 'ignored', reason: 'author_not_whitelisted' });
    expect(await task()).toBeNull();
    expect(h.starts).toEqual([]);
  });

  it('只登记了登录名的创始人开的单：提出人照样记成员编号', async () => {
    const { h, task } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened', issue({ user: founderB }), founderB)));
    expect((await task())?.requestedBy).toBe(IDS.founderB);
  });

  it('自家机器人代开的单：照样建任务、按开关拉起，操作记录记在引擎名下', async () => {
    const { h, task, auditsOf } = setup();
    expect(
      await json(deliver(h, 'issues', issuesEvent('opened', issue({ user: engineBot }), engineBot))),
    ).toMatchObject({ verdict: 'accepted', wake: false, note: 'task=created, workflow=started' });
    const t = await task();
    expect(t?.requestedBy).toBe(IDS.botEngine);
    if (!t) throw new Error('没建任务');
    expect((await auditsOf(t.id)).find((a) => a.action === 'task.create')?.actor).toEqual({
      kind: 'engine',
      id: IDS.botEngine,
    });
  });

  it('拉起工作流失败（Temporal 连不上）：投递记成出错、任务行留着；重放时接着拉起，不重复建任务', async () => {
    let down = true;
    const starts: string[] = [];
    const requirements: RequirementWorkflows = {
      async start(input) {
        if (down) throw new WorkflowUnavailableError('Temporal 连不上');
        starts.push(input.taskId);
        return 'started';
      },
    };
    const { h, task } = setup({ requirements });
    const res = await deliver(h, 'issues', issuesEvent('opened'), { delivery: 'first' });
    expect(res.status).toBe(500);
    expect(await h.store.getDelivery('first')).toMatchObject({ status: 'failed', reason: 'Temporal 连不上' });
    const t = await task();
    expect(t?.state).toBe('queued');

    down = false;
    expect(await createGitHubIntake(h.deps).replay('first')).toMatchObject({
      verdict: 'accepted',
      note: 'task=exists, workflow=started',
    });
    expect(h.store.data.tasks.filter((x) => x.issueNumber === 40)).toHaveLength(1);
    expect(starts).toEqual([t?.id]);
  });

  it('/issues 列表里混进来的 PR：不建任务', async () => {
    const { h, task } = setup();
    const pr = issuesEvent('synced', issue({ pull_request: { url: 'x' } }));
    expect(await json(deliver(h, 'issues', pr))).toMatchObject({ note: 'skip=pull_request' });
    expect(await task()).toBeNull();
  });

  it('真 GitHub 录下的 issue 对象（正文带引擎的进度段）走同一段代码：原话去掉进度段', async () => {
    const recorded = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../github/test/fixtures/github/issue.json'), 'utf8'),
    ) as Record<string, unknown>;
    const { h, task } = setup();
    // 录的是一张验收脚本开的、已经关了的单；换成白名单作者开的、开着的 #41
    const iss = { ...recorded, number: 41, state: 'open', user: founderA, created_at: at(-10) };
    expect(await json(deliver(h, 'issues', issuesEvent('opened', iss)))).toMatchObject({
      note: 'task=created, workflow=started',
    });
    expect((await task(41))?.rawRequest).toBe(
      '原话：真机验收 2026-09-24T20-55-57-851Z（验收脚本自动开的，跑完自己关）\nAI 理解：在 README 末尾加一行时间',
    );
  });
});

describe('issue 关了、重开、改了', () => {
  it('关了：给需求工作流发叫停（记下是谁关的），记操作记录；已经结束的任务不再发', async () => {
    const { h, task, auditsOf } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const closed = issuesEvent('closed', issue({ state: 'closed', updated_at: at(-5) }));
    expect(await json(deliver(h, 'issues', closed))).toMatchObject({ note: 'stop=sent' });
    const t = await task();
    if (!t) throw new Error('没建任务');
    expect(h.signals).toEqual([
      { taskId: t.id, signal: { name: 'stop', by: IDS.founderA, reason: 'GitHub 上关了这张 issue' } },
    ]);
    expect((await auditsOf(t.id))[0]).toMatchObject({
      action: 'task.stop',
      reason: 'GitHub 上关了这张 issue',
    });

    // #13 在样例里已经做完了
    const done = issuesEvent('closed', issue({ number: 13, state: 'closed' }));
    expect(await json(deliver(h, 'issues', done))).toMatchObject({ note: 'task=done' });
    expect(h.signals).toHaveLength(1);
  });

  it('自家机器人关的（做完了引擎自己关单）：不叫停；没有任务的关单也不建任务', async () => {
    const { h, task } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const byEngine = issuesEvent('closed', issue({ state: 'closed' }), engineBot);
    expect(await json(deliver(h, 'issues', byEngine))).toMatchObject({ note: 'stop=skip_bot' });
    expect(h.signals).toEqual([]);
    const unknown = issuesEvent('closed', issue({ number: 77, state: 'closed' }));
    expect(await json(deliver(h, 'issues', unknown))).toMatchObject({ note: 'task=none' });
    expect(await task(77)).toBeNull();
  });

  it('工作流不在、任务还在排队（从没派出去）：直接把任务记成叫停', async () => {
    const workflows: WorkflowControl = {
      async signal(taskId) {
        throw new WorkflowGoneError(taskId);
      },
    };
    const { h, task, auditsOf } = setup({ switchOn: null, workflows });
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const closed = issuesEvent('closed', issue({ state: 'closed' }));
    expect(await json(deliver(h, 'issues', closed))).toMatchObject({ note: 'task=stopped' });
    const t = await task();
    expect(t?.state).toBe('stopped');
    if (!t) throw new Error('没建任务');
    expect((await auditsOf(t.id))[0]?.reason).toBe('GitHub 上关了这张 issue（没派出去过，直接记成叫停）');
  });

  it('叫停发不出去（Temporal 连不上）：投递记成出错，重投或重放时再来', async () => {
    const workflows: WorkflowControl = {
      async signal() {
        throw new WorkflowUnavailableError('Temporal 连不上');
      },
    };
    const { h } = setup({ workflows });
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const res = await deliver(h, 'issues', issuesEvent('closed', issue({ state: 'closed' })), {
      delivery: 'close',
    });
    expect(res.status).toBe(500);
    expect(await h.store.getDelivery('close')).toMatchObject({ status: 'failed', reason: 'Temporal 连不上' });
  });

  it('GitHub 上删了、转走了：一样叫停', async () => {
    const { h } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    expect(await json(deliver(h, 'issues', issuesEvent('deleted')))).toMatchObject({ note: 'stop=sent' });
    expect(h.signals.map((s) => (s.signal as Extract<TaskSignal, { name: 'stop' }>).reason)).toEqual([
      'GitHub 上删了这张 issue',
    ]);
  });

  it('重开：已经结束的任务重新拉起一次；补收看到「开着、任务已结束」不算重开，不拉起', async () => {
    const { h, task, auditsOf } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    await json(deliver(h, 'issues', issuesEvent('closed', issue({ state: 'closed', updated_at: at(-20) }))));
    const t = h.store.data.tasks.find((x) => x.issueNumber === 40);
    if (!t) throw new Error('没建任务');
    t.state = 'stopped'; // 引擎收到叫停后写的
    const polled = issuesEvent('synced', issue({ updated_at: at(-10) }));
    expect(await json(deliver(h, 'issues', polled))).toMatchObject({
      note: 'task=exists, workflow=finished',
    });
    expect(h.starts).toHaveLength(1);

    expect(
      await json(deliver(h, 'issues', issuesEvent('reopened', issue({ updated_at: at(-5) })))),
    ).toMatchObject({ note: 'task=exists, workflow=started' });
    expect(h.starts).toHaveLength(2);
    expect((await task())?.id).toBe(t.id);
    expect((await auditsOf(t.id))[0]).toMatchObject({
      action: 'task.start',
      reason: 'GitHub 上重开了这张 issue',
    });
  });

  it('关了又马上重开、上一轮还没结束（任务还在跑）：重开记成出错（503，不当后端出错），不拉起；上一轮结束后重放再拉起', async () => {
    const { h } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const t = h.store.data.tasks.find((x) => x.issueNumber === 40);
    if (!t) throw new Error('没建任务');
    t.state = 'running';
    await json(deliver(h, 'issues', issuesEvent('closed', issue({ state: 'closed', updated_at: at(-20) }))));
    const res = await deliver(h, 'issues', issuesEvent('reopened', issue({ updated_at: at(-10) })), {
      delivery: 'reopen',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'retry_later' } });
    expect(await h.store.getDelivery('reopen')).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('上一轮还没结束（任务现在是 running）'),
    });
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('现在做不了'))).toBe(true);
    expect(h.logs.some((l) => l.level === 'error')).toBe(false);
    expect(h.starts).toHaveLength(1);

    // 还没结束时重放：照样等
    const intake = createGitHubIntake(h.deps);
    await expect(intake.replay('reopen')).rejects.toThrow('上一轮还没结束');
    t.state = 'stopped'; // 引擎收完尾写的
    expect(await intake.replay('reopen')).toMatchObject({
      verdict: 'accepted',
      note: 'task=exists, workflow=started',
    });
    expect(h.starts).toHaveLength(2);
    expect(await h.store.getDelivery('reopen')).toMatchObject({ status: 'accepted', attempts: 3 });
  });

  it('任务已经记成结束、上一轮工作流却还在收尾（拉起回 already_running）：重开同样记成出错，之后重放再拉起', async () => {
    let calls = 0;
    const requirements: RequirementWorkflows = {
      async start() {
        calls += 1;
        return calls === 2 ? 'already_running' : 'started';
      },
    };
    const { h } = setup({ requirements });
    await json(deliver(h, 'issues', issuesEvent('opened')));
    await json(deliver(h, 'issues', issuesEvent('closed', issue({ state: 'closed', updated_at: at(-20) }))));
    const t = h.store.data.tasks.find((x) => x.issueNumber === 40);
    if (!t) throw new Error('没建任务');
    t.state = 'stopped';
    const res = await deliver(h, 'issues', issuesEvent('reopened', issue({ updated_at: at(-10) })), {
      delivery: 'reopen',
    });
    expect(res.status).toBe(503);
    expect(await h.store.getDelivery('reopen')).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('上一轮工作流还没收完尾'),
    });
    expect(await createGitHubIntake(h.deps).replay('reopen')).toMatchObject({
      note: 'task=exists, workflow=started',
    });
    expect(calls).toBe(3);
  });

  it('旧的重开重放时，同一张 issue 后来又关了（更新的一版处理过）：不再拉起，记成 superseded', async () => {
    const { h } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const t = h.store.data.tasks.find((x) => x.issueNumber === 40);
    if (!t) throw new Error('没建任务');
    t.state = 'running';
    await json(deliver(h, 'issues', issuesEvent('closed', issue({ state: 'closed', updated_at: at(-20) }))));
    await deliver(h, 'issues', issuesEvent('reopened', issue({ updated_at: at(-10) })), {
      delivery: 'reopen',
    });
    // 又关了一次（这一版处理过了）
    await json(deliver(h, 'issues', issuesEvent('closed', issue({ state: 'closed', updated_at: at(-5) }))));
    t.state = 'stopped';
    expect(await createGitHubIntake(h.deps).replay('reopen')).toEqual({
      verdict: 'ignored',
      reason: 'superseded',
    });
    expect(await h.store.getDelivery('reopen')).toMatchObject({ status: 'ignored', reason: 'superseded' });
    expect(h.starts).toHaveLength(1);
  });

  it('晚到的旧关单（之后的一版已经处理过、显示开着）：不叫停', async () => {
    const { h } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    await json(
      deliver(h, 'issues', issuesEvent('edited', issue({ title: '改过的标题', updated_at: at(-10) }))),
    );
    const late = issuesEvent('closed', issue({ state: 'closed', updated_at: at(-20) }));
    expect(await json(deliver(h, 'issues', late))).toEqual({
      ok: true,
      verdict: 'ignored',
      reason: 'superseded',
    });
    expect(h.signals).toEqual([]);
  });

  it('白名单的人改了标题、正文：任务行跟着改、记操作记录；自家机器人改进度段不动任务行', async () => {
    const { h, task, auditsOf } = setup();
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const edited = issuesEvent('edited', issue({ title: 'README 加时间', body: `改成加在开头${PROGRESS}` }));
    expect(await json(deliver(h, 'issues', edited))).toMatchObject({
      note: 'request=ok, workflow=already_running',
    });
    expect(await task()).toMatchObject({ title: 'README 加时间', rawRequest: '改成加在开头' });
    const t = await task();
    if (!t) throw new Error('没建任务');
    expect((await auditsOf(t.id))[0]).toMatchObject({ action: 'task.edit', actor: { id: IDS.founderA } });

    const echo = issuesEvent(
      'edited',
      issue({ title: 'README 加时间', body: '机器人改了进度段' }),
      engineBot,
    );
    await json(deliver(h, 'issues', echo));
    expect((await task())?.rawRequest).toBe('改成加在开头');
  });
});

describe('评论 → 回答追问', () => {
  const ask = (over: Partial<AskRecord> = {}): AskRecord => ({
    id: 'f1000000-0000-4000-8000-000000000001',
    taskId: IDS.task12,
    question: '验证码几分钟过期？',
    options: [],
    askedAt: at(-10),
    ...over,
  });
  const comment = (body: string, over: Record<string, unknown> = {}, user: object = founderA) => ({
    action: 'created',
    issue: { number: 12, user: founderA },
    comment: { id: 900, body, user, created_at: at(-2), updated_at: at(-2), ...over },
    sender: user,
    repository: REPO,
  });

  it('白名单的人评论、这张任务正好一条没答的追问：当作回答（写库、发 answer 信号）', async () => {
    const { h } = setup({ asks: [ask()] });
    expect(await json(deliver(h, 'issue_comment', comment('  5 分钟  ')))).toMatchObject({
      note: 'ask=answered',
    });
    expect(await h.store.getAsk(ask().id)).toMatchObject({ answer: '5 分钟', answeredBy: IDS.founderA });
    expect(h.signals).toEqual([
      {
        taskId: IDS.task12,
        signal: { name: 'answer', by: IDS.founderA, askId: ask().id, answer: '5 分钟' },
      },
    ]);
    const audits = await h.store.listAudit({ target: `task:${IDS.task12}`, limit: 5 });
    expect(audits.items[0]).toMatchObject({ action: 'ask.answer', via: 'github' });
  });

  it('对不上就不当回答、记下原因：没有没答的、有好几条没答的、追问是评论之后才问的', async () => {
    const none = setup();
    expect(await json(deliver(none.h, 'issue_comment', comment('随便说一句')))).toMatchObject({
      note: 'ask=none_open',
    });
    const two = setup({
      asks: [ask(), ask({ id: 'f1000000-0000-4000-8000-000000000002', question: '发几位数？' })],
    });
    expect(await json(deliver(two.h, 'issue_comment', comment('5 分钟')))).toMatchObject({
      note: 'ask=ambiguous_2',
    });
    expect(two.h.logs.some((l) => l.level === 'warn' && l.message.includes('对不上'))).toBe(true);
    const later = setup({ asks: [ask({ askedAt: at(-1) })] });
    expect(await json(deliver(later.h, 'issue_comment', comment('5 分钟')))).toMatchObject({
      note: 'ask=none_open',
    });
    for (const s of [none, two, later]) expect(s.h.signals).toEqual([]);
    expect((await later.h.store.getAsk(ask().id))?.answer).toBeUndefined();
  });

  it('自家机器人的评论、改过的评论、空评论、PR 上的评论：都不当回答', async () => {
    const { h } = setup({ asks: [ask()] });
    expect(await json(deliver(h, 'issue_comment', comment('做完了', {}, engineBot)))).toMatchObject({
      note: 'skip=bot',
    });
    expect(await json(deliver(h, 'issue_comment', { ...comment('5 分钟'), action: 'edited' }))).toMatchObject(
      {
        note: 'skip=edited',
      },
    );
    expect(await json(deliver(h, 'issue_comment', comment('   ')))).toMatchObject({
      note: 'ask=empty_comment',
    });
    const onPr = { ...comment('5 分钟'), issue: { number: 12, pull_request: { url: 'x' } } };
    expect(await json(deliver(h, 'issue_comment', onPr))).toMatchObject({ note: 'skip=pull_request' });
    expect((await h.store.getAsk(ask().id))?.answer).toBeUndefined();
    expect(h.signals).toEqual([]);
  });

  it('补收来的评论（synced）：从没改过的照样当回答；改过的（updated_at 不等于 created_at）不当，记 skip=edited 并告警', async () => {
    const synced = (over: Record<string, unknown>) => {
      const { sender: _sender, ...rest } = comment('5 分钟', over);
      return { ...rest, action: 'synced', issue: { number: 12 } };
    };
    const edited = setup({ asks: [ask()] });
    expect(
      await json(deliver(edited.h, 'issue_comment', synced({ created_at: at(-5), updated_at: at(-2) }))),
    ).toMatchObject({ note: 'skip=edited' });
    expect((await edited.h.store.getAsk(ask().id))?.answer).toBeUndefined();
    expect(edited.h.signals).toEqual([]);
    expect(edited.h.logs.some((l) => l.level === 'warn' && l.message.includes('改过'))).toBe(true);
    const audits = await edited.h.store.listAudit({ target: `task:${IDS.task12}`, limit: 10 });
    expect(audits.items.filter((a) => a.action === 'ask.answer')).toEqual([]);

    const pristine = setup({ asks: [ask()] });
    expect(await json(deliver(pristine.h, 'issue_comment', synced({})))).toMatchObject({
      note: 'ask=answered',
    });
    expect(await pristine.h.store.getAsk(ask().id)).toMatchObject({
      answer: '5 分钟',
      answeredBy: IDS.founderA,
    });
  });

  it('评论的时刻读不出（补收的建立或修改时刻、webhook 的建立时刻）：不当回答，告警', async () => {
    const polled = setup({ asks: [ask()] });
    const { sender: _sender, ...rest } = comment('5 分钟', { updated_at: 'garbage' });
    expect(
      await json(deliver(polled.h, 'issue_comment', { ...rest, action: 'synced', issue: { number: 12 } })),
    ).toMatchObject({ note: 'ask=comment_time_unreadable' });
    expect(polled.h.logs.some((l) => l.level === 'warn' && l.message.includes('读不出'))).toBe(true);

    const hooked = setup({ asks: [ask()] });
    expect(
      await json(deliver(hooked.h, 'issue_comment', comment('5 分钟', { created_at: 'yesterday' }))),
    ).toMatchObject({ note: 'ask=comment_time_unreadable' });
    expect(hooked.h.logs.some((l) => l.level === 'warn' && l.message.includes('什么时候写的'))).toBe(true);
    for (const s of [polled, hooked]) expect((await s.h.store.getAsk(ask().id))?.answer).toBeUndefined();
  });

  it('补收的评论认不出是哪张 issue、评论太长、事件没带动作：不当回答，记下原因（前两样告警）', async () => {
    const { h } = setup({ asks: [ask()] });
    const { issue: _issue, sender: _sender, ...orphan } = comment('5 分钟');
    expect(await json(deliver(h, 'issue_comment', { ...orphan, action: 'synced' }))).toMatchObject({
      note: 'skip=issue_unknown',
    });
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('认不出是哪张 issue'))).toBe(true);
    expect(await json(deliver(h, 'issue_comment', comment('长'.repeat(4001))))).toMatchObject({
      note: 'ask=comment_too_long',
    });
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('评论太长'))).toBe(true);
    const { action: _action, ...noAction } = comment('5 分钟');
    expect(await json(deliver(h, 'issue_comment', noAction))).toMatchObject({ note: 'skip=no_action' });
    expect((await h.store.getAsk(ask().id))?.answer).toBeUndefined();
  });

  it('回答写进库了、信号没发出去（Temporal 连不上）：记成出错；重放时只补发信号，不重写回答', async () => {
    let down = true;
    const sent: TaskSignal[] = [];
    const workflows: WorkflowControl = {
      async signal(_taskId, signal) {
        if (down) throw new WorkflowUnavailableError('Temporal 连不上');
        sent.push(signal);
      },
    };
    const { h } = setup({ asks: [ask()], workflows });
    expect((await deliver(h, 'issue_comment', comment('5 分钟'), { delivery: 'c1' })).status).toBe(500);
    expect(await h.store.getDelivery('c1')).toMatchObject({ status: 'failed' });
    expect((await h.store.getAsk(ask().id))?.answer).toBe('5 分钟');
    down = false;
    expect(await createGitHubIntake(h.deps).replay('c1')).toMatchObject({ note: 'ask=answered' });
    expect(sent).toEqual([{ name: 'answer', by: IDS.founderA, askId: ask().id, answer: '5 分钟' }]);
    const answers = (await h.store.listAudit({ target: `task:${IDS.task12}`, limit: 10 })).items.filter(
      (a) => a.action === 'ask.answer',
    );
    expect(answers).toHaveLength(1);
  });
});

describe('开关的判法', () => {
  const on = { autoDispatchSince: SWITCH_ON };
  it('关着不派；开关以前开的不派；排队中的派；已结束的只在重开时派；在跑的不再派；建立时刻认不出不派', () => {
    expect(dispatchDecision({ autoDispatchSince: null }, at(0), { state: 'queued' }, false)).toBe(
      'dispatch_off',
    );
    expect(dispatchDecision(on, at(-61), { state: 'queued' }, false)).toBe('opened_before_switch');
    expect(dispatchDecision(on, at(-60), { state: 'queued' }, false)).toBe('start');
    expect(dispatchDecision(on, at(0), { state: 'done' }, false)).toBe('finished');
    expect(dispatchDecision(on, at(0), { state: 'running' }, false)).toBe('in_progress');
    expect(dispatchDecision(on, 'yesterday', { state: 'queued' }, false)).toBe('created_at_unreadable');
  });

  it('重开：已结束的、还在排队的再拉起；正在做的等它结束；开关照样先看', () => {
    expect(dispatchDecision(on, at(0), { state: 'failed' }, true)).toBe('restart');
    expect(dispatchDecision(on, at(0), { state: 'stopped' }, true)).toBe('restart');
    expect(dispatchDecision(on, at(0), { state: 'queued' }, true)).toBe('restart');
    expect(dispatchDecision(on, at(0), { state: 'running' }, true)).toBe('wait_previous_run');
    expect(dispatchDecision(on, at(0), { state: 'triaging' }, true)).toBe('wait_previous_run');
    expect(dispatchDecision(on, at(-61), { state: 'failed' }, true)).toBe('opened_before_switch');
    expect(dispatchDecision({ autoDispatchSince: null }, at(0), { state: 'running' }, true)).toBe(
      'dispatch_off',
    );
  });
});

describe('读不到、认不出：明确失败或记下原因，并告警', () => {
  it('仓在门口放进来之后、接活之前被删了：投递记成出错，原因写明', async () => {
    const { h } = setup();
    h.store.findRepoByName = async () => null;
    const res = await deliver(h, 'issues', issuesEvent('opened'), { delivery: 'repo-gone' });
    expect(res.status).toBe(500);
    expect(await h.store.getDelivery('repo-gone')).toMatchObject({
      status: 'failed',
      reason: '仓 example/canary 不在库里（门口还当它是受管的）',
    });
    expect(h.store.data.tasks.filter((t) => t.issueNumber === 40)).toEqual([]);
  });

  it('关单时工作流已经不在、任务又不在排队（多半刚结束）：记 stop=workflow_gone 并告警', async () => {
    const workflows: WorkflowControl = {
      async signal(taskId) {
        throw new WorkflowGoneError(taskId);
      },
    };
    const { h } = setup({ workflows });
    await json(deliver(h, 'issues', issuesEvent('opened')));
    const t = h.store.data.tasks.find((x) => x.issueNumber === 40);
    if (!t) throw new Error('没建任务');
    t.state = 'running';
    const closed = issuesEvent('closed', issue({ state: 'closed', updated_at: at(-5) }));
    expect(await json(deliver(h, 'issues', closed))).toMatchObject({ note: 'stop=workflow_gone' });
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('工作流已经不在'))).toBe(true);
    expect(t.state).toBe('running');
  });
});
