// 点名派单（jobs/dispatch-issue.ts，#1337）：过准入的被派并留操作记录；每一道没过的都打印原因、退出码非 0、不起工作流；
// --force 只放行就绪度那几道，硬闸（作者白名单、母单子单、本机做、已有 PR、碰 workflows、碰改标准的路径、已派过、工作流没查成）怎么都不放行；
// 总开关关着拒绝；已派过的不重复派。没有工作流的排队或已叫停老行接手再派。故意造出失败的一条（查 Temporal 失败按不确定拒绝）放最后。

import type { TaskState } from '@fleet-dao/shared';
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
import type { TaskGenerationFacts } from '../src/jobs/dispatch-standing.ts';
import type { IntakeIssue, IntakePlan, IntakeRepo } from '../src/jobs/intake.ts';
import { dispatchIssueDeps, failedGenerations } from '../src/real/dispatch-issue.ts';

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
  /** 旧测试的简写：有一条在跑的任务工作流。 */
  dispatched?: boolean;
  taskRow?: { id: string; state: TaskState } | null;
  generations?: TaskGenerationFacts;
  /** 问 Temporal 时抛这个。测「不确定」，不当成没有工作流。 */
  generationsError?: Error;
  claims?: Map<number, number>;
  failed?: number;
  startResult?: 'started' | 'already_exists';
  auditFails?: boolean;
  /** 读改标准的路径清单时抛这个。 */
  standardPathsError?: Error;
  /** 前置单此刻开没开着（批量读回的结果；没写的号回来就缺）。 */
  prereqStates?: Record<number, 'open' | 'closed'>;
  /** 批量读前置单时抛这个。 */
  prereqError?: Error;
  /** 此刻；默认 NOW。 */
  now?: Date;
}

/** 北京时间 2026-10-19 12:00。 */
const NOW = new Date('2026-10-19T04:00:00Z');

function world(over: Over = {}): World & { prereqReads: number[][] } {
  const started: World['started'] = [];
  const audits: DispatchIssueAudit[] = [];
  const prereqReads: number[][] = [];
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
    issueTask: async () => {
      if (over.taskRow !== undefined) return over.taskRow;
      if (over.dispatched) return { id: 't-old', state: 'running' };
      return null;
    },
    taskGenerations: async () => {
      if (over.generationsError) throw over.generationsError;
      if (over.generations) return over.generations;
      if (over.dispatched) return { ok: true, lives: ['running'] };
      return { ok: true, lives: [] };
    },
    openPrClaims: async () => over.claims ?? new Map(),
    prerequisiteStates: async (_repo, numbers) => {
      prereqReads.push([...numbers]);
      if (over.prereqError) throw over.prereqError;
      const out = new Map<number, 'open' | 'closed'>();
      for (const n of numbers) {
        const s = over.prereqStates?.[n];
        if (s !== undefined) out.set(n, s);
      }
      return out;
    },
    now: () => over.now ?? NOW,
    ...(over.standardPathsError
      ? {
          standardPaths: async () => {
            throw over.standardPathsError;
          },
        }
      : {}),
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
  return { deps, started, audits, prereqReads };
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
  it('作者 github-actions[bot] 过作者门；random-user 不过', async () => {
    const bot = world({
      issue: issue({ author: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' } }),
    });
    expect((await dispatchIssue(bot.deps, ARGS)).outcome).toBe('started');

    const stranger = world({ issue: issue({ author: { login: 'random-user', id: 4242, type: 'User' } }) });
    const refused = await dispatchIssue(stranger.deps, ARGS);
    expect(refused).toMatchObject({ outcome: 'refused', failures: [{ reason: 'untrusted_author' }] });
    expect(stranger.started).toEqual([]);
  });

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
    expect(r.err).toContain('fleet-api task redo');
    expect(r.err).toContain('驾驶舱');
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
    if (r.outcome !== 'refused') throw new Error('上面已经断言是拒绝');
    expect(r.failures[0]?.why).toContain('fleet-api task redo');
    expect(r.failures[0]?.why).toContain('驾驶舱');
    expect(w.audits[0]).toMatchObject({ ok: false });
  });
});

describe('--force 放行就绪度类', () => {
  const cases: { reason: DispatchGateReason; over: Over }[] = [
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

  it('挂不挂当前版本不是闸（决定 0031；#2683 删了版本这一道）：别的版本、未排期、认不出版本号的都照派', async () => {
    for (const milestone of [V2, null, { number: 9, title: 'P1 旧写法' }]) {
      const w = world({
        plan: plan({ milestone, openMilestones: [V1, V2, { number: 9, title: 'P1 旧写法' }] }),
        issue: issue({ milestone }),
      });
      expect((await dispatchIssue(w.deps, ARGS)).outcome, JSON.stringify(milestone)).toBe('started');
    }
  });

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
    {
      reason: 'touches_standard',
      over: { issue: issue({ body: body('- `agents/shared-rules.md`：通用段') }) },
    },
    { reason: 'already_dispatched', over: { dispatched: true } },
    {
      reason: 'brief_incomplete',
      over: { issue: issue({ body: '## 场景\n\n只写了场景' }) },
    },
    {
      reason: 'waiting_prerequisite',
      over: { issue: issue({ body: `前置：#5\n\n${BODY}` }), prereqStates: { 5: 'open' } },
    },
    {
      reason: 'prerequisite_unknown',
      over: { issue: issue({ body: `前置：#5\n\n${BODY}` }), prereqError: new Error('GraphQL 502') },
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
      issue: issue({ author: { login: 'stranger', id: 99, type: 'User' } }),
      failed: MAX_FAILED_ATTEMPTS + 1,
    });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'untrusted_author' }] });
  });
});

describe('前置没等完：和拉单同一份判法，force 也不放行（#3298）', () => {
  /** 场景段开头加一行 */
  const withPre = (line: string) => issue({ body: BODY.replace('## 场景\n\n', `## 场景\n\n${line}\n\n`) });

  it('前置单还开着：开单顺手戳的那条命令（不带 force）不派，原因写等前置、提示 force 也不放行，操作记录写明', async () => {
    const w = world({ issue: withPre('前置：#3249'), prereqStates: { 3249: 'open' } });
    // pnpm issue:new 戳法国跑的就是 `fleet-api dispatch-issue <owner/仓> <单号>`，不带别的参数
    const r = await cli(w, ['acme/demo', '12']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('waiting_prerequisite');
    expect(r.err).toContain('等前置 #3249');
    expect(r.err).toContain('force 也不放行');
    expect(w.started).toHaveLength(0);
    expect(w.prereqReads).toEqual([[3249]]);
    expect(w.audits).toEqual([
      {
        repo: 'acme/demo',
        issueNumber: 12,
        force: false,
        note: undefined,
        ok: false,
        result: expect.stringContaining('waiting_prerequisite（等前置 #3249'),
        forced: [],
      },
    ]);
  });

  it('前置单还开着：带 --force --note 也不派，前置不在 FORCEABLE 里', async () => {
    expect(FORCEABLE.has('waiting_prerequisite')).toBe(false);
    expect(FORCEABLE.has('prerequisite_unknown')).toBe(false);
    expect([...FORCEABLE]).toEqual(['heaviest_tier', 'failure_history']);
    const w = world({ issue: withPre('前置：#3249'), prereqStates: { 3249: 'open' }, failed: 3 });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r).toMatchObject({
      outcome: 'refused',
      failures: [{ reason: 'waiting_prerequisite', forceable: false }],
    });
    expect(w.started).toHaveLength(0);
    expect(w.audits[0]).toMatchObject({ force: true, note: FORCE.note, ok: false, forced: [] });
    expect(w.audits[0]?.result).toContain('waiting_prerequisite');
  });

  it('几个前置只有一部分开着：只写开着的那个', async () => {
    const w = world({ issue: withPre('前置：#5、#6'), prereqStates: { 5: 'closed', 6: 'open' } });
    const r = await dispatchIssue(w.deps, ARGS);
    expect(r.outcome === 'refused' && r.failures[0]?.why).toContain('等前置 #6');
    expect(r.outcome === 'refused' && r.failures[0]?.why).not.toContain('#5');
    expect(w.started).toHaveLength(0);
  });

  it('日期前置北京时间没到：不派、不读前置单；那天 0 点（北京时间）起照派', async () => {
    const early = world({ issue: withPre('前置：2026-10-20 复查日') });
    const r = await dispatchIssue(early.deps, FORCE);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'waiting_prerequisite' }] });
    expect(r.outcome === 'refused' && r.failures[0]?.why).toContain('等到 2026-10-20');
    expect(early.started).toHaveLength(0);
    expect(early.prereqReads).toEqual([]);
    expect(early.audits[0]?.result).toContain('等到 2026-10-20');

    // UTC 10-19 15:59:59 是北京时间 10-19 23:59:59，还没到
    const almost = world({ issue: withPre('前置：2026-10-20'), now: new Date('2026-10-19T15:59:59Z') });
    expect((await dispatchIssue(almost.deps, ARGS)).outcome).toBe('refused');
    const due = world({ issue: withPre('前置：2026-10-20'), now: new Date('2026-10-19T16:00:00Z') });
    expect((await dispatchIssue(due.deps, ARGS)).outcome).toBe('started');
    expect(due.started).toHaveLength(1);
  });

  it('【故意造出的失败】前置单状态读不到：不派，原因是没查成（prerequisite_unknown），不当成已关；force 也一样', async () => {
    const w = world({ issue: withPre('前置：#3249'), prereqError: new Error('GraphQL 502') });
    const r = await cli(w, ['acme/demo', '12', '--force', '--note', '我就是要派']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('prerequisite_unknown');
    expect(r.err).toContain('没查成');
    expect(r.err).toContain('GraphQL 502');
    expect(r.err).not.toContain('waiting_prerequisite');
    expect(r.err).toContain('force 也不放行');
    expect(w.started).toHaveLength(0);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ force: true, ok: false, forced: [] });
    expect(w.audits[0]?.result).toContain('prerequisite_unknown');
    expect(w.audits[0]?.result).toContain('GraphQL 502');
  });

  it('【故意造出的失败】批量读回来缺了前置单的号：同样算没查成，不派', async () => {
    const w = world({ issue: withPre('前置：#5、#6'), prereqStates: { 5: 'closed' } });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'prerequisite_unknown' }] });
    expect(r.outcome === 'refused' && r.failures[0]?.why).toContain('#6 没读到状态');
    expect(w.started).toHaveLength(0);
    expect(w.audits[0]?.result).toContain('prerequisite_unknown');
  });

  it('前置都关了：照派，只读一次、只问这几个号', async () => {
    const w = world({ issue: withPre('前置：#5、#6'), prereqStates: { 5: 'closed', 6: 'closed' } });
    const r = await dispatchIssue(w.deps, ARGS);
    expect(r.outcome).toBe('started');
    expect(w.started).toHaveLength(1);
    expect(w.prereqReads).toEqual([[5, 6]]);
    expect(w.audits[0]).toMatchObject({ ok: true, result: '已派' });
  });

  it('没写前置：照派，不读前置单', async () => {
    const w = world();
    expect((await dispatchIssue(w.deps, ARGS)).outcome).toBe('started');
    expect(w.prereqReads).toEqual([]);
  });

  it('代码块、引用、列表里的「前置：」和正文里顺口提的 #N 都是举例，不算前置：照派，不读前置单', async () => {
    const w = world({
      issue: withPre('顺带看 #5。\n\n```\n前置：#7\n```\n\n> 前置：#8\n\n- 前置：#9'),
      prereqStates: { 5: 'open', 7: 'open', 8: 'open', 9: 'open' },
    });
    expect((await dispatchIssue(w.deps, ARGS)).outcome).toBe('started');
    expect(w.prereqReads).toEqual([]);
  });

  it('前置排在碰 workflows 这些硬闸前面、在已派过之后：已派过的仍报已派过', async () => {
    const dispatched = world({ issue: withPre('前置：#5'), prereqStates: { 5: 'open' }, dispatched: true });
    const r = await dispatchIssue(dispatched.deps, ARGS);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'already_dispatched' }] });
    expect(dispatched.prereqReads).toEqual([]);
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

describe('没有任务工作流的老行：不算已派出，接手再派', () => {
  it.each(['queued', 'stopped'] as const)('%s：照常派，操作记录写明接手，force 用不上', async (state) => {
    const w = world({
      taskRow: { id: 'old-row', state },
      generations: { ok: true, lives: [] },
    });
    const r = await dispatchIssue(w.deps, ARGS);
    expect(r).toMatchObject({ outcome: 'started', adopted: true });
    expect(w.started).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ ok: true });
    expect(w.audits[0]?.result).toContain('接手无工作流的老任务行');
  });

  it('有一代在跑：仍拒绝，指向 redo，force 也不放行', async () => {
    const w = world({
      taskRow: { id: 'old-row', state: 'queued' },
      generations: { ok: true, lives: ['running'] },
    });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r).toMatchObject({
      outcome: 'refused',
      failures: [{ reason: 'already_dispatched', forceable: false }],
    });
    if (r.outcome !== 'refused') throw new Error('上面已经断言是拒绝');
    expect(r.failures[0]?.why).toContain('fleet-api task redo');
    expect(w.started).toHaveLength(0);
  });

  it('已做完的一代：仍拒绝，指向 redo', async () => {
    const w = world({
      taskRow: { id: 'old-row', state: 'done' },
      generations: { ok: true, lives: ['terminated'] },
    });
    const r = await dispatchIssue(w.deps, ARGS);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'already_dispatched' }] });
    if (r.outcome !== 'refused') throw new Error('上面已经断言是拒绝');
    expect(r.failures[0]?.why).toContain('fleet-api task redo');
    expect(w.started).toHaveLength(0);
  });

  it('老行没有工作流，也不放宽别的硬闸（作者不在白名单仍拒）', async () => {
    const w = world({
      taskRow: { id: 'old-row', state: 'stopped' },
      generations: { ok: true, lives: [] },
      issue: issue({ author: { login: 'stranger', id: 99, type: 'User' } }),
    });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r).toMatchObject({ outcome: 'refused', failures: [{ reason: 'untrusted_author' }] });
    expect(w.started).toHaveLength(0);
  });

  it('排队或叫停以外的状态、又没有工作流：仍当已派出，不接手', async () => {
    const w = world({
      taskRow: { id: 'old-row', state: 'failed' },
      generations: { ok: true, lives: [] },
    });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r).toMatchObject({
      outcome: 'refused',
      failures: [{ reason: 'already_dispatched', forceable: false }],
    });
    expect(w.started).toHaveLength(0);
  });
});

describe('故意造出失败：force 也过不了作者白名单', () => {
  it('陌生人开的单，带 force 和理由也派不出去', async () => {
    const w = world({ issue: issue({ author: { login: 'stranger', id: 99, type: 'User' } }) });
    const r = await dispatchIssue(w.deps, FORCE);
    expect(r.outcome).toBe('refused');
    expect(w.started).toHaveLength(0);
  });
});

describe('故意造出失败：改标准的清单读不到', () => {
  it('不派、不当成没碰标准路径', async () => {
    const w = world({ standardPathsError: new Error('清单认不出') });
    await expect(dispatchIssue(w.deps, ARGS)).rejects.toThrow('清单认不出');
    expect(w.started).toHaveLength(0);
  });
});

describe('故意造出失败：查 Temporal 失败按不确定拒绝（放最后）', () => {
  it('问工作流抛错：拒绝并说明不确定，不当成没有工作流，force 也不派', async () => {
    const w = world({
      taskRow: { id: 'old-row', state: 'queued' },
      generationsError: new Error('UNAVAILABLE'),
    });
    const r = await cli(w, ['acme/demo', '12', '--force', '--note', '我就是要派']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('workflow_unknown');
    expect(r.err).toContain('不确定');
    expect(r.err).toContain('没有当成没有工作流');
    expect(r.err).toContain('UNAVAILABLE');
    expect(r.err).toContain('force 也不放行');
    expect(w.started).toHaveLength(0);
    expect(w.audits[0]).toMatchObject({ ok: false });
  });
});

describe('真装配：点名派单接的是拉单的前置单批量读和同一个时间来源（#3298）', () => {
  it('prerequisiteStates 走 gh.readIssueStates（只问给的号），now 用装配给的时钟', async () => {
    const asked: { repo: { owner: string; name: string }; numbers: readonly number[] }[] = [];
    const gh = {
      readIssueStates: async (input: { repo: { owner: string; name: string }; numbers: readonly number[] }) => {
        asked.push(input);
        return new Map(input.numbers.map((n) => [n, 'open'] as const));
      },
    };
    const clock = new Date('2026-10-19T15:59:59Z');
    const deps = dispatchIssueDeps({
      db: {} as never,
      gh: gh as never,
      client: {} as never,
      taskQueue: 'q',
      operator: 'ops',
      now: () => clock,
    });
    expect(await deps.prerequisiteStates(REPO, [3249])).toEqual(new Map([[3249, 'open']]));
    expect(asked).toEqual([{ repo: { owner: 'acme', name: 'demo' }, numbers: [3249] }]);
    expect(deps.now()).toBe(clock);
  });
});
