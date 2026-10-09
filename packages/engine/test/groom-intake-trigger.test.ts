// 拉单一轮的结尾叫不叫临时指挥官整理待办（#1338）：触发条件（有从没整理过的老单；或有空位、一条都没起、待办里还有候选）、
// 间隔 / 次数 / 锁 / 总开关由 requestGroom 判（这里用真的 requestGroom + 假记录）。
import { GROOM_ACTION, GROOM_TARGET, type GroomAuditRow } from '@fleet-dao/shared';
import { githubWhitelist } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { autoGroomWhy, type GroomRequestDeps, requestGroom } from '../src/jobs/groom-request.ts';
import { type IntakeDeps, type IntakeIssue, type IntakeRepo, runIntakeJob } from '../src/jobs/intake.ts';

const NOW = new Date('2026-10-08T14:00:00.000Z');
const SINCE = '2026-10-01T00:00:00.000Z';
const OLD = '2026-09-20T00:00:00.000Z';
const NEW = '2026-10-05T00:00:00.000Z';
const REPO: IntakeRepo = {
  id: 'r1',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
  autoDispatchSince: SINCE,
};
const GOOD_BODY = [
  '## 场景',
  '',
  '要在驾驶舱看到状态。',
  '',
  '## 原话',
  '',
  '「看到状态」',
  '',
  '## 已知的模块',
  '',
  '- `packages/web/src/pages/`：页面',
  '',
  '## 怎么算做完',
  '',
  '1. 页面上能看到「验收中」',
  '',
].join('\n');
const issue = (over: Partial<IntakeIssue> = {}): IntakeIssue => ({
  number: 12,
  title: '给驾驶舱加状态',
  body: GOOD_BODY,
  author: { login: 'frank', id: 1, type: 'User' },
  createdAt: NEW,
  labels: ['需求'],
  milestone: null,
  ...over,
});
const whitelist = githubWhitelist([
  { id: 'u1', displayName: '创始人', role: 'founder', active: true, githubId: 1, githubLogin: 'frank' },
]);

function intakeHarness(issues: IntakeIssue[], over: Partial<IntakeDeps> = {}) {
  const called: { repo: string; why: string }[] = [];
  const started: number[] = [];
  const deps: IntakeDeps = {
    repos: async () => [REPO],
    whitelist: async () => whitelist,
    openIssues: async () => ({ issues, openMilestones: [] }),
    plan: async () => ({
      state: 'open',
      pullRequest: false,
      milestone: null,
      openMilestones: [],
      labels: ['需求'],
      parent: null,
      subIssues: 0,
    }),
    issueTask: async () => null,
    taskGenerations: async () => ({ ok: true, lives: [] }),
    openPrClaims: async () => new Map(),
    markLocal: async () => undefined,
    readSpecDoc: async () => null,
    runningTasks: async () => 0,
    failures: async () => 0,
    startedSince: async () => 0,
    breaker: async () => ({ open: null, recent: [] }),
    breakerChanged: async () => undefined,
    start: async ({ issueNumber }) => {
      started.push(issueNumber);
      return 'started';
    },
    comment: async () => ({ created: true }),
    groomRequest: async ({ repo, why }) => {
      called.push({ repo: `${repo.owner}/${repo.name}`, why });
      return { ok: true, requestId: 'req-1', used: 0, remainingAfter: 2 };
    },
    runs: { start: async () => 1, finish: async () => undefined },
    gateLive: true,
    now: () => NOW,
    log: () => undefined,
    ...over,
  };
  return { deps, called, started };
}

describe('autoGroomWhy · 触发条件（纯函数）', () => {
  const base = { spare: true, started: 0, backlog: 1, ungroomedOld: 0 };
  it('有空位、一条都没起、待办里还有候选 → idle', () => {
    expect(autoGroomWhy(base)).toBe('idle');
  });
  it('没有空位（任务满了 / 限速 / 熔断）→ 不叫', () => {
    expect(autoGroomWhy({ ...base, spare: false })).toBeNull();
  });
  it('这一轮起了任务（有可挑的单）→ 不叫', () => {
    expect(autoGroomWhy({ ...base, started: 1 })).toBeNull();
  });
  it('待办里没有候选可整理 → 不叫', () => {
    expect(autoGroomWhy({ ...base, backlog: 0 })).toBeNull();
  });
  it('有从没整理过的老单 → 叫，不管空不空闲、起没起任务', () => {
    expect(autoGroomWhy({ spare: false, started: 3, backlog: 0, ungroomedOld: 2 })).toBe('ungroomed_old');
  });
});

describe('拉单一轮的结尾叫整理待办', () => {
  it('有空位、挑不出可做的单（只有一张缺东西的单）、待办还有 → 叫一次，写明原因', async () => {
    const h = intakeHarness([issue({ body: '随便写写' })]);
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.called).toHaveLength(1);
    expect(h.called[0]?.repo).toBe('acme/demo');
    expect(h.called[0]?.why).toContain('空位');
    expect(run.outcome).toBe('ok');
  });

  it('这一轮能起任务 → 不因为空闲叫', async () => {
    const h = intakeHarness([issue()]);
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([12]);
    expect(h.called).toEqual([]);
  });

  it('有从没整理过的老单 → 叫，哪怕同时起了别的单', async () => {
    const h = intakeHarness([issue({ number: 1 }), issue({ number: 2, createdAt: OLD })]);
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([1]);
    expect(h.called).toHaveLength(1);
    expect(h.called[0]?.why).toContain('老单');
  });

  it('老单已经贴了「整理过」→ 不因为它叫', async () => {
    const h = intakeHarness([issue({ createdAt: OLD, labels: ['需求', '整理过'] })]);
    await runIntakeJob(h.deps);
    expect(h.called).toEqual([]);
  });

  it('开关关着的仓（autoDispatchSince 空）→ 不叫', async () => {
    const h = intakeHarness([issue({ createdAt: OLD })], {
      repos: async () => [{ ...REPO, autoDispatchSince: null }],
    });
    await runIntakeJob(h.deps);
    expect(h.called).toEqual([]);
  });

  it('被拒（间隔没到、次数用完、别的在做）是正常的：这一轮照样记 ok', async () => {
    const h = intakeHarness([issue({ createdAt: OLD })], {
      groomRequest: async () => ({ ok: false, reason: 'too_soon', why: '不到 6 小时' }),
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('ok');
  });

  it('【故意造出的失败】叫的时候读不到操作记录 → 这一轮记没查成（partial），不当成叫过', async () => {
    const h = intakeHarness([issue({ createdAt: OLD })], {
      groomRequest: async () => {
        throw new Error('库连不上');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('库连不上');
  });
});

// —— requestGroom：同一个入口的拒绝 ——

const row = (
  action: string,
  after: unknown,
  at: Date,
  ok = true,
  error: string | null = null,
): GroomAuditRow => ({
  at,
  action,
  actorId: 'x',
  after,
  ok,
  error,
});
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function requestDeps(
  rows: GroomAuditRow[],
  master: { on: true } | { on: false; why: string } = { on: true },
) {
  const recorded: { requestId: string; repo: string; source: string }[] = [];
  const deps: GroomRequestDeps = {
    rows: async () => rows,
    engineMaster: async () => master,
    record: async (i) => {
      recorded.push({ requestId: i.requestId, repo: i.repo, source: i.source });
    },
    now: () => NOW,
    newId: () => 'new-id',
  };
  return { deps, recorded };
}
const request = (id: string, at: Date, repo = 'acme/demo') =>
  row(GROOM_ACTION.request, { requestId: id, repo, source: 'cli' }, at);
const start = (id: string, at: Date, repo = 'acme/demo') =>
  row(GROOM_ACTION.start, { requestId: id, repo }, at);
const done = (id: string, at: Date) => row(GROOM_ACTION.done, { requestId: id }, at, false, '会话没跑成');

describe('requestGroom · 三路共用的入口', () => {
  it('什么都没做过 → 排上队，记一条点了，说明今天还剩几次', async () => {
    const { deps, recorded } = requestDeps([]);
    const got = await requestGroom(deps, { repo: 'acme/demo', source: 'cli', reason: 'x' });
    expect(got).toEqual({ ok: true, requestId: 'new-id', used: 0, remainingAfter: 2 });
    expect(recorded).toEqual([{ requestId: 'new-id', repo: 'acme/demo', source: 'cli' }]);
    expect(GROOM_TARGET).toBe('groom');
  });

  it('引擎总开关关着 → 拒，说明总开关，不记', async () => {
    const { deps, recorded } = requestDeps([], { on: false, why: '关着' });
    const got = await requestGroom(deps, { repo: 'acme/demo', source: 'cli', reason: 'x' });
    expect(got).toMatchObject({ ok: false, reason: 'engine_off' });
    expect(recorded).toEqual([]);
  });

  it('已经有一次在做（锁被占）→ 拒；排队中的也算占着', async () => {
    const running = requestDeps([request('a', ago(20)), start('a', ago(19))]);
    expect(
      await requestGroom(running.deps, { repo: 'other/repo', source: 'cli', reason: 'x' }),
    ).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    const queued = requestDeps([request('a', ago(2))]);
    expect(await requestGroom(queued.deps, { repo: 'acme/demo', source: 'cli', reason: 'x' })).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    expect(running.recorded).toEqual([]);
  });

  it('滚动 24 小时里已经接手 3 次 → 第 4 次拒；最早那次滚出 24 小时又行', async () => {
    const used = (offsets: number[]) =>
      offsets.flatMap((m, i) => [
        request(`r${i}`, ago(m + 1)),
        start(`r${i}`, ago(m)),
        done(`r${i}`, ago(m - 0.5)),
      ]);
    const full = requestDeps(used([600, 400, 200]));
    expect(await requestGroom(full.deps, { repo: 'acme/demo', source: 'cli', reason: 'x' })).toMatchObject({
      ok: false,
      reason: 'daily_cap',
    });
    const rolled = requestDeps(used([1500, 400, 200]));
    expect(await requestGroom(rolled.deps, { repo: 'acme/demo', source: 'cli', reason: 'x' })).toMatchObject({
      ok: true,
    });
  });

  it('次数按仓数：别的仓用满了不影响这个仓', async () => {
    const rows = [0, 1, 2].flatMap((i) => [
      request(`o${i}`, ago(300 + i * 10), 'other/repo'),
      start(`o${i}`, ago(299 + i * 10), 'other/repo'),
      done(`o${i}`, ago(298 + i * 10)),
    ]);
    const { deps } = requestDeps(rows);
    expect(await requestGroom(deps, { repo: 'acme/demo', source: 'auto', reason: 'x' })).toMatchObject({
      ok: true,
    });
  });

  it('自动叫：距这个仓上次接手不到 6 小时 → 拒；命令行叫不受这条管', async () => {
    const rows = [request('a', ago(200)), start('a', ago(199)), done('a', ago(150))];
    const auto = await requestGroom(requestDeps(rows).deps, {
      repo: 'acme/demo',
      source: 'auto',
      reason: 'x',
    });
    expect(auto).toMatchObject({ ok: false, reason: 'too_soon' });
    const cli = await requestGroom(requestDeps(rows).deps, { repo: 'acme/demo', source: 'cli', reason: 'x' });
    expect(cli).toMatchObject({ ok: true });
  });

  it('排了很久没人接手的点击作废，不占锁', async () => {
    const { deps } = requestDeps([request('a', ago(40))]);
    expect(await requestGroom(deps, { repo: 'acme/demo', source: 'cli', reason: 'x' })).toMatchObject({
      ok: true,
    });
  });

  it('【故意造出的失败】读不到操作记录 → 抛出，不当成「没人叫过」', async () => {
    const { deps } = requestDeps([]);
    deps.rows = async () => {
      throw new Error('库连不上');
    };
    await expect(requestGroom(deps, { repo: 'acme/demo', source: 'cli', reason: 'x' })).rejects.toThrow(
      '库连不上',
    );
  });
});
