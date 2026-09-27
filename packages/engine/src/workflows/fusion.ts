// Fusion 工作流（docs/decisions/0003-fusion-flow.md 第 5–7、9、13 条；specs/214-Fusion工作流/）：一张单一个主导模型（Lead）
// 会话领着走 0–7 步，派一个副手（Sidekick）干界定清楚的活；引擎推分支、开 PR、合并、关单，不往主线直接写。
//   1 收单（引擎，不用模型）：看流程配置副本（读不到、认不出就停派报红），认单子正文里指的需求文档目录，建工作树。
//     没指、正文写全了需求的（引擎对账开的单，#295）照收：目录按标题取短名，需求文档照正文写好交给 Lead。
//   2 规划：Lead 读需求文档和代码，把方案写进 specs/<号>-<短名>/方案.md 提交，交方案摘要和任务简报（core 判），先推上去。
//     照正文写的需求文档由 Lead 原样和方案一起提交；这种单开 PR 前验证照单子正文核，「对应计划」照单子挂的版本写。
//   3 方案评审：小单跳过；不算小单的引擎还没接评审（#249），照跳过、PR 里写明。
//   4 执行：副手照简报在同一棵树上干（按流程配置派别家的便宜路由；派不出、没额度就 Lead 自己干）；副手干完 Lead 续同一个
//     会话验收：收下 / 打回（最多 2 次）/ Lead 接手（core 的 decideAcceptance）。Lead 验收时副手不在跑（一步一步来）。
//   5 验证：推上去之后别家验证（workflows/verify.ts）；挡了 Lead 可以拿证据驳回，回第 4 步改，最多 2 轮。
//   6 开 PR（正文：方案摘要、验证结论）→ 等 CI；红了 Lead 写修复简报、副手改，最多 3 轮；绿了 Lead 最终审查、结果.md 提交。
//   7 合并队列合并（碰人闸的等人批）→ 关单（评论：改了什么、用时、各模型额度；正文经 decide 定一次再发，重试不重写）。
// 走哪一步只听 core 的 nextFlow（经 decide，进历史）。编号和需求工作流同一个（req:<仓>#<号>）：驾驶舱、fleet 命令的信号照旧。
// 步骤交界（stepBoundary）是 #215（存档点、换 Lead）、#216（每步耗时和额度进库）要接的地方。
// 问创始人不挡路（#259）：会话 fleet ask 当场按推荐接着干，他晚到、改选了别的回答在存档点（每一步开工前，checkpoint）读库
// 交给 Lead 照改——没开 PR 的回第 4 步，开了 PR 的算修一轮，改完推上去记 applied_at；开 PR 写「按推荐先做了」一栏、关单记数。
// 合进去以后才到的由对账开后续单（jobs/ask-issues.ts）。
// 这里是工作流代码：判断只经 judge、编号只经 newId、core 只许 import type；改调度顺序要 patched()（kit.ts 头注释）。

import type {
  Brief,
  FlowAction,
  FlowEvent,
  FlowState,
  FusionPrFacts,
  FusionPrParts,
  FusionSetup,
  LeadPlan,
  Step,
  TaskAsk,
} from '@fleet-dao/core';
import type { StageKind, SubtaskState, TaskState } from '@fleet-dao/shared';
import {
  CancellationScope,
  condition,
  getExternalWorkflowHandle,
  isCancellation,
  log,
  patched,
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
  KeepVerifierRequest,
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
import { type SyncMainlineOutcome, syncMainlineNow } from './sync-mainline.ts';
import { rebutRound, type VerifyRound, verifyLines, verifyRound } from './verify.ts';

type Setup = Extract<FusionSetup, { ok: true }>;
type Docs = { requirement: string; plan: string; result: string };
type LeadOutput = Extract<SessionOutput['kind'], `lead-${string}` | 'delivery'>;
type Delivery = OutputOf<'delivery'>;

/** 叫停收尾时等合并队列确认撤出多久（和子任务一样）。 */
const STOP_WITHDRAW_MINUTES = 10;
/** CI 连着几次没查成就停下等人（没查成不是没过，也不能一直空转）。 */
const CI_UNKNOWN_LIMIT = 3;
/**
 * 第二意见「必须改」连着几轮还是改不好就停下等人（#253，design 第五节「审一轮、最多 2 轮」）：和 CI 红共用「开了 PR
 * 之后修一轮」的账（ciRounds，最多 3 轮），这里另加一道更紧的闸，专盯第二意见自己。
 */
const SECOND_OPINION_ROUND_LIMIT = 2;
/**
 * 合并闸报「等第二意见」（或第二意见状态还没被合并闸重算追上）却查不到别的失败检查，连着几次都这样就停下等人：
 * 多半是别的原因（认领对得上、关单要带结果……），不是第二意见能解的，也不能一直空转（#253）。
 */
const GATE_ONLY_RED_LIMIT = 3;
/**
 * 合并闸自己的提交状态名（@fleet-dao/conventions 的 merge-gates.ts GATE_CONTEXT）：写死在这里、不从那个包
 * 运行时导入——工作流文件会被 Temporal 的 webpack 打进沙盒执行的包，那个包的入口 index.ts 还带出 node:path
 * 这类 Node 内置模块，webpack 打不出沙盒包（worker.test.ts 实测过，见 test/rules 里钉住这个字符串的测试）。
 */
export const MERGE_GATE_CONTEXT = 'merge-gate';
/**
 * 第二意见接进 waitCiEvent（#253）：在途任务的历史里没调过 checkHighRisk / postSecondOpinion 这两个新活动，
 * 换上新代码直接调会报「历史对不上」（replay.test.ts 钉住）；没打这个标记（老历史）就照老步序走，一个字都不多问。
 */
const SECOND_OPINION_PATCH = 'second-opinion-253';
/** 在合并队列里的这一块叫什么（合并条目、快照里的块）。一张单一块（母单按块循环归 #252）。 */
const BLOCK_KEY = 'fusion';
/**
 * 问创始人不挡路（#259）接进来的几处（存档点读晚到的回答、开 PR 写「按推荐先做了」、关单记数）都多调了活动和判断：
 * 接这道改法之前起的执行，重放时照老样子一处都不调。
 */
const ASK_PATCH = 'ask-not-blocking';
/**
 * 任务边界并主线、已开 PR 的单定时检查主线（创始人 09-28 凌晨拍：「正在干活的工人都拉一下主线内容」）：多调了
 * syncMainline 活动、把等批准/排合并队列的单个 condition 拆成了按 chunk 轮询——接这道改法之前起的执行，
 * 重放时一处都不多调、等待还是原来那一个不设超时/整段超时的 condition（syncMainlineNow、applySync 见 sync-mainline.ts）。
 */
const MAINLINE_SYNC_PATCH = 'mainline-sync-boundary';
/**
 * 存档点看晚到的回答的几步：规划做完、合进去之前（core 的 nextFlow 收「changed」的也是这几步）。规划之前方案还没有，
 * 读到的留到规划之后；合进去以后的归对账开后续单。
 */
const CHECKPOINT_STEPS: readonly Step[] = ['review', 'execute', 'verify', 'pr', 'final-review', 'merge'];
/**
 * 开 PR 前验证还在前头的几步（规划做完、开 PR 之前；验证挡了回第 4 步也还在）：这时候选副手、Lead 换路由都要给验证留一家。
 * 开了 PR 之后验证就过去了，不再管。
 */
const VERIFY_AHEAD: readonly Step[] = ['review', 'execute', 'verify'];

/** 交给 Lead、还没照改完的：他晚到、改选了别的回答（库里 asks 的编号）和交给 Lead 的话（core 的 changeLine）。 */
interface Change {
  askIds: string[];
  items: string[];
}

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
  'sync-mainline': 'CI 报和主线冲突，自动并主线',
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
  /**
   * 正文写全了需求、没有需求文档的单（#295，引擎开的后续单、巡检单）：照正文写的需求文档。Lead 在第 2 步原样提交进
   * docs.requirement、随 PR 进主线；开 PR 前验证照正文核，「对应计划」照单子挂的版本写。有需求文档的单是 null。
   */
  let requirementSeed: string | null = null;
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
  /** 这张单各步提交改到过的文件（一轮轮累计）：进度段的文档、最终审查核结果.md 用。 */
  const changed = new Set<string>();
  /**
   * 推上去的头相对主线的净改动（pushBranch 交回的，推之前刚并了最新主线）：开 PR 前验证判界面、给验证方的清单、PR 正文按它。
   * changed 是累计的：撤回了的、老版端口把会话并进来的主线也算成这一步改的（#293：主线上别人改的页面代码让验证按界面类派，
   * 没人可派）都还在里面。老版端口推的（重放在途任务的历史）没交它，是 null，照旧按 changed。
   */
  let netChanged: string[] | null = null;
  /**
   * 副手这一块改到过的，几轮累计（每轮交回的只有这一轮的改动：前一轮碰了、这一轮没再碰的也要算上）。撤回了的也还在里面：
   * 拿它硬挡就是 #246 的死结（撤了也过不了），所以简报外的归 Lead 判；#252 接上别的块的硬挡时要换成净改动。
   */
  const blockChanged = new Set<string>();
  /** Lead 验收时收下的简报外文件（decideAcceptance 交回的 outside）：状态里写一句，进 PR 正文和关单评论。 */
  const outsideAccepted = new Set<string>();
  let lastDelivery: { summary: string; testsPassed: boolean } | null = null;
  /** 这一块由 Lead 自己写的原因（副手写的是 undefined）。 */
  let soloWhy: string | undefined;
  let planReviewSkipped = false;
  const rounds: VerifyRound[] = [];
  let prNumber: number | null = null;
  /** 开 PR 时拼正文用的事实：开了 PR 之后 Lead 又收下简报外的，照它重拼一份给关单评论（PR 正文开出去就不改了）。 */
  let prFacts: FusionPrFacts | null = null;
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
  /** 第二意见（#253）：已经贴过状态的头（同一个头只请一次，头变了要重新请）；「必须改」的轮数，封顶见上面的常量。 */
  let soHead: string | null = null;
  let soRounds = 0;
  /** 合并闸只报「等第二意见」（或还没追上我们刚贴的状态）却没有别的失败检查，连着几次——不占 CI 没查成、也不占修的轮数。 */
  let gateOnlyRetries = 0;
  let intakeTries = 0;
  /** 存档点交给 Lead、还没照改完的（#259）：照改的那一轮推上去才记 applied_at、清掉。 */
  let change: Change | null = null;

  const need = <T>(value: T | null | undefined, what: string): T => {
    if (value === null || value === undefined) throw new Error(`Fusion 工作流走到这里却没有${what}`);
    return value;
  };
  const addChanged = (files: readonly string[] | undefined) => {
    for (const f of files ?? []) changed.add(f);
  };
  /**
   * 记下 Lead 收下的简报外文件（推上去之后才记）：状态里写一句带理由。交回有没有新记下的。
   * 旧版代码判的结果（重放在途的任务）没有 outside：那时简报外的一律不收，收下的本来就一个都没有。
   */
  const noteOutside = (files: readonly string[] | undefined, why: string): boolean => {
    if (!files?.length) return false;
    status.lastProblem = `简报外改了：${files.join('、')}（主导收下：${why}）`;
    const before = outsideAccepted.size;
    for (const f of files) outsideAccepted.add(f);
    return outsideAccepted.size > before;
  };

  // ---- 写库给驾驶舱、原地更新 issue 的进度段（尽力而为，失败不挡流程）

  let lastSaved = '';
  let lastPublished = '';
  /** 收尾时这一块的结局（叫停、没做完）；走在路上是 null，按步骤算。 */
  let blockEnd: SubtaskState | null = null;
  const publish = async () => {
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
      // 认出需求文档目录之前不写目录和文档（写空的会把库里上一轮、重开前记下的冲掉）；状态、在做什么照写，停在收单的也看得见
      ...(docs ? { specDir, docs: publishedDocs() } : {}),
      lastProblem: status.lastProblem,
      // 这一轮用的流程配置读自仓里还是全组织默认：驾驶舱要标出后者（0003 第 9 条）。开工前的判完才有
      ...(setup ? { flowSource: setup.source } : {}),
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
    // 公开的 issue 进度段只写已经公开的东西（单子标题、步骤、PR 号、文档路径），不写 Lead 写的简报；认出需求文档之前不写
    if (!docs) return;
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
  /** 进度段、快照里的文档：需求文档一直在（照正文写的那份提交了才写，#295）；方案、结果提交了才写。 */
  const publishedDocs = (): { requirement?: string; plan?: string; result?: string } => {
    if (!docs) return {};
    return {
      ...(requirementSeed === null || changed.has(docs.requirement) ? { requirement: docs.requirement } : {}),
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

  // ---- 问创始人不挡路（#259）：他晚到的回答

  /** 这张单问过创始人的（库里 asks）。读不到按失败分流走（重试、挂起报警），不当成一条都没问过。 */
  const readAsks = (): Promise<TaskAsk[]> => attempt(kit, 'taskAsks', () => acts.taskAsks({ ...kit.scope }));

  const changeFeedback = (c: Change): Feedback => ({
    kind: 'answer',
    summary:
      '创始人晚到的回答：没等他回时按推荐先做的，他改选了别的，照他选的改（改完的推上去，引擎记下已照改）',
    items: c.items,
  });

  /**
   * 存档点（每一步开工前）：读这张单「选了别的、还没照改」的回答，交给 Lead（core 的 lateChanges）。执行、开了 PR 之后修一轮
   * 这两种自己会接（doDispatch、doTakeover 先把本来的活做完再照改，doFix 并进这一轮）；别的几步经 core 的 nextFlow 改道：
   * 没开 PR 的回第 4 步执行，开了 PR 的算修一轮（和 CI 红同一本账，修满了停下等人）。
   */
  const checkpoint = async (action: FlowAction): Promise<FlowAction> => {
    if (!CHECKPOINT_STEPS.includes(need(flow, '状态').step) || !patched(ASK_PATCH)) return action;
    const late = await judge(kit, 'lateChanges', { asks: await readAsks(), handed: change?.askIds ?? [] });
    if (late.askIds.length > 0) {
      change = {
        askIds: [...(change?.askIds ?? []), ...late.askIds],
        items: [...(change?.items ?? []), ...late.items],
      };
      status.lastProblem = `创始人晚到的回答改选了别的（${late.askIds.length} 条），交给 Lead 照改`;
    }
    // 本来的活还没交过（规划完、头一次派活之前）：先照原方案做，收下推上去以后的存档点再照改，不跳过这之间的步骤
    if (!change || !lastDelivery) return action;
    if (action === 'dispatch' || action === 'lead-takeover' || action === 'fix-ci') return action;
    const prOpen = prNumber !== null;
    if (prOpen) fix = fix ?? { feedback: [] };
    return advance({ kind: 'changed', prOpen });
  };

  /** 照改的那一轮推上去了：记 applied_at（卡片原地改成「已生效」），清掉。 */
  const changeApplied = async (done: Change) => {
    await attempt(kit, 'markAsksApplied', () => acts.markAsksApplied({ ...kit.scope, askIds: done.askIds }));
    change = null;
    status.lastProblem = `创始人改选的 ${done.askIds.length} 条已照改`;
  };

  /**
   * 还没开 PR、本来的活已经收下推上去了：照他改选的改一轮（Lead 写照改的简报、副手改、Lead 验收，和开了 PR 之后修一轮同一套）；
   * 单模型模式、这一块 Lead 已经接手的由 Lead 自己改。改完推上去才记照改了，接着回去验证。
   */
  const applyChange = async (c: Change, solo: boolean): Promise<FlowEvent> => {
    const fb = [changeFeedback(c)];
    // PR 正文「这一块由 Lead 自己写」照旧写本来的原因（单模型模式、副手打回两次……），不换成照改这一轮的
    const keep = soloWhy;
    const r = solo
      ? await leadWork('创始人改选了别的：Lead 照他选的改（#259）', fb, need(plan, '方案').brief)
      : await deliverFix(await leadFixBrief(fb), fb);
    if (solo && keep !== undefined) soloWhy = keep;
    if ('needsHuman' in r) return { kind: 'needs-human', why: r.needsHuman };
    await changeApplied(c);
    return { kind: 'accepted' };
  };

  // ---- 会话：Lead 一张单一个会话、按步续用；副手也续同一个

  /**
   * 选路要给开 PR 前验证留一家（store-ports 的 keepVerifier，0003 第 5 条「验证只派别家」）：选副手、Lead 换路由会给这张单
   * 加一个写手族，加上以后验证可能一家都派不出（界面类的活 GPT 不验，#293 在法国干完才挂起「没有别家可验」、干等）。
   * 规划完才知道算不算界面类；开了 PR 验证就过去了；这张单不验的（单模型模式、不算高风险，和 core 的 nextFlow 同一条）不管。
   * 留不下时：副手交派不出（Lead 自己干），Lead 照常选；都当场报警「这张单做完没人能验」。
   */
  const keepVerifierFor = (
    otherwise: KeepVerifierRequest['otherwise'],
    spare: string[] = [],
  ): KeepVerifierRequest | undefined => {
    const f = flow;
    if (!plan || !f || !VERIFY_AHEAD.includes(f.step)) return undefined;
    if (!(f.mode === 'fusion' || f.highRisk)) return undefined;
    return {
      models: need(setup, '流程配置').models.verify,
      uiWork,
      otherwise,
      ...(spare.length > 0 ? { spare } : {}),
    };
  };

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
      // 续不上原来那条、换了别族的 Lead 也是多一个写手族：照样给验证留一家，留不下照常选、报警（Lead 非派不可）
      keepVerifier: keepVerifierFor('any'),
    });
    lead.sessionId = got.sessionId;
    lead.routeId = got.route.routeId;
    lead.family = got.route.family;
    status.lead = { sessionId: got.sessionId, routeId: got.route.routeId, family: got.route.family };
    return got.output;
  };

  /**
   * 副手干一轮：照简报，在同一棵树上，按流程配置的副手模型顺序派别家（避开 Lead 那一族：Lead 那家的额度留给 Lead，0002 第 5 条）。
   * 开 PR 前验证还在前头时，避开 Lead 那一族只是「先避开」：别家的副手都会让验证没人可派，才派和 Lead 同族的新会话（同族
   * 不多加写手族）；能给验证留一家的都派不出就交派不出。派不出（没接好、没额度、连着做不好、留不下验证）交回 unavailable，
   * 调用方让 Lead 自己干（0003 第 7 条）。
   */
  const sidekickRun = async (
    brief: Brief,
    fb: Feedback[],
  ): Promise<{ delivery: Delivery } | { unavailable: string }> => {
    const current = need(setup, '流程配置');
    const leadFamilies = lead.family ? [lead.family] : [];
    const keep = keepVerifierFor('none', leadFamilies);
    const got = await tryStage(kit, {
      stage: uiWork ? 'ui' : 'execute',
      expect: 'delivery',
      brief: sessionBrief({ task: brief, touches: brief.files, acceptance: brief.acceptance, feedback: fb }),
      resumeSessionId: side.sessionId,
      stickRouteId: side.routeId,
      worktreePath: need(tree, '工作树').path,
      baseHead: treeHead,
      // 给验证留一家时 Lead 那一族挪进 keepVerifier.spare（先避开）；不用管验证的（开了 PR 之后）照旧整族避开
      avoidFamilies: keep || leadFamilies.length === 0 ? undefined : leadFamilies,
      uiWork: uiWork || undefined,
      models: current.models.sidekick,
      keepVerifier: keep,
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
    netChanged = pushed.ok.changedFiles ?? null;
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
    const dir = await judge(kit, 'specDir', { body, issueNumber: input.issueNumber, title: input.title });
    if ('error' in dir) {
      return {
        kind: 'needs-human',
        why: `认不出需求文档：${dir.error}。用 pnpm issue:new 开单（会写需求文档和这一行），或在单子正文里补上「文档：\`specs/<号>-<短名>/需求.md\`」、把需求文档合进主线，或者把需求写全在正文里（要有写了字的「## 怎么算做完」），再点「继续」`,
      };
    }
    specDir = dir.ok;
    docs = dir.docs;
    requirementSeed = dir.requirement ?? null;
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
      // 还没有需求文档的（#295）：照正文写好的那份交给 Lead，和方案一起原样提交
      const out = await leadRun('plan', 'lead-plan', {
        feedback: fb,
        ...(requirementSeed === null ? {} : { material: { requirementText: requirementSeed } }),
      });
      treeHead = out.head;
      const checked = await judge(kit, 'leadPlan', {
        output: out,
        specDir,
        ...(requirementSeed === null ? {} : { withRequirement: true }),
      });
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
    await syncWorktreeAtBoundary('execute');
    const current = need(flow, '状态');
    const brief = need(plan, '方案').brief;
    // 存档点交过来的、他改选了别的（#259）：本来的活已经收下推上去了才照改；还没收下的先把本来的活做完，下一个存档点再照改
    if (change && lastDelivery) return applyChange(change, current.mode === 'single');
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
        // Lead 不一定是 Claude（创始人 09-27 夜：拼车号和 Grok 混用当 Lead），这句进 PR 正文，不写死哪一家
        `副手派不出（${got.unavailable}）：Lead 单干（0003 第 7 条）`,
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
      // 一张单一块，#252 母单多块时填别的块的简报
      otherBlocks: [],
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
      noteOutside(decision.outside, verdict.why);
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
    await syncWorktreeAtBoundary('execute');
    if (change && lastDelivery) return applyChange(change, true);
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
    await syncWorktreeAtBoundary('verify');
    const current = need(setup, '流程配置');
    // 第几轮按验过几次数（不按没过的轮数）：验过了、他又改选了别的回去照改（#259），再验是新的一轮
    const n = rounds.length + 1;
    // 判界面、给验证方的清单：送检的头相对主线改了什么（不按累计的，见 netChanged）
    const files = netChanged ?? [...changed];
    const ui = await judge(kit, 'filesUnder', { paths: current.uiPaths, files });
    let round = await verifyRound(kit, {
      round: n,
      repo: input.repo,
      specDir,
      // 还没有需求文档的（#295）：主线上没有，「怎么算做完」照单子正文核（分支上的写这张单的能改，不读）
      ...(requirementSeed === null ? {} : { criteriaFromBody: true }),
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

  /** 请第二意见的会话简报：审哪个 PR 的哪个头，对照的「怎么算合格」「只许改的文件」照方案的任务简报。 */
  const secondOpinionBrief = (prNum: number, atHead: string): SessionBrief => ({
    title: input.title,
    request: input.rawRequest,
    specDir,
    acceptance: need(plan, '方案').brief.acceptance,
    touches: need(plan, '方案').brief.files,
    feedback: [],
    answers: [],
    branch,
    prNumber: prNum,
    head: atHead,
  });

  type SecondOpinionOutcome =
    | { kind: 'skip' }
    | { kind: 'pass' }
    | { kind: 'changes'; items: string[] }
    | { kind: 'needs-human'; why: string };

  /**
   * 先审后合（#253）：这个头碰没碰高风险路径（迁移里有删改语句、碰安全，清单和判法和合并闸同一份）；碰了就派别家审
   * 一轮，结论写回 GitHub 的 second-opinion 提交状态和一条评论（合并闸认的就是这个）。同一个头只请一次：头没变、
   * 已经贴过的不再重请。
   * 派别家和第 5 步「开 PR 前验证」同一套（帅位 2026-09-27 夜挑错：路由配置里 review 阶段的排法可能是 grok-4.7、
   * deepseek-flash、opus-5.5，写这张单的要是 grok 就可能挑到自己审自己）：整族避开写这张单用过的族（authorFamilies），
   * 界面单再避开 GPT（uiWork，禁令按 stage 'ui' 判，见 shared 的 bans.ts）；挑不出别家（runStage 自己的兜底梯）
   * 停下等人，原因写清，不拿同族顶。
   * 「必须改」的反馈和 CI 红走同一条账（fix，由 doFix 派会话去改）；连着 SECOND_OPINION_ROUND_LIMIT 轮还是必须改
   * 才停下等人。
   */
  const secondOpinionRound = async (pr: number, atHead: string): Promise<SecondOpinionOutcome> => {
    if (atHead === soHead) return { kind: 'skip' };
    const risk = await attempt(kit, 'checkHighRisk', () =>
      acts.checkHighRisk({ ...kit.scope, repo: input.repo, prNumber: pr }),
    );
    if (risk.hits.length === 0) {
      soHead = atHead;
      return { kind: 'skip' };
    }
    const authors = await attempt(kit, 'authorFamilies', () => acts.authorFamilies({ ...kit.scope }));
    const uiPaths = need(setup, '流程配置').uiPaths;
    const files = netChanged ?? [...changed];
    const ui = await judge(kit, 'filesUnder', { paths: uiPaths, files });
    const got = await runStage(kit, {
      stage: 'review',
      expect: 'review',
      brief: secondOpinionBrief(pr, atHead),
      avoidFamilies: authors.families,
      uiWork: ui.length > 0 || undefined,
      noRouteTitle: `没有别家可请第二意见：写这张单的是 ${authors.families.join('、')} 族，第二意见只派别家，不拿同族顶`,
    });
    const verdict: 'pass' | 'changes' = got.output.review.verdict === 'pass' ? 'pass' : 'changes';
    const blocking = got.output.review.findings.filter((f) => f.severity === 'blocking');
    await attempt(kit, 'postSecondOpinion', () =>
      acts.postSecondOpinion({
        ...kit.scope,
        repo: input.repo,
        prNumber: pr,
        head: atHead,
        round: soRounds + 1,
        hits: risk.hits,
        verdict,
        findings: got.output.review.findings,
        model: got.route.modelId,
      }),
    );
    soHead = atHead;
    if (verdict === 'pass') return { kind: 'pass' };
    soRounds += 1;
    if (soRounds >= SECOND_OPINION_ROUND_LIMIT) {
      return {
        kind: 'needs-human',
        why: `第二意见连着 ${soRounds} 轮都要改，停下等人：${
          blocking.map((f) => f.text).join('；') || '没写具体条目'
        }`,
      };
    }
    return { kind: 'changes', items: blocking.map((f) => (f.file ? `${f.file}：${f.text}` : f.text)) };
  };

  /**
   * 等 CI（绑在推上去的头上）：红了记下要修的；没查成的连着几次就停下等人；和主线冲突交给 core 走「并主线」
   * （不算没查成的次数，见 doSyncMainline）；头被改写了（github 包已经排除了「新头含着老头」的良性情形）不是
   * 重试或并主线能接的，直接停下等人，不占没查成的次数。
   * 第二意见（#253）和等 CI 同时跑（design 第五节「第二意见一轮、和测试同时跑」）：碰了高风险路径就顺带请一轮，
   * 「必须改」并进这一轮的修一轮反馈（和 CI 红同一本账）；合并闸报「等第二意见」（MERGE_GATE_CONTEXT）而没有别的失败检查，
   * 不当 CI 红去修一轮（Lead 改不了合并闸自己的状态，见需求：#253 第 3 条），多半是状态还没被合并闸重算追上，
   * 稍等再查一次，连着几次都这样才停下等人。
   */
  const waitCiEvent = async (): Promise<FlowEvent> => {
    const pr = need(prNumber, 'PR');
    const atHead = head;
    // patched() 本身也要记进历史、调用次数和顺序不能跟着分支变，所以先问一次存起来，不要在 Promise.all 里现问。
    const soOn = patched(SECOND_OPINION_PATCH);
    const [ci, so] = await Promise.all([
      attempt(kit, 'waitCi', () =>
        acts.waitCi({ ...kit.scope, repo: input.repo, prNumber: pr, head: atHead }),
      ),
      soOn ? secondOpinionRound(pr, atHead) : Promise.resolve<SecondOpinionOutcome>({ kind: 'skip' }),
    ]);
    if (so.kind === 'needs-human') return { kind: 'needs-human', why: so.why };
    if (ci.state === 'diverged') {
      // ci.detail（ciResultOf 拼的）已经写清是哪个头变成了哪个头、为什么不认：不再重复一遍。
      return { kind: 'needs-human', why: ci.detail ?? 'PR 的头变了，且新头不含老头（像是被强推改写了）' };
    }
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
    if (ci.state === 'conflict') {
      status.lastProblem = `CI 报和主线冲突，GitHub 没给它起：${ci.detail ?? ''}`;
      return { kind: 'ci', state: 'conflict' };
    }
    const feedback: Feedback[] = [];
    if (ci.state === 'red') {
      // 合并闸自己不算「Lead 能改代码解决」的失败：碰了高风险路径本来就该等 second-opinion 的空窗，不报给 Lead
      // （老历史没打过这个标记：照老步序一个字都不改，failedChecks 原样报给 Lead）
      const realFails = soOn ? ci.failedChecks.filter((c) => c !== MERGE_GATE_CONTEXT) : ci.failedChecks;
      if (realFails.length > 0) {
        feedback.push({
          kind: 'ci',
          summary: 'CI 没过',
          items: [...realFails, ...(ci.digest ? [ci.digest] : []), ...(ci.detail ? [ci.detail] : [])],
        });
      }
    }
    if (so.kind === 'changes') {
      feedback.push({
        kind: 'review',
        summary: `第二意见第 ${soRounds} 轮：必须改`,
        items: so.items,
      });
    }
    if (feedback.length > 0) {
      status.lastProblem = feedback[0]?.summary ?? '';
      fix = { feedback };
      return { kind: 'ci', state: 'red' };
    }
    if (ci.state === 'red') {
      // 走到这里：合并闸红了，但既不是第二意见要改（above 已经处理过），也没有别的失败检查——多半是合并闸还没
      // 追上刚贴的状态（second-opinion 的状态写上去、merge-gate.yml 重算要几秒到几十秒），稍等再查一次。
      gateOnlyRetries += 1;
      if (gateOnlyRetries >= GATE_ONLY_RED_LIMIT) {
        gateOnlyRetries = 0;
        return {
          kind: 'needs-human',
          why: `合并闸连着 ${GATE_ONLY_RED_LIMIT} 次只报「${MERGE_GATE_CONTEXT}」红、没有别的失败检查，这个头也已经贴过第二意见：多半是别的原因（认领对得上、关单要带结果……），要人看`,
        };
      }
      return waitCiEvent();
    }
    gateOnlyRetries = 0;
    return { kind: 'ci', state: ci.state };
  };

  /**
   * 并一次主线（sync-mainline.ts 的 syncMainlineNow），把结果套用到这张单自己的状态上：干净且并出了新头就
   * 记下（工作树已经被端口快进过去，见 github-ports.ts 的 syncMainline）；真冲突写一句状态，`setFixOnConflict`
   * 才顺手给 `fix` 填好返工意见（只有 CI 报冲突走 fix-ci 那条路要——任务边界/定时检查这两处不占这条路，冲突了
   * 也不挡这一步，交给后面真正等 CI 时再处理，不然会给一个没人会去读的 `fix` 埋着）。
   * 「一个函数两处（这里数下面几处调用的话是四处）共用」：CI 报冲突时（doSyncMainline）、派新会话/开 PR 前的
   * 任务边界（syncWorktreeAtBoundary）、等批准/排合并队列时的定时检查（awaitApproval、viaMergeQueue）都用它。
   */
  const applySync = async (
    label: string,
    opts: { setFixOnConflict?: boolean } = {},
  ): Promise<SyncMainlineOutcome & { changed: boolean }> => {
    const worktree = need(tree, '工作树');
    const before = head;
    const outcome = await syncMainlineNow(kit, acts, {
      ...kit.scope,
      repo: input.repo,
      prNumber: prNumber ?? undefined,
      branch,
      head: before,
      worktreePath: worktree.path,
    });
    if (outcome.state === 'conflict') {
      status.lastProblem = `${label}：自动并主线遇到冲突：${outcome.conflictFiles.join('、') || '（没列出文件）'}`;
      if (opts.setFixOnConflict) {
        fix = {
          feedback: [
            {
              kind: 'conflict',
              summary: '自动并主线遇到冲突，请在分支上把最新主线并进来、解决冲突后提交',
              items: outcome.conflictFiles,
            },
          ],
        };
      }
      return { ...outcome, changed: false };
    }
    const changed = outcome.head !== before;
    if (changed) {
      head = outcome.head;
      treeHead = outcome.head;
      status.head = head;
      status.lastProblem = `${label}：主线动过，自动并进工作树（新头 ${head.slice(0, 7)}）`;
    }
    return { ...outcome, changed };
  };

  /**
   * 任务边界并主线（创始人 09-28 凌晨拍：「正在干活的工人都拉一下主线内容」）：没有会话在跑、工作树冻结的时候
   * （每一步真正派新会话、或开 PR 之前，一步只点一次，不是每一步都点——`tag` 去重）主线比这张单的分支新就并
   * 进来；最佳努力，并不上（真冲突）不挡这一步（不设 setFixOnConflict），等真开了 PR、CI 报冲突时走现成那条
   * 路（doSyncMainline）处理，别在这里另起一套「开 PR 前的冲突要修几轮」的账。没有工作树（还没建树）就跳过。
   */
  const boundarySynced = new Set<string>();
  const syncWorktreeAtBoundary = async (tag: string): Promise<void> => {
    // 接这道改法之前起的执行：重放时不多调 syncMainline（MAINLINE_SYNC_PATCH，见常量定义处）。
    if (!patched(MAINLINE_SYNC_PATCH) || boundarySynced.has(tag) || !tree || !head) return;
    boundarySynced.add(tag);
    await applySync(`任务边界（${tag}）`);
  };

  /**
   * 并主线（core 判 CI 报冲突之后派的动作）：并干净了记下新头，回去查它的 CI；并不上（真冲突）记下要修的，
   * 交给下一轮 fix-ci 派会话解——这条路径不能不派会话就干等，所以走 applySync 时要它顺手把 `fix` 填好。
   */
  const doSyncMainline = async (): Promise<FlowEvent> => {
    const outcome = await applySync('CI 报和主线冲突', { setFixOnConflict: true });
    return { kind: 'synced', state: outcome.state, conflictFiles: outcome.conflictFiles };
  };

  /** 6 开 PR：正文有方案摘要和验证结论（被卫生检查拦下让 Lead 重写摘要），再等 CI。 */
  const doOpenPr = async (): Promise<FlowEvent> => {
    if (prNumber === null) {
      // 开 PR 前再并一次（创始人 09-28 凌晨拍的第二点）：这一步只点一次（syncWorktreeAtBoundary 的 tag 去重）。
      await syncWorktreeAtBoundary('open-pr');
      const current = need(setup, '流程配置');
      const lines = rounds.length > 0 ? await verifyLines(kit, rounds) : null;
      // 「按推荐先做了」一栏（#259）：照开 PR 这一刻库里这张单的提问写
      const assumed = patched(ASK_PATCH) ? await judge(kit, 'assumedLines', await readAsks()) : [];
      let planSummary = need(plan, '方案').summary;
      let summary = lastDelivery?.summary ?? '';
      for (;;) {
        const facts: FusionPrFacts = {
          mode: current.mode,
          planSummary,
          summary,
          testsPassed: lastDelivery?.testsPassed ?? false,
          verify: lines,
          highRisk: need(plan, '方案').highRisk,
          planReviewSkipped,
          flowSource: current.source,
          ...(soloWhy ? { soloWhy } : {}),
          ...(assumed.length > 0 ? { assumed } : {}),
          outsideBrief: [...outsideAccepted],
        };
        const parts = await judge(kit, 'fusionPr', facts);
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
                assumed: parts.assumed ?? [],
                specs: specDir,
                // 需求文档跟着这个 PR 才进主线（#295）：「对应计划」照单子挂的版本写
                ...(requirementSeed === null ? {} : { planFromIssue: true }),
                tier: parts.tier,
                // 「文档」一栏：这个 PR 相对主线改了哪些（不按累计的，见 netChanged）
                changedFiles: netChanged ?? [...changed],
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
        prFacts = facts;
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
        // 一张单一块，#252 母单多块时填别的块的简报
        otherBlocks: [],
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
          if (noteOutside(decision.outside, accepted.why) && prFacts) {
            prParts = await judge(kit, 'fusionPr', { ...prFacts, outsideBrief: [...outsideAccepted] });
          }
          return { ok: true };
        }
        // 推之前被拦下（卫生检查、并主线冲突）也算这一轮没收下：同一本打回账
        decision = await judge(kit, 'acceptance', {
          brief,
          otherBlocks: [],
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
    // 存档点交过来的、他改选了别的（#259）并进这一轮修；只有它要修时也修一轮
    const applying = change;
    const cause = fix ?? (applying ? { feedback: [] } : null);
    if (cause) {
      if (cause.follow) await followBranchHead();
      const single = need(flow, '状态').mode === 'single';
      const fb = applying ? [...cause.feedback, changeFeedback(applying)] : cause.feedback;
      // 他改选了别的：修复简报由 Lead 连同改选的重写（最终审查给的那份没算上它）
      const brief = applying
        ? single
          ? undefined
          : await leadFixBrief(fb)
        : (cause.brief ?? (single ? undefined : await leadFixBrief(cause.feedback)));
      const r = await deliverFix(brief, fb);
      if ('needsHuman' in r) return { kind: 'needs-human', why: r.needsHuman };
      fix = null;
      if (applying) await changeApplied(applying);
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

  /**
   * 人闸：发卡请人批（编号先定好进历史，发卡重试只有一张卡），等批准或拒绝。拒了回返工意见，批了回 null；
   * 已开 PR 的单等批准这段可能很久（创始人 09-28 凌晨拍：定时检查，比如 10 分钟一次）：每 10 分钟顺手并一次
   * 主线，并出新头了这张卡审的就是旧头，不算数——回 null 交回去，doMerge 的外层循环拿新头重新申批一张。
   */
  const awaitApproval = async (pr: number, h: string): Promise<Feedback[] | null> => {
    const approvalId = await newId(kit);
    const holds = [...status.holds];
    const what = describeHolds(holds);
    status.approval = { approvalId, holds, head: h, state: 'pending' };
    // 接这道改法之前起的执行：重放时还是原来那一个不设超时的 condition，不拆成按 10 分钟一轮的定时检查。
    const mainlineSync = patched(MAINLINE_SYNC_PATCH);
    const headMoved = await waitFor(
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
        if (!mainlineSync) {
          await condition(() => status.approval?.state !== 'pending');
          return false;
        }
        for (;;) {
          const decided = await condition(() => status.approval?.state !== 'pending', '10 minutes');
          if (decided) return false;
          if ((await applySync('等批准时定时检查')).changed) return true;
        }
      },
      { approvalId },
    );
    if (headMoved) return null;
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

  /**
   * 排进合并队列等结果。暂停了、新加了人闸要等批准：还没合的撤出来，回 null（回头过暂停门、人闸再排）。
   * 排队这段可能很久：每 10 分钟（或 mergeWaitMinutes 比它还短就按那个算）顺手并一次主线（创始人 09-28 凌晨
   * 拍的定时检查），要并才并；并出新头了，队列里那条排的还是老头，撤了回 null——doMerge 的外层循环会拿新头
   * 重新调这个函数，建一条新的排队记录（新 mergeAttempt、新 itemId），不是在这里边等边偷换排队条目的头。
   */
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
    // 接这道改法之前起的执行：重放时还是原来那一个整段 mergeWaitMinutes 超时的 condition，不拆成按 10 分钟
    // 一轮的定时检查。
    const mainlineSync = patched(MAINLINE_SYNC_PATCH);
    const chunkMinutes = Math.max(1, Math.min(10, limits.mergeWaitMinutes));
    for (;;) {
      await attempt(kit, 'enqueueMerge', () => acts.enqueueMerge({ item, limits: input.limits ?? {} }));
      const headMoved = await waitFor(kit, 'merge-queue', `PR #${pr} 在合并队列里`, async () => {
        if (!mainlineSync) {
          await condition(
            () => item.itemId in mergeResults || interrupted(),
            `${limits.mergeWaitMinutes} minutes`,
          );
          return false;
        }
        let waited = 0;
        for (;;) {
          const got = await condition(
            () => item.itemId in mergeResults || interrupted(),
            `${chunkMinutes} minutes`,
          );
          waited += chunkMinutes;
          if (got || waited >= limits.mergeWaitMinutes) return false;
          if ((await applySync('排队时定时检查')).changed) return true;
        }
      });
      if (headMoved) {
        await withdrawUntilConfirmed(item.itemId);
        pendingItemId = null;
        return null;
      }
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
      // 太久没回话（不是并出了新头）：再排一次同一条（队列按条目编号去重，已经有结果的会补发）
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
    // 问创始人的记数（#259）：按推荐先做了几条、事后被改了几条，给检验制度用（#257）
    const asks = patched(ASK_PATCH) ? await judge(kit, 'askTally', await readAsks()) : undefined;
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
      ...(asks ? { asks } : {}),
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
      action = await checkpoint(action);
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
        case 'sync-mainline':
          event = await doSyncMainline();
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
