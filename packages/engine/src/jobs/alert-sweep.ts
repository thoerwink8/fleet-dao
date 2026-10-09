// 提醒对账（每小时对账的一项，design 15.3）：提醒推一次就完、条件没了也不撤、第一次没人接住就再也不提醒——
// 两处都在这里补。
// 1. 能判断条件还在不在的，现算：条件没了就撤，写明谁撤的（engine:hourly-reconcile）、为什么（正文开头「已撤：…」，
//    操作记录里也有一条）。条件还在的原样留着。判法一种提醒一条（RULES），没列进来的不在这里判（见下面的清单）。
// 2. 卡住报警（alert 这一级）超过 24 小时没人处理：再推一次——新写一条「还没处理：<原标题>」（键 remind:<原提醒>:<北京日期>，
//    同一条一天最多一次），驾驶舱弹一条、飞书发一张新卡（原来那张卡只会原地改，沉在群里）。原来那条处理掉，再提醒跟着撤；
//    在再提醒上点「处理」，原来那条也跟着撤。有人在处理（有人在修、PR 开着、合了、发布了）、静默了的不再推（谁在处理现算，
//    core 的 alertHandling）；谁在处理读不到：照旧再推，记没查全（宁可多一张卡）。键以 reconcile:pr:、reconcile:ledger:
//    开头、对应 PR 已合并超过 7 天的，不再每天重推：沿用静默的效果（驾驶舱留原来那一条，不发新的飞书卡），不另开通道，
//    也不写会在 7 天后续期的静默行；已经推出去的「还没处理」跟着撤。合并时刻读不到的照旧再推，记没查成。
// 3. 同一条再立案（#1406，对 #445「不自动开跟进单」的有意收窄，只这一层、还限量）：alert 级、开着、超过 24 小时、
//    alertHandling 判为没人处理、没静默、键不是自己会撤的、正文开头还没有单号的，开一张未排期的缺陷单。四节按整理会话
//    同一份模板拼，再用 requiredSectionProblems 核过；不贴「要人拍」。单号写回这条提醒的正文开头。同一键只一张；那张关了
//    而提醒还在，隔 7 天才再开。每次对账最多 2 张，每个仓每天最多 4 张。GitHub 写不进记没立成、不回写单号，下一轮再试。
//    reconcile:* 虽在「自己会撤」的前缀里（过期兜底不碰它们），条件没了的核对那一步已经撤了，还开着的是断链，要立案。
//    其余自己会撤的（canary、备份、切号……）不立案。认不出仓的不猜、不开。谁在处理读不到：不立案（跟再推相反，开单宁可不开）。
//    历史事实类不立案（#1420）：键以 reconcile:pr:、reconcile:ledger: 开头且对应 PR 已合并超过 7 天。事实已经发生、改不了，
//    对账只在合并时判一次，条件永远还在，开单没有可做的事（#1418、#1419 因此白起了会话）。合并未满 7 天、别的类别照旧。
//    读不到合并时刻不跳过，记没查成。立案前再自检：单的「怎么算做完」只有「提醒的条件不再成立」一条、且类别不在自己会撤的
//    清单里，不开单，提醒正文写「没有可做的事，已跳过立案」。
//
// 各种提醒谁来撤（改这里之前先对一遍）：
// - 「工作树没收掉」（子任务报的 sub:<子任务>:worktree、Fusion 报的 req:<仓>#<号>:worktree）、worktree:<树>「要你拍」：
//   工作树那一部分撤（jobs/worktree-sweep.ts）。
// - <工作流>:park:<n> 挂起（任务工作流报的键是 task:<仓>#<号>:park:<n>，旧的是 req:/sub:；#901 之前这里不认 task:，
//   任务工作流的挂起提醒永远撤不掉；读它的状态走 taskStatus 查询，real/hourly-reconcile.ts 的 taskViewOf）：工作流不在跑了、不挂着了、后来又挂起了一次（这条是旧的）就撤；「「<阶段>」没有能用的路由」
//   挂着时路由恢复了，正文开头写一句「路由已经恢复…点继续」（不撤：任务还挂着等人点继续）。
// - <工作流>:history 事件数到线：工作流结束了就撤。
// - req:<…>:failed 需求没做完：需求的状态不再是 failed（重开了、又跑了、做完了、人叫停了）就撤。
// - mq:<仓>:decide 合并队列判断出错：队列正常收工了（COMPLETED）或工作流已经不在了就撤；还在跑时判不了。
// - approval:<批准> 要人批：批了、拒了，或者在等它的工作流（子任务的；Fusion 的是需求工作流）不在跑了、不在等这一次了就撤。
// - routing:all-open:<阶段> 某阶段的路由全都熔断了：这个阶段有不在熔断的候选路由了就撤（只读判法，和选路同一套；
//   读不了记没查成，不撤）。
// - no-verifier:<任务> 这张单做完没人能验（已删的「给开 PR 前验证留一家」留下的老键）：选路不再报、也不再撤；
//   这张单做完、叫停、没做完了就在这里撤。
// - 自己会撤的，这里不管：pool-hold:<池>（探针、会话跑通就撤；人拍的暂停不在这里，在设置 engine.poolHolds，只有人撤，#746）、
//   session-org:*（引擎切号那一块：切成了、探通了、读到恢复时刻、组织读数定下来了、整池暂停的设置读得出了就撤，
//   real/org-switch.ts；整池暂停到了复查日期的 session-org:pool-hold-overdue 也在这里：人撤了或续了期才撤）、flow-config:<仓>（GitHub 对账）、deploy-lag:（后端健康检查）、
//   auto-release:（自动发布）、备份脚本的几种（fleet-backup）、canary:broken（全流程巡检下一轮通过）、canary:leftover-pr（巡检收上一轮留下的单时没关掉它开的 PR，之后一轮把 PR 关掉了就撤，#336）、
//   watchdog:job:<任务>:…（看门狗 jobs/watchdog.ts：任务按期跑成了就撤）、
//   watchdog-down:…（后端看着看门狗，packages/api 的 watchdog-health.ts：看门狗又按期跑完一轮就撤）、
//   github-app:<机器人>:<仓>（机器人权限自检 jobs/github-app-check.ts：权限够了就撤）、reconcile:workflow:<任务>（开着的单
//   没有着落）、reconcile:ledger:<仓>#<号>（合了的 PR 记账不全）——后两个由两处核对自己撤（jobs/reconcile-checks.ts）。
//   历史上 unclaimed:<提醒>:…、stuck:<提醒>:…（已删的「提醒派单」推出来的）、ask-issue:<提问>、ask-answer:<提问>
//   （已删的对账给提问另开单推出来的，#530）如果还开着，不再有代码去撤它们，落进下面「判不了、还没接的」那一档，
//   只靠 24 小时再推。
// - 判不了、还没接的，24 小时再推一次，开着 3 天没人动就按「过期」撤（过期兜底，下一条）：<工作流>:failure:<规则>（封号、换池接着干这类通报，
//   条件就是「发生过」，要人知道）。
// - 过期兜底（EXPIRE_AFTER_MS）：上面所有的判法、工作树那一部分、别处自己会撤的（SELF_RESOLVING_PREFIXES）都不管的提醒——没有谁
//   能判它还在不在——最近一次被报（updated_at；条件还在的报警者每次再报都会刷新它）过了 3 天，就标「已撤：过期」（写 resolved_at、
//   谁撤的和原因，记录不删）。要人拍的（level = decision）不在此列：那是等人定的事，不是等条件过去的提醒。真的还在的，
//   报警者下一次再报会重新打开（upsert 把已处理的重新打开）。新加一种自己会撤的提醒，前缀加进 SELF_RESOLVING_PREFIXES。

import { doneSection, parseMd, requiredSectionProblems } from '@fleet-dao/conventions';
import { type AlertStage, criteriaOf, HANDLED_STAGES, isEscalationKey } from '@fleet-dao/core';
import type { AlertRow } from '@fleet-dao/db';
import type { StageKind, TaskState } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { duration, STAGE_NAMES } from '../routing/names.ts';
import type { AllOpenCheck } from '../routing/types.ts';
import { plainText } from './groom-plan.ts';
import {
  type AlertStore,
  beijingDate,
  clip,
  isStage,
  notRunningWords,
  RECONCILE_ACTOR,
  type ReconcileLog,
  type SweepPart,
  stamp,
  type WorkflowReader,
} from './reconcile-common.ts';
import { FUSION_TREE_ALERT, KEEP_ALERT_PREFIX, SUBTASK_TREE_ALERT } from './worktree-sweep.ts';

/** 再提醒的键：remind:<原提醒的编号>:<北京日期>。 */
export const REMIND_PREFIX = 'remind:';
/** 卡住报警多久没人处理就再推一次、并立案（同一条再推一天最多一次）。 */
export const REMIND_AFTER_MS = 24 * 60 * 60_000;
/** 一次对账最多新开几张单（没立成的也占这一轮的名额，免得 GitHub 不通时把开着的全打一遍）。 */
export const FILE_PER_RUN = 2;
/** 一个仓一天（北京时间）最多新开几张。数操作记录里立成的，不数没写上单号的。 */
export const FILE_PER_REPO_DAY = 4;
/** 立案的那张关了、提醒还在：至少再隔这么久才允许另开一张。 */
export const REFILE_AFTER_MS = 7 * 24 * 60 * 60_000;
/**
 * 历史事实：对应 PR 已合并超过这么久就不再重推、不立案（#1420）。刚好满 7 天仍算还没过，照旧立案。
 * 不跟 REFILE_AFTER_MS 共用：那边是「单关了再隔多久」，这边是「PR 合了多久算改不了」。
 */
const HISTORICAL_MERGED_AFTER_MS = 7 * 24 * 60 * 60_000;
/** 跟 jobs/reconcile-checks.ts 的前缀同一串。这里不引用那个文件：它反过来引用本文件，会绕成圈。 */
const HISTORICAL_FACT_PREFIXES = ['reconcile:pr:', 'reconcile:ledger:'] as const;
const SKIP_FILING_NOTE = '没有可做的事，已跳过立案';
const HISTORICAL_KEY = /^(?:reconcile:pr:|reconcile:ledger:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
/** 开出去的单只贴这一个类别。不贴「要人拍」「本机做」「待补」：拉不拉由现有准入决定。 */
export const FILE_LABELS = ['缺陷'] as const;
/**
 * 挂起报警是不是「现在挂着的这一次」：报警写进库（updated_at）在挂起那一刻（waiting.since）之后；早过它这么多的是
 * 之前那一次（人点继续以后又挂起了）。留一分钟余量：两个时刻一个是工作流的钟、一个是库的钟。
 */
export const PARK_MATCH_SLACK_MS = 60_000;
/** 过期兜底：没有判法的提醒，这么久没被再报过就撤（标「已撤：过期」）。 */
export const EXPIRE_AFTER_MS = 3 * 24 * 60 * 60_000;
/**
 * 别处自己会撤（或只有人撤）的提醒键前缀：过期兜底不碰它们（它们的条件可以一直在好几天，撤了就是把真问题藏起来）。
 * 清单抄上面「各种提醒谁来撤」那一段；备份脚本的键是 backup.<项>:…（deploy/backup/fleet-backup.sh）。
 * 新加一种自己会撤的提醒，前缀加这里（packages/engine/test/real/hourly-reconcile.test.ts 对着这份清单造过期用例）。
 */
export const SELF_RESOLVING_PREFIXES: readonly string[] = [
  'pool-hold:',
  'session-org:',
  'flow-config:',
  'deploy-lag:',
  'auto-release:',
  'backup',
  'canary:',
  'watchdog:',
  'watchdog-down:',
  'github-app:',
  'reconcile:',
  'quota-read:',
  'route-wake:',
  'carpool-cap:',
  'engine-drain',
  'engine-session-io',
  'retired-schedule:',
  'cursor-pending:',
  'mirasim-pending:',
];
/** 「「<阶段>」没有能用的路由」挂着时，路由恢复了写在正文开头的那一句以它开头（再恢复、再没了按它认出来换掉）。 */
export const ROUTE_BACK_PREFIX = '路由已经恢复';

const NO_ROUTE_TITLE = /^「([a-z]+)」没有能用的路由$/;

/** 这个阶段现在派不派得出去（真实现是选路 pickRoute：和挂起时选的是同一套）。 */
export type RouteCheck =
  | { kind: 'dispatch' }
  | { kind: 'wait'; detail: string }
  | { kind: 'none'; detail: string };

export interface ApprovalFacts {
  decision: 'approved' | 'rejected' | null;
  decidedBy: string | null;
  /** 在等这次批准的工作流：子任务的（sub:<子任务>），Fusion 的是需求工作流（req:<仓>#<号>）；认不出是 null（不撤）。 */
  waitingWorkflowId: string | null;
}

export interface AlertSweepDeps {
  workflows: WorkflowReader;
  taskState(taskId: string): Promise<TaskState | null>;
  approval(approvalId: string): Promise<ApprovalFacts | null>;
  stageRoutable(stage: StageKind, taskId: string | null): Promise<RouteCheck>;
  /**
   * 这个阶段现在是不是全熔断（store-ports 的 stageAllOpen：不写库、不报警）。读不了照抛。
   * 真装配（real/hourly-reconcile.ts）一定接上；可选只是让只测别的部分的装配不用带它。没接上的当没查成记下、不撤。
   */
  stageAllOpen?(stage: StageKind): Promise<AllOpenCheck>;
  alerts: AlertStore;
  /**
   * 这批提醒（编号）此刻谁在处理（core 的 alertHandling 现算：阶段、给人看的一行）。读不到照抛。
   * 真装配（real/hourly-reconcile.ts）一定接上；没接上的照旧按 24 小时再推，但不立案。
   */
  handling?(ids: readonly string[]): Promise<Map<string, { stage: AlertStage; line: string }>>;
  /**
   * 立案（开一张未排期的单、把单号写回提醒）。真装配一定接上；没接上的这一步跳过（单测只测撤和再推）。
   * 认不出仓回 null，不许猜一个。GitHub 写不进、单状态读不到照抛。
   */
  filing?: AlertFiling;
  /**
   * 历史事实类提醒（键以 reconcile:pr:、reconcile:ledger: 开头）对应 PR 的合并时刻。读不到照抛。
   * 真装配一定接上；没接上、抛了、认不出的都不跳过，记没查成。
   */
  prMergedAt?(repo: AlertRepo, number: number): Promise<Date>;
  /** 单测换立案单「怎么算做完」的条目（带「- 」）。生产不接。 */
  doneItems?(key: string): readonly string[];
  now: () => Date;
  log: ReconcileLog;
}

/** 立案开到哪个仓。 */
export interface AlertRepo {
  owner: string;
  name: string;
}

/**
 * 立案要的写和读。openIssue 的 key 同一个仓只开一张（账丢了按标记回查）；milestone 由这里传 null（未排期）。
 */
export interface AlertFiling {
  repoOf(alert: AlertRow): Promise<AlertRepo | null>;
  /** 这个仓从北京时间今天 0 点起已经立成几张。读不到照抛。 */
  filedToday(repo: AlertRepo): Promise<number>;
  /** 正文里那张单此刻开没开着、什么时候关的。关了但时刻读不到，closedAt 回 null（调用方先记下「看见已关」，隔 7 天再开）。 */
  issueState(repo: AlertRepo, number: number): Promise<{ state: 'open' | 'closed'; closedAt: Date | null }>;
  openIssue(input: {
    repo: AlertRepo;
    key: string;
    title: string;
    body: string;
    labels: readonly string[];
    /** null = 不挂里程碑（未排期）。 */
    milestone: null;
  }): Promise<{ number: number }>;
  /** 单号已经写回提醒正文之后记一笔，供今天的限额数。写不进照抛。 */
  recordFiled(input: { repo: AlertRepo; dedupeKey: string; number: number }): Promise<void>;
}

type Verdict =
  /** 条件还在，原样留着。 */
  | { keep: true }
  /** 条件没了：撤，why 写进正文开头和操作记录。 */
  | { resolve: string }
  /** 条件还在，正文改一句（路由恢复了）。 */
  | { body: string };

interface Rule {
  name: string;
  pattern: RegExp;
  judge(deps: AlertSweepDeps, alert: AlertRow, m: RegExpExecArray): Promise<Verdict>;
}

const TASK_STATE_WORDS: Readonly<Record<TaskState, string>> = {
  queued: '排队中',
  triaging: '分诊中',
  asking: '在等人回答',
  planning: '写方案中',
  running: '在干',
  merging: '在合并',
  done: '做完了',
  stopped: '人叫停了',
  failed: '没做完',
  stalled: '停滞',
};

/** 正文开头换上（或拿掉）「路由已经恢复」那一句；别的原样。 */
export function withRouteNote(body: string, note: string | null): string {
  let rest = body;
  if (body.startsWith(ROUTE_BACK_PREFIX)) {
    const cut = body.indexOf('\n\n');
    rest = cut === -1 ? '' : body.slice(cut + 2);
  }
  if (!note) return rest;
  return rest ? `${note}\n\n${rest}` : note;
}

export const RULES: readonly Rule[] = [
  {
    name: '挂起',
    pattern: /^((?:task|req|sub):.+):park:\d+$/,
    async judge(deps, alert, m) {
      const wf = m[1] as string;
      const st = await deps.workflows.state(wf);
      if (st.state !== 'running') return { resolve: `任务已经不挂着了：${notRunningWords(st)}` };
      const view = await deps.workflows.view(wf);
      if (!view.parked) {
        return { resolve: `任务已经不挂着了：挂起已经解除、接着干了（现在：${view.doing || '没写'}）` };
      }
      const since = view.waiting?.kind === 'human' ? Date.parse(view.waiting.since) : Number.NaN;
      if (Number.isFinite(since) && alert.updatedAt.getTime() < since - PARK_MATCH_SLACK_MS) {
        return { resolve: '这一次挂起已经过去了：人点继续以后又挂起了一次，看新报的那条' };
      }
      const stage = NO_ROUTE_TITLE.exec(alert.title)?.[1];
      if (!stage || !isStage(stage)) return { keep: true };
      const route = await deps.stageRoutable(stage, alert.taskId);
      const note =
        route.kind === 'none'
          ? null
          : `${ROUTE_BACK_PREFIX}（「${stage}」阶段现在有能用的路由了）：任务还挂着等人，在驾驶舱点「继续」就接着干。`;
      const body = withRouteNote(alert.body, note);
      return body === alert.body ? { keep: true } : { body };
    },
  },
  {
    name: '事件数到线',
    pattern: /^((?:req|sub|mq):.+):history$/,
    async judge(deps, _alert, m) {
      const st = await deps.workflows.state(m[1] as string);
      return st.state === 'running'
        ? { keep: true }
        : { resolve: `${notRunningWords(st)}，事件数不会再涨了` };
    },
  },
  {
    name: '需求没做完',
    pattern: /^req:.+:failed$/,
    async judge(deps, alert) {
      if (!alert.taskId) return { keep: true };
      const state = await deps.taskState(alert.taskId);
      if (state === null || state === 'failed') return { keep: true };
      return { resolve: `需求现在是「${TASK_STATE_WORDS[state]}」，不再是没做完` };
    },
  },
  {
    name: '合并队列判断出错',
    pattern: /^(mq:.+):decide$/,
    async judge(deps, _alert, m) {
      const st = await deps.workflows.state(m[1] as string);
      if (st.state === 'missing') return { resolve: `合并队列${notRunningWords(st)}` };
      if (st.state === 'closed' && st.status === 'COMPLETED') {
        return { resolve: '合并队列已经排空、正常收工了：判断出错的那一步后来过去了' };
      }
      return { keep: true };
    },
  },
  {
    name: '要人批',
    pattern: /^approval:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    async judge(deps, _alert, m) {
      const id = m[1] as string;
      const a = await deps.approval(id);
      if (!a) return { keep: true };
      if (a.decision) {
        return {
          resolve: `已经${a.decision === 'approved' ? '批准' : '拒绝'}了（${a.decidedBy ?? '没记是谁'}）`,
        };
      }
      const wf = a.waitingWorkflowId;
      if (!wf) return { keep: true };
      const st = await deps.workflows.state(wf);
      if (st.state !== 'running') return { resolve: `在等批准的${notRunningWords(st)}，不用再批了` };
      const view = await deps.workflows.view(wf);
      if (view.approval?.approvalId === id && view.approval.state === 'pending') return { keep: true };
      return {
        resolve: `任务已经不在等这次批准了（${view.approval ? '它在等的是另一次' : '现在没在等批准'}）`,
      };
    },
  },
  {
    // 已删的「给开 PR 前验证留一家」留下的 no-verifier:<任务>：选路不再报这条、也不再撤；
    // 这张单不在跑了（做完、叫停、没做完）在这里撤
    name: '做完没人能验',
    pattern: /^no-verifier:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    async judge(deps, _alert, m) {
      const state = await deps.taskState(m[1] as string);
      if (state !== 'done' && state !== 'stopped' && state !== 'failed') return { keep: true };
      return { resolve: `需求现在是「${TASK_STATE_WORDS[state]}」，走不到开 PR 前验证那一步了` };
    },
  },
  {
    name: '全熔断',
    pattern: /^routing:all-open:([a-z]+)$/,
    async judge(deps, _alert, m) {
      const stage = m[1] as string;
      if (!isStage(stage)) return { keep: true };
      if (!deps.stageAllOpen) throw new Error('全熔断判不了：没接上只读判法');
      const check = await deps.stageAllOpen(stage);
      if (check.allOpen) return { keep: true };
      return { resolve: `${STAGE_NAMES[stage]}有路由不熔断了：${check.detail}` };
    },
  },
];

/** 别处自己会撤的：过期兜底不碰。 */
const resolvesItself = (key: string) => SELF_RESOLVING_PREFIXES.some((p) => key.startsWith(p));

/**
 * 这条键该不该立案。自己会撤的不立（条件自己会过去）。reconcile:* 除外：它在前缀清单里只为了过期兜底不撤，
 * 条件没了的由核对那一步撤掉，轮到这里还开着就是断链还在（#1406）。
 * 历史事实类（键以 reconcile:pr:、reconcile:ledger: 开头，对应 PR 已合并超过 7 天）不在这道同步过滤里排除：
 * 合并时刻要现查。再推和立案两步里跳过，原因写在文件头（#1420）。合并未满 7 天的仍从这里放行。
 */
export function eligibleToFile(key: string): boolean {
  if (isEscalationKey(key)) return false;
  if (key.startsWith('reconcile:')) return true;
  return !resolvesItself(key);
}

/** 历史事实类的键认成哪条 PR。不是这两类回 not-historical；前缀对上但认不出仓和号回 unparsed（记没查成，不跳过）。 */
function historicalFactTarget(
  key: string,
): { repo: AlertRepo; number: number } | 'not-historical' | 'unparsed' {
  if (!HISTORICAL_FACT_PREFIXES.some((p) => key.startsWith(p))) return 'not-historical';
  const m = HISTORICAL_KEY.exec(key);
  if (!m?.[1] || !m[2] || !m[3]) return 'unparsed';
  return { repo: { owner: m[1], name: m[2] }, number: Number(m[3]) };
}

/** 键或链接里嵌的 owner/name。认不出回 null，不拿别的仓顶。 */
export function alertRepoFromText(dedupeKey: string, link: string | null): AlertRepo | null {
  const from = (text: string, re: RegExp): AlertRepo | null => {
    const m = re.exec(text);
    return m?.[1] && m?.[2] ? { owner: m[1], name: m[2] } : null;
  };
  return (
    from(dedupeKey, /(?:^|:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[#:/]|$)/) ??
    (link ? from(link, /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/) : null)
  );
}

/** 刚过 24 小时是第 1 天，满 48 小时是第 2 天。 */
export function unhandledDays(createdAt: Date, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - createdAt.getTime()) / REMIND_AFTER_MS));
}

/** 立案的单：四节和整理会话同一份拼法（groom-plan 的 renderNewIssueBody），原话按这条提醒写死。 */
function stripFilingHead(body: string): string {
  if (!body.startsWith('已立案：')) return body;
  const cut = body.indexOf('\n\n');
  return cut === -1 ? '' : body.slice(cut + 2);
}

function stripSkipNote(body: string): string {
  if (!body.startsWith(SKIP_FILING_NOTE)) return body;
  const cut = body.indexOf('\n\n');
  return cut === -1 ? '' : body.slice(cut + 2);
}

/** 自己会撤的只留「条件不再成立」（条件过去了对账会撤）。其余再加一条 diff 里看得见的，免得自检把正常立案拦掉。 */
function defaultDoneItems(key: string): string[] {
  const items = ['- 这条提醒的条件不再成立（对账撤掉它）'];
  if (!resolvesItself(key)) items.push('- 造成这条提醒的问题已经改掉，diff 里看得到');
  return items;
}

export function renderAlertIssueBody(
  alert: Pick<AlertRow, 'dedupeKey' | 'title' | 'body'>,
  days: number,
  doneItems?: readonly string[],
): string {
  const scene = clip(
    [plainText(alert.title), plainText(stripSkipNote(stripFilingHead(alert.body)))]
      .filter(Boolean)
      .join('\n\n') || alert.dedupeKey,
    4000,
  );
  const items = doneItems ?? defaultDoneItems(alert.dedupeKey);
  return [
    '## 场景',
    '',
    scene,
    '',
    '## 原话',
    '',
    `无（AI 发现：提醒 ${alert.dedupeKey} 第 ${days} 天没人处理）`,
    '',
    '## 已知的模块',
    '',
    '暂无',
    '',
    '## 怎么算做完',
    '',
    ...items,
    '',
  ].join('\n');
}

/**
 * 怎么算做完只有「提醒的条件不再成立」一条，而且这类提醒不会自己撤：开出去的单没有能做的事。
 * 自己会撤的不在这里拦（条件过去了对账会撤，那一条就是验收）。认不出节的不拦，交给上面的四节检查。
 */
function filingHasNothingToDo(key: string, issueBody: string): boolean {
  if (resolvesItself(key)) return false;
  const parsed = criteriaOf(issueBody);
  if (!('ok' in parsed)) return false;
  return parsed.ok.length === 1 && (parsed.ok[0]?.includes('提醒的条件不再成立') ?? false);
}

const FILING_HEAD = /^已立案：#(\d+)（(\d{4}-\d{2}-\d{2})(?:，已关 ([^）]+))?）/;

/** 正文开头的立案标记。没有（或不是我们写的那一行）回 null。 */
export function parseFilingHead(
  body: string,
): { number: number; day: string; closedAt: string | null } | null {
  const m = FILING_HEAD.exec(body);
  if (!m?.[1] || !m[2]) return null;
  return { number: Number(m[1]), day: m[2], closedAt: m[3] ?? null };
}

function filingHead(number: number, day: string, closedAt: string | null): string {
  return `已立案：#${number}（${day}${closedAt ? `，已关 ${closedAt}` : ''}）`;
}

function withFilingHead(body: string, head: string): string {
  const rest = stripFilingHead(body);
  return rest ? `${head}\n\n${rest}` : head;
}

function issueKey(dedupeKey: string, after: number | null): string {
  return after === null ? `alert-file:${dedupeKey}` : `alert-file:${dedupeKey}:after:${after}`;
}

const repoSlug = (repo: AlertRepo) => `${repo.owner}/${repo.name}`;

/** 工作树那一部分撤的，这里不碰。 */
const handledByTrees = (key: string) =>
  SUBTASK_TREE_ALERT.test(key) || FUSION_TREE_ALERT.test(key) || key.startsWith(KEEP_ALERT_PREFIX);

interface Ctx {
  deps: AlertSweepDeps;
  part: SweepPart;
  /** 这一轮之后还开着的原提醒（按编号）。 */
  stillOpen: Map<string, AlertRow>;
  /** 这一轮已经判过的历史事实（按提醒编号）。再推和立案共用，没查成只记一次。 */
  historical: Map<string, 'skip' | 'go'>;
}

async function resolve(c: Ctx, alert: AlertRow, why: string, by = RECONCILE_ACTOR): Promise<boolean> {
  const r = await c.deps.alerts.resolve({
    dedupeKey: alert.dedupeKey,
    by,
    why,
    ...(by === RECONCILE_ACTOR ? {} : { auditActor: RECONCILE_ACTOR }),
  });
  c.stillOpen.delete(alert.id);
  if (r !== 'ok') return false;
  c.part.found += 1;
  c.deps.log('info', '每小时对账：撤了一条提醒', { dedupeKey: alert.dedupeKey, why });
  return true;
}

function reminderBody(alert: AlertRow, now: Date): string {
  const updated =
    alert.updatedAt.getTime() - alert.createdAt.getTime() >= 60_000
      ? `（最近一次更新 ${stamp(alert.updatedAt)}）`
      : '';
  return [
    `这条卡住报警北京时间 ${stamp(alert.createdAt)} 就报了，到现在 ${duration(now.getTime() - alert.createdAt.getTime())} 没人处理${updated}。`,
    '每天最多再提醒一次；原来那条处理掉，这条跟着撤；在这条上点「处理」也算把原来那条处理了。',
    '',
    '原来那条的正文：',
    clip(alert.body, 2000) || '（没写）',
  ].join('\n');
}

const uncheckedMergeTime = (key: string, why: string) => `提醒 ${key} 的 PR 合并时刻没查成，不跳过：${why}`;

/**
 * 这条是不是「PR 已合并超过 7 天」的历史事实。是就不再重推、不立案。
 * 读不到、认不出、没接上：不跳过（照原来的再推和立案），记没查成。同一条这一轮只查一次。
 */
async function historicalSkip(c: Ctx, alert: AlertRow): Promise<boolean> {
  const cached = c.historical.get(alert.id);
  if (cached) return cached === 'skip';
  const target = historicalFactTarget(alert.dedupeKey);
  let skip = false;
  if (target === 'unparsed') {
    c.part.unchecked.push(uncheckedMergeTime(alert.dedupeKey, '认不出是哪条 PR'));
  } else if (target !== 'not-historical') {
    const read = c.deps.prMergedAt;
    if (!read) {
      c.part.unchecked.push(uncheckedMergeTime(alert.dedupeKey, '没接上合并时刻的读法'));
    } else {
      try {
        const at = await read(target.repo, target.number);
        if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
          c.part.unchecked.push(uncheckedMergeTime(alert.dedupeKey, '合并时刻认不出'));
        } else if (c.deps.now().getTime() - at.getTime() > HISTORICAL_MERGED_AFTER_MS) {
          skip = true;
        }
      } catch (err) {
        c.part.unchecked.push(uncheckedMergeTime(alert.dedupeKey, errMessage(err)));
      }
    }
  }
  c.historical.set(alert.id, skip ? 'skip' : 'go');
  return skip;
}

/** 历史事实不再每天重推：原来那条留着，已经推出去的「还没处理」撤掉。不写静默行（静默最长 7 天，这条是一直如此）。 */
async function settleHistorical(c: Ctx, alert: AlertRow, open: readonly AlertRow[]): Promise<void> {
  c.deps.log('info', '每小时对账：PR 已合并超过 7 天，历史事实不再重推、不立案', {
    dedupeKey: alert.dedupeKey,
  });
  for (const child of open) {
    if (child.resolvedAt || !child.dedupeKey.startsWith(REMIND_PREFIX)) continue;
    const rest = child.dedupeKey.slice(REMIND_PREFIX.length);
    const cut = rest.indexOf(':');
    if (cut < 0 || rest.slice(0, cut) !== alert.id) continue;
    try {
      await resolve(
        c,
        child,
        '原来那条说的 PR 已经合并超过 7 天，是改不了的历史事实，不再每天重推；驾驶舱留原来那一条',
      );
    } catch (err) {
      c.part.unchecked.push(`再提醒 ${child.dedupeKey} 没撤成：${errMessage(err)}`);
    }
  }
}

/** 再推：卡住报警超过 24 小时没人处理，一天一条；人在再提醒上点了处理，原来那条跟着撤。 */
async function remind(c: Ctx, alert: AlertRow): Promise<void> {
  const { deps } = c;
  const now = deps.now();
  const last = await deps.alerts.latestByPrefix(`${REMIND_PREFIX}${alert.id}:`);
  if (
    last?.resolvedAt &&
    last.resolvedBy !== RECONCILE_ACTOR &&
    last.resolvedAt.getTime() >= alert.updatedAt.getTime()
  ) {
    await resolve(
      c,
      alert,
      `人在再提醒上点了处理（北京时间 ${stamp(last.resolvedAt)}），原来这条跟着撤`,
      last.resolvedBy ?? RECONCILE_ACTOR,
    );
    return;
  }
  const since = Math.max(alert.createdAt.getTime(), last?.createdAt.getTime() ?? 0);
  if (now.getTime() - since < REMIND_AFTER_MS) return;
  const { created } = await deps.alerts.insertOnce({
    dedupeKey: `${REMIND_PREFIX}${alert.id}:${beijingDate(now)}`,
    level: 'alert',
    taskId: alert.taskId,
    title: clip(`还没处理：${alert.title}`, 300),
    body: reminderBody(alert, now),
    link: alert.link,
  });
  if (created) {
    c.part.found += 1;
    deps.log('info', '每小时对账：卡住报警超过 24 小时没人处理，再推了一次', { dedupeKey: alert.dedupeKey });
  }
}

/**
 * 有人在处理、静默了的（编号）：这些不按 24 小时再推，也不立案。
 * 谁在处理读不到：一条都不算（照旧再推），记没查全，failed = true（立案整轮不做：开单宁可不开）。
 */
async function quietAlerts(
  c: Ctx,
  alerts: readonly AlertRow[],
): Promise<{ quiet: Set<string>; failed: boolean; stage: Map<string, AlertStage> }> {
  const quiet = new Set<string>();
  const stage = new Map<string, AlertStage>();
  if (!c.deps.handling || alerts.length === 0) return { quiet, failed: false, stage };
  try {
    const byId = await c.deps.handling(alerts.map((a) => a.id));
    for (const [id, h] of byId) {
      stage.set(id, h.stage);
      if (h.stage === 'silenced' || HANDLED_STAGES.includes(h.stage)) quiet.add(id);
    }
    return { quiet, failed: false, stage };
  } catch (err) {
    c.part.unchecked.push(`谁在处理没查成，照旧按 24 小时再推：${errMessage(err)}`);
    return { quiet, failed: true, stage };
  }
}

/** 没有可做的事：写在提醒正文开头，不开单。已经写过的不重复写。写不进照抛。 */
async function writeSkipNote(c: Ctx, alert: AlertRow): Promise<void> {
  if (alert.body.startsWith(SKIP_FILING_NOTE)) return;
  const body = alert.body ? `${SKIP_FILING_NOTE}\n\n${alert.body}` : SKIP_FILING_NOTE;
  const r = await c.deps.alerts.updateOpen({ dedupeKey: alert.dedupeKey, body });
  if (r !== 'ok') throw new Error('提醒已经不在开着的里面，跳过立案没写上');
  alert.body = body;
}

/** 把立案结果写回还开着的提醒。写不进照抛（调用方记没立成，不当成写上了）。 */
async function writeFilingHead(c: Ctx, alert: AlertRow, head: string): Promise<void> {
  const body = withFilingHead(alert.body, head);
  if (body === alert.body) return;
  const r = await c.deps.alerts.updateOpen({ dedupeKey: alert.dedupeKey, body });
  if (r !== 'ok') throw new Error('提醒已经不在开着的里面，单号没写上');
  alert.body = body;
}

/**
 * 这一条要不要新开一张。回 'open' 才去开；'wait' 是已经有单（开着，或关了还没到 7 天）；'skip' 是这轮先不动。
 * 关了但不知道什么时候关的：先把看见的时刻写进正文，这一轮不开。
 */
async function filingPlan(
  c: Ctx,
  filing: AlertFiling,
  alert: AlertRow,
  repo: AlertRepo,
  now: Date,
): Promise<{ open: false } | { open: true; after: number | null }> {
  const existing = parseFilingHead(alert.body);
  if (!existing) return { open: true, after: null };
  const st = await filing.issueState(repo, existing.number);
  if (st.state === 'open') return { open: false };
  const fromApi = st.closedAt !== null && Number.isFinite(st.closedAt.getTime()) ? st.closedAt : null;
  const parsed = existing.closedAt ? new Date(existing.closedAt) : null;
  const closedAt = fromApi ?? (parsed !== null && Number.isFinite(parsed.getTime()) ? parsed : null);
  if (closedAt === null) {
    await writeFilingHead(c, alert, filingHead(existing.number, existing.day, now.toISOString()));
    return { open: false };
  }
  if (now.getTime() - closedAt.getTime() < REFILE_AFTER_MS) return { open: false };
  return { open: true, after: existing.number };
}

/**
 * 还开着的卡住报警里，该立案的立一张。名额：这一轮最多 FILE_PER_RUN 次尝试（开成、GitHub 写失败都算），
 * 一个仓北京时间今天最多 FILE_PER_REPO_DAY 张立成的。认不出仓的跳过，不记没查成（不是这轮读失败）。
 */
async function fileStuckAlerts(
  c: Ctx,
  candidates: readonly AlertRow[],
  quiet: ReadonlySet<string>,
  handlingFailed: boolean,
  stage: ReadonlyMap<string, AlertStage>,
): Promise<void> {
  const filing = c.deps.filing;
  if (!filing) return;
  if (!c.deps.handling || handlingFailed) {
    if (!c.deps.handling) c.part.unchecked.push('谁在处理没接上，这一轮不立案');
    return;
  }
  const now = c.deps.now();
  const queued = candidates
    .filter(
      (a) =>
        stage.get(a.id) === 'unclaimed' &&
        !quiet.has(a.id) &&
        eligibleToFile(a.dedupeKey) &&
        now.getTime() - a.createdAt.getTime() >= REMIND_AFTER_MS,
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  let attempts = 0;
  const dailyFull = new Set<string>();
  for (const alert of queued) {
    // 再推那一步可能刚把这条撤了（人在再提醒上点了处理）。撤了的不再开。
    if (!c.stillOpen.has(alert.id)) continue;
    // 已合并超过 7 天的历史事实：开单没有能做的事，不占这一轮的名额（#1420）。
    if (await historicalSkip(c, alert)) continue;
    if (attempts >= FILE_PER_RUN) break;
    const { dedupeKey } = alert;
    let repo: AlertRepo | null;
    try {
      repo = await filing.repoOf(alert);
    } catch (err) {
      c.part.unchecked.push(`提醒 ${dedupeKey} 的仓没查成，没立案：${errMessage(err)}`);
      continue;
    }
    if (!repo) {
      c.deps.log('info', '每小时对账：卡住报警认不出仓，不立案', { dedupeKey });
      continue;
    }
    const slug = repoSlug(repo);
    let plan: { open: false } | { open: true; after: number | null };
    try {
      plan = await filingPlan(c, filing, alert, repo, now);
    } catch (err) {
      c.part.unchecked.push(`提醒 ${dedupeKey} 已立案的单没查成，这轮不另开：${errMessage(err)}`);
      continue;
    }
    if (!plan.open) continue;
    if (dailyFull.has(slug)) continue;
    let today: number;
    try {
      today = await filing.filedToday(repo);
    } catch (err) {
      c.part.unchecked.push(`提醒 ${dedupeKey} 今天立了几张没查成，没立案：${errMessage(err)}`);
      continue;
    }
    if (today >= FILE_PER_REPO_DAY) {
      dailyFull.add(slug);
      c.deps.log('info', '每小时对账：这个仓今天立案已到上限，剩下的下一轮再看', { repo: slug });
      continue;
    }
    const days = unhandledDays(alert.createdAt, now);
    const body = renderAlertIssueBody(alert, days, c.deps.doneItems?.(dedupeKey));
    const doc = parseMd('body.md', body);
    const problems = requiredSectionProblems(doc);
    if (problems.length > 0 || doneSection(doc) !== 'ok') {
      c.part.unchecked.push(
        `提醒 ${dedupeKey} 的单拼不出四节，没立案：${problems[0]?.why ?? '「怎么算做完」是空的'}`,
      );
      continue;
    }
    // 只有「条件不再成立」一条、又不会自己撤：开出去没有能做的事。不占这一轮的名额。
    if (filingHasNothingToDo(dedupeKey, body)) {
      try {
        await writeSkipNote(c, alert);
      } catch (err) {
        c.part.unchecked.push(`提醒 ${dedupeKey} 没有可做的事，跳过立案没写上：${errMessage(err)}`);
      }
      continue;
    }
    const title = clip(alert.title.replace(/\s+/g, ' ').trim() || `提醒 ${dedupeKey} 没人处理`, 200);
    attempts += 1;
    let number: number;
    try {
      const got = await filing.openIssue({
        repo,
        key: issueKey(dedupeKey, plan.after),
        title,
        body,
        labels: FILE_LABELS,
        milestone: null,
      });
      number = got.number;
    } catch (err) {
      c.part.unchecked.push(`提醒 ${dedupeKey} 没立成：${errMessage(err)}`);
      continue;
    }
    try {
      await writeFilingHead(c, alert, filingHead(number, beijingDate(now), null));
    } catch (err) {
      c.part.unchecked.push(`提醒 ${dedupeKey} 的单 #${number} 开了，正文没写上单号：${errMessage(err)}`);
      continue;
    }
    try {
      await filing.recordFiled({ repo, dedupeKey, number });
    } catch (err) {
      c.part.unchecked.push(`提醒 ${dedupeKey} 立了 #${number}，今天的笔数没记上：${errMessage(err)}`);
    }
    c.part.found += 1;
    c.deps.log('info', '每小时对账：卡住报警超过 24 小时没人处理，立了一张单', {
      dedupeKey,
      number,
      repo: slug,
    });
  }
}

/**
 * 跑提醒这一部分。open 是这一轮列出的没处理的提醒（truncated = 没列全，照实记没查全）。
 * 某一条判不成（查不了 Temporal、库）进 unchecked，别的照判。
 */
export async function sweepAlerts(
  deps: AlertSweepDeps,
  open: readonly AlertRow[],
  truncated: boolean,
): Promise<SweepPart> {
  const c: Ctx = {
    deps,
    part: { scanned: open.length, found: 0, unchecked: [] },
    stillOpen: new Map(open.filter((a) => !a.dedupeKey.startsWith(REMIND_PREFIX)).map((a) => [a.id, a])),
    historical: new Map(),
  };
  if (truncated) c.part.unchecked.push(`没处理的提醒太多，这一轮只看了前 ${open.length} 条`);
  // 1. 条件没了的撤掉；还在的留着（路由恢复了的改一句正文）
  for (const alert of open) {
    if (alert.dedupeKey.startsWith(REMIND_PREFIX) || handledByTrees(alert.dedupeKey)) continue;
    let judged = false;
    for (const rule of RULES) {
      const m = rule.pattern.exec(alert.dedupeKey);
      if (!m) continue;
      judged = true;
      try {
        const verdict = await rule.judge(deps, alert, m);
        if ('resolve' in verdict) await resolve(c, alert, verdict.resolve);
        else if ('body' in verdict) {
          if ((await deps.alerts.updateOpen({ dedupeKey: alert.dedupeKey, body: verdict.body })) === 'ok') {
            deps.log('info', '每小时对账：挂着的任务路由恢复了，提醒里写上一句', {
              dedupeKey: alert.dedupeKey,
            });
          }
        }
      } catch (err) {
        c.part.unchecked.push(`提醒 ${alert.dedupeKey}（${rule.name}）没查成：${errMessage(err)}`);
      }
      break;
    }
    // 过期兜底：没有判法、别处也不撤的，三天没被再报过就撤
    if (!judged && alert.level !== 'decision' && !resolvesItself(alert.dedupeKey)) {
      const idle = deps.now().getTime() - alert.updatedAt.getTime();
      if (idle > EXPIRE_AFTER_MS) {
        try {
          await resolve(
            c,
            alert,
            `过期：这种提醒没有办法自动判断条件还在不在，北京时间 ${stamp(alert.updatedAt)} 报过之后已经 ${duration(idle)} 没被再报，按过期撤了。条件要是还在，报警者下一次再报会重新打开`,
          );
        } catch (err) {
          c.part.unchecked.push(`提醒 ${alert.dedupeKey} 的过期撤销没做成：${errMessage(err)}`);
        }
      }
    }
  }
  // 2. 还开着的卡住报警（工作树的也算），超过 24 小时没人处理就再推；有人在处理、静默了的不推
  const candidates = [...c.stillOpen.values()].filter(
    (a) => a.level === 'alert' && !isEscalationKey(a.dedupeKey),
  );
  const { quiet, failed: handlingFailed, stage } = await quietAlerts(c, candidates);
  for (const alert of candidates) {
    if (quiet.has(alert.id)) continue;
    try {
      // 已合并超过 7 天：不发新的飞书卡（不插 remind:），原来那条留在驾驶舱。沿用静默的效果，不另开通道。
      if (await historicalSkip(c, alert)) {
        await settleHistorical(c, alert, open);
        continue;
      }
      await remind(c, alert);
    } catch (err) {
      c.part.unchecked.push(`提醒 ${alert.dedupeKey} 的再提醒没做成：${errMessage(err)}`);
    }
  }
  // 3. 同一批里该立案的立案（再推照旧；开单失败不挡再推，再推失败也不挡立案）
  await fileStuckAlerts(c, candidates, quiet, handlingFailed, stage);
  // 4. 原来那条已经处理了的再提醒，跟着撤
  for (const alert of open) {
    if (!alert.dedupeKey.startsWith(REMIND_PREFIX)) continue;
    const origin = alert.dedupeKey.slice(REMIND_PREFIX.length).split(':')[0] ?? '';
    if (c.stillOpen.has(origin)) continue;
    try {
      await resolve(c, alert, '原来那条已经处理了');
    } catch (err) {
      c.part.unchecked.push(`再提醒 ${alert.dedupeKey} 没撤成：${errMessage(err)}`);
    }
  }
  return c.part;
}
