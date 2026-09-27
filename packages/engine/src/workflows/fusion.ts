// Fusion 工作流（docs/decisions/0003-fusion-flow.md 第 5–7、9、13 条；specs/214-Fusion工作流/）：一张单一个主导模型（Lead）
// 会话领着走 0–7 步，派一个副手（Sidekick）干界定清楚的活；引擎推分支、开 PR、合并、关单，不往主线直接写。
//   1 收单（引擎，不用模型）：看流程配置副本（读不到、认不出就停派报红），认单子正文里指的需求文档目录，建工作树。
//   2 规划：Lead 读需求文档和代码，把方案写进 specs/<号>-<短名>/方案.md 提交，交方案摘要和任务简报（core 判），先推上去。
//   3 方案评审：小单跳过；不算小单的引擎还没接评审（#249），照跳过、PR 里写明。
//   4 执行：副手照简报在同一棵树上干（按流程配置派别家的便宜路由；派不出、没额度就 Lead 自己干）；副手干完 Lead 续同一个
//     会话验收：收下 / 打回（最多 2 次）/ Lead 接手（core 的 decideAcceptance）。Lead 验收时副手不在跑（一步一步来）。
//   5 验证：推上去之后别家验证（workflows/verify.ts）；挡了 Lead 可以拿证据驳回，回第 4 步改，最多 2 轮。
//   6 开 PR（正文：方案摘要、验证结论）→ 等 CI；红了 Lead 写修复简报、副手改，最多 3 轮；绿了 Lead 最终审查、结果.md 提交。
//   7 合并队列合并（碰人闸的等人批）→ 关单（评论：改了什么、用时、各模型额度；正文经 decide 定一次再发，重试不重写）。
// 走哪一步只听 core 的 nextFlow（经 decide，进历史）。编号和需求工作流同一个（req:<仓>#<号>）：驾驶舱、fleet 命令的信号照旧。
// 步骤交界（stepBoundary）是 #215（存档点、换 Lead）、#216（每步耗时和额度进库）要接的地方。
// 这里是工作流代码：判断只经 judge、编号只经 newId、core 只许 import type；改调度顺序要 patched()（kit.ts 头注释）。

import type {
  Brief,
  FlowAction,
  FlowEvent,
  FlowState,
  FusionPrParts,
  FusionSetup,
  LeadPlan,
  Step,
} from '@fleet-dao/core';
import type { StageKind, SubtaskState, TaskState } from '@fleet-dao/shared';
import {
  CancellationScope,
  condition,
  getExternalWorkflowHandle,
  isCancellation,
  log,
  setHandler,
  sleep,
  TemporalFailure,
  workflowInfo,
} from '@temporalio/workflow';
import {
  type ApprovalCommand,
  type FusionInput,
  type FusionResult,
  type FusionStatus,
  fusionBranch,
  fusionStatusQuery,
  type MergeItem,
  type MergeResult,
  mergeQueueWorkflowId,
  mergeResultSignal,
  withdrawSignal,
} from '../contract.ts';
import type { Feedback } from '../decisions/verify.ts';
import { describeHolds, normalizeHolds } from '../holds.ts';
import type {
  LeadBrief,
  LeadStep,
  SessionBrief,
  SessionOutput,
  TaskStateSnapshot,
  Worktree,
} from '../ports.ts';
import {
  activitiesFor,
  attempt,
  attemptOrRework,
  type Control,
  gate,
  installControl,
  iso,
  judge,
  type Kit,
  limitsFor,
  NO_REWORK,
  newId,
  newKit,
  type OutputOf,
  offClockMs,
  park,
  type Rework,
  type ReworkCarry,
  reworkFeedback,
  runStage,
  stopActiveSessions,
  tryStage,
  type Verdict,
  waitFor,
} from './kit.ts';
import { rebutRound, type VerifyRound, verifyLines, verifyRound } from './verify.ts';

type Setup = Extract<FusionSetup, { ok: true }>;
type Docs = { requirement: string; plan: string; result: string };
type LeadOutput = Extract<SessionOutput['kind'], `lead-${string}` | 'delivery'>;
type Delivery = OutputOf<'delivery'>;

/** 叫停收尾时等合并队列确认撤出多久（和子任务一样）。 */
const STOP_WITHDRAW_MINUTES = 10;
/** CI 连着几次没查成就停下等人（没查成不是没过，也不能一直空转）。 */
const CI_UNKNOWN_LIMIT = 3;
/** 在合并队列里的这一块叫什么（合并条目、快照里的块）。一张单一块（母单按块循环归 #252）。 */
const BLOCK_KEY = 'fusion';

const STATE_OF_STEP: Record<Step, TaskState> = {
  discuss: 'triaging',
  intake: 'triaging',
  plan: 'planning',
  review: 'planning',
  execute: 'running',
  verify: 'running',
  pr: 'running',
  'final-review': 'running',
  merge: 'merging',
  'mother-verify': 'running',
  done: 'done',
  parked: 'running',
};

const BLOCK_OF_STEP: Record<Step, SubtaskState> = {
  discuss: 'pending',
  intake: 'pending',
  plan: 'pending',
  review: 'pending',
  execute: 'running',
  verify: 'verifying',
  pr: 'verifying',
  'final-review': 'verifying',
  merge: 'in_merge_queue',
  'mother-verify': 'verifying',
  done: 'merged',
  parked: 'running',
};

const DOING: Record<FlowAction, string> = {
  discuss: '创单并讨论',
  intake: '收单：看流程配置、认需求文档、建工作树',
  plan: 'Lead 写方案和任务简报',
  'review-plan': '方案评审',
  dispatch: '副手照简报干，Lead 验收',
  'lead-takeover': 'Lead 自己接手写',
  verify: '开 PR 前别家验证',
  'open-pr': '开 PR、等 CI',
  'fix-ci': '开了 PR 之后修一轮',
  'recheck-ci': '再查一次 CI',
  'final-review': 'Lead 最终审查、写结果',
  merge: '合并队列合并',
  'verify-mother': '母单级验证',
  close: '关单',
  'wait-human': '停下等人',
};

export async function fusionWorkflow(input: FusionInput): Promise<FusionResult> {
  const info = workflowInfo();
  const startedAt = Date.now();
  const status: FusionStatus = {
    kind: 'fusion',
    taskId: input.taskId,
    issueNumber: input.issueNumber,
    state: 'triaging',
    step: 'discuss',
    action: 'intake',
    doing: '收单',
    mode: null,
    flowSource: null,
    specDir: null,
    branch: null,
    paused: false,
    parked: false,
    waiting: null,
    route: null,
    runId: null,
    sessionId: null,
    lead: null,
    sidekick: null,
    prNumber: null,
    head: null,
    rounds: { reworks: 0, verify: 0, fix: 0, mergeReturn: 0 },
    holds: [],
    approval: null,
    steps: [],
    lastProblem: null,
    lastAgentEvent: null,
    commands: [],
  };

  // 这一块（一张单一块）在库里 subtasks 的编号，建工作树时经 newId 生成：分支名、合并条目、快照都用它。
  let blockId: string | null = null;

  // 信号处理器挂上时会当场处理缓存着的信号：它们要用的东西都得先声明好。
  let kitRef: Kit | null = null;
  const mergeResults: Record<string, MergeResult> = {};
  setHandler(mergeResultSignal, (result) => {
    mergeResults[result.itemId] = result;
  });

  const decideApproval = (command: ApprovalCommand, state: 'approved' | 'rejected'): Verdict => {
    if (command.subtaskId && command.subtaskId !== blockId) {
      return { accepted: false, note: `点名的不是这张单的块（${command.subtaskId}）` };
    }
    const pending = status.approval;
    if (pending?.state !== 'pending') return { accepted: false, note: '没有在等批准' };
    if (command.approvalId && command.approvalId !== pending.approvalId) {
      return { accepted: false, note: `批准编号对不上：在等的是 ${pending.approvalId}` };
    }
    status.approval = {
      ...pending,
      state,
      ...(command.by ? { by: command.by } : {}),
      ...(command.reason ? { reason: command.reason } : {}),
      at: iso(Date.now()),
    };
    return {
      accepted: true,
      note:
        state === 'approved'
          ? `批准（${describeHolds(pending.holds)}），进合并队列`
          : `拒绝，回去改${command.reason ? `：${command.reason}` : ''}`,
    };
  };

  const main = new CancellationScope();
  const control: Control = installControl(input.routeOverrides, {
    onStop: () => main.cancel(),
    // 不带阶段的「换路由」：Lead（plan）和写码（副手、Lead 接手）
    mainStages: ['plan', 'execute', 'ui'],
    ownsRun: (runId) => Boolean(kitRef?.active[runId]),
    approve: (command) => decideApproval(command, 'approved'),
    reject: (command) => decideApproval(command, 'rejected'),
    requireApproval: (command) => {
      if (command.subtaskId && command.subtaskId !== blockId) {
        return { accepted: false, note: `点名的不是这张单的块（${command.subtaskId}）` };
      }
      const holds = normalizeHolds([...status.holds, ...(command.holds ?? [])]);
      if (holds.length === status.holds.length) {
        return { accepted: false, note: command.holds?.length ? '这些人闸已经有了' : '没给要拦的事' };
      }
      status.holds = holds;
      return { accepted: true, note: `加人闸：${describeHolds(holds)}（合并前等人批）` };
    },
  });
  setHandler(fusionStatusQuery, () => ({
    ...status,
    paused: control.paused,
    parked: control.parked,
    lastAgentEvent: control.lastAgentEvent,
    commands: [...control.commands],
  }));

  const limits = await limitsFor(input.limits);
  const acts = activitiesFor(limits);
  const kit = newKit({
    acts,
    limits,
    control,
    scope: { taskId: input.taskId },
    view: status,
    onChange: () => undefined,
  });
  kitRef = kit;

  // ---- 这张单一路上的事实（都在内存里，从历史重放出来）
  let setup: Setup | null = null;
  let flow: FlowState | null = null;
  let specDir = '';
  let docs: Docs | null = null;
  let tree: Worktree | null = null;
  let branch = '';
  /** 推上去的头（远端分支头）；工作树的头可能更新（交回了、还没推）。 */
  let head = '';
  let treeHead = '';
  let plan: LeadPlan | null = null;
  /** 任务简报碰到了页面代码：副手按界面类派（GPT 不做界面）。 */
  let uiWork = false;
  const lead: { sessionId?: string; routeId?: string; family?: string } = {};
  const side: { sessionId?: string; routeId?: string; family?: string } = {};
  /** 下一次执行要带的返工意见（验收打回、验证挡住、推分支被拦……）。 */
  let feedback: Feedback[] = [];
  /** 这张单提交改到过的文件（相对主线）：PR 正文、验证材料、最终审查核结果.md 用。 */
  const changed = new Set<string>();
  /** 副手这一块改到过的（验收看累计的：前一轮碰了简报外的文件，后一轮没改回来也照样算）。 */
  const blockChanged = new Set<string>();
  let lastDelivery: { summary: string; testsPassed: boolean } | null = null;
  /** 这一块由 Lead 自己写的原因（副手写的是 undefined）。 */
  let soloWhy: string | undefined;
  let planReviewSkipped = false;
  const rounds: VerifyRound[] = [];
  let prNumber: number | null = null;
  let prParts: FusionPrParts | null = null;
  let pushRework: ReworkCarry = NO_REWORK;
  let prRework: ReworkCarry = NO_REWORK;
  /** 开了 PR 之后要修的（CI 红、最终审查要改、合并前退回）：修完推上去才清掉，停下等人再回来接着修。 */
  let fix: { feedback: Feedback[]; brief?: Brief; follow?: boolean } | null = null;
  let review: { did: string[]; owed: string[] } | null = null;
  let mergeCommit: string | null = null;
  let mergeAttempt = 0;
  let pendingItemId: string | null = null;
  let mergeReturns = 0;
  let ciUnknown = 0;
  let intakeTries = 0;

  const need = <T>(value: T | null | undefined, what: string): T => {
    if (value === null || value === undefined) throw new Error(`Fusion 工作流走到这里却没有${what}`);
    return value;
  };
  const addChanged = (files: readonly string[] | undefined) => {
    for (const f of files ?? []) changed.add(f);
  };

  // ---- 写库给驾驶舱、原地更新 issue 的进度段（尽力而为，失败不挡流程）

  let lastSaved = '';
  let lastPublished = '';
  /** 收尾时这一块的结局（叫停、没做完）；走在路上是 null，按步骤算。 */
  let blockEnd: SubtaskState | null = null;
  const publish = async () => {
    if (!docs) return; // 认出需求文档目录之前没有要写的（写空目录会把库里的冲掉）
    const step = flow?.step ?? 'intake';
    const shown: Step = step === 'parked' ? (flow?.resume ?? 'intake') : step;
    const blockState = blockEnd ?? BLOCK_OF_STEP[shown];
    const snapshot: TaskStateSnapshot = {
      ...kit.scope,
      repoId: input.repo.id,
      issueNumber: input.issueNumber,
      state: status.state,
      phase: `fusion:${step}`,
      doing: status.doing,
      specDir,
      docs: publishedDocs(),
      lastProblem: status.lastProblem,
      // 一张单一块：块不开单，只进库给驾驶舱看（0003 第 1 条）
      subtasks:
        blockId && plan
          ? [
              {
                id: blockId,
                key: BLOCK_KEY,
                index: 0,
                title: plan.brief.goal,
                touches: plan.brief.files,
                dependsOn: [],
                state: blockState,
                prNumber,
                waitingOn: status.waiting?.detail ?? null,
                workflowId: info.workflowId,
                holds: status.holds,
              },
            ]
          : [],
    };
    const snapshotText = JSON.stringify(snapshot);
    if (snapshotText !== lastSaved) {
      lastSaved = snapshotText;
      try {
        await CancellationScope.nonCancellable(() => acts.saveTaskState(snapshot));
      } catch (error) {
        log.warn('任务状态没写进库', { error: String(error) });
      }
    }
    // 公开的 issue 进度段只写已经公开的东西（单子标题、步骤、PR 号、文档路径），不写 Lead 写的简报
    const progress = {
      state: status.state,
      current: status.doing,
      done: blockState === 'merged' ? 1 : 0,
      total: plan ? 1 : 0,
      subtasks: plan ? [{ key: BLOCK_KEY, title: input.title, state: blockState, prNumber }] : [],
      docs: publishedDocs(),
    };
    const progressText = JSON.stringify(progress);
    if (progressText === lastPublished) return;
    lastPublished = progressText;
    try {
      await CancellationScope.nonCancellable(() =>
        acts.updateIssueProgress({
          ...kit.scope,
          repo: input.repo,
          issueNumber: input.issueNumber,
          progress,
        }),
      );
    } catch (error) {
      log.warn('issue 进度段没更新上', { error: String(error) });
    }
  };
  /** 进度段、快照里的文档：需求文档一直在；方案、结果提交了才写。 */
  const publishedDocs = (): { requirement?: string; plan?: string; result?: string } => {
    if (!docs) return {};
    return {
      requirement: docs.requirement,
      ...(changed.has(docs.plan) ? { plan: docs.plan } : {}),
      ...(changed.has(docs.result) ? { result: docs.result } : {}),
    };
  };

  /**
   * 步骤交界：记下每一步的起止，写库给驾驶舱。
   * #215 接在这里：每步结束 Lead 写存档点（一个 git 提交加写明白的进度），按上下文用量在这里换新 Lead 会话（lead.sessionId 清空、
   * 新会话先读存档点）。#216 接在这里：按步骤记这一步的耗时和各模型用量（kit.usage 在两次交界之间的差）进库。
   */
  const stepBoundary = async (from: Step, to: Step) => {
    if (from !== to) {
      const at = iso(Date.now());
      const open = status.steps.at(-1);
      if (open && open.until === null) open.until = at;
      status.steps.push({ step: to, since: at, until: null });
    }
    status.step = to;
    const shown: Step = to === 'parked' ? (flow?.resume ?? 'intake') : to;
    status.state = STATE_OF_STEP[shown];
    await publish();
  };

  /** 状态机往前走一步（core 的 nextFlow，经 decide）。判不了是代码错了：让工作流任务失败重试，修好换上新工人接着走。 */
  const advance = async (event: FlowEvent): Promise<FlowAction> => {
    const current = need(flow, '状态');
    const decided = await judge(kit, 'fusionFlow', { state: current, event });
    if (!decided.ok) throw new Error(`Fusion 状态机判不了：${decided.why}`);
    flow = decided.state;
    status.action = decided.action;
    status.doing =
      decided.action === 'wait-human' ? `停下等人：${decided.state.why ?? ''}` : DOING[decided.action];
    status.rounds = {
      reworks: decided.state.reworks,
      verify: decided.state.verifyRounds,
      fix: decided.state.ciRounds,
      mergeReturn: mergeReturns,
    };
    await stepBoundary(current.step, decided.state.step);
    return decided.action;
  };

  // ---- 会话：Lead 一张单一个会话、按步续用；副手也续同一个

  const sessionBrief = (extra: Partial<SessionBrief>): SessionBrief => ({
    title: input.title,
    request: input.rawRequest,
    specDir,
    acceptance: plan?.brief.acceptance ?? [],
    touches: plan?.brief.files ?? [],
    feedback: [],
    answers: [],
    branch,
    ...extra,
  });

  /**
   * Lead 的一步：续同一个会话、同一条路由（同池 --resume，0003 第 6 条），在同一棵工作树上。派不出就挂起（没有 Lead 做不了）；
   * 要问创始人的（fleet ask / blocked）runStage 问了再续。
   */
  const leadRun = async <K extends LeadOutput>(
    step: LeadStep,
    expect: K,
    opts: { feedback?: Feedback[]; material?: Partial<LeadBrief>; stage?: StageKind; task?: Brief } = {},
  ): Promise<OutputOf<K>> => {
    const current = need(setup, '流程配置');
    const task = opts.task ?? plan?.brief;
    const got = await runStage(kit, {
      stage: opts.stage ?? 'plan',
      expect,
      brief: sessionBrief({
        feedback: opts.feedback ?? [],
        lead: { step, mode: current.mode, docs: need(docs, '需求文档'), ...opts.material },
        ...(task ? { task } : {}),
      }),
      resumeSessionId: lead.sessionId,
      stickRouteId: lead.routeId,
      worktreePath: need(tree, '工作树').path,
      baseHead: treeHead,
      models: current.models.lead,
      uiWork: opts.stage === 'ui' ? true : undefined,
    });
    lead.sessionId = got.sessionId;
    lead.routeId = got.route.routeId;
    lead.family = got.route.family;
    status.lead = { sessionId: got.sessionId, routeId: got.route.routeId, family: got.route.family };
    return got.output;
  };

  /**
   * 副手干一轮：照简报，在同一棵树上，按流程配置的副手模型顺序派别家（避开 Lead 那一族：Claude 额度留给 Lead，0002 第 5 条）。
   * 派不出（没接好、没额度、连着做不好）交回 unavailable，调用方让 Lead 自己干（0003 第 7 条）。
   */
  const sidekickRun = async (
    brief: Brief,
    fb: Feedback[],
  ): Promise<{ delivery: Delivery } | { unavailable: string }> => {
    const current = need(setup, '流程配置');
    const got = await tryStage(kit, {
      stage: uiWork ? 'ui' : 'execute',
      expect: 'delivery',
      brief: sessionBrief({ task: brief, touches: brief.files, acceptance: brief.acceptance, feedback: fb }),
      resumeSessionId: side.sessionId,
      stickRouteId: side.routeId,
      worktreePath: need(tree, '工作树').path,
      baseHead: treeHead,
      avoidFamilies: lead.family ? [lead.family] : undefined,
      uiWork: uiWork || undefined,
      models: current.models.sidekick,
    });
    if ('unavailable' in got) return got;
    side.sessionId = got.sessionId;
    side.routeId = got.route.routeId;
    side.family = got.route.family;
    status.sidekick = { sessionId: got.sessionId, routeId: got.route.routeId, family: got.route.family };
    treeHead = got.output.head;
    return { delivery: got.output };
  };

  /** 推分支（推之前引擎并最新主线、过卫生检查）。拦下了交回返工原因，调用方退回写它的那一方。 */
  const pushOrRework = async (to: string): Promise<{ head: string } | { rework: Rework }> => {
    const worktree = need(tree, '工作树');
    const pushed = await attemptOrRework(
      kit,
      'pushBranch',
      () =>
        acts.pushBranch({ ...kit.scope, repo: input.repo, worktreePath: worktree.path, branch, head: to }),
      pushRework,
    );
    if ('rework' in pushed) {
      pushRework = pushed.rework.carry;
      status.lastProblem = pushed.rework.reason;
      return pushed;
    }
    pushRework = NO_REWORK;
    head = pushed.ok.head;
    treeHead = pushed.ok.head;
    status.head = head;
    return { head };
  };

  /** Lead 自己写（副手打回两次还没做好、副手派不出、单模型模式）：写完测试没过就停下等人，推分支被拦就接着改。 */
  const leadWork = async (
    why: string,
    fb: Feedback[],
    brief?: Brief,
  ): Promise<{ ok: true } | { needsHuman: string }> => {
    let feedbackNow = fb;
    status.lastProblem = why;
    for (;;) {
      const del = await leadRun('takeover', 'delivery', {
        stage: uiWork ? 'ui' : 'execute',
        feedback: feedbackNow,
        material: { why },
        ...(brief ? { task: brief } : {}),
      });
      treeHead = del.head;
      addChanged(del.changedFiles);
      if (!del.testsPassed) return { needsHuman: `Lead 自己写完测试没过：${del.summary}` };
      const pushed = await pushOrRework(del.head);
      if ('rework' in pushed) {
        feedbackNow = [reworkFeedback('push', pushed.rework)];
        continue;
      }
      lastDelivery = { summary: del.summary, testsPassed: true };
      soloWhy = why;
      return { ok: true };
    }
  };

  /** Lead 验收副手这一轮交回的（续 Lead 的会话看树里的改动；副手这时候不在跑）。 */
  const leadAccept = async (del: Delivery, brief: Brief) => {
    const verdict = await leadRun('accept', 'lead-verdict', {
      material: {
        delivery: {
          head: del.head,
          summary: del.summary,
          changedFiles: del.changedFiles ?? [],
          testsPassed: del.testsPassed,
          // 上一次推上去的头：从它到副手交回的头就是这一块副手的全部改动（打回过的几轮连在一起看）
          base: head,
        },
      },
      task: brief,
    });
    return { verdict: verdict.verdict, why: verdict.why.trim() || '（Lead 没写理由）' };
  };

  // ---- 各步

  /** 开工前看流程配置：不能用就挂起报红（这张单停派），人修好点「继续」再读。 */
  const readSetup = async (): Promise<Setup> => {
    for (;;) {
      const read = await attempt(kit, 'flowConfig', () => acts.flowConfig({ ...kit.scope }));
      const got = await judge(kit, 'fusionSetup', {
        read,
        now: iso(Date.now()),
        category: input.category ?? '需求',
        ...(input.profile ? { profile: input.profile } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      });
      if (got.ok) return got;
      status.lastProblem = got.why;
      await park(
        kit,
        `流程配置不能用，这张单停派：${got.why}`,
        `${got.why}。改好仓里的 .fleet/flow.json 合进主线（对账读成后副本自己好），或等对账恢复，再点「继续」`,
      );
    }
  };

  /** 1 收单：认需求文档目录（单子正文里那一行，不按标题拼），建工作树。 */
  const doIntake = async (): Promise<FlowEvent> => {
    // 第一次用拉起时带的正文；停下等人（正文里没有那一行）之后，读库里最新的正文（GitHub 上改了正文由接活跟着改）
    const body =
      intakeTries === 0
        ? input.rawRequest
        : (await attempt(kit, 'taskRequest', () => acts.taskRequest({ ...kit.scope }))).rawRequest;
    intakeTries += 1;
    const dir = await judge(kit, 'specDir', { body, issueNumber: input.issueNumber });
    if ('error' in dir) {
      return {
        kind: 'needs-human',
        why: `认不出需求文档：${dir.error}。用 pnpm issue:new 开单（会写需求文档和这一行），或在单子正文里补上「文档：\`specs/<号>-<短名>/需求.md\`」、把需求文档合进主线，再点「继续」`,
      };
    }
    specDir = dir.ok;
    docs = dir.docs;
    status.specDir = specDir;
    if (!tree) {
      blockId = await newId(kit);
      branch = fusionBranch(input.issueNumber, blockId);
      status.branch = branch;
      const worktree = await attempt(kit, 'createWorktree', () =>
        acts.createWorktree({ ...kit.scope, repo: input.repo, branch }),
      );
      tree = worktree;
      head = worktree.baseSha;
      treeHead = worktree.baseSha;
    }
    return { kind: 'intaken' };
  };

  /** 2 规划：Lead 写方案（提交进 specs/…/方案.md）和任务简报，core 判；合格的先推上去（方案里被卫生检查拦下退回 Lead）。 */
  const doPlan = async (): Promise<FlowEvent> => {
    const current = need(setup, '流程配置');
    let fb: Feedback[] = [];
    let tries = 0;
    for (;;) {
      const out = await leadRun('plan', 'lead-plan', { feedback: fb });
      treeHead = out.head;
      const checked = await judge(kit, 'leadPlan', { output: out, specDir });
      if (!checked.ok) {
        status.lastProblem = checked.problems[0] ?? '方案不合格';
        fb = [{ kind: 'plan', summary: '方案或任务简报不合格，按下面几条改好再交', items: checked.problems }];
        if (tries >= limits.planRetries) {
          await park(kit, '方案几次都不合格', checked.problems.join('\n'));
          tries = 0;
        } else {
          tries += 1;
        }
        continue;
      }
      const pushed = await pushOrRework(checked.plan.head);
      if ('rework' in pushed) {
        fb = [reworkFeedback('push', pushed.rework)];
        continue;
      }
      plan = checked.plan;
      addChanged(plan.changedFiles);
      status.holds = normalizeHolds([...status.holds, ...plan.holds]);
      const ui = await judge(kit, 'filesUnder', { paths: current.uiPaths, files: plan.brief.files });
      uiWork = ui.length > 0;
      return {
        kind: 'planned',
        blocks: 1,
        small: plan.small,
        highRisk: plan.highRisk,
        matchesDiscussion: false,
      };
    }
  };

  /** 4 执行：副手干、Lead 验收；单模型模式、副手派不出由 Lead 自己干。收下的推上去。 */
  const doDispatch = async (): Promise<FlowEvent> => {
    const current = need(flow, '状态');
    const brief = need(plan, '方案').brief;
    const soloDone = (r: { ok: true } | { needsHuman: string }): FlowEvent =>
      'needsHuman' in r ? { kind: 'needs-human', why: r.needsHuman } : { kind: 'accepted' };
    if (current.mode === 'single') {
      const r = await leadWork('单模型模式：没有副手，Lead 自己写（0003 第 7 条）', feedback, brief);
      if (!('needsHuman' in r)) feedback = [];
      return soloDone(r);
    }
    const got = await sidekickRun(brief, feedback);
    if ('unavailable' in got) {
      const r = await leadWork(
        `副手派不出（${got.unavailable}）：Claude 单干（0003 第 7 条）`,
        feedback,
        brief,
      );
      if (!('needsHuman' in r)) feedback = [];
      return soloDone(r);
    }
    const del = got.delivery;
    if (!del.changedFiles) {
      feedback = [
        { kind: 'delivery', summary: '交回的没带改了哪些文件（引擎没查成），不收', items: [del.summary] },
      ];
      return { kind: 'rejected' };
    }
    for (const f of del.changedFiles) blockChanged.add(f);
    addChanged(del.changedFiles);
    const verdict = await leadAccept(del, brief);
    const decision = await judge(kit, 'acceptance', {
      brief,
      delivery: { changedFiles: [...blockChanged], tests: del.testsPassed ? 'green' : 'red' },
      lead: verdict,
      reworks: current.reworks,
    });
    if (decision.decision === 'accept') {
      const pushed = await pushOrRework(del.head);
      if ('rework' in pushed) {
        feedback = [reworkFeedback('push', pushed.rework)];
        return { kind: 'rejected' };
      }
      lastDelivery = { summary: del.summary, testsPassed: del.testsPassed };
      soloWhy = undefined;
      feedback = [];
      return { kind: 'accepted' };
    }
    status.lastProblem = decision.why[0] ?? 'Lead 没收下';
    feedback = [
      {
        kind: 'review',
        summary:
          decision.decision === 'takeover'
            ? '副手打回两次还没做好，Lead 自己接手，照下面几条改'
            : 'Lead 验收没收下，照下面几条改好再交',
        items: decision.why,
      },
    ];
    return { kind: 'rejected' };
  };

  /** 4 执行（Lead 接手）：副手打回满两次，或验证挡住时已经是 Lead 在写。 */
  const doTakeover = async (): Promise<FlowEvent> => {
    const r = await leadWork(
      '副手打回两次还没做好，Lead 接手（0003 第 5 条）',
      feedback,
      need(plan, '方案').brief,
    );
    if ('needsHuman' in r) return { kind: 'needs-human', why: r.needsHuman };
    feedback = [];
    return { kind: 'accepted' };
  };

  /** 5 验证：别家对照「怎么算做完」核推上去的头；挡了 Lead 看过、有证据就驳回。 */
  const doVerify = async (): Promise<FlowEvent> => {
    const current = need(setup, '流程配置');
    const n = need(flow, '状态').verifyRounds + 1;
    const files = [...changed];
    const ui = await judge(kit, 'filesUnder', { paths: current.uiPaths, files });
    let round = await verifyRound(kit, {
      round: n,
      repo: input.repo,
      specDir,
      head,
      title: input.title,
      request: input.rawRequest,
      branch,
      planSummary: need(plan, '方案').summary,
      changedFiles: files,
      uiWork: ui.length > 0 || undefined,
      models: current.models.verify,
    });
    let refused: string | undefined;
    if (round.final.verdict === 'block') {
      const blocking = await judge(kit, 'rebuttable', round.report);
      const rebut = await leadRun('rebut', 'lead-rebut', {
        material: { blocking, notes: round.final.notes },
      });
      if (rebut.rebuttals.length > 0) {
        const r = await rebutRound(kit, round, rebut.rebuttals);
        if (r.ok) round = r.round;
        else refused = r.why;
      }
    }
    rounds.push(round);
    if (round.final.verdict === 'block') {
      status.lastProblem = `开 PR 前别家验证第 ${n} 轮挡住了：${round.final.reasons[0] ?? ''}`;
      feedback = [
        {
          kind: 'review',
          summary: `开 PR 前别家验证第 ${n} 轮挡住了，照下面几条改`,
          items: [...round.final.reasons, ...(refused ? [`Lead 的驳回不成立：${refused}`] : [])],
        },
      ];
    }
    return { kind: 'verified', verdict: round.final.verdict };
  };

  /** 等 CI（绑在推上去的头上）：红了记下要修的，没查成的连着几次就停下等人。 */
  const waitCiEvent = async (): Promise<FlowEvent> => {
    const pr = need(prNumber, 'PR');
    const ci = await attempt(kit, 'waitCi', () =>
      acts.waitCi({ ...kit.scope, repo: input.repo, prNumber: pr, head }),
    );
    if (ci.state === 'unknown') {
      ciUnknown += 1;
      if (ciUnknown >= CI_UNKNOWN_LIMIT) {
        ciUnknown = 0;
        return {
          kind: 'needs-human',
          why: `CI 连着 ${CI_UNKNOWN_LIMIT} 次没查成（没查成不是没过）：${ci.detail ?? '没说原因'}`,
        };
      }
      return { kind: 'ci', state: 'unknown' };
    }
    ciUnknown = 0;
    if (ci.state === 'red') {
      status.lastProblem = `CI 没过：${ci.failedChecks.join('、') || '（没列出检查名）'}`;
      fix = {
        feedback: [
          {
            kind: 'ci',
            summary: 'CI 没过',
            items: [...ci.failedChecks, ...(ci.digest ? [ci.digest] : []), ...(ci.detail ? [ci.detail] : [])],
          },
        ],
      };
    }
    return { kind: 'ci', state: ci.state };
  };

  /** 6 开 PR：正文有方案摘要和验证结论（被卫生检查拦下让 Lead 重写摘要），再等 CI。 */
  const doOpenPr = async (): Promise<FlowEvent> => {
    if (prNumber === null) {
      const current = need(setup, '流程配置');
      const lines = rounds.length > 0 ? await verifyLines(kit, rounds) : null;
      let planSummary = need(plan, '方案').summary;
      let summary = lastDelivery?.summary ?? '';
      for (;;) {
        const parts = await judge(kit, 'fusionPr', {
          mode: current.mode,
          planSummary,
          summary,
          testsPassed: lastDelivery?.testsPassed ?? false,
          verify: lines,
          highRisk: need(plan, '方案').highRisk,
          planReviewSkipped,
          flowSource: current.source,
          ...(soloWhy ? { soloWhy } : {}),
        });
        const opened = await attemptOrRework(
          kit,
          'openPr',
          () =>
            acts.openPr({
              ...kit.scope,
              repo: input.repo,
              branch,
              head,
              title: input.title,
              body: {
                requirement: input.issueNumber,
                did: parts.did,
                verified: parts.verified,
                owed: parts.owed,
                specs: specDir,
                tier: parts.tier,
                changedFiles: [...changed],
              },
            }),
          prRework,
        );
        if ('rework' in opened) {
          prRework = opened.rework.carry;
          status.lastProblem = opened.rework.reason;
          const text = await leadRun('pr-text', 'lead-text', {
            feedback: [reworkFeedback('openPr', opened.rework)],
          });
          planSummary = text.summary;
          summary = text.did.join('\n');
          continue;
        }
        prRework = NO_REWORK;
        prParts = parts;
        prNumber = opened.ok.prNumber;
        status.prNumber = prNumber;
        await publish();
        break;
      }
    }
    return waitCiEvent();
  };

  /** Lead 写修复简报（core 判，不合格退回重写，几次都不合格挂起）。 */
  const leadFixBrief = async (fb: Feedback[]): Promise<Brief> => {
    let feedbackNow = fb;
    let tries = 0;
    for (;;) {
      const out = await leadRun('fix-brief', 'lead-brief', { feedback: feedbackNow });
      const checked = await judge(kit, 'brief', out.brief);
      if (checked.ok) return checked.brief;
      feedbackNow = [
        ...fb,
        { kind: 'plan', summary: '修复简报不合格，按下面几条改好再交', items: checked.problems },
      ];
      if (tries >= limits.planRetries) {
        await park(kit, '修复简报几次都不合格', checked.problems.join('\n'));
        tries = 0;
      } else {
        tries += 1;
      }
    }
  };

  /** 按修复简报修一轮：副手改、Lead 验收（打回最多 2 次，再不行 Lead 接手）；派不出、单模型模式由 Lead 自己修。 */
  const deliverFix = async (
    brief: Brief | undefined,
    fb: Feedback[],
  ): Promise<{ ok: true } | { needsHuman: string }> => {
    const current = need(flow, '状态');
    if (!brief || current.mode === 'single') return leadWork('单模型模式：Lead 自己修', fb);
    const fixChanged = new Set<string>();
    let reworks = 0;
    let feedbackNow = fb;
    for (;;) {
      const got = await sidekickRun(brief, feedbackNow);
      if ('unavailable' in got) {
        return leadWork(`副手派不出（${got.unavailable}）：Lead 自己修（0003 第 7 条）`, feedbackNow, brief);
      }
      const del = got.delivery;
      for (const f of del.changedFiles ?? []) fixChanged.add(f);
      addChanged(del.changedFiles);
      const accepted = await leadAccept(del, brief);
      let decision = await judge(kit, 'acceptance', {
        brief,
        delivery: {
          changedFiles: del.changedFiles ? [...fixChanged] : [],
          tests: del.testsPassed ? 'green' : 'red',
        },
        lead: accepted,
        reworks,
      });
      if (decision.decision === 'accept') {
        const pushed = await pushOrRework(del.head);
        if (!('rework' in pushed)) {
          lastDelivery = { summary: del.summary, testsPassed: del.testsPassed };
          return { ok: true };
        }
        // 推之前被拦下（卫生检查、并主线冲突）也算这一轮没收下：同一本打回账
        decision = await judge(kit, 'acceptance', {
          brief,
          delivery: { changedFiles: [...fixChanged], tests: del.testsPassed ? 'green' : 'red' },
          lead: { verdict: 'reject', why: pushed.rework.message },
          reworks,
        });
      }
      if (decision.decision === 'takeover') {
        return leadWork(
          '副手修了两次还没修好，Lead 接手（0003 第 5 条）',
          [{ kind: 'review', summary: '副手没修好，照下面几条改', items: decision.why }],
          brief,
        );
      }
      if (decision.decision === 'accept') continue; // 不会出现：打回账上写的是 reject
      reworks += 1;
      status.lastProblem = decision.why[0] ?? 'Lead 没收下';
      feedbackNow = [{ kind: 'review', summary: 'Lead 验收没收下，照下面几条改好再交', items: decision.why }];
    }
  };

  /** 合并队列退回后：队列可能把主线并进分支推上去了，工作树跟过去再改（不然改完一推就和远端分叉）。 */
  const followBranchHead = async () => {
    const pr = need(prNumber, 'PR');
    const worktree = need(tree, '工作树');
    const sync = await attempt(kit, 'syncMainline', () =>
      acts.syncMainline({
        ...kit.scope,
        repo: input.repo,
        prNumber: pr,
        branch,
        head,
        worktreePath: worktree.path,
      }),
    );
    // 冲突：队列没推成什么，树还在原来的头上；修的人照退回的意见在树里并主线
    if (sync.state === 'clean') {
      head = sync.head;
      treeHead = sync.head;
      status.head = head;
    }
  };

  /** 6 开了 PR 之后修一轮（CI 红、最终审查要改、合并前退回），修完推上去再等 CI。 */
  const doFix = async (): Promise<FlowEvent> => {
    const cause = fix;
    if (cause) {
      if (cause.follow) await followBranchHead();
      const single = need(flow, '状态').mode === 'single';
      const brief = cause.brief ?? (single ? undefined : await leadFixBrief(cause.feedback));
      const r = await deliverFix(brief, cause.feedback);
      if ('needsHuman' in r) return { kind: 'needs-human', why: r.needsHuman };
      fix = null;
    }
    return waitCiEvent();
  };

  /** 6 CI 绿了，Lead 最终审查：过了把结果.md 提交推上去；要改给修复简报，回去修一轮。 */
  const doFinalReview = async (): Promise<FlowEvent> => {
    let fb: Feedback[] = [];
    let tries = 0;
    const notes = rounds.at(-1)?.final.notes ?? [];
    for (;;) {
      const out = await leadRun('review', 'lead-review', { feedback: fb, material: { notes } });
      const checked = await judge(kit, 'leadReview', { output: out, specDir, committed: [...changed] });
      if (!checked.ok) {
        status.lastProblem = checked.problems[0] ?? '最终审查交回的不合格';
        fb = [{ kind: 'plan', summary: '最终审查交回的不合格，按下面几条改好再交', items: checked.problems }];
        if (tries >= limits.planRetries) {
          await park(kit, '最终审查交回的几次都不合格', checked.problems.join('\n'));
          tries = 0;
        } else {
          tries += 1;
        }
        continue;
      }
      const r = checked.review;
      treeHead = r.head;
      addChanged(r.changedFiles);
      if (r.verdict === 'fix') {
        status.lastProblem = `Lead 最终审查要改：${r.why}`;
        fix = {
          feedback: [{ kind: 'review', summary: `Lead 最终审查要改：${r.why}`, items: [r.why] }],
          brief: r.brief,
        };
        return { kind: 'final-reviewed', verdict: 'fix' };
      }
      if (r.head !== head) {
        const pushed = await pushOrRework(r.head);
        if ('rework' in pushed) {
          fb = [reworkFeedback('push', pushed.rework)];
          continue;
        }
      }
      review = { did: r.did, owed: r.owed };
      return { kind: 'final-reviewed', verdict: 'pass' };
    }
  };

  // ---- 7 合并：人闸、合并队列（和子任务同一套）

  const approvedFor = (h: string) => {
    const a = status.approval;
    return a?.state === 'approved' && a.head === h && status.holds.every((x) => a.holds.includes(x));
  };
  const needsApproval = (h: string) => status.holds.length > 0 && !approvedFor(h);

  /** 人闸：发卡请人批（编号先定好进历史，发卡重试只有一张卡），等批准或拒绝。拒了回返工意见，批了回 null。 */
  const awaitApproval = async (pr: number, h: string): Promise<Feedback[] | null> => {
    const approvalId = await newId(kit);
    const holds = [...status.holds];
    const what = describeHolds(holds);
    status.approval = { approvalId, holds, head: h, state: 'pending' };
    await waitFor(
      kit,
      'human',
      `等人批准：${what}（PR #${pr}）`,
      async () => {
        await attempt(kit, 'requestApproval', () =>
          acts.requestApproval({
            ...kit.scope,
            approvalId,
            holds,
            repo: input.repo,
            prNumber: pr,
            head: h,
            title: input.title,
            summary: need(plan, '方案').summary,
          }),
        );
        await condition(() => status.approval?.state !== 'pending');
      },
      { approvalId },
    );
    const decided = status.approval;
    if (decided?.state !== 'rejected') return null;
    return [
      {
        kind: 'review',
        summary: `人没批（${what}）：${decided.reason ?? '没写理由'}`,
        items: decided.reason ? [decided.reason] : [],
      },
    ];
  };

  /** 撤出合并队列（同子任务：直接发信号送不到就经活动 signalWithStart 送，顺手挡住晚到的排队）。 */
  const sendWithdraw = async (itemId: string): Promise<boolean> => {
    const withdraw = { itemId, subtaskWorkflowId: info.workflowId };
    try {
      await getExternalWorkflowHandle(mergeQueueWorkflowId(input.repo)).signal(withdrawSignal, withdraw);
      return true;
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.info('合并队列没在跑，撤出改经活动送去', { itemId, error: String(error) });
    }
    try {
      await acts.withdrawMerge({ repo: input.repo, ...withdraw, limits: input.limits ?? {} });
      return true;
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn('撤出没送到合并队列', { itemId, error: String(error) });
      return false;
    }
  };

  const withdrawUntilConfirmed = (itemId: string): Promise<MergeResult | null> =>
    waitFor(kit, 'merge-queue', '撤出合并队列，等队列确认', async () => {
      for (;;) {
        if (!(await sendWithdraw(itemId))) return mergeResults[itemId] ?? null;
        if (await condition(() => itemId in mergeResults, `${limits.mergeWaitMinutes} minutes`)) {
          return mergeResults[itemId] ?? null;
        }
      }
    });

  /** 排进合并队列等结果。暂停了、新加了人闸要等批准：还没合的撤出来，回 null（回头过暂停门、人闸再排）。 */
  const viaMergeQueue = async (pr: number, h: string): Promise<MergeResult | null> => {
    await gate(kit);
    mergeAttempt += 1;
    const item: MergeItem = {
      itemId: `${info.workflowId}#${mergeAttempt}`,
      subtaskWorkflowId: info.workflowId,
      taskId: input.taskId,
      subtaskId: need(blockId, '块的编号'),
      subtaskKey: BLOCK_KEY,
      repo: input.repo,
      prNumber: pr,
      branch,
      head: h,
      enqueuedAt: new Date().toISOString(),
    };
    pendingItemId = item.itemId;
    const interrupted = () => control.paused || needsApproval(h);
    for (;;) {
      await attempt(kit, 'enqueueMerge', () => acts.enqueueMerge({ item, limits: input.limits ?? {} }));
      await waitFor(kit, 'merge-queue', `PR #${pr} 在合并队列里`, () =>
        condition(() => item.itemId in mergeResults || interrupted(), `${limits.mergeWaitMinutes} minutes`),
      );
      const answered = mergeResults[item.itemId];
      if (answered) {
        pendingItemId = null;
        return answered;
      }
      if (interrupted()) {
        const confirmed = await withdrawUntilConfirmed(item.itemId);
        pendingItemId = null;
        return confirmed && confirmed.outcome !== 'withdrawn' ? confirmed : null;
      }
      // 太久没回话：再排一次（队列按条目编号去重，已经有结果的会补发）
    }
  };

  const doMerge = async (): Promise<FlowEvent> => {
    const pr = need(prNumber, 'PR');
    for (;;) {
      if (needsApproval(head)) {
        const rejected = await awaitApproval(pr, head);
        if (rejected) {
          status.lastProblem = rejected[0]?.summary ?? '人没批';
          fix = { feedback: rejected };
          return { kind: 'merge-returned' };
        }
        continue;
      }
      const result = await viaMergeQueue(pr, head);
      if (!result || result.outcome === 'withdrawn') continue;
      if (result.outcome === 'merged') {
        mergeCommit = result.mergeCommit;
        return { kind: 'merged' };
      }
      const after = await judge(kit, 'mergeReturn', {
        reason: result.reason,
        detail: result.detail,
        files: result.files,
        returnsSoFar: mergeReturns,
        limits,
      });
      mergeReturns += 1;
      status.rounds = { ...status.rounds, mergeReturn: mergeReturns };
      status.lastProblem = after.reason;
      if (after.action === 'requeue') {
        await waitFor(kit, 'retry', after.reason, () => sleep(`${after.delaySeconds} seconds`));
        continue;
      }
      if (after.action === 'rework') {
        fix = { feedback: after.feedback, follow: true };
        return { kind: 'merge-returned' };
      }
      // 退回次数到了：停下等人，人看过之后重新计
      mergeReturns = 0;
      return { kind: 'needs-human', why: `${after.reason}：${after.detail}` };
    }
  };

  /** 7 关单：评论正文经 decide 定一次（进历史）再发，重试、工人重启都是同一份。 */
  const doClose = async () => {
    const current = need(setup, '流程配置');
    const parts = need(prParts, 'PR 正文');
    const usage = Object.values(kit.usage).sort((a, b) =>
      a.model < b.model ? -1 : a.model > b.model ? 1 : 0,
    );
    const comment = await judge(kit, 'closeComment', {
      prNumber: need(prNumber, 'PR'),
      mergeCommit: need(mergeCommit, '合并提交'),
      did: review?.did ?? parts.did,
      elapsedMs: Date.now() - startedAt,
      offClockMs: offClockMs(kit),
      usage,
      verified: parts.verified,
      owed: [...(review?.owed ?? []), ...parts.owed],
      docs: need(docs, '需求文档'),
      flowSource: current.source,
      mode: current.mode,
    });
    await attempt(kit, 'closeIssue', () =>
      acts.closeIssue({
        ...kit.scope,
        repo: input.repo,
        issueNumber: input.issueNumber,
        reason: 'completed',
        comment,
      }),
    );
  };

  const run = async (): Promise<void> => {
    const got = await readSetup();
    setup = got;
    status.mode = got.mode;
    status.flowSource = got.source;
    if (got.source === 'org_default') {
      status.lastProblem = '这个项目没有 .fleet/flow.json，按全组织默认的流程配置派';
    }
    flow = await judge(kit, 'fusionStart', { mode: got.mode, mother: false, verifyRounds: got.verifyRounds });
    let action = await advance({ kind: 'discussed' });
    while (action !== 'close') {
      await gate(kit);
      let event: FlowEvent;
      switch (action) {
        case 'intake':
          event = await doIntake();
          break;
        case 'plan':
          event = await doPlan();
          break;
        case 'review-plan':
          // 方案评审（第 3 步）引擎还没接（#249）：照跳过，PR 正文「还欠什么」写明
          planReviewSkipped = true;
          status.lastProblem = '方案评审（第 3 步）引擎还没接，这次跳过（#249），PR 里写明';
          event = { kind: 'reviewed' };
          break;
        case 'dispatch':
          event = await doDispatch();
          break;
        case 'lead-takeover':
          event = await doTakeover();
          break;
        case 'verify':
          event = await doVerify();
          break;
        case 'open-pr':
          event = await doOpenPr();
          break;
        case 'recheck-ci':
          await waitFor(kit, 'retry', 'CI 没查成，隔一会儿再查', () => sleep('2 minutes'));
          event = await waitCiEvent();
          break;
        case 'fix-ci':
          event = await doFix();
          break;
        case 'final-review':
          event = await doFinalReview();
          break;
        case 'merge':
          event = await doMerge();
          break;
        case 'wait-human': {
          const why = need(flow, '状态').why ?? '停下等人';
          status.lastProblem = why;
          await park(kit, why, why);
          event = { kind: 'resumed' };
          break;
        }
        default:
          // 讨论（第 0 步在开单时）、母单级验证（一张单一块）走不到这里：走到了就是代码错了
          throw new Error(`Fusion 工作流不认这一步要做的事：${action}`);
      }
      action = await advance(event);
    }
    await doClose();
  };

  let outcome: FusionResult['state'];
  let problem: string | null = null;
  try {
    await main.run(run);
    outcome = 'done';
  } catch (error) {
    if (isCancellation(error)) {
      outcome = 'stopped';
      problem = '叫停';
    } else if (error instanceof TemporalFailure) {
      outcome = 'failed';
      problem = error.message;
    } else {
      // 代码错误：让工作流任务失败重试，修好代码、换上新工人就能接着跑。
      throw error;
    }
  }

  // 收尾不可取消：停会话、撤出合并队列、收工作树（没合并的先存档）。收不掉只报警，不改结论。
  await CancellationScope.nonCancellable(async () => {
    await stopActiveSessions(kit, problem ?? '收尾');
    status.runId = null;
    status.sessionId = null;
    const itemId = pendingItemId as string | null;
    if (itemId && !(await sendWithdraw(itemId))) {
      problem = `${problem ?? '收尾'}；撤出没送到合并队列，PR #${prNumber} 要人核对有没有合上`;
    } else if (itemId) {
      await waitFor(kit, 'merge-queue', '撤出合并队列，等队列确认', () =>
        condition(() => itemId in mergeResults, `${STOP_WITHDRAW_MINUTES} minutes`),
      );
      const confirmed = mergeResults[itemId];
      if (confirmed?.outcome === 'merged') {
        mergeCommit = confirmed.mergeCommit;
        problem = `${problem ?? '收尾'}时已经合进主线了，单子没关：要人关`;
      } else if (!confirmed) {
        problem = `${problem ?? '收尾'}；合并队列 ${STOP_WITHDRAW_MINUTES} 分钟没确认撤出，PR #${prNumber} 要人核对有没有合上`;
      }
    }
    const worktree = tree as Worktree | null;
    if (worktree) {
      try {
        await acts.removeWorktree({
          ...kit.scope,
          repo: input.repo,
          path: worktree.path,
          branch: worktree.branch,
          archive: outcome !== 'done',
        });
      } catch (error) {
        status.lastProblem = `工作树没收掉：${String(error)}`;
        await acts
          .raiseAlert({
            ...kit.scope,
            level: 'stuck',
            title: '工作树没收掉',
            detail: String(error),
            dedupeKey: `${info.workflowId}:worktree`,
          })
          .catch(() => undefined);
      }
    }
    status.state = outcome;
    status.waiting = null;
    status.doing = outcome === 'done' ? '做完了' : outcome === 'stopped' ? '已叫停' : `没做完：${problem}`;
    blockEnd = mergeCommit
      ? 'merged'
      : outcome === 'stopped'
        ? 'stopped'
        : outcome === 'failed'
          ? 'failed'
          : null;
    if (problem) status.lastProblem = problem;
    if (outcome === 'failed') {
      await acts
        .raiseAlert({
          ...kit.scope,
          level: 'stuck',
          title: `需求 #${input.issueNumber} 没做完`,
          detail: problem ?? '',
          dedupeKey: `${info.workflowId}:failed`,
        })
        .catch((error) => log.warn('报警没发出去', { error: String(error) }));
    }
    await publish();
  });

  return {
    taskId: input.taskId,
    state: outcome,
    prNumber,
    mergeCommit,
    docs: publishedDocs(),
    problem,
  };
}
