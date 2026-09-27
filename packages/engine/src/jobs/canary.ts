// 全流程巡检（#223；design 第六节「断链怎么被发现」第 3 层）：每 6 小时在巡检仓开一张固定的小单，看它从收单一路走到派活、
// 规划、执行、验证、开 PR 过 CI、合并、关单、记账、驾驶舱显示。每一步有期限，超时或出事（挂起等人、工作流没做完、单子被关成
// 不做了）就推一条「卡住报警」，写清断在哪一步；下一轮通过了这条自己撤。
// 一轮 = 开单（openCanaryRound：记开始 → 补记没收尾的几轮、收掉前几轮留下的单 → 找巡检仓的当前版本 → 开单、挂上当前版本）
// → 每 2 分钟看一回（checkCanaryRound：读库、问 Temporal、要时读 GitHub → canaryNext 判 → 记进库）→ 有结论就收尾。
// 结论三种：通过、断在哪、没跑成（巡检自己挂了：没配、仓读不到、开不了单、连着查不成）。没跑成的这一轮在 schedule_runs 记
// failed，由看门狗（#203）照登记表报；断了的这一轮巡检自己跑成了，schedule_runs 记 ok、发现 1 个问题，报警由这里推。
// 改这里之前必须知道：接活只派挂在当前版本上的单（design 第九节「在哪能做与接活开关」），开单时就挂上巡检仓的当前版本。
// 巡检单没有「文档：」那一行，也不先在巡检仓里建需求文档（引擎不直写主线）：正文照 #295 的写法写全需求，收单照正文写需求
// 文档、Lead 随 PR 提交，开 PR 前验证照正文核（core 的 specOf、bodyCriteria）。「怎么算做完」下面只放验收条，别的话会被当成一条。
// 判走到哪一步只在 canaryNext（纯函数），读东西只在 observe。
import { currentVersion } from '@fleet-dao/core';
import {
  CANARY_MAX_MINUTES,
  CANARY_RUN_TIMEOUT_MINUTES,
  CANARY_STAGE_NAMES,
  type CanaryDbFacts,
  type CanaryStage,
  type CanaryStep,
  type CanaryVerdict,
  type ScheduleResult,
} from '@fleet-dao/db';
import type { SubtaskState, TaskState } from '@fleet-dao/shared';
import { requirementWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { CANARY_CHECK_FAILURE_LIMIT, CANARY_POLL_SECONDS } from '../contract.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { clip, message, stamp, type WorkflowState } from './reconcile-common.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来（看门狗按登记表查）。 */
export const CANARY_JOB = {
  id: 'canary',
  name: '全流程巡检',
  schedule: '每 6 小时（北京时间 2、8、14、20 点 26 分）',
  // 6 小时一轮、一轮最长 5 小时：漏一轮不报，连着两轮没跑成才算过期
  expectEveryMinutes: 13 * 60,
} as const;

export const CANARY_EVERY_HOURS = 6;
/** 和对账补漏（整点起每 15 分钟）、路由探针（7、22、37、52 分）、每小时对账（41 分）、备份巡查（17 分）错开。 */
export const CANARY_OFFSET_MINUTES = 26;
/**
 * 两回之间隔多久、连着几回没查成算没跑成：工作流和活动共用，定义在 contract.ts。
 * 一轮最长多久（到了还没走完，断在当时那一步）、一轮的工作流最长活多久：和健康页同一份（@fleet-dao/db），过了工作流的时限
 * 还没有结论的一轮，健康页不说它在跑、下一轮开始时补记没跑成。
 */
export { CANARY_CHECK_FAILURE_LIMIT, CANARY_MAX_MINUTES, CANARY_POLL_SECONDS, CANARY_RUN_TIMEOUT_MINUTES };
/** 断了的报警只有一条（同一个键）：下一轮再断原地更新、处理过的重新打开；通过了自己撤。 */
export const CANARY_ALERT_KEY = 'canary:broken';
/** 撤报警、记操作记录时的「谁」。 */
export const CANARY_ACTOR = 'engine:canary';
/** 一轮最多收掉前几轮留下的几张单（多出来的下一轮接着收）。 */
export const CANARY_CLEANUP_LIMIT = 5;
/** 巡检单要改的文件（巡检仓根上）。 */
export const CANARY_LOG_FILE = '巡检记录.md';

/** 每一步给人看的名字：和健康页同一份（@fleet-dao/db 的 CANARY_STAGE_NAMES）。 */
export { CANARY_STAGE_NAMES };

/**
 * 每一步多久没走完算断（分钟）：从上一步走完算起，等并发空位、等额度清零的时间不算（那是忙，不是断；一轮 5 小时的总上限照样管着）。
 * 收单：webhook 几秒、对账补漏每 15 分钟补一次；派活：读流程配置、建工作树、选上路由起第一个会话；之后照一张小单的正常用时放宽。
 */
export const CANARY_STAGE_LIMIT_MINUTES: Readonly<Record<CanaryStage, number>> = {
  open: 10,
  intake: 20,
  dispatch: 30,
  plan: 45,
  execute: 60,
  verify: 45,
  pr: 45,
  merge: 30,
  close: 15,
  ledger: 10,
  board: 10,
};

const STAGE_ORDER: readonly CanaryStage[] = [
  'open',
  'intake',
  'dispatch',
  'plan',
  'execute',
  'verify',
  'pr',
  'merge',
  'close',
  'ledger',
  'board',
];
const indexOf = (s: CanaryStage) => STAGE_ORDER.indexOf(s);

/** Fusion 工作流的步骤（core 的 FlowState.step）落在巡检的哪一步。读库里的 phase（fusion:<步骤>）或 status 查询的 step。 */
const FUSION_STAGE: Readonly<Record<string, CanaryStage>> = {
  discuss: 'dispatch',
  intake: 'dispatch',
  plan: 'plan',
  review: 'plan',
  execute: 'execute',
  verify: 'verify',
  pr: 'pr',
  'final-review': 'pr',
  merge: 'merge',
  done: 'close',
};

/** 等这两种不算断：等并发空位、等额度清零（kit.ts 的 WaitKind）。 */
const BUSY_WAITS: readonly string[] = ['slot', 'quota'];

/** 两次看之间的状态：进了工作流历史，以后只许加可选字段。 */
export interface CanaryState {
  schemaVersion: 1;
  /** schedule_runs 那一行。 */
  runId: number;
  /** canary_runs 那一行。 */
  canaryRunId: number;
  repo: { owner: string; name: string };
  issueNumber: number;
  issueUrl: string;
  openedAt: string;
  /** 收单以后才有。 */
  taskId: string | null;
  /** 在等哪一步走完。 */
  stage: CanaryStage;
  /** 这一步从什么时候开始等。 */
  stageSince: string;
  /** 这一步里在等并发空位、额度的时间（不算进期限）。 */
  busyMs: number;
  lastCheckAt: string;
  /** 走完的每一步和走完的时刻（先后照顺序）。 */
  steps: CanaryStep[];
  /** 连着几回没查成。 */
  checkFailures: number;
  /** 开单时收前几轮留下的单的情况这类备注，收尾时写进结论。 */
  notes: string[];
}

/** 在跑的 Fusion 工作流 status 查询里要用的几样（real/canary.ts 解析，认不出照抛）。 */
export interface CanaryView {
  step: string;
  parked: boolean;
  waiting: { kind: string; detail: string } | null;
  prNumber: number | null;
  lastProblem: string | null;
}

/** 驾驶舱读到的这张单（后端的 Store：getTask、listSubtasks，和看板读的同一份）。 */
export interface CanaryBoard {
  taskState: TaskState | null;
  prNumber: number | null;
  blockState: SubtaskState | null;
}

/** 看一回读到的东西。issue、board 只在任务做完了才读（省 GitHub 调用）。 */
export interface CanaryObservation {
  at: string;
  db: CanaryDbFacts;
  workflow: WorkflowState;
  view: CanaryView | null;
  issue: { state: 'open' | 'closed'; stateReason: string | null } | null;
  board: CanaryBoard | null;
}

export type CanaryDecision =
  | { kind: 'continue'; state: CanaryState }
  | { kind: 'pass'; state: CanaryState }
  | { kind: 'broken'; state: CanaryState; stage: CanaryStage; why: string };

const WORKFLOW_WORDS: Readonly<Record<string, string>> = {
  COMPLETED: '跑完了',
  FAILED: '失败了',
  CANCELLED: '被取消了',
  TERMINATED: '被强行终止了',
  TIMED_OUT: '超时了',
  CONTINUED_AS_NEW: '换了新的一轮',
};

/** 这张单此刻走到了 Fusion 的哪一步（落在巡检的哪一步）；认不出（挂起、还没开工）是 null。 */
function fusionStage(obs: CanaryObservation): CanaryStage | null {
  if (obs.db.task?.state === 'done') return 'close';
  const step = obs.view?.step ?? obs.db.task?.phase?.replace(/^fusion:/, '') ?? null;
  return step ? (FUSION_STAGE[step] ?? null) : null;
}

/** 这一步走完了没有。 */
function stageDone(stage: CanaryStage, obs: CanaryObservation): boolean {
  const { db } = obs;
  switch (stage) {
    case 'open':
      return true;
    case 'intake':
      return db.task !== null;
    case 'dispatch':
      // 选上路由、第一个会话起来了（Lead 写方案那一个）
      return db.sessions.started > 0;
    case 'plan':
    case 'execute':
    case 'verify':
    case 'pr':
    case 'merge': {
      const at = fusionStage(obs);
      return at !== null && indexOf(at) > indexOf(stage);
    }
    case 'close':
      return (
        db.task?.state === 'done' && obs.issue?.state === 'closed' && obs.issue.stateReason === 'completed'
      );
    case 'ledger':
      return (
        db.sessions.total > 0 &&
        db.sessions.ended === db.sessions.total &&
        db.sessions.withUsage > 0 &&
        db.timings > 0
      );
    case 'board':
      return (
        obs.board?.taskState === 'done' && obs.board.prNumber !== null && obs.board.blockState === 'merged'
      );
  }
}

/** 这一步已经断了（不用等期限）的原因；没断是 null。 */
function brokenNow(stage: CanaryStage, obs: CanaryObservation, state: CanaryState): string | null {
  const { db } = obs;
  if (!db.repo) return '巡检仓不在库里了（没受管）：接活收不进这张单';
  if (stage === 'dispatch') {
    if (db.repo.autoDispatchSince === null) {
      return '巡检仓的「让 AI 接活」开关关着，这张单不会派（fleet-api dispatch <巡检仓> on）';
    }
    if (db.repo.autoDispatchSince.getTime() > Date.parse(state.openedAt)) {
      return '巡检仓的「让 AI 接活」开关是开单之后才打开的，这张单不自动派';
    }
  }
  const task = db.task;
  if (task && (task.state === 'failed' || task.state === 'stopped')) {
    return `任务${task.state === 'failed' ? '没做完（失败了）' : '被叫停了'}${task.lastProblem ? `：${task.lastProblem}` : ''}`;
  }
  if (indexOf(stage) >= indexOf('dispatch') && indexOf(stage) <= indexOf('merge')) {
    const alert = db.openAlerts[0];
    if (alert) return `挂起等人：${alert.title}`;
    if (obs.view?.parked) {
      return `挂起等人：${obs.view.waiting?.detail ?? obs.view.lastProblem ?? '（没说原因）'}`;
    }
    if (task && task.state !== 'queued' && obs.workflow.state === 'missing') {
      return '这张单的工作流不见了（没在跑、Temporal 里也查不到）';
    }
    if (obs.workflow.state === 'closed' && obs.workflow.status !== 'COMPLETED') {
      const words = WORKFLOW_WORDS[obs.workflow.status] ?? obs.workflow.status;
      return `这张单的工作流${words}${task?.lastProblem ? `：${task.lastProblem}` : ''}`;
    }
  }
  if (stage === 'close' && obs.issue?.state === 'closed' && obs.issue.stateReason !== 'completed') {
    return `单子被关成了「${obs.issue.stateReason ?? '没写原因'}」，不是做完关的`;
  }
  return null;
}

/** 超时的时候，这一步为什么没走完（给人看的补充）。 */
function whyStuck(stage: CanaryStage, obs: CanaryObservation): string {
  const { db } = obs;
  const delivery = db.lastDelivery
    ? `最近一次带着这张单的投递（${db.lastDelivery.event}${db.lastDelivery.action ? `.${db.lastDelivery.action}` : ''}）` +
      `记的是 ${db.lastDelivery.status}${db.lastDelivery.reason ? `：${db.lastDelivery.reason}` : ''}` +
      `${db.lastDelivery.note ? `（${db.lastDelivery.note}）` : ''}`
    : '库里没有带着这张单的投递（GitHub 事件没送到）';
  if (stage === 'intake') return `库里还没有这张单的任务行；${delivery}`;
  const parts: string[] = [];
  if (stage === 'dispatch') {
    parts.push(
      obs.workflow.state === 'missing'
        ? `工作流没起来；${delivery}`
        : obs.workflow.state === 'running'
          ? '工作流起来了，第一个会话还没起来'
          : `工作流${WORKFLOW_WORDS[obs.workflow.status] ?? obs.workflow.status}`,
    );
  }
  if (obs.view?.waiting) parts.push(`在等：${obs.view.waiting.detail}`);
  const problem = obs.view?.lastProblem ?? db.task?.lastProblem;
  if (problem) parts.push(`最近的问题：${problem}`);
  if (stage === 'close' && obs.issue?.state === 'open') parts.push('GitHub 上单子还开着');
  if (stage === 'ledger') {
    const s = db.sessions;
    parts.push(
      `会话 ${s.total} 个、结束了 ${s.ended} 个、记上用量的 ${s.withUsage} 个；每步耗时 ${db.timings} 笔`,
    );
  }
  if (stage === 'board') {
    const b = obs.board;
    parts.push(
      b
        ? `驾驶舱读到的：任务 ${b.taskState ?? '（没有）'}、PR ${b.prNumber === null ? '（没有）' : `#${b.prNumber}`}、块 ${b.blockState ?? '（没有）'}`
        : '驾驶舱那边还没读成',
    );
  }
  return parts.join('；');
}

/**
 * 看一回之后怎么办（纯函数，测试逐条核对）：能往前走的一步步往前走（一回里可以走好几步），走完最后一步是通过；
 * 当前这一步已经出事的、超过期限的、整轮超过上限的，断在这一步。
 */
export function canaryNext(state: CanaryState, obs: CanaryObservation): CanaryDecision {
  const at = Date.parse(obs.at);
  let s: CanaryState = {
    ...state,
    steps: [...state.steps],
    checkFailures: 0,
    lastCheckAt: obs.at,
    taskId: state.taskId ?? obs.db.task?.id ?? null,
  };
  // 两回之间一直在等空位、额度：这段不算进这一步的期限
  if (obs.view?.waiting && BUSY_WAITS.includes(obs.view.waiting.kind)) {
    s.busyMs += Math.max(0, at - Date.parse(state.lastCheckAt));
  }
  for (;;) {
    if (!stageDone(s.stage, obs)) break;
    s.steps.push({ stage: s.stage, at: obs.at });
    const next = STAGE_ORDER[indexOf(s.stage) + 1];
    if (!next) return { kind: 'pass', state: s };
    s = { ...s, stage: next, stageSince: obs.at, busyMs: 0 };
  }
  const broken = brokenNow(s.stage, obs, s);
  if (broken) return { kind: 'broken', state: s, stage: s.stage, why: broken };
  const limit = CANARY_STAGE_LIMIT_MINUTES[s.stage];
  const spent = at - Date.parse(s.stageSince) - s.busyMs;
  if (spent > limit * 60_000) {
    const why = whyStuck(s.stage, obs);
    return {
      kind: 'broken',
      state: s,
      stage: s.stage,
      why: `「${CANARY_STAGE_NAMES[s.stage]}」${limit} 分钟没走完${why ? `：${why}` : ''}`,
    };
  }
  if (at - Date.parse(s.openedAt) > CANARY_MAX_MINUTES * 60_000) {
    const why = whyStuck(s.stage, obs);
    return {
      kind: 'broken',
      state: s,
      stage: s.stage,
      why: `一轮 ${CANARY_MAX_MINUTES / 60} 小时还没走完，停在「${CANARY_STAGE_NAMES[s.stage]}」${why ? `：${why}` : ''}`,
    };
  }
  return { kind: 'continue', state: s };
}

// —— 巡检单本身 ——

/**
 * 巡检单的标题和正文（#295 的写法）：正文写全需求——起因、要什么，最后是写了字的「## 怎么算做完」；不写「文档：」那一行。
 * 收单照正文写需求文档（目录 specs/<号>-<照标题取的短名>），Lead 随 PR 提交；开 PR 前验证照正文核。开单时还不知道单号，
 * 要追加的那一行用这一轮的编号和开单时刻认（每轮都不一样）。
 */
export function canaryIssue(round: number, openedAt: Date): { title: string; body: string } {
  const line = canaryLogLine(round, openedAt);
  return {
    title: `巡检第 ${round} 轮：往巡检记录追加一行`,
    body: [
      '原话：巡检单。fleet-dao 每 6 小时自动开一张，由引擎从收单一路做到合并、关单，证明整条链是通的；断在哪一步会报警。不用人管。',
      '',
      '## 要什么',
      '',
      `在仓根的 \`${CANARY_LOG_FILE}\` 末尾追加一行 \`${line}\`（这一轮巡检的编号和开单时刻，UTC）。文件不在就新建：第一行写 \`# 巡检记录\`，空一行，再写这一行。别的内容一个字都不动。`,
      '',
      '## 怎么算做完',
      '',
      `- \`${CANARY_LOG_FILE}\` 的最后一行是 \`${line}\`，一字不差。`,
      `- 这张单改到的文件只有 \`${CANARY_LOG_FILE}\`，和 \`specs/\` 下这张单自己的目录（目录名以这张单的号开头）里的文档。`,
      '- `node --test` 通过。',
    ].join('\n'),
  };
}

/** 巡检记录里这一轮要追加的那一行：这一轮的编号和开单时刻（UTC，到秒）。 */
export function canaryLogLine(round: number, openedAt: Date): string {
  return `- 第 ${round} 轮 ${openedAt.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

// —— 一轮怎么跑（外面的读写都经 deps，真装配在 real/canary.ts）——

/** canary_runs 的读写（真实现是 @fleet-dao/db 的同名查询）。 */
export interface CanaryRecord {
  start(input: { scheduleRunId: number; repo: string | null; at: Date }): Promise<number>;
  progress(
    id: number,
    input: {
      stage: CanaryStage;
      steps: readonly CanaryStep[];
      issueNumber?: number;
      taskId?: string;
      at: Date;
    },
  ): Promise<boolean>;
  finish(
    id: number,
    input: {
      verdict: CanaryVerdict;
      stage: CanaryStage;
      why: string | null;
      steps: readonly CanaryStep[];
      issueNumber?: number;
      taskId?: string;
      at: Date;
    },
  ): Promise<'ok' | 'already_finished' | 'not_found'>;
  /** 前几轮留下、还没收掉的单（断了或没跑成、开成了单的）。 */
  leftovers(repo: string): Promise<{ id: number; issueNumber: number | null }[]>;
  /** 没收尾的几轮（开始得比 before 早、还没结论的）补记成没跑成，回补记了哪几轮。 */
  abandon(input: {
    before: Date;
    why: string;
    at: Date;
  }): Promise<{ id: number; scheduleRunId: number; issueNumber: number | null }[]>;
  cleaned(id: number, at: Date): Promise<void>;
}

/** 「引擎」机器人在巡检仓上要做的几样（真实现是 @fleet-dao/github）。 */
export interface CanaryGitHub {
  openMilestones(): Promise<{ number: number; title: string }[]>;
  /** 开单、同时挂上里程碑（按去重键幂等：重试不开第二张）。 */
  openIssue(input: {
    title: string;
    body: string;
    dedupe: string;
    milestone: number;
  }): Promise<{ number: number; url: string }>;
  issueState(issueNumber: number): Promise<{ state: 'open' | 'closed'; stateReason: string | null }>;
  closeIssue(issueNumber: number, comment: string): Promise<void>;
}

export interface CanaryDeps {
  /** 巡检仓（引擎配置 FLEET_CANARY_REPO）；没配、认不出是 error，这一轮没跑成。 */
  repo: { owner: string; name: string } | { error: string };
  runs: ScheduleRunLog;
  record: CanaryRecord;
  github: CanaryGitHub;
  /** 这张单在库里的事实（@fleet-dao/db 的 canaryDbFacts）。 */
  facts(issueNumber: number): Promise<CanaryDbFacts>;
  workflows: {
    state(workflowId: string): Promise<WorkflowState>;
    /** 在跑的 Fusion 工作流的 status 查询；认不出、查不了照抛。 */
    view(workflowId: string): Promise<CanaryView>;
    /** 叫停一张单的工作流（收前几轮留下的单）；工作流已经不在回 gone。 */
    stop(workflowId: string, reason: string): Promise<'sent' | 'gone'>;
  };
  /** 驾驶舱读到的这张单（后端 Store 的 getTask、listSubtasks）。 */
  board(taskId: string): Promise<CanaryBoard>;
  alerts: {
    raise(input: { title: string; body: string; taskId: string | null }): Promise<void>;
    /** 撤掉断了的那条（没开着的不管）。 */
    resolve(why: string): Promise<void>;
  };
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 一轮的结局（工作流的返回值，和记进库的同一份）。 */
export interface CanaryRun {
  runId: number;
  canaryRunId: number;
  verdict: CanaryVerdict;
  stage: CanaryStage;
  issueNumber: number | null;
  why: string | null;
}

/** 开单或看一回之后：还在跑（带着下一回要的状态），或者有结论了。 */
export type CanaryStepResult = { done: false; state: CanaryState } | { done: true; run: CanaryRun };

/** 记开始就失败（库连不上、没登记）：这一轮在库里没有记录，登记表上它会过期，看门狗照样看得见。 */
export class CanaryNotRecordedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanaryNotRecordedError';
  }
}

const slugOf = (repo: { owner: string; name: string }) => `${repo.owner}/${repo.name}`;

/** schedule_runs 的结局：巡检自己跑成了（通过、断了）是 ok，没跑成是 failed。 */
function scheduleResult(verdict: CanaryVerdict, reached: number, why: string | null): ScheduleResult {
  if (verdict === 'not_run') return { outcome: 'failed', why: why ?? '巡检没跑成' };
  return { outcome: 'ok', scanned: Math.max(1, reached), found: verdict === 'broken' ? 1 : 0 };
}

async function conclude(
  deps: CanaryDeps,
  base: { runId: number; canaryRunId: number; issueNumber: number | null; taskId: string | null },
  verdict: CanaryVerdict,
  stage: CanaryStage,
  why: string | null,
  steps: readonly CanaryStep[],
): Promise<CanaryRun> {
  const at = deps.now();
  const clipped = why === null ? null : clip(why, 1500);
  const finished = await deps.record.finish(base.canaryRunId, {
    verdict,
    stage,
    why: clipped,
    steps,
    ...(base.issueNumber === null ? {} : { issueNumber: base.issueNumber }),
    ...(base.taskId === null ? {} : { taskId: base.taskId }),
    at,
  });
  if (finished === 'not_found') throw new Error(`这一轮巡检的记录不见了（canary_runs ${base.canaryRunId}）`);
  await deps.runs.finish(base.runId, scheduleResult(verdict, steps.length, clipped), at);
  const run: CanaryRun = {
    runId: base.runId,
    canaryRunId: base.canaryRunId,
    verdict,
    stage,
    issueNumber: base.issueNumber,
    why: clipped,
  };
  const fields = { ...run, stage: CANARY_STAGE_NAMES[stage] };
  if (verdict === 'pass') deps.log('info', '全流程巡检这一轮通过了', fields);
  else if (verdict === 'broken') deps.log('warn', '全流程巡检这一轮断了', fields);
  else deps.log('error', '全流程巡检这一轮没跑成', fields);
  return run;
}

/** 没收尾的一轮补记成没跑成时写的原因。 */
export const CANARY_ABANDONED_WHY = `这一轮过了 ${CANARY_RUN_TIMEOUT_MINUTES / 60} 小时还没有结论：巡检的工作流没收尾就没了（被终止、工人丢了、看一回连着失败），下一轮开始时补记没跑成`;

/**
 * 没收尾的几轮（过了一轮工作流的时限还没有结论：工作流一定已经没了）补记成没跑成，它们在 schedule_runs 的那一行也记没跑成
 * （看门狗照登记表看得见）。之后它们开成了的单照前几轮留下的单收掉。没成的写进备注，不挡这一轮。
 */
async function concludeAbandoned(deps: CanaryDeps, at: Date): Promise<string[]> {
  let lost: { id: number; scheduleRunId: number; issueNumber: number | null }[];
  try {
    lost = await deps.record.abandon({
      before: new Date(at.getTime() - CANARY_RUN_TIMEOUT_MINUTES * 60_000),
      why: CANARY_ABANDONED_WHY,
      at,
    });
  } catch (err) {
    return [`没补记成没收尾的几轮：${message(err)}`];
  }
  const notes: string[] = [];
  for (const r of lost) {
    const which = r.issueNumber === null ? '' : `（#${r.issueNumber}）`;
    try {
      await deps.runs.finish(r.scheduleRunId, { outcome: 'failed', why: CANARY_ABANDONED_WHY }, at);
      notes.push(`补记了没收尾的一轮${which}：没跑成`);
    } catch (err) {
      notes.push(`没收尾的一轮${which}补记了，它在 schedule_runs 的那一行没记成没跑成：${message(err)}`);
    }
  }
  return notes;
}

/** 收掉前几轮留下的单：叫停它的工作流、关单（不做了）。收不掉的写进备注，不挡这一轮。 */
async function cleanLeftovers(
  deps: CanaryDeps,
  repo: { owner: string; name: string },
  at: Date,
): Promise<string[]> {
  const notes: string[] = [];
  let left: { id: number; issueNumber: number | null }[];
  try {
    left = await deps.record.leftovers(slugOf(repo));
  } catch (err) {
    return [`没查成前几轮留下的单：${message(err)}`];
  }
  for (const r of left) {
    if (r.issueNumber === null) continue;
    const n = r.issueNumber;
    try {
      await deps.workflows.stop(
        requirementWorkflowId(repo, n),
        `巡检下一轮开始了（${stamp(at)}），上一轮留下的这张收掉`,
      );
      const now = await deps.github.issueState(n);
      if (now.state === 'open') {
        await deps.github.closeIssue(
          n,
          `巡检下一轮开始了（${stamp(at)}），这张是上一轮断了留下的，收掉。断在哪、为什么见 fleet-dao 的驾驶舱（全流程巡检）和当时的卡住报警。`,
        );
      }
      await deps.record.cleaned(r.id, at);
      notes.push(`收掉了上一轮留下的 #${n}`);
    } catch (err) {
      notes.push(`上一轮留下的 #${n} 没收掉：${message(err)}`);
    }
  }
  return notes;
}

/**
 * 开单：记开始 → 补记没收尾的几轮、收前几轮留下的单 → 找巡检仓的当前版本 → 开单、同时挂上当前版本（正文照 #295 写全需求）。
 * 哪一步没成都算这一轮没跑成（写明停在哪）。记开始就失败：抛 CanaryNotRecordedError（这一轮在库里没有记录）。
 */
export async function openCanaryRound(deps: CanaryDeps): Promise<CanaryStepResult> {
  const startedAt = deps.now();
  let runId: number;
  try {
    runId = await deps.runs.start(CANARY_JOB.id, startedAt);
  } catch (err) {
    throw new CanaryNotRecordedError(`全流程巡检记不上开始：${message(err)}`);
  }
  const repo = 'error' in deps.repo ? null : deps.repo;
  let canaryRunId: number;
  try {
    canaryRunId = await deps.record.start({
      scheduleRunId: runId,
      repo: repo ? slugOf(repo) : null,
      at: startedAt,
    });
  } catch (err) {
    const why = `全流程巡检记不上这一轮：${message(err)}`;
    await deps.runs.finish(runId, { outcome: 'failed', why }, deps.now());
    throw new CanaryNotRecordedError(why);
  }
  const base = { runId, canaryRunId, issueNumber: null as number | null, taskId: null };
  const lost = await concludeAbandoned(deps, startedAt);
  if ('error' in deps.repo || !repo) {
    const why = 'error' in deps.repo ? deps.repo.error : '没配巡检仓';
    return { done: true, run: await conclude(deps, base, 'not_run', 'open', [why, ...lost].join('；'), []) };
  }
  const notes = [...lost, ...(await cleanLeftovers(deps, repo, startedAt))];
  const failed = async (why: string) => ({
    done: true as const,
    run: await conclude(deps, base, 'not_run', 'open', [...notes, why].join('；'), []),
  });
  let milestone: { number: number; title: string };
  try {
    const current = currentVersion(await deps.github.openMilestones());
    if (!current) {
      return failed(
        `巡检仓 ${slugOf(repo)} 没有开着的 v<N> 里程碑（没有当前版本）：接活只派挂在当前版本上的单，巡检单派不出去。给它建一个一直开着的「v1 巡检」`,
      );
    }
    milestone = current.milestone;
  } catch (err) {
    return failed(`读不到巡检仓还开着的里程碑：${message(err)}`);
  }
  let issue: { number: number; url: string };
  try {
    issue = await deps.github.openIssue({
      ...canaryIssue(canaryRunId, startedAt),
      dedupe: `canary:${canaryRunId}`,
      milestone: milestone.number,
    });
  } catch (err) {
    return failed(`在巡检仓开不了单（挂当前版本「${milestone.title}」）：${message(err)}`);
  }
  const at = deps.now().toISOString();
  const state: CanaryState = {
    schemaVersion: 1,
    runId,
    canaryRunId,
    repo,
    issueNumber: issue.number,
    issueUrl: issue.url,
    openedAt: startedAt.toISOString(),
    taskId: null,
    stage: 'intake',
    stageSince: at,
    busyMs: 0,
    lastCheckAt: at,
    steps: [{ stage: 'open', at }],
    checkFailures: 0,
    notes,
  };
  await saveProgress(deps, state);
  deps.log('info', '全流程巡检开了一张单', { issueNumber: issue.number, milestone: milestone.title, notes });
  return { done: false, state };
}

async function saveProgress(deps: CanaryDeps, state: CanaryState): Promise<void> {
  try {
    await deps.record.progress(state.canaryRunId, {
      stage: state.stage,
      steps: state.steps,
      issueNumber: state.issueNumber,
      ...(state.taskId ? { taskId: state.taskId } : {}),
      at: deps.now(),
    });
  } catch (err) {
    // 进度只给人看：写不进不挡巡检，下一回再写
    deps.log('warn', '全流程巡检的进度没写进库', { error: message(err) });
  }
}

/** 看一回：读库、问 Temporal，任务做完了再读 GitHub 上的单子和驾驶舱读到的样子。读不到照抛。 */
async function observe(deps: CanaryDeps, state: CanaryState): Promise<CanaryObservation> {
  const db = await deps.facts(state.issueNumber);
  const workflowId = requirementWorkflowId(state.repo, state.issueNumber);
  const workflow = await deps.workflows.state(workflowId);
  const view = workflow.state === 'running' ? await deps.workflows.view(workflowId) : null;
  const done = db.task?.state === 'done';
  const issue = done ? await deps.github.issueState(state.issueNumber) : null;
  const board = done && db.task ? await deps.board(db.task.id) : null;
  return { at: deps.now().toISOString(), db, workflow, view, issue, board };
}

/** 断了的报警正文：断在哪、为什么、走到哪了、单子在哪、下一步怎么办。 */
export function brokenAlert(
  state: CanaryState,
  stage: CanaryStage,
  why: string,
): { title: string; body: string } {
  const walked = state.steps
    .map((s) => `${CANARY_STAGE_NAMES[s.stage]} ${stamp(new Date(s.at))}`)
    .concat(`${CANARY_STAGE_NAMES[stage]}（没走完）`)
    .join(' → ');
  return {
    title: `全流程巡检断在「${CANARY_STAGE_NAMES[stage]}」`,
    body: [
      `这一轮巡检（${stamp(new Date(state.openedAt))} 开单，巡检仓 #${state.issueNumber}）断在「${CANARY_STAGE_NAMES[stage]}」：${why}`,
      `走到哪了：${walked}`,
      `单子：${state.issueUrl}`,
      ...(state.notes.length > 0 ? [`开单时：${state.notes.join('；')}`] : []),
      '断的这张留着给人看；下一轮（6 小时后）开始时自动收掉。修好了不用管这条：下一轮通过它自己撤。',
    ].join('\n'),
  };
}

/**
 * 看一回，判完记进库：还在跑的写进度；通过的记结论、撤报警；断了的记结论、推报警。连着没查成到上限，这一轮算没跑成。
 * 记结论、推报警没成照抛（活动失败，工作流下一回再来：判出来还是一样的结论）。
 */
export async function checkCanaryRound(deps: CanaryDeps, state: CanaryState): Promise<CanaryStepResult> {
  const base = {
    runId: state.runId,
    canaryRunId: state.canaryRunId,
    issueNumber: state.issueNumber,
    taskId: state.taskId,
  };
  let obs: CanaryObservation;
  try {
    obs = await observe(deps, state);
  } catch (err) {
    const failures = state.checkFailures + 1;
    deps.log('warn', '全流程巡检这一回没查成', { failures, error: message(err) });
    if (failures < CANARY_CHECK_FAILURE_LIMIT) {
      return { done: false, state: { ...state, checkFailures: failures } };
    }
    const why = `巡检连着 ${failures} 回没查成（停在「${CANARY_STAGE_NAMES[state.stage]}」）：${message(err)}`;
    return {
      done: true,
      run: await conclude(deps, base, 'not_run', state.stage, why, state.steps),
    };
  }
  const decision = canaryNext(state, obs);
  const next = decision.state;
  const ended = { ...base, taskId: next.taskId };
  if (decision.kind === 'continue') {
    await saveProgress(deps, next);
    return { done: false, state: next };
  }
  const note = next.notes.length > 0 ? next.notes.join('；') : null;
  if (decision.kind === 'pass') {
    const run = await conclude(deps, ended, 'pass', 'board', note, next.steps);
    await deps.alerts.resolve(
      `全流程巡检 ${stamp(new Date(next.openedAt))} 开单的这一轮通过了（#${next.issueNumber}）`,
    );
    return { done: true, run };
  }
  const alert = brokenAlert(next, decision.stage, decision.why);
  await deps.alerts.raise({ ...alert, taskId: next.taskId });
  const why = `断在「${CANARY_STAGE_NAMES[decision.stage]}」：${decision.why}`;
  const run = await conclude(deps, ended, 'broken', decision.stage, why, next.steps);
  return { done: true, run };
}
