// 点名派单（jobs/dispatch-issue.ts，#1337）：过准入的被派并留操作记录；每一道没过的都打印原因、退出码非 0、不起工作流；
// --force 只放行就绪度那几道，硬闸（作者白名单、母单子单、本机做、已有 PR、碰 workflows、已派过）怎么都不放行；
// 总开关关着拒绝；已派过的不重复派。故意造出失败的一条（force 也过不了白名单）放最后。

import { githubWhitelist } from '@fleet-dao/store';
import { WorkflowNotFoundError } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import {
  type DispatchGateReason,
  type DispatchIssueAudit,
  type DispatchIssueDeps,
  dispatchIssue,
  FORCEABLE,
  MAX_FAILED_ATTEMPTS,
  parseDispatchIssueArgs,
  runDispatchIssue,
} from '../src/jobs/dispatch-issue.ts';
import type { IntakeIssue, IntakePlan, IntakeRepo } from '../src/jobs/intake.ts';
import { failedGenerations } from '../src/real/dispatch-issue.ts';

const V1 = { number: 3, title: 'v1 三段一条龙' };
const V2 = { number: 4, title: 'v2 下一版' };
const REPO: IntakeRepo = {
  id: 'r1',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
  // 开关关着：点名派单本来就是给这种情况用的
  autoDispatchSince: null,
};

const body = (modules: string) =>
  [
    '## 场景',
    '',
    '创始人要在驾驶舱看到每张单走到哪一步。',
    '',
    '## 原话',
    '',
    '「我回来打开驾驶舱，这张单就该在做完的那一栏」',
    '',
    '## 已知的模块',
    '',
    modules,
    '',
    '## 怎么算做完',
    '',
    '1. 页面上能看到「验收中」这个状态',
    '',
  ].join('\n');
const BODY = body('- `packages/web/src/pages/`：驾驶舱页面');

const whitelist = githubWhitelist([
  { id: 'u1', displayName: '创始人', role: 'founder', active: true, githubId: 1, githubLogin: 'frank' },
]);

const issue = (over: Partial<IntakeIssue> = {}): IntakeIssue => ({
  number: 12,
  title: '给驾驶舱加状态',
  body: BODY,
  author: { login: 'frank', id: 1, type: 'User' },
  createdAt: '2026-10-01T00:00:00.000Z',
  labels: ['需求'],
  milestone: V1,
  ...over,
});

const plan = (over: Partial<IntakePlan> = {}): IntakePlan => ({
  state: 'open',
  pullRequest: false,
  milestone: V1,
  openMilestones: [V1, V2],
  labels: ['需求'],
  parent: null,
  subIssues: 0,
  ...over,
});

interface World {
  deps: DispatchIssueDeps;
  started: Parameters<DispatchIssueDeps['start']>[0][];
  audits: DispatchIssueAudit[];
}

interface Over {
  master?: boolean | 'unset';
  plan?: IntakePlan | (() => IntakePlan);
  issue?: IntakeIssue | null;
  repo?: IntakeRepo | null;
  dispatched?: boolean;
  claims?: Map<number, number>;
  failed?: number;
  startResult?: 'started' | 'already_exists';
  auditFails?: boolean;
}

function world(over: Over = {}): World {
  const started: World['started'] = [];
  const audits: DispatchIssueAudit[] = [];
  const master = over.master ?? true;
  const deps: DispatchIssueDeps = {
    findRepo: async () => (over.repo === undefined ? REPO : over.repo),
    engineMasterRow: async () =>
      master === 'unset' ? null : { value: master, updatedBy: 'u1', updatedAt: '2026-10-08T00:00:00.000Z' },
    whitelist: async () => whitelist,
    plan: async () => {
      const p = over.plan ?? plan();
      return typeof p === 'function' ? p() : p;
    },
    listIssue: async () => (over.issue === undefined ? issue() : over.issue),
    dispatched: async () => over.dispatched ?? false,
    openPrClaims: async () => over.claims ?? new Map(),
    readSpecDoc: async () => null,
    failedAttempts: async () => over.failed ?? 0,
    start: async (input) => {
      started.push(input);
      return over.startResult ?? 'started';
    },
    audit: async (entry) => {
      if (over.auditFails) throw new Error('库写不进');
      audits.push(entry);
    },
  };
  return { deps, started, audits };
}

const ARGS = { owner: 'acme', name: 'demo', issueNumber: 12, force: false } as const;
const FORCE = { ...ARGS, force: true, note: '创始人口头说先做这张' } as const;

async function cli(w: World, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDispatchIssue(argv, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    open: async () => ({ deps: w.deps, close: async () => {} }),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('过了准入：派，并写操作记录', () => {
  it('开关关着的仓里，合格的单被派出去，操作记录写明谁的哪张单、force 与否、结果', async () => {
    const w = world();
    const r = await dispatchIssue(w.deps, ARGS);
    expect(r.outcome).toBe('started');
    expect(w.started).toHaveLength(1);
    expect(w.started[0]).toMatchObject({ issueNumber: 12, title: '给驾驶舱加状态' });
    expect(w.audits).toEqual([
      {
        repo: 'acme/demo',
        issueNumber: 12,
        force: false,
        note: undefined,
        ok: true,
        result: '已派',
        forced: [],
      },
    ]);
  });

  it('命令行：派了退出码 0，打印已派', async () => {
    const w = world();
    const r = await cli(w, ['acme/demo', '12']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已派：acme/demo#12');
  });
});

describe('没过准入：打印是哪一道不过，非 0，不起工作流，也留记录', () => {
  it('命令行：退出码 1，原因写在输出里', async () => {
    const w = world({ dispatched: true });
    const r = await cli(w, ['acme/demo', '12']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already_dispatched');
    expect(w.started).toHaveLength(0);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ ok: false });
    expect(w.audits[0]?.result).toContain('already_dispatched');
  });

  it('库里没有这个仓：拒绝', async () => {
    const w = world({ repo: null });
    const r = await dispatchIssue(w.deps, ARGS);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'repo_not_found' }] });
  });

  it('读不到现状（GitHub 出错）：退出码 1、说没查成、记一条 ok=false，不当成过了', async () => {
    const w = world({
      plan: () => {
        throw new Error('GitHub 502');
      },
    });
    const r = await cli(w, ['acme/demo', '12']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('没查成');
    expect(r.err).toContain('GitHub 502');
    expect(w.started).toHaveLength(0);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ ok: false });
    expect(w.audits[0]?.result).toContain('没查成');
  });

  it('PR 号、已关的单拒绝', async () => {
    const pr = await dispatchIssue(world({ plan: plan({ pullRequest: true }) }).deps, ARGS);
    expect(pr).toMatchObject({ outcome: 'refused', failures: [{ reason: 'pull_request' }] });
    const closed = await dispatchIssue(world({ plan: plan({ state: 'closed' }) }).deps, ARGS);
    expect(closed).toMatchObject({ outcome: 'refused', failures: [{ reason: 'closed' }] });
  });
});

describe('引擎总开关', () => {
  it.each([false, 'unset'] as const)(
    '总开关%s：拒绝，说明总开关，force 也一样，不起工作流',
    async (master) => {
      const w = world({ master });
      const r = await cli(w, ['acme/demo', '12', '--force', '--note', '先做']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('engine_off');
      expect(r.err).toContain('总开关');
      expect(w.started).toHaveLength(0);
    },
  );
});

describe('已派过的不重复派', () => {
  it('库里已有任务行：拒绝', async () => {
    const w = world({ dispatched: true });
    expect(await dispatchIssue(w.deps, FORCE)).toMatchObject({
      outcome: 'refused',
      failures: [{ reason: 'already_dispatched', forceable: false }],
    });
    expect(w.started).toHaveLength(0);
  });

  it('工作流编号已经用过（起的时候撞上）：拒绝，不报成已派', async () => {
    const w = world({ startResult: 'already_exists' });
    const r = await dispatchIssue(w.deps, ARGS);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'already_dispatched' }] });
    expect(w.audits[0]).toMatchObject({ ok: false });
  });
});

describe('--force 放行就绪度类', () => {
  const cases: { reason: DispatchGateReason; over: Over }[] = [
    {
      reason: 'not_current_version',
      over: { plan: plan({ milestone: V2 }), issue: issue({ milestone: V2 }) },
    },
    { reason: 'unscheduled', over: { plan: plan({ milestone: null }), issue: issue({ milestone: null }) } },
    {
      reason: 'heaviest_tier',
      over: { issue: issue({ body: body('- `packages/web/src/` 和 `packages/api/src/`') }) },
    },
    { reason: 'failure_history', over: { failed: MAX_FAILED_ATTEMPTS + 1 } },
  ];

  it.each(cases)(
    '$reason：不加 --force 拒绝（说明可以 force），加了放行并把放行的闸记进操作记录',
    async ({ reason, over }) => {
      expect(FORCEABLE.has(reason)).toBe(true);
      const refused = world(over);
      const r1 = await cli(refused, ['acme/demo', '12']);
      expect(r1.code).toBe(1);
      expect(r1.err).toContain(reason);
      expect(r1.err).toContain('--force');
      expect(refused.started).toHaveLength(0);

      const forced = world(over);
      const r2 = await cli(forced, ['acme/demo', '12', '--force', '--note', '创始人口头说先做这张']);
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(reason);
      expect(forced.started).toHaveLength(1);
      expect(forced.audits).toHaveLength(1);
      expect(forced.audits[0]).toMatchObject({
        force: true,
        note: '创始人口头说先做这张',
        ok: true,
        forced: [reason],
      });
    },
  );

  it('失败恰好 2 次还没超限，不拦', async () => {
    const w = world({ failed: MAX_FAILED_ATTEMPTS });
    expect((await dispatchIssue(w.deps, ARGS)).outcome).toBe('started');
  });

  it('就绪度闸一次说全，不是一道一道挤牙膏', async () => {
    const w = world({
      plan: plan({ milestone: null }),
      issue: issue({ milestone: null, body: body('- `packages/web/src/` 和 `packages/api/src/`') }),
      failed: 3,
    });
    const r = await dispatchIssue(w.deps, ARGS);
    expect(r.outcome === 'refused' && r.failures.map((f) => f.reason)).toEqual([
      'unscheduled',
      'heaviest_tier',
      'failure_history',
    ]);
  });
});

describe('硬闸：--force 怎么都不放行', () => {
  const hard: { reason: DispatchGateReason; over: Over }[] = [
    {
      reason: 'untrusted_author',
      over: { issue: issue({ author: { login: 'stranger', id: 99, type: 'User' } }) },
    },
    { reason: 'mother_ticket', over: { plan: plan({ labels: ['母单'] }) } },
    { reason: 'mother_ticket', over: { plan: plan({ subIssues: 2 }) } },
    { reason: 'sub_issue', over: { plan: plan({ parent: 7 }) } },
    { reason: 'reserved_local', over: { plan: plan({ labels: ['本机做'] }) } },
    { reason: 'pr_claimed', over: { claims: new Map([[12, 40]]) } },
    {
      reason: 'touches_workflows',
      over: { issue: issue({ body: body('- `.github/workflows/ci.yml`：改流水线') }) },
    },
    { reason: 'already_dispatched', over: { dispatched: true } },
    {
      reason: 'brief_incomplete',
      over: { issue: issue({ body: '## 场景\n\n只写了场景' }) },
    },
    {
      reason: 'version_unreadable',
      over: {
        plan: plan({
          milestone: { number: 9, title: 'P1 旧写法' },
          openMilestones: [V1, { number: 9, title: 'P1 旧写法' }],
        }),
      },
    },
  ];

  it.each(hard)('$reason：带 --force --note 也拒绝，写明不放行，不起工作流', async ({ reason, over }) => {
    expect(FORCEABLE.has(reason)).toBe(false);
    const w = world(over);
    const r = await cli(w, ['acme/demo', '12', '--force', '--note', '我就是要派']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(reason);
    expect(r.err).toContain('force 也不放行');
    expect(w.started).toHaveLength(0);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ force: true, note: '我就是要派', ok: false });
  });

  it('硬闸遇到第一个就停：同时还有就绪度问题，只报硬闸', async () => {
    const w = world({
      issue: issue({ author: { login: 'stranger', id: 99, type: 'User' }, milestone: V2 }),
      plan: plan({ milestone: V2 }),
    });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'untrusted_author' }] });
  });
});

describe('参数', () => {
  it('认得出的写法', () => {
    expect(parseDispatchIssueArgs(['acme/demo', '12'])).toEqual({
      owner: 'acme',
      name: 'demo',
      issueNumber: 12,
      force: false,
    });
    expect(parseDispatchIssueArgs(['acme/demo', '12', '--force', '--note', '先做'])).toMatchObject({
      force: true,
      note: '先做',
    });
  });

  it.each([
    [['acme/demo', '12', '--force'], '--force 必须带 --note'],
    [['acme/demo', '12', '--force', '--note', '  '], '--force 必须带 --note'],
    [['acme/demo', '12', '--note', '理由'], '--note 只配 --force'],
    [['acme/demo'], '要两个参数'],
    [['demo', '12'], '要写成 owner/仓名'],
    [['acme/demo', 'abc'], '不是正整数'],
    [['acme/demo', '0'], '不是正整数'],
    [['acme/demo', '12', '--yolo'], '认不出参数'],
  ])('%j：退出码 2，不连任何东西', async (argv, hint) => {
    let opened = 0;
    const err: string[] = [];
    const code = await runDispatchIssue(argv, {
      out: () => {},
      err: (t) => err.push(t),
      open: async () => {
        opened += 1;
        throw new Error('不该连');
      },
    });
    expect(code).toBe(2);
    expect(opened).toBe(0);
    expect(err.join('\n')).toContain(hint);
  });

  it('--help 只打印用法，退出码 0', async () => {
    const out: string[] = [];
    const code = await runDispatchIssue(['--help'], {
      out: (t) => out.push(t),
      err: () => {},
      open: async () => {
        throw new Error('不该连');
      },
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('dispatch-issue');
  });
});

describe('操作记录写不进', () => {
  it('派出去之后记录写不进：明说已经派了，退出码 1', async () => {
    const w = world({ auditFails: true });
    const r = await cli(w, ['acme/demo', '12']);
    expect(w.started).toHaveLength(1);
    expect(r.code).toBe(1);
    expect(r.err).toContain('已经派出去了');
  });
});

describe('failedGenerations：顺着代数问 Temporal 数失败了几条', () => {
  const clientWith = (statuses: Record<string, string | Error>) => ({
    workflow: {
      getHandle: (id: string) => ({
        describe: async () => {
          const s = statuses[id];
          if (s === undefined) throw new WorkflowNotFoundError('not found', id, undefined);
          if (s instanceof Error) throw s;
          return { status: { name: s } };
        },
      }),
    },
  });
  const repo = { owner: 'acme', name: 'demo' };

  it('第一个不存在就停；失败、终止、超时各算一次，做成的不算', async () => {
    const c = clientWith({
      'task:acme/demo#12': 'FAILED',
      'task:acme/demo#12:r2': 'TERMINATED',
      'task:acme/demo#12:r3': 'COMPLETED',
    });
    expect(await failedGenerations(c as never, repo, 12)).toBe(2);
  });

  it('一代都没有是 0', async () => {
    expect(await failedGenerations(clientWith({}) as never, repo, 12)).toBe(0);
  });

  it('问不清（连不上、状态认不出）抛错，不当成 0', async () => {
    await expect(
      failedGenerations(clientWith({ 'task:acme/demo#12': new Error('UNAVAILABLE') }) as never, repo, 12),
    ).rejects.toThrow('UNAVAILABLE');
    await expect(
      failedGenerations(clientWith({ 'task:acme/demo#12': 'WEIRD' }) as never, repo, 12),
    ).rejects.toThrow('认不出');
  });
});

describe('故意造出失败：force 也过不了作者白名单（放最后）', () => {
  it('陌生人开的单，带 force 和理由也派不出去', async () => {
    const w = world({ issue: issue({ author: { login: 'stranger', id: 99, type: 'User' } }) });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r.outcome).toBe('refused');
    expect(w.started).toHaveLength(0);
  });
});
