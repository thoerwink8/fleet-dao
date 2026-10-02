// fleet-api handover：人明说把一张自动派管不到的单（开关打开以前开的、别的版本的、未排期的）交给引擎，起 Fusion 工作流。
// 能交的起了工作流、记一条操作记录 task.handover（谁跑的、谁说的为什么）并读回打印；开关关着、停派、库里没任务行、读不到 GitHub、
// GitHub 上关着、结束了又没重开的一律拒（退出码 1，什么都不派）；在跑的不重复起（退出码 0）。没做成的每条路都故意造一遍。
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditLog } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { FUSION_WORKFLOW_TYPE, type RequirementStartInput, requirementWorkflowId } from '@fleet-dao/shared';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaimStatus } from '../src/claim-status.ts';
import { type CliDeps, CliError, main, parseHandoverArgs, TASK_HANDOVER } from '../src/cli.ts';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import { silentLogger } from '../src/log.ts';
import type { MemoryData } from '../src/memory-store.ts';
import { createMemoryStore } from '../src/memory-store.ts';
import { createPgStore } from '../src/pg-store.ts';
import type { IssuePlan, Store } from '../src/ports.ts';
import { createTemporalRequirementWorkflows, type WorkflowStarterLike } from '../src/temporal.ts';
import { runChild } from './child.ts';
import { fakeClaimsGitHub } from './fake-claims-github.ts';
import { issuePlan, V2 } from './harness.ts';
import { seedPg } from './pg-fixtures.ts';

const T0 = new Date('2026-09-26T07:00:00.000Z');
const SWITCH_ON = new Date(T0.getTime() - 60 * 60_000).toISOString();
const CANARY = { owner: 'example', name: 'canary' };
const REASON = '创始人 09-27 说：开关打开以前开的 v1 单交给 fleet';

/** 假 Temporal 客户端：按编号去重（和真的一样），连不上时照真客户端的样子抛；记下起了哪种、哪个编号、带的输入。 */
function fakeTemporal() {
  const started: { type: string; workflowId: string; input: RequirementStartInput }[] = [];
  const running = new Set<string>();
  const state = { down: false, opened: 0, closed: 0 };
  const client: WorkflowStarterLike = {
    connection: {
      async withDeadline(_deadline, fn) {
        return fn();
      },
    },
    workflow: {
      async start(workflowType, options) {
        if (state.down) {
          throw new Error('Failed to start Workflow', {
            cause: Object.assign(new Error('No connection established'), { code: 14 }),
          });
        }
        if (running.has(options.workflowId)) {
          throw new WorkflowExecutionAlreadyStartedError('already started', options.workflowId, workflowType);
        }
        running.add(options.workflowId);
        started.push({ type: workflowType, workflowId: options.workflowId, input: options.args[0] });
        return {};
      },
    },
  };
  return { client, started, running, state };
}

type Data = Partial<MemoryData>;

function setup(options: { switchOn?: string | null; data?: (d: Data) => void; noGitHub?: boolean } = {}) {
  const data: Data = devFixtures(T0);
  const since = options.switchOn === undefined ? SWITCH_ON : options.switchOn;
  data.repos = (data.repos ?? []).map((r) => ({ ...r, ...(since ? { autoDispatchSince: since } : {}) }));
  options.data?.(data);
  const store = createMemoryStore(data, { now: () => T0 });
  const out: string[] = [];
  const err: string[] = [];
  const temporal = fakeTemporal();
  const gh = fakeClaimsGitHub();
  const plans = new Map<number, IssuePlan | Error>();
  const planReads: number[] = [];
  const opened = { store: 0, plans: 0 };
  const deps = (s: Store = store): CliDeps => ({
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    openStore: async () => {
      opened.store += 1;
      return { store: s, close: async () => {} };
    },
    openIssuePlans: async () => {
      opened.plans += 1;
      return {
        async read(repo, issueNumber) {
          expect(repo).toMatchObject(CANARY);
          planReads.push(issueNumber);
          const plan = plans.get(issueNumber) ?? issuePlan();
          if (plan instanceof Error) throw plan;
          return plan;
        },
      };
    },
    openTemporal: async () => {
      temporal.state.opened += 1;
      return {
        requirements: createTemporalRequirementWorkflows(temporal.client, 'fleet'),
        close: async () => {
          temporal.state.closed += 1;
        },
      };
    },
    ...(options.noGitHub
      ? {}
      : {
          openClaims: async () => ({
            claims: createClaimStatus({ store: s, github: gh, log: silentLogger }),
            close: async () => {},
          }),
        }),
    now: () => T0,
  });
  const run = (args: string[], s?: Store) => main(['handover', ...args], deps(s));
  /** 开关打开以前就开着的单：接活收进来过（任务行在排队），没派。 */
  const queued = async (issueNumber = 40) => {
    const id = randomUUID();
    await store.createTaskFromIssue(
      {
        id,
        repoId: IDS.repo,
        issueNumber,
        title: `开关打开以前开的第 ${issueNumber} 张`,
        rawRequest: `第 ${issueNumber} 张的原话`,
        requestedBy: IDS.founderA,
      },
      {
        actor: { kind: 'user', id: IDS.founderA },
        action: 'task.create',
        target: `task:${id}`,
        via: 'github',
        ok: true,
      },
    );
    return id;
  };
  const handovers = () => store.data.audit.filter((a) => a.action === TASK_HANDOVER);
  return { store, out, err, temporal, gh, plans, planReads, opened, deps, run, queued, handovers };
}

describe('参数', () => {
  it('仓、issue 号两个位置参数，必带 --reason（也认 --reason=…、#号）；别的写法一律拒（退出码 2），不猜', () => {
    expect(parseHandoverArgs(['example/canary', '40', '--reason', REASON])).toEqual({
      owner: 'example',
      name: 'canary',
      issueNumber: 40,
      reason: REASON,
    });
    expect(parseHandoverArgs(['--reason=  创始人说的  ', 'Example-1/fleet.dao_x', '#7'])).toEqual({
      owner: 'Example-1',
      name: 'fleet.dao_x',
      issueNumber: 7,
      reason: '创始人说的',
    });
    for (const argv of [
      [],
      ['example/canary'],
      ['example/canary', '40'],
      ['example/canary', '40', '--reason'],
      ['example/canary', '40', '--reason', '   '],
      ['example/canary', '40', '--reason', '--force'],
      ['example/canary', '40', '--reason='],
      ['canary', '40', '--reason', 'x'],
      ['https://github.com/example/canary', '40', '--reason', 'x'],
      ['example/canary', 'forty', '--reason', 'x'],
      ['example/canary', '0', '--reason', 'x'],
      ['example/canary', '-5', '--reason', 'x'],
      ['example/canary', '4.5', '--reason', 'x'],
      ['example/canary', '40', '41', '--reason', 'x'],
      ['example/canary', '40', '--force', '--reason', 'x'],
      ['example/canary', '40', '--reason', '字'.repeat(501)],
    ]) {
      let caught: unknown;
      try {
        parseHandoverArgs(argv);
      } catch (e) {
        caught = e;
      }
      expect(caught, argv.join(' ')).toBeInstanceOf(CliError);
      expect((caught as CliError).exitCode, argv.join(' ')).toBe(2);
    }
  });

  it('--help 只打印用法、退出码 0，不连库；参数不对退出码 2、打印用法，不连库', async () => {
    const t = setup();
    expect(await t.run(['--help'])).toBe(0);
    expect(t.out.at(-1)).toContain('用法：fleet-api handover <owner/仓名> <issue 号> --reason');
    expect(await main(['--help'], t.deps())).toBe(0);
    expect(t.out.at(-1)).toContain('fleet-api dispatch');
    expect(t.out.at(-1)).toContain('fleet-api handover');
    expect(await t.run(['example/canary', '40'])).toBe(2);
    expect(t.err.at(-1)).toContain('要带 --reason');
    expect(t.opened.store).toBe(0);
  });
});

describe('交给 fleet', () => {
  it('【故意造出的失败】开关关着：拒（退出码 1），写明关着和怎么开；不读 GitHub、不连 Temporal、什么都不记', async () => {
    const t = setup({ switchOn: null });
    await t.queued();
    expect(await t.run(['example/canary', '40', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toBe(
      '没交成（什么都没派）：example/canary 的「让 AI 接活」关着：关着时引擎只收单、显示，不派，交了也不起。要交先打开（fleet-api dispatch example/canary on，开不开由创始人拍）',
    );
    expect(t.opened.plans).toBe(0);
    expect(t.temporal.state.opened).toBe(0);
    expect(t.temporal.started).toEqual([]);
    expect(t.handovers()).toEqual([]);
  });

  it('交一张开关打开以前开的 v1 单（还在排队）：起 Fusion 工作流，记 task.handover（谁跑的、谁说的为什么、按哪个版本），读回打印', async () => {
    const t = setup();
    const taskId = await t.queued();
    expect(await t.run(['example/canary', '40', '--reason', REASON])).toBe(0);
    const workflowId = requirementWorkflowId(CANARY, 40);
    expect(t.temporal.started).toEqual([
      {
        type: FUSION_WORKFLOW_TYPE,
        workflowId,
        input: {
          schemaVersion: 1,
          taskId,
          // 开关、副本不进工作流的历史（和接活拉起的是同一种输入）
          repo: {
            id: IDS.repo,
            owner: 'example',
            name: 'canary',
            defaultBranch: 'main',
            testCommand: 'pnpm check',
          },
          issueNumber: 40,
          title: '开关打开以前开的第 40 张',
          rawRequest: '第 40 张的原话',
          requestedBy: 'founder-a',
        },
      },
    ]);
    expect(t.temporal.state.closed).toBe(1);
    const [entry] = t.handovers();
    expect(entry).toMatchObject({
      actor: { kind: 'engine', id: 'ops:handover' },
      action: TASK_HANDOVER,
      target: `task:${taskId}`,
      via: 'engine',
      ok: true,
      before: { state: 'queued' },
      after: { workflowId, outcome: 'started', restart: false, milestone: 'v1 Fusion 接活' },
      reason: `服务器上 root 跑的 fleet-api handover example/canary 40：${REASON}`,
    });
    // 认领归引擎：先记待起，起成了改在做（#299）
    const [claim] = t.store.data.claims;
    expect(claim).toMatchObject({ issueNumber: 40, ownerKind: 'engine', state: 'doing', workflowId });
    expect(entry?.after).toMatchObject({ claim: { claimId: claim?.claimId, fresh: true, voided: null } });
    expect(t.out.at(-1)).toBe(
      `已交给 fleet：example/canary#40（挂在当前版本「v1 Fusion 接活」上）起了 Fusion 工作流 ${workflowId}\n` +
        `认领：归引擎（认领 ${claim?.claimId.slice(0, 8)}）\n` +
        `操作记录 ${entry?.id}：${T0.toISOString()} 服务器上 root 跑的 fleet-api handover example/canary 40：${REASON}`,
    );
    expect(t.err).toEqual([]);
  });

  it('v2 的单、未排期的单也能交（人替版本那道放行），打印写明交的是哪个版本的', async () => {
    const t = setup();
    await t.queued(41);
    await t.queued(42);
    t.plans.set(41, issuePlan({ milestone: V2 }));
    t.plans.set(42, issuePlan({ milestone: null }));
    expect(await t.run(['example/canary', '41', '--reason', REASON])).toBe(0);
    expect(t.out.at(-1)).toContain(
      'example/canary#41（挂在「v2 引擎打磨」上（不是当前版本））起了 Fusion 工作流',
    );
    expect(await t.run(['example/canary', '42', '--reason', REASON])).toBe(0);
    expect(t.out.at(-1)).toContain('example/canary#42（未排期）起了 Fusion 工作流');
    expect(t.temporal.started.map((s) => s.input.issueNumber)).toEqual([41, 42]);
    expect(t.handovers().map((a) => (a.after as { milestone: unknown }).milestone)).toEqual([
      'v2 引擎打磨',
      null,
    ]);
  });

  it('母单、子单自动派不派，人交了照起（#252 之前一张一张明着交）：打印写明是母单、是哪张下面的子单，操作记录记下父子关系', async () => {
    const t = setup();
    await t.queued(43);
    await t.queued(44);
    t.plans.set(43, issuePlan({ labels: ['需求', '母单'], subIssues: 3 }));
    t.plans.set(44, issuePlan({ parent: 43 }));
    expect(await t.run(['example/canary', '43', '--reason', REASON])).toBe(0);
    expect(t.out.at(-1)).toContain(
      'example/canary#43（挂在当前版本「v1 Fusion 接活」上，是母单、下面挂着 3 张子单）起了 Fusion 工作流',
    );
    expect(await t.run(['example/canary', '44', '--reason', REASON])).toBe(0);
    expect(t.out.at(-1)).toContain(
      'example/canary#44（挂在当前版本「v1 Fusion 接活」上，是 #43 下面的子单）起了 Fusion 工作流',
    );
    expect(t.temporal.started.map((s) => s.input.issueNumber)).toEqual([43, 44]);
    expect(t.handovers().map((a) => a.after)).toMatchObject([
      { parent: null, subIssues: 3 },
      { parent: 43, subIssues: 0 },
    ]);
  });

  it('【故意造出的失败】贴着「本机做」的（#299 止血，自动派不派）：人明着交照起，打印和操作记录写明它贴着「本机做」、帅位原本留给本机', async () => {
    const t = setup();
    await t.queued(45);
    t.plans.set(45, issuePlan({ labels: ['需求', '本机做'] }));
    expect(await t.run(['example/canary', '45', '--reason', REASON])).toBe(0);
    expect(t.out.at(-1)).toContain(
      '已交给 fleet：example/canary#45（挂在当前版本「v1 Fusion 接活」上，贴着「本机做」（帅位原本留给本机做的））起了 Fusion 工作流',
    );
    expect(t.temporal.started.map((s) => s.input.issueNumber)).toEqual([45]);
    expect(t.handovers().map((a) => a.after)).toMatchObject([
      {
        outcome: 'started',
        place: '挂在当前版本「v1 Fusion 接活」上，贴着「本机做」（帅位原本留给本机做的）',
      },
    ]);
  });

  it('在跑的：不重复起（退出码 0），不连 Temporal；谁交的、为什么照样记一条、读回打印', async () => {
    const t = setup();
    // 样例里的 #12 正在跑
    expect(await t.run(['example/canary', '12', '--reason', REASON])).toBe(0);
    const [entry] = t.handovers();
    expect(entry).toMatchObject({
      actor: { kind: 'engine', id: 'ops:handover' },
      target: `task:${IDS.task12}`,
      ok: true,
      before: { state: 'running' },
      after: { outcome: 'in_progress', restart: false, milestone: 'v1 Fusion 接活' },
      reason: `服务器上 root 跑的 fleet-api handover example/canary 12：${REASON}`,
    });
    expect(t.out.at(-1)).toBe(
      '没起：example/canary#12（挂在当前版本「v1 Fusion 接活」上）已经在跑（任务现在是 running），不重复起\n' +
        `操作记录 ${entry?.id}：${T0.toISOString()} 服务器上 root 跑的 fleet-api handover example/canary 12：${REASON}`,
    );
    expect(t.temporal.state.opened).toBe(0);
  });

  it('【故意造出的失败】任务还在跑、GitHub 上已经关了：拒（退出码 1），不说「已经在跑」，不记', async () => {
    const t = setup();
    t.plans.set(12, issuePlan({ state: 'closed' }));
    expect(await t.run(['example/canary', '12', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toBe(
      '没交成（什么都没派）：example/canary#12（挂在当前版本「v1 Fusion 接活」上）：GitHub 上这张单关着：关着的单不派，要做先在 GitHub 上重开',
    );
    expect(t.out).toEqual([]);
    expect(t.temporal.state.opened).toBe(0);
    expect(t.handovers()).toEqual([]);
  });

  it('【故意造出的失败】已经结束、GitHub 上没重开过：拒（退出码 1），写明怎么再做一轮；关着的拒；重开过的再起一轮', async () => {
    const t = setup();
    // 样例里的 #13 已经做完
    expect(await t.run(['example/canary', '13', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toBe(
      '没交成（什么都没派）：example/canary#13（挂在当前版本「v1 Fusion 接活」上）：任务已经结束（done），不重复起：要再做一轮，先在 GitHub 上重开这张单（关了再开），再交一次',
    );
    t.plans.set(13, issuePlan({ state: 'closed' }));
    expect(await t.run(['example/canary', '13', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toContain('GitHub 上这张单关着：关着的单不派，要做先在 GitHub 上重开');
    expect(t.temporal.started).toEqual([]);
    expect(t.handovers()).toEqual([]);

    t.plans.set(13, issuePlan({ reopened: true }));
    expect(await t.run(['example/canary', '13', '--reason', REASON])).toBe(0);
    expect(t.out.at(-1)).toContain('上一轮是 done、GitHub 上重开过，再起了 Fusion 工作流');
    expect(t.temporal.started.map((s) => s.input.issueNumber)).toEqual([13]);
    expect(t.handovers()[0]).toMatchObject({ before: { state: 'done' }, after: { restart: true } });
  });

  it('【故意造出的失败】重开过的再起一轮、上一轮工作流还在收尾：没起（退出码 1），记一条没做成的', async () => {
    const t = setup();
    t.temporal.running.add(requirementWorkflowId(CANARY, 13));
    t.plans.set(13, issuePlan({ reopened: true }));
    expect(await t.run(['example/canary', '13', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toMatch(
      /^没交成：example\/canary#13（.+）上一轮工作流还没收完尾，这次没起：等它结束了再交一次\n认领：这次新认领的（认领 [0-9a-f]{8}）已放下\n操作记录 \d+：/,
    );
    expect(t.handovers()).toMatchObject([
      {
        ok: false,
        error: '上一轮工作流还没收完尾，这次没起：等它结束了再交一次',
        after: { outcome: 'failed' },
      },
    ]);
  });

  it('排队中的单刚被别处拉起了（Temporal 回已经在跑）：不重复起，退出码 0，照样记下这次交', async () => {
    const t = setup();
    const taskId = await t.queued();
    t.temporal.running.add(requirementWorkflowId(CANARY, 40));
    expect(await t.run(['example/canary', '40', '--reason', REASON])).toBe(0);
    expect(t.out.at(-1)).toContain('已经在跑（刚被别处拉起），没重复起');
    expect(t.temporal.started).toEqual([]);
    expect(t.handovers()).toMatchObject([
      { target: `task:${taskId}`, ok: true, after: { outcome: 'already_running' } },
    ]);
  });

  it('【故意造出的失败】Temporal 连不上：没起（退出码 1），记一条没做成的（带原因），读回打印', async () => {
    const t = setup();
    await t.queued();
    t.temporal.state.down = true;
    expect(await t.run(['example/canary', '40', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toMatch(
      /^没交成：example\/canary#40（挂在当前版本「v1 Fusion 接活」上）起工作流没成：拉起工作流 .+Temporal 连不上或没回应\n认领：这次新认领的（认领 [0-9a-f]{8}）已放下\n操作记录 \d+：/,
    );
    const [entry] = t.handovers();
    expect(entry).toMatchObject({
      ok: false,
      after: { outcome: 'failed' },
      reason: expect.stringContaining(REASON),
    });
    expect(entry?.error).toMatch(/Temporal 连不上或没回应/);
    expect(t.temporal.state.closed).toBe(1);
    // 这次什么都没派：新认领的放下了（写明为什么），本机能接着认领
    expect(t.store.data.claims).toMatchObject([
      {
        issueNumber: 40,
        ownerKind: 'engine',
        state: 'released',
        endReason: expect.stringContaining('交单时起工作流没成'),
      },
    ]);
  });

  it('【故意造出的失败】库里没有这张单的任务行（接活没收进来）、没有这个仓：拒，不读 GitHub、不连 Temporal', async () => {
    const t = setup();
    expect(await t.run(['example/canary', '99', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toContain('库里没有 example/canary#99 的任务：接活还没收进来');
    expect(await t.run(['example/nope', '40', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toBe(
      '没交成（什么都没派）：库里没有仓 example/nope（受管的仓就是 repos 表的行，见 docs/ops.md 第九节）',
    );
    expect(t.opened.plans).toBe(0);
    expect(t.temporal.state.opened).toBe(0);
  });

  it('【故意造出的失败】这个项目停派（流程配置副本认不出）：拒，写明原因', async () => {
    const t = setup({
      data: (d) => {
        d.repos = (d.repos ?? []).map((r) => ({
          ...r,
          flow: {
            syncedAt: SWITCH_ON,
            error: '项目配置 .fleet/flow.json：不是 JSON',
            unread: null,
            testCommand: null,
          },
        }));
      },
    });
    await t.queued();
    expect(await t.run(['example/canary', '40', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toContain('没交成（什么都没派）：这个项目停派：流程配置认不出');
    expect(t.opened.plans).toBe(0);
    expect(t.temporal.started).toEqual([]);
  });

  it('【故意造出的失败】读不到 GitHub 上这张单：说「没查成」，不派、不记', async () => {
    const t = setup();
    await t.queued();
    t.plans.set(40, new Error('GitHub 回 502'));
    expect(await t.run(['example/canary', '40', '--reason', REASON])).toBe(1);
    expect(t.err.at(-1)).toBe(
      '没交成（什么都没派）：没查成：读不到 GitHub 上 example/canary#40 此刻的样子（GitHub 回 502）',
    );
    expect(t.temporal.state.opened).toBe(0);
    expect(t.handovers()).toEqual([]);
  });

  it('【故意造出的失败】操作记录写不进去（库出错）：工作流起了也照实说没记上，退出码 1', async () => {
    const t = setup();
    await t.queued();
    const broken: Store = {
      ...t.store,
      appendAudit: async () => {
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      },
    };
    expect(await t.run(['example/canary', '40', '--reason', REASON], broken)).toBe(1);
    expect(t.err.at(-1)).toBe(
      `已交给 fleet：example/canary#40（挂在当前版本「v1 Fusion 接活」上）起了 Fusion 工作流 ${requirementWorkflowId(CANARY, 40)}，但操作记录没写进去：库出错（57014：canceling statement due to statement timeout）`,
    );
  });
});

describe('认领（#299）：交单和本机抢同一行；帅位座位整张删掉后只剩运维这一路（#531）', () => {
  /** 直接在本机的认领账里塞一份本机工人的认领（帅位座位整张删掉：本机不再经 Store 拿，这里照老样子造出来）。 */
  function localHolds(t: ReturnType<typeof setup>, pr?: number) {
    const at = T0.toISOString();
    const claim = {
      repoId: IDS.repo,
      issueNumber: 40,
      claimId: randomUUID(),
      ownerKind: 'worker' as const,
      ownerMachine: '本机',
      ownerLabel: 'w1',
      seatScope: 'main',
      seatTerm: 1,
      state: pr === undefined ? ('claimed' as const) : ('pr_open' as const),
      workflowId: null,
      prNumbers: pr === undefined ? [] : [pr],
      graceMinutes: 120,
      claimedAt: at,
      heartbeatAt: at,
      updatedAt: at,
      endedAt: null,
      endReason: null,
      note: null,
    };
    t.store.data.claims.push(claim);
    return claim;
  }

  it('参数：--founder 要写原话；座位那几样（--machine、--session、--term、--scope）整张删掉（#531），给了一律拒（退出码 2）', () => {
    expect(
      parseHandoverArgs(['example/canary', '40', '--reason', REASON, '--founder', '  这张给引擎做  ']),
    ).toMatchObject({ founder: '这张给引擎做' });
    for (const extra of [
      ['--machine', '本机'],
      ['--machine', '本机', '--session', 's1'],
      ['--term', '1'],
      ['--scope', 'main'],
      ['--machine', '本机', '--session', 's1', '--term', '1', '--scope', 'main'],
      ['--founder', '   '],
      ['--founder', '字'.repeat(501)],
      ['--founder', 'a', '--founder', 'b'],
    ]) {
      let caught: unknown;
      try {
        parseHandoverArgs(['example/canary', '40', '--reason', REASON, ...extra]);
      } catch (e) {
        caught = e;
      }
      expect(caught, extra.join(' ')).toBeInstanceOf(CliError);
      expect((caught as CliError).exitCode, extra.join(' ')).toBe(2);
    }
  });

  it('钉子：usage 里不再出现拒收的那四个旗（#531；删掉以后照拒收测试的错拒得有据）', async () => {
    const t = setup();
    await t.run(['--help']);
    const usage = t.out.join('\n');
    expect(usage).not.toContain('--term');
    expect(usage).not.toContain('--machine');
    expect(usage).not.toContain('--session');
    expect(usage).not.toContain('--scope');
  });

  it('【故意造出的失败】本机认领着：拒（退出码 3），写明谁拿着、怎么强制改派；不起工作流、不记 task.handover', async () => {
    const t = setup();
    await t.queued();
    const held = localHolds(t);
    expect(await t.run(['example/canary', '40', '--reason', REASON])).toBe(3);
    expect(t.err.at(-1)).toContain('没交成（什么都没派）：example/canary#40');
    expect(t.err.at(-1)).toContain('这张单本机认领着');
    expect(t.err.at(-1)).toContain('要改派给引擎，带上创始人原话 --founder');
    expect(t.temporal.started).toEqual([]);
    expect(t.handovers()).toEqual([]);
    expect(t.store.data.claims).toMatchObject([{ claimId: held.claimId, state: 'claimed' }]);
  });

  it('带创始人原话：本机那份认领当场作废（记 claim.reassign），归引擎、起工作流；它开着的 PR 撤自动合并、留言、关掉（#348）', async () => {
    const t = setup();
    await t.queued();
    const held = localHolds(t, 88);
    t.gh.addPull('example/canary', { number: 88, body: '**需求**：#40', autoMerge: true });
    expect(await t.run(['example/canary', '40', '--reason', REASON, '--founder', '这张交给引擎做'])).toBe(0);
    expect(t.temporal.started.map((s) => s.input.issueNumber)).toEqual([40]);
    const [claim] = t.store.data.claims;
    expect(claim).toMatchObject({ ownerKind: 'engine', state: 'doing' });
    expect(t.store.data.audit.find((a) => a.action === 'claim.reassign')).toMatchObject({
      target: `claim:${IDS.repo}#40`,
      before: { claimId: held.claimId, owner: '本机/w1' },
      reason: '改派给引擎（创始人原话：这张交给引擎做）',
    });
    expect(t.out.at(-1)).toContain(
      `认领：归引擎（认领 ${claim?.claimId.slice(0, 8)}）；作废了本机的认领（原来归 本机/w1，认领 ${held.claimId.slice(0, 8)}），它开着的 PR #88 撤了自动合并、关了（分支留着）`,
    );
    expect(t.gh.writes).toEqual([
      'disable example/canary#88',
      'comment example/canary#88',
      'close example/canary#88',
    ]);
    expect(t.gh.comments[0]?.body).toContain('改派给 引擎（创始人原话：这张交给引擎做）');
    expect(t.handovers()[0]).toMatchObject({
      after: { claim: { voided: held.claimId, fresh: true } },
      reason: expect.stringContaining('（创始人原话：这张交给引擎做）'),
    });
  });

  it('【故意造出的失败】强制改派时没接 GitHub：照交，照实写旧 PR 没处理、要人撤自动合并关掉', async () => {
    const t = setup({ noGitHub: true });
    await t.queued();
    localHolds(t, 88);
    expect(await t.run(['example/canary', '40', '--reason', REASON, '--founder', '这张交给引擎做'])).toBe(0);
    expect(t.out.at(-1)).toContain('它开着的 PR 没处理（这里没接 GitHub（openClaims）');
    expect(t.out.at(-1)).toContain('登记过的 #88 要人撤自动合并、关掉');
  });

  it('引擎本来就拿着（接活抢到了、起工作流没成留着待起）：交单照起，认领改在做', async () => {
    const t = setup();
    await t.queued();
    const r = await t.store.claimForEngine({
      repoId: IDS.repo,
      issueNumber: 40,
      workflowId: requirementWorkflowId(CANARY, 40),
      actor: { kind: 'engine', id: 'github-intake' },
    });
    expect(r.ok).toBe(true);
    expect(await t.run(['example/canary', '40', '--reason', REASON])).toBe(0);
    expect(t.store.data.claims).toMatchObject([{ ownerKind: 'engine', state: 'doing' }]);
    expect(t.handovers()[0]).toMatchObject({ after: { claim: { fresh: false } } });
  });
});

describe('接在真库上（PGlite 跑真迁移）', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => db.close());

  it('交一张排队中的单：按库里的任务行起工作流，task.handover 进 audit_log，从库里读回打印', async () => {
    await resetTestDb(db);
    const data: Data = devFixtures(T0);
    data.repos = (data.repos ?? []).map((r) => ({ ...r, autoDispatchSince: SWITCH_ON }));
    await seedPg(db.db, data);
    const store = createPgStore(db.db, { now: () => T0 });
    const t = setup();
    const id = randomUUID();
    await store.createTaskFromIssue(
      {
        id,
        repoId: IDS.repo,
        issueNumber: 40,
        title: '库里的一张',
        rawRequest: '原话',
        requestedBy: IDS.founderA,
      },
      {
        actor: { kind: 'user', id: IDS.founderA },
        action: 'task.create',
        target: `task:${id}`,
        via: 'github',
        ok: true,
      },
    );
    expect(await t.run(['example/canary', '40', '--reason', REASON], store)).toBe(0);
    expect(t.temporal.started.map((s) => [s.input.taskId, s.input.title])).toEqual([[id, '库里的一张']]);
    const rows = await db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `task:${id}`));
    const handed = rows.find((r) => r.action === TASK_HANDOVER);
    expect(handed).toMatchObject({
      actorKind: 'engine',
      actorId: 'ops:handover',
      via: 'engine',
      ok: true,
      reason: `服务器上 root 跑的 fleet-api handover example/canary 40：${REASON}`,
    });
    expect(t.out.at(-1)).toContain(`操作记录 ${handed?.id}：`);
    expect(t.err).toEqual([]);
  });
});

// 同步起 node：不设 vitest 的超时，卡死由子进程自己的上限管（为什么见 child.ts 开头）。
describe('命令行入口（真起一个 node 进程）', { timeout: 0 }, () => {
  const bin = fileURLToPath(new URL('../src/bin/fleet-api.ts', import.meta.url));
  const exec = (args: string[], env: Record<string, string> = {}) => {
    const base = { ...process.env };
    delete base.DATABASE_URL;
    return runChild(process.execPath, [bin, ...args], { env: { ...base, ...env } });
  };

  it('handover --help：退出码 0，打印用法（不要库连接）；少了 --reason、没带库连接：退出码 2', () => {
    const help = exec(['handover', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('用法：fleet-api handover <owner/仓名> <issue 号> --reason');
    const noReason = exec(['handover', 'example/canary', '40'], {
      DATABASE_URL: 'postgres://fleet@127.0.0.1:1/fleet',
    });
    expect(noReason.status).toBe(2);
    expect(noReason.stderr).toContain('要带 --reason');
    const noDb = exec(['handover', 'example/canary', '40', '--reason', REASON]);
    expect(noDb.status).toBe(2);
    expect(noDb.stderr).toContain('DATABASE_URL');
  });
});
