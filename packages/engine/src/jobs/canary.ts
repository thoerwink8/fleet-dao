// 全流程巡检（#223；design 第六节「断链怎么被发现」第 3 层）：每 6 小时在巡检仓开一张固定的小单，看它跟着三段任务工作流
// （#632，workflows/task.ts）从收单一路走到动手、开 PR 过 CI、验收、合并、关单、记账、驾驶舱显示。每一步有期限，超时或出事
// （停下等人、工作流没做完、单子被关成不做了）就推一条「卡住报警」，写清断在哪一步、这一步走了多久；下一轮通过了这条自己撤。
// 一轮 = 开单（openCanaryRound：记开始 → 补记没收尾的几轮、收掉前几轮留下的单 → 找巡检仓的当前版本 → 开单、挂上当前版本）
// → 每 2 分钟看一回（checkCanaryRound：读库、问 Temporal、要时读 GitHub → canaryNext 判 → 记进库）→ 有结论就收尾。
// 结论三种：通过、断在哪、没跑成（巡检自己挂了：没配、仓读不到、开不了单、连着查不成）。没跑成的这一轮在 schedule_runs 记
// failed，由看门狗（#203）照登记表报；断了的这一轮巡检自己跑成了，schedule_runs 记 ok、发现 1 个问题，报警由这里推。
// 立刻跑一轮、等结论、打印每步用时：pnpm drill（../drill.ts，同一个定时任务、同一份代码）。
// 改这里之前必须知道：
// - 收单靠引擎自己拉（jobs/intake.ts，每 5 分钟一轮）：巡检单要过拉单的每一道关——开关打开以后开的、开单的「引擎」机器人在
//   白名单里、挂在当前版本上、交代齐（场景、原话、已知的模块、怎么算做完，runner/task-brief.ts）。canaryIssue 的正文由测试拿
//   真的 buildTaskBrief 核过，改正文要让那条测试照样过；「怎么算做完」下面只放验收条，别的话会被当成一条。
// - 任务工作流走到哪只有 Temporal 一份（taskStatus 查询）；库里的任务行只在开工、停下等人、做完、放弃时写，工作流不在跑了才拿它兜。
// - 判走到哪一步只在 canaryNext（纯函数），读东西只在 observe。
import { currentVersion } from '@fleet-dao/core';
import {
  CANARY_MAX_MINUTES,
  CANARY_RUN_TIMEOUT_MINUTES,
  CANARY_STAGE_NAMES,
  CANARY_STAGES,
  type CanaryDbFacts,
  type CanaryStage,
  type CanaryStep,
  type CanaryVerdict,
  type RecordedCanaryStage,
  type ScheduleResult,
} from '@fleet-dao/db';
import type { TaskState } from '@fleet-dao/shared';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { CANARY_CHECK_FAILURE_LIMIT, CANARY_POLL_SECONDS } from '../contract.ts';
import type { TaskPhase } from '../task-contract.ts';
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
/**
 * 收前几轮留下的单时，它开的 PR 没关掉的报警（#336）：和断了的报警分开一个键——下一轮通过不该把它撤掉，
 * 只有这条没收干净的单后来真把 PR 关掉了（或没有 PR 了）才撤。
 */
export const CANARY_LEFTOVER_PR_ALERT_KEY = 'canary:leftover-pr';
/** 撤报警、放弃前几轮留下的任务、记操作记录时的「谁」。 */
export const CANARY_ACTOR = 'engine:canary';
/** 一轮最多收掉前几轮留下的几张单（多出来的下一轮接着收）。 */
export const CANARY_CLEANUP_LIMIT = 5;
/** 巡检单要改的文件（巡检仓根上）。 */
export const CANARY_LOG_FILE = '巡检记录.md';

/** 每一步给人看的名字：和健康页同一份（@fleet-dao/db 的 CANARY_STAGE_NAMES，老步骤也认得）。 */
export { CANARY_STAGE_NAMES };

/**
 * 每一步多久没走完算断（分钟）：从上一步走完算起，等并发空位、等额度清零的时间不算（那是忙，不是断；一轮 5 小时的总上限照样管着）。
 * 收单：拉单每 5 分钟一轮；动手：读交代、选路、建树、一次性会话（最长 60 分钟）、推分支、开 PR；之后照一张小单的正常用时放宽。
 */
export const CANARY_STAGE_LIMIT_MINUTES: Readonly<Record<CanaryStage, number>> = {
  open: 10,
  intake: 20,
  implement: 60,
  pr: 45,
  verify: 45,
  merge: 30,
  close: 15,
  ledger: 10,
  // 本机档收不到 GitHub 事件：PR 镜像里的「合了」要等对账补漏（每 15 分钟一轮）补上
  board: 30,
};

const STAGE_ORDER: readonly CanaryStage[] = CANARY_STAGES;
const indexOf = (s: CanaryStage) => STAGE_ORDER.indexOf(s);

/**
 * 任务工作流的阶段（task-contract.ts 的 TaskPhase）落在巡检的哪一步：工作流在这个阶段里，就是这一步还没走完。
 * 停下等人、放弃不落在哪一步（另判）。TaskPhase 加了新值这里编译不过：要想清楚它落在哪一步。
 */
const TASK_PHASE_STAGE: Readonly<Record<TaskPhase, CanaryStage | null>> = {
  brief: 'implement',
  implement: 'implement',
  ci: 'pr',
  verify: 'verify',
  merge: 'merge',
  done: 'close',
  parked: null,
  abandoned: null,
};

/** 等这两种不算断：等并发空位、等额度清零（task-contract.ts 的 TaskWait）。 */
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
  /** 在等哪一步走完。换版本前起的一轮可能是老步骤（canaryNext 从收单接着看）。 */
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
  /** 这张单的 PR 号：任务工作流开了 PR 以后从它的状态里读到的（驾驶舱显示那一步要核镜像里的这个 PR）。 */
  prNumber?: number | undefined;
}

/** 在跑的任务工作流 taskStatus 查询里要用的几样（real/canary.ts 解析，认不出照抛）。 */
export interface CanaryView {
  /** 任务工作流的阶段（TaskPhase）。 */
  phase: string;
  /** 白话：正在做什么。 */
  doing: string;
  /** 停下等人（阶段是 parked，或在等的是人）。 */
  parked: boolean;
  waiting: { kind: string; detail: string } | null;
  prNumber: number | null;
  lastProblem: string | null;
  /** 动手第几轮、验收第几轮：大于 1 是返工过。 */
  round: number;
  verifyRound: number;
}

/** 驾驶舱读到的这张单（后端的 Store：getTask、getPullRequest——主页「做完的」那一栏读的同一份）。 */
export interface CanaryBoard {
  taskState: TaskState | null;
  /**
   * PR 镜像里的这个 PR；还不知道 PR 号、镜像里还没有是 null。linkedIssue 是它挂的第一张单：主页「做完的」按它反查标题，
   * 挂的不是这张单，驾驶舱上就显示不出这张单做完了。
   */
  pr: {
    number: number;
    state: 'open' | 'closed' | 'merged';
    mergedAt: string | null;
    linkedIssue: number | null;
  } | null;
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
  /** spentMs：断在的这一步走了多久（等空位、额度的不算）。 */
  | { kind: 'broken'; state: CanaryState; stage: CanaryStage; why: string; spentMs: number };

const WORKFLOW_WORDS: Readonly<Record<string, string>> = {
  COMPLETED: '跑完了',
  FAILED: '失败了',
  CANCELLED: '被取消了',
  TERMINATED: '被强行终止了',
  TIMED_OUT: '超时了',
  CONTINUED_AS_NEW: '换了新的一轮',
};

/** 一段时长说成人话：「47 分 3 秒」「2 小时 5 分」「40 秒」。 */
export function spanWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** 每一步用了多久：第一步从开单那一刻算起，之后每一步从上一步走完算起。时刻认不出的那一步 ms 是 null（不拿 0 顶）。 */
export function stepSpans(
  openedAt: string,
  steps: readonly CanaryStep[],
): { stage: RecordedCanaryStage; at: string; ms: number | null }[] {
  let previous = Date.parse(openedAt);
  return steps.map((s) => {
    const at = Date.parse(s.at);
    const ms = Number.isFinite(at) && Number.isFinite(previous) ? Math.max(0, at - previous) : null;
    previous = at;
    return { stage: s.stage, at: s.at, ms };
  });
}

/** 这张单此刻在任务工作流的哪一步（落在巡检的哪一步）；认不出（停下等人、还没开工）是 null。 */
function taskStage(obs: CanaryObservation): CanaryStage | null {
  if (obs.db.task?.state === 'done') return 'close';
  const phase = obs.view?.phase ?? obs.db.task?.phase ?? null;
  if (phase === null || !Object.hasOwn(TASK_PHASE_STAGE, phase)) return null;
  return TASK_PHASE_STAGE[phase as TaskPhase];
}

/** 这一步走完了没有。 */
function stageDone(stage: CanaryStage, obs: CanaryObservation, state: CanaryState): boolean {
  const { db } = obs;
  switch (stage) {
    case 'open':
      return true;
    case 'intake':
      // 拉单建了任务行、任务工作流起来了（起不成的任务行留在排队，下一轮拉单再起）
      return db.task !== null && obs.workflow.state !== 'missing';
    case 'implement':
    case 'pr':
    case 'verify':
    case 'merge': {
      const at = taskStage(obs);
      return at !== null && indexOf(at) > indexOf(stage);
    }
    case 'close':
      return (
        db.task?.state === 'done' && obs.issue?.state === 'closed' && obs.issue.stateReason === 'completed'
      );
    case 'ledger': {
      const r = db.runs;
      return r.manual > 0 && r.verify > 0 && r.ended === r.total && r.withUsage > 0 && db.timings > 0;
    }
    case 'board': {
      const b = obs.board;
      return (
        b?.taskState === 'done' &&
        b.pr?.state === 'merged' &&
        b.pr.mergedAt !== null &&
        b.pr.linkedIssue === state.issueNumber
      );
    }
  }
}

/** 这一步已经断了（不用等期限）的原因；没断是 null。 */
function brokenNow(stage: CanaryStage, obs: CanaryObservation, state: CanaryState): string | null {
  const { db } = obs;
  if (!db.repo) return '巡检仓不在库里了（没受管）：拉单不看这个仓';
  if (stage === 'intake') {
    if (db.repo.autoDispatchSince === null) {
      return '巡检仓的「让 AI 接活」开关关着，拉单不拉这张单（fleet-api dispatch <巡检仓> on）';
    }
    if (db.repo.autoDispatchSince.getTime() > Date.parse(state.openedAt)) {
      return '巡检仓的「让 AI 接活」开关是开单之后才打开的，拉单不拉开关打开以前开的单';
    }
  }
  const task = db.task;
  if (task && (task.state === 'failed' || task.state === 'stopped')) {
    return `任务${task.state === 'failed' ? '没做完（失败了）' : '被叫停了（放弃）'}${task.lastProblem ? `：${task.lastProblem}` : ''}`;
  }
  if (indexOf(stage) >= indexOf('implement') && indexOf(stage) <= indexOf('merge')) {
    const alert = db.openAlerts[0];
    if (alert) return `停下等人：${alert.title}`;
    if (obs.view?.parked) {
      return `停下等人：${obs.view.waiting?.detail ?? obs.view.lastProblem ?? '（没说原因）'}`;
    }
    if (obs.workflow.state === 'missing') return '这张单的任务工作流不见了（没在跑、Temporal 里也查不到）';
    if (obs.workflow.state === 'closed' && obs.workflow.status !== 'COMPLETED') {
      const words = WORKFLOW_WORDS[obs.workflow.status] ?? obs.workflow.status;
      return `这张单的任务工作流${words}${task?.lastProblem ? `：${task.lastProblem}` : ''}`;
    }
  }
  if (stage === 'close' && obs.issue?.state === 'closed' && obs.issue.stateReason !== 'completed') {
    return `单子被关成了「${obs.issue.stateReason ?? '没写原因'}」，不是做完关的`;
  }
  return null;
}

/** 最近一轮拉单说成人话（收单卡住时写进原因）。 */
function intakeWords(last: CanaryDbFacts['lastIntake']): string {
  if (!last) return '库里没有拉单的记录（定时任务 intake 一轮都没跑过）';
  const when = `最近一轮拉单 ${stamp(last.startedAt)} 开始`;
  if (last.outcome === null) return `${when}，还没跑完`;
  if (last.outcome === 'ok') {
    return `${when}，跑成了却没拉起这张单（每张单没派的原因在引擎日志「拉单这一轮」那行：作者不在白名单、没挂当前版本、交代不全……）`;
  }
  return `${when}，记的是 ${last.outcome}${last.why ? `：${last.why}` : ''}`;
}

/** 超时的时候，这一步为什么没走完（给人看的补充）。 */
function whyStuck(stage: CanaryStage, obs: CanaryObservation): string {
  const { db } = obs;
  if (stage === 'intake') {
    const intake = intakeWords(db.lastIntake);
    return db.task === null
      ? `库里还没有这张单的任务行，拉单没把它拉起来；${intake}`
      : `任务行建了（${db.task.state}），任务工作流还没起来（起不成的下一轮拉单再起）；${intake}`;
  }
  const parts: string[] = [];
  const view = obs.view;
  if (view) {
    parts.push(`在做：${view.doing}`);
    if (view.round > 1 || view.verifyRound > 1) {
      parts.push(`返工过：动手第 ${view.round} 轮、验收第 ${view.verifyRound} 轮`);
    }
    if (view.waiting) parts.push(`在等：${view.waiting.detail}`);
  } else if (indexOf(stage) <= indexOf('merge')) {
    parts.push(
      obs.workflow.state === 'running'
        ? '任务工作流在跑，状态没查到'
        : obs.workflow.state === 'missing'
          ? '任务工作流不在 Temporal 里'
          : `任务工作流${WORKFLOW_WORDS[obs.workflow.status] ?? obs.workflow.status}`,
    );
  }
  const problem = view?.lastProblem ?? db.task?.lastProblem;
  if (problem) parts.push(`最近的问题：${problem}`);
  if (stage === 'close' && obs.issue?.state === 'open') parts.push('GitHub 上单子还开着');
  if (stage === 'ledger') {
    const r = db.runs;
    parts.push(
      `runs 记了 ${r.total} 笔（动手 ${r.manual}、验收 ${r.verify}）、结束了 ${r.ended} 笔、记上用量的 ${r.withUsage} 笔；每步耗时 ${db.timings} 笔`,
    );
  }
  if (stage === 'board') {
    const b = obs.board;
    const pr = b?.pr;
    parts.push(
      !b
        ? '驾驶舱那边还没读成'
        : `驾驶舱读到的：任务 ${b.taskState ?? '（没有）'}、${
            pr
              ? `PR #${pr.number} ${pr.state}${pr.mergedAt ? '' : '（没有合并时刻）'}、挂的单 ${pr.linkedIssue === null ? '（没有）' : `#${pr.linkedIssue}`}`
              : 'PR 镜像里没有这张单的 PR（对账补漏还没补上？）'
          }`,
    );
  }
  return parts.join('；');
}

/**
 * 换版本前起的一轮（跟 Fusion 走，停在派活、规划、执行这几个老步骤上）：从收单接着看——走过的照留，这一回能走完的一回里走完，
 * 走不完的到期限照常断。
 */
function resumable(state: CanaryState): CanaryState {
  return STAGE_ORDER.includes(state.stage) ? state : { ...state, stage: 'intake' };
}

/**
 * 看一回之后怎么办（纯函数，测试逐条核对）：能往前走的一步步往前走（一回里可以走好几步），走完最后一步是通过；
 * 当前这一步已经出事的、超过期限的、整轮超过上限的，断在这一步（带上这一步走了多久）。
 */
export function canaryNext(state: CanaryState, obs: CanaryObservation): CanaryDecision {
  const at = Date.parse(obs.at);
  const prNumber = obs.view?.prNumber ?? state.prNumber ?? null;
  let s: CanaryState = {
    ...resumable(state),
    steps: [...state.steps],
    checkFailures: 0,
    lastCheckAt: obs.at,
    taskId: state.taskId ?? obs.db.task?.id ?? null,
    ...(prNumber === null ? {} : { prNumber }),
  };
  // 两回之间一直在等空位、额度：这段不算进这一步的期限
  if (obs.view?.waiting && BUSY_WAITS.includes(obs.view.waiting.kind)) {
    s.busyMs += Math.max(0, at - Date.parse(state.lastCheckAt));
  }
  for (;;) {
    if (!stageDone(s.stage, obs, s)) break;
    s.steps.push({ stage: s.stage, at: obs.at });
    const next = STAGE_ORDER[indexOf(s.stage) + 1];
    if (!next) return { kind: 'pass', state: s };
    s = { ...s, stage: next, stageSince: obs.at, busyMs: 0 };
  }
  const spentMs = Math.max(0, at - Date.parse(s.stageSince) - s.busyMs);
  const broken = brokenNow(s.stage, obs, s);
  if (broken) return { kind: 'broken', state: s, stage: s.stage, why: broken, spentMs };
  const limit = CANARY_STAGE_LIMIT_MINUTES[s.stage];
  if (spentMs > limit * 60_000) {
    const why = whyStuck(s.stage, obs);
    return {
      kind: 'broken',
      state: s,
      stage: s.stage,
      why: `超过期限 ${limit} 分钟还没走完${why ? `：${why}` : ''}`,
      spentMs,
    };
  }
  if (at - Date.parse(s.openedAt) > CANARY_MAX_MINUTES * 60_000) {
    const why = whyStuck(s.stage, obs);
    return {
      kind: 'broken',
      state: s,
      stage: s.stage,
      why: `一轮 ${CANARY_MAX_MINUTES / 60} 小时还没走完${why ? `：${why}` : ''}`,
      spentMs,
    };
  }
  return { kind: 'continue', state: s };
}

// —— 巡检单本身 ——

/**
 * 巡检单的标题和正文：正文写全需求——拉单要的三栏（场景、原话、已知的模块）、要什么，最后是写了字的「## 怎么算做完」；
 * 不写「文档：」那一行（#654 起所有新单都是这样，需求就在单子正文里）。开单时还不知道单号，要追加的那一行用这一轮的编号和
 * 开单时刻认（每轮都不一样）。「已知的模块」只写这一个文件：分档按它定成快档（runner/tier.ts）。
 */
export function canaryIssue(round: number, openedAt: Date): { title: string; body: string } {
  const line = canaryLogLine(round, openedAt);
  return {
    title: `巡检第 ${round} 轮：往巡检记录追加一行`,
    body: [
      '## 场景',
      '',
      'fleet-dao 的全流程巡检每 6 小时自动开一张这样的小单，由引擎从收单一路做到合并、关单，证明整条链是通的；断在哪一步会报警。不用人管。',
      '',
      '## 原话',
      '',
      '无（引擎的全流程巡检自己开的单，没有创始人原话）。',
      '',
      '## 已知的模块',
      '',
      `- \`${CANARY_LOG_FILE}\``,
      '',
      '## 要什么',
      '',
      `在仓根的 \`${CANARY_LOG_FILE}\` 末尾追加一行 \`${line}\`（这一轮巡检的编号和开单时刻，UTC）。文件不在就新建：第一行写 \`# 巡检记录\`，空一行，再写这一行。别的内容一个字都不动。`,
      '',
      '## 怎么算做完',
      '',
      `- \`${CANARY_LOG_FILE}\` 的最后一行是 \`${line}\`，一字不差。`,
      `- 这张单改到的文件只有 \`${CANARY_LOG_FILE}\`。`,
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
  /**
   * 这张单开过的 PR（引擎分支 fleet/<单号>-t…）里还开着的关掉，回关了哪几个：已合并、已关的不动，没有 PR 回空。
   * 列不出、关不掉照抛（调用方报警，不当成收干净了）。
   */
  closePulls(issueNumber: number, comment: string): Promise<number[]>;
}

export interface CanaryDeps {
  /** 巡检仓（引擎配置 FLEET_CANARY_REPO）；没配、认不出是 error，这一轮没跑成。 */
  repo: { owner: string; name: string } | { error: string };
  runs: ScheduleRunLog;
  record: CanaryRecord;
  github: CanaryGitHub;
  /** 这张单在库里的事实（@fleet-dao/db 的 canaryDbFacts）；since 是这一轮开单的时刻（认 runs 的账用）。 */
  facts(input: { issueNumber: number; since: Date }): Promise<CanaryDbFacts>;
  workflows: {
    state(workflowId: string): Promise<WorkflowState>;
    /** 在跑的任务工作流的 taskStatus 查询；认不出、查不了照抛。 */
    view(workflowId: string): Promise<CanaryView>;
    /** 放弃一张单的任务工作流（收前几轮留下的单：发「放弃」信号，工作流存档收树退出）；工作流已经不在回 gone。 */
    stop(workflowId: string, reason: string): Promise<'sent' | 'gone'>;
  };
  /** 驾驶舱读到的这张单（后端 Store 的 getTask、getPullRequest）；prNumber 还不知道是 null（只读任务）。 */
  board(taskId: string, prNumber: number | null): Promise<CanaryBoard>;
  alerts: {
    raise(input: { title: string; body: string; taskId: string | null; key?: string }): Promise<void>;
    /** 撤掉一条（没开着的不管）；不给 key 撤的是断了的那条（CANARY_ALERT_KEY）。 */
    resolve(why: string, key?: string): Promise<void>;
  };
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 一轮的结局（工作流的返回值，和记进库的同一份）。进了工作流历史：以后只许加字段。 */
export interface CanaryRun {
  runId: number;
  canaryRunId: number;
  verdict: CanaryVerdict;
  stage: CanaryStage;
  issueNumber: number | null;
  why: string | null;
  /** 这一轮几点开始、几点有的结论、每一步走完的时刻：pnpm drill 照它打印每步用时（这三样之前的老结局里没有）。 */
  startedAt: string;
  endedAt: string;
  steps: CanaryStep[];
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
  base: {
    runId: number;
    canaryRunId: number;
    issueNumber: number | null;
    taskId: string | null;
    startedAt: string;
  },
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
    startedAt: base.startedAt,
    endedAt: at.toISOString(),
    steps: [...steps],
  };
  const fields = {
    runId: run.runId,
    canaryRunId: run.canaryRunId,
    verdict,
    issueNumber: run.issueNumber,
    why: run.why,
    stage: CANARY_STAGE_NAMES[stage],
  };
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

/**
 * 收掉前几轮留下的单：放弃它的任务工作流、关单（不做了）、连它开的、还开着的 PR 一起关（#336：不关的话巡检仓里 PR 一轮攒一个）。
 * 收不掉的写进备注，不挡这一轮；关单成了但 PR 没关掉的，推一条单独的报警（CANARY_LEFTOVER_PR_ALERT_KEY）、不记「收过了」，
 * 下一轮这张单还在留下的单里，接着关；一轮里没有任何一张收不掉才撤这条报警。
 */
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
  const pullFailures: string[] = [];
  let anyFailed = false;
  let tried = 0;
  for (const r of left) {
    if (r.issueNumber === null) continue;
    const n = r.issueNumber;
    tried += 1;
    try {
      await deps.workflows.stop(
        taskWorkflowId(repo, n),
        `巡检下一轮开始了（${stamp(at)}），上一轮留下的这张收掉`,
      );
      const now = await deps.github.issueState(n);
      if (now.state === 'open') {
        await deps.github.closeIssue(
          n,
          `巡检下一轮开始了（${stamp(at)}），这张是上一轮断了留下的，收掉。断在哪、为什么见 fleet-dao 的驾驶舱（全流程巡检）和当时的卡住报警。`,
        );
      }
    } catch (err) {
      anyFailed = true;
      notes.push(`上一轮留下的 #${n} 没收掉：${message(err)}`);
      continue;
    }
    let closed: number[];
    try {
      closed = await deps.github.closePulls(
        n,
        `巡检下一轮开始了（${stamp(at)}），这个 PR 是上一轮巡检单 #${n} 断了留下的，随单收掉（不合并）。`,
      );
    } catch (err) {
      anyFailed = true;
      pullFailures.push(`#${n}：${message(err)}`);
      notes.push(`上一轮留下的 #${n} 已关，但它开的 PR 没关掉：${message(err)}`);
      continue;
    }
    try {
      await deps.record.cleaned(r.id, at);
      notes.push(
        closed.length > 0
          ? `收掉了上一轮留下的 #${n}（连它开的 PR ${closed.map((p) => `#${p}`).join('、')} 一起关了）`
          : `收掉了上一轮留下的 #${n}`,
      );
    } catch (err) {
      anyFailed = true;
      notes.push(`上一轮留下的 #${n} 没收掉：${message(err)}`);
    }
  }
  // 留下的单一张都没动过（空的）不碰报警：这条报警对应的单还留着没收干净时，它一定还在名单里
  if (tried > 0) notes.push(...(await syncLeftoverPullAlert(deps, pullFailures, anyFailed)));
  return notes;
}

/** 收前几轮留下的单时，PR 没关掉的报警：有就推（同一个键，原地更新），一轮里什么都没收不掉才撤。推不出、撤不掉写进备注。 */
async function syncLeftoverPullAlert(
  deps: CanaryDeps,
  pullFailures: readonly string[],
  anyFailed: boolean,
): Promise<string[]> {
  try {
    if (pullFailures.length > 0) {
      await deps.alerts.raise({
        key: CANARY_LEFTOVER_PR_ALERT_KEY,
        title: '全流程巡检收掉上一轮留下的单时，没关掉它开的 PR',
        body: [
          `巡检仓里这些单已经关了，但它们开的 PR 关不掉（每一轮开头会再试，关掉了这条自己撤）：`,
          ...pullFailures,
        ].join('\n'),
        taskId: null,
      });
    } else if (!anyFailed) {
      await deps.alerts.resolve('上一轮留下的单连带的 PR 都关掉了', CANARY_LEFTOVER_PR_ALERT_KEY);
    }
    return [];
  } catch (err) {
    return [
      `${pullFailures.length > 0 ? 'PR 没关掉的报警推不出' : 'PR 没关掉的报警撤不掉'}：${message(err)}`,
    ];
  }
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
  const base = {
    runId,
    canaryRunId,
    issueNumber: null as number | null,
    taskId: null,
    startedAt: startedAt.toISOString(),
  };
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
        `巡检仓 ${slugOf(repo)} 没有开着的 v<N> 里程碑（没有当前版本）：拉单只拉挂在当前版本上的单，巡检单派不出去。给它建一个一直开着的「v1 巡检」`,
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
  const db = await deps.facts({ issueNumber: state.issueNumber, since: new Date(state.openedAt) });
  const workflowId = taskWorkflowId(state.repo, state.issueNumber);
  const workflow = await deps.workflows.state(workflowId);
  const view = workflow.state === 'running' ? await deps.workflows.view(workflowId) : null;
  const done = db.task?.state === 'done';
  const issue = done ? await deps.github.issueState(state.issueNumber) : null;
  const prNumber = view?.prNumber ?? state.prNumber ?? null;
  const board = done && db.task ? await deps.board(db.task.id, prNumber) : null;
  return { at: deps.now().toISOString(), db, workflow, view, issue, board };
}

/** 断了的报警正文：断在哪、这一步走了多久、为什么、走到哪了（每一步几点、用了多久）、单子在哪、下一步怎么办。 */
export function brokenAlert(
  state: CanaryState,
  stage: CanaryStage,
  why: string,
  spentMs: number,
): { title: string; body: string } {
  const walked = stepSpans(state.openedAt, state.steps)
    .map(
      (s) =>
        `${CANARY_STAGE_NAMES[s.stage] ?? s.stage} ${stamp(new Date(s.at))}${s.ms === null ? '' : `（${spanWords(s.ms)}）`}`,
    )
    .concat(`${CANARY_STAGE_NAMES[stage]}（没走完，走了 ${spanWords(spentMs)}）`)
    .join(' → ');
  return {
    title: `全流程巡检断在「${CANARY_STAGE_NAMES[stage]}」`,
    body: [
      `这一轮巡检（${stamp(new Date(state.openedAt))} 开单，巡检仓 #${state.issueNumber}）断在「${CANARY_STAGE_NAMES[stage]}」（这一步走了 ${spanWords(spentMs)}）：${why}`,
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
    startedAt: state.openedAt,
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
    const name = CANARY_STAGE_NAMES[state.stage] ?? state.stage;
    const why = `巡检连着 ${failures} 回没查成（停在「${name}」）：${message(err)}`;
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
  const alert = brokenAlert(next, decision.stage, decision.why, decision.spentMs);
  await deps.alerts.raise({ ...alert, taskId: next.taskId });
  const why = `断在「${CANARY_STAGE_NAMES[decision.stage]}」（这一步走了 ${spanWords(decision.spentMs)}）：${decision.why}`;
  const run = await conclude(deps, ended, 'broken', decision.stage, why, next.steps);
  return { done: true, run };
}
