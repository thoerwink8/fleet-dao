// 法国指挥官会话（#3294 第 2 片、#3423）：停下等人的单，停了超过 15 分钟、第 1 片规则（jobs/parked-retry.ts）没解开的，
// 以及「已继续满三次、交指挥官」的，交给用途 commander 选出来的模型看一眼，让它对每张单交一个裁决加理由，引擎执行到出结果。
//
// 改这里之前必须知道：
// - 会话只交裁决，不动手、没有 GitHub 令牌（和整理待办同一条一次性会话的路，real/groom.ts 的 readOnlySessionRunner）。
//   引擎拿裁决先过纯函数白名单（decisions/park-triage.ts；额度超预算另按 decisions/spin.ts 判空转），放行的才执行。
// - 人不处理停下的单（创始人 2026-10-20，引导单 #3425）：「留给人」只剩三种理由类别（要掏新钱、删了找不回又没备份、改标准）。
//   前两种写「要你拍」卡（带选项），改标准给单子贴「本机做」交本机指挥官。没带类别的留给人、没给裁决的、交了白名单外动作的，
//   引擎改按这种停法的默认动作执行（decisions/park-triage.ts 的 defaultAction），不退成「只写诊断」。
// - 每张单每次停下最多处理一次：处理前先记一条 commander.claim（键 = 工作流编号 + 第几次停下）。会话没起成（主线头没读到、
//   选不到路由、会话报错、回答里找不到裁决清单）不算处理过：另记一条 commander.retry，下一轮还会再看；同一次停下最多试
//   PARK_TRIAGE_SESSION_TRIES 次，第 3 次还没起成就当场按默认动作执行。认领数多于没起成数才算处理过。
//   全局熔断（PARK_TRIAGE_DAILY_CAP，数 24 小时内「有效」的 claim；没起成的那次不算）：碰到它这一轮记 partial、发
//   commander:daily-cap（列等着的单和下一个名额什么时候空出来），回到上限以下自动撤。它只防失控，不是日常配额：
//   防同一张单空转的是单张单防空转（decisions/park-triage.ts 的 noContinue：24 小时内指挥官处理满 3 次，
//   或这次停下的原文和上一次判「继续」时一字不差，就不再放行「继续」）。设置 engine.commander 能关，关着不看。
// - 老历史（patched('park-kind') 为假，查询里没有 status.park）不再静默跳过：停下编号从开着的停下提醒（<工作流>:park:<n>）读，
//   停法按提醒标题、正文和任务行认（legacyParkKind），认不出写进这一轮的 problems 并按「按临时的办」处理。
//   老历史的「继续」用 COMMANDER_LEGACY_ACTOR（工作流按普通继续收），收不到额度放宽。
// - 运行环境类停法按工作流记在查询里的失败码和规则编号认（triageKindOf），不按标题文字猜。
// - 用途 commander 没配模型（路由页清空了）：明说「没配模型」并报警，不悄悄不跑。
// - 执行的操作都记在 engine:commander 名下（操作记录 target=commander），诊断文字（理由、白名单核对结果、空转判断）带进发出的提醒。

import { createHash } from 'node:crypto';
import { LOCAL_LABEL } from '@fleet-dao/conventions';
import type { AcceptanceDutyRow, CommanderAcceptanceTask, ScheduleResult } from '@fleet-dao/db';
import {
  type AcceptanceCoverage,
  acceptanceDutyState,
  type DecisionOption,
  type DecisionReason,
  noteOnlyOptions,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import { COMMANDER_ACTOR, COMMANDER_LEGACY_ACTOR, ROUNDS_HANDOFF_TITLE } from '../commander-contract.ts';
import {
  type AcceptanceVerdictCheck,
  allowedActions,
  COMMANDER_ACTION_WORDS,
  type CommanderAction,
  checkAcceptanceVerdict,
  checkVerdict,
  type DefaultAction,
  defaultAction,
  LEAVE_REASON_WORDS,
  LEAVE_REASONS,
  type LeaveReason,
  legacyParkKind,
  PARK_KIND_WORDS,
  type ParkFacts,
  type TriageKind,
  triageKindOf,
} from '../decisions/park-triage.ts';
import { judgeSpin, type SpinJudgement, type SpinRound } from '../decisions/spin.ts';
import type { ContinueCommand, TaskParkInfo } from '../task-contract.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import type { GroomSessionInput, GroomSessionOutcome } from './groom.ts';
import { extractJson, renderNewIssueBody } from './groom-plan.ts';
import type { IntakeRepo } from './intake.ts';
import type { ParkedRetryRow, ParkedSnapshot } from './parked-retry.ts';
import { stamp } from './reconcile-common.ts';

export const PARK_TRIAGE_EVERY_MINUTES = 10;
/** 和每 10 分钟的引擎续停（4 分起）错开。 */
export const PARK_TRIAGE_OFFSET_MINUTES = 7;
/** 停下超过这么久、规则没解开，才交指挥官（引擎续停每 10 分钟看一遍，这里等它至少看过一次）。 */
export const PARK_TRIAGE_AFTER_MINUTES = 15;
/** 全局熔断：24 小时内最多几张有效认领（commander.claim 去掉没起成的）。碰到它就报警，不再起会话。 */
export const PARK_TRIAGE_DAILY_CAP = 60;
export const PARK_TRIAGE_CAP_ALERT_KEY = 'commander:daily-cap';
/** 单张单防空转：同一张单 24 小时内指挥官已经处理满这么多次，就不再放行「继续」。 */
export const PARK_TRIAGE_SPIN_HANDLED = 3;
const WINDOW_MS = 24 * 3_600_000;
/** 一个会话一次最多看几张（同一个仓的）；一轮最多起几个会话。 */
export const PARK_TRIAGE_BATCH = 5;
export const PARK_TRIAGE_MAX_SESSIONS = 2;
/** 会话最长几分钟。 */
export const PARK_TRIAGE_SESSION_MINUTES = 20;
/** 同一次停下，会话最多试几次没起成；第这么多次还没起成就按默认动作执行。 */
export const PARK_TRIAGE_SESSION_TRIES = 3;
export const PARK_TRIAGE_JOB = {
  id: 'park-triage',
  name: '停下的单交指挥官会话看',
  schedule: '每 10 分钟（7 分起）',
  expectEveryMinutes: 60,
} as const;

/** 改标准的停下贴这个标签交本机指挥官（conventions 的 LOCAL_LABEL：引擎不接贴了它的单）。 */
export const LOCAL_WORK_LABEL = LOCAL_LABEL;

/** 操作记录的 action：先记「认领」，执行了再记「执行」；会话没起成记「重试」（这一次停下不算处理过）。 */
export const COMMANDER_AUDIT_CLAIM = 'commander.claim';
export const COMMANDER_AUDIT_ACT = 'commander.act';
export const COMMANDER_AUDIT_RETRY = 'commander.retry';

export type CommanderSwitch = { on: true } | { on: false; why: string };

export interface CommanderAuditView {
  at: Date;
  action: string;
  after: unknown;
  ok?: boolean;
}

export interface CommanderNotice {
  level: 'daily' | 'alert' | 'decision';
  key: string;
  title: string;
  body: string;
  taskId: string | null;
  /** 「要你拍」才带：选项和原因（落库时核）。 */
  options?: DecisionOption[];
  reason?: DecisionReason;
}

export interface ParsedAcceptanceVerdict {
  issue: number;
  dutyId: number;
  generation: number;
  prNumber: number;
  head: string;
  action: 'settle' | 'supersede' | 'leave';
  reason: string;
  evidence?: string | undefined;
  humanOnly?: string | undefined;
  target?: { id: number; generation: number; prNumber: number; head: string } | undefined;
  coverage?: readonly unknown[] | undefined;
}

export interface ParkTriageItem {
  row: ParkedRetryRow;
  workflowId: string;
  park: TaskParkInfo;
  /** 指挥官看的停法（运行环境类按失败码认出来）。缺省按 park.kind 认（老调用方）。 */
  kind?: TriageKind;
  /** 老历史：查询里没有 status.park，停法从提醒和任务行认的。 */
  legacy?: boolean;
  /** 这一次停下之前会话已经没起成几次。 */
  attempts?: number;
  /** 同一张单同一种停下已经继续过一次还停。 */
  continuedBefore?: boolean;
  /** 已继续满三次、交指挥官的那一停。 */
  handoff: boolean;
  /** 这一次停下的提醒正文（原因原文）；没读到是 null。 */
  detail: string | null;
  /** 原文的指纹（detailHashOf）；原文没读到没有。记进执行记录，下一次停下拿来比「一字不差」。 */
  detailHash?: string | undefined;
  /** 单张单防空转生效时的原因：有它就不放行「继续」。 */
  noContinue?: string | undefined;
  /** 这张单已有的回合（旧的在前）；没读到是 null。 */
  rounds: SpinRound[] | null;
  /** 只有额度停法算；回合没读到也是 null（allowedActions 当「没法判」）。 */
  spin: SpinJudgement | null;
}

export interface CommanderActEntry {
  item: ParkTriageItem;
  action: CommanderAction | 'reject';
  reason: string;
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
  /** 指挥官的裁决，还是引擎替它执行的默认动作。 */
  source?: 'verdict' | 'default';
}

export interface OpenParkAlert {
  seq: number;
  title: string;
  body: string | null;
  at: Date;
}

/** 重做接续阶段。叫停已发出、新代请求已提交，都不是重做完成。 */
export const REDO_FOLLOW_PHASES = [
  'stop_sent_unconfirmed',
  'old_terminal_pending_start',
  'start_failed',
  'started',
] as const;
export type RedoFollowPhase = (typeof REDO_FOLLOW_PHASES)[number];

/** 给回执和测试钉住的四句。改字面要连测试一起改。 */
export const REDO_RECEIPT = {
  stopUnconfirmed: '叫停已发送、终态未确认',
  pendingStart: '旧代已终态、新代待启动',
  startFailed: '旧代已终态、新代启动失败',
  started: '新代已确认启动',
} as const;

/** 叫停前看到的一代 Temporal 执行。接续时 runId 必须仍是这一条。 */
export interface RedoExecutionIdentity {
  workflowId: string;
  generation: number;
  runId: string;
}

export type RedoFollowBlock = 'running' | 'unknown' | 'identity' | 'exists' | 'start';

/** 可信执行意图。只追加在 commander.act 的 after.redoFollow 里，不另开账。 */
export interface RedoFollowIntent {
  intentId: string;
  phase: RedoFollowPhase;
  /** 第一次没做成的原文。后面的接续不得改写这一句。 */
  why: string;
  identities: RedoExecutionIdentity[];
  source: 'verdict' | 'default';
  reason: string;
  /** 同一时刻多条时，大的是后写的。 */
  seq: number;
  block?: RedoFollowBlock;
}

export interface RedoResumeContext {
  intentId: string;
  parkSeq: number;
  source: 'verdict' | 'default';
  reason: string;
  follow?: RedoFollowIntent;
}

/** ok:true 只表示新代已经确认启动。follow 让下一轮标准调度认得接续停在哪。 */
export type CommanderRedoResult =
  | { ok: true; workflowId: string; generation: number; follow?: RedoFollowIntent }
  | ({ ok: false; why: string } & { follow?: RedoFollowIntent });

export function redoIntentId(workflowId: string, parkSeq: number): string {
  return `redo:${workflowId}#${parkSeq}`;
}

export interface ParkTriageDeps {
  /** 设置 engine.commander：没设过算开；读不到、认不出按关（回原因）。 */
  enabled(): Promise<CommanderSwitch>;
  /** 用途 commander 下有没有模型。 */
  purposeConfigured(): Promise<boolean>;
  /** 用途已明确配有模型时，只解除缺配置提醒；不代表路由或会话已恢复。 */
  resolveNoModelAlert(): Promise<void>;
  /** 回到上限以下，撤 commander:daily-cap。没有这张卡也不报错。写不进照抛。 */
  resolveCapAlert(): Promise<void>;
  /** state=stalled、executor=engine 的任务。读不到照抛。 */
  tasks(): Promise<ParkedRetryRow[]>;
  /** PR 已合并超过 30 分钟、仍有 open 验收责任的候选；真装配还会核 GitHub 单是否开着。 */
  acceptanceTasks?: () => Promise<CommanderAcceptanceTask[]>;
  acceptanceIssueOpen?: (task: CommanderAcceptanceTask) => Promise<boolean>;
  /** 现问工作流；已经没了回 gone。 */
  status(workflowId: string): Promise<ParkedSnapshot | 'gone'>;
  /** 这个工作流还开着的、最新的一条停下提醒（<工作流>:park:<n>）；没有回 null。老历史认停在哪一次用。读不到照抛。 */
  openPark(workflowId: string): Promise<OpenParkAlert | null>;
  /** since 之后 target=commander 的操作记录。读不到照抛。 */
  audits(since: Date): Promise<CommanderAuditView[]>;
  /** 认领这一次停下（写 commander.claim）。写不进照抛：这一张这一轮不处理。 */
  claim(entry: {
    row: ParkedRetryRow;
    workflowId: string;
    park: TaskParkInfo;
    requestId: string;
    kind?: TriageKind;
    legacy?: boolean;
    attempt?: number;
  }): Promise<void>;
  claimAcceptance?: (entry: {
    task: CommanderAcceptanceTask;
    requestId: string;
    attempt: number;
  }) => Promise<void>;
  /** 验收会话没起成：抵销这次认领，下一轮仍可按同一 head 重试。 */
  acceptanceRetry?: (entry: { task: CommanderAcceptanceTask; attempt: number; why: string }) => Promise<void>;
  /** 会话没起成：记一条 commander.retry，这一次停下不算处理过。写不进照抛。 */
  retry(entry: {
    row: ParkedRetryRow;
    workflowId: string;
    park: TaskParkInfo;
    attempt: number;
    why: string;
  }): Promise<void>;
  /** 这一次停下的提醒正文。 */
  detail(workflowId: string, parkSeq: number): Promise<string | null>;
  /** 这张单已有的回合。读不到回 null，不抛：回合没读到就当没法判空转。 */
  rounds(taskId: string): Promise<SpinRound[] | null>;
  findRepo(owner: string, name: string): Promise<IntakeRepo | null>;
  /** 主线头（完整提交号）：只读检出钉在它上面。读不到照抛。 */
  mainHead(repo: IntakeRepo): Promise<string>;
  /** 起会话（选路按用途 commander、只读检出、不带令牌）。 */
  runSession(input: GroomSessionInput): Promise<GroomSessionOutcome>;
  continueTask(workflowId: string, command: ContinueCommand): Promise<'sent' | 'gone'>;
  /** 收尾放弃这一代（拆单、停掉用）。 */
  abandonTask(workflowId: string, reason: string): Promise<'sent' | 'gone'>;
  /**
   * 叫停停着的这一代、另起下一代（换路由、换模型重来）。
   * resume 有 follow 时是沿原裁决接续：不再开会话，也不把「请求已提交」当成做完。
   */
  redoTask(row: ParkedRetryRow, workflowId: string, resume?: RedoResumeContext): Promise<CommanderRedoResult>;
  /** 开子单（拆单用）。 */
  openIssue(
    repo: IntakeRepo,
    input: { key: string; title: string; body: string; labels: string[] },
  ): Promise<{ number: number }>;
  /** 给单子贴标签（改标准的停下贴「本机做」）。 */
  addLabel(repo: IntakeRepo, issueNumber: number, label: string): Promise<void>;
  /** 记一条执行（commander.act，actor = engine:commander）。执行之前写；写不进照抛，这一张不执行。 */
  audit(entry: CommanderActEntry): Promise<void>;
  acceptanceAudit?: (entry: {
    task: CommanderAcceptanceTask;
    duty: AcceptanceDutyRow;
    action: string;
    reason: string;
    ok: boolean;
    error?: string;
  }) => Promise<void>;
  settleAcceptance?: (input: {
    task: CommanderAcceptanceTask;
    duty: AcceptanceDutyRow;
    evidence: string;
  }) => Promise<void>;
  supersedeAcceptance?: (input: {
    task: CommanderAcceptanceTask;
    source: AcceptanceDutyRow;
    target: AcceptanceDutyRow;
    evidence: string;
    coverage: readonly AcceptanceCoverage[];
  }) => Promise<void>;
  closeAcceptanceTask?: (task: CommanderAcceptanceTask, mergeCommit: string) => Promise<void>;
  notify(notice: CommanderNotice): Promise<void>;
  /** 继续发出去之后撤这一次停下的提醒。 */
  resolveAlert(entry: { workflowId: string; park: TaskParkInfo; why: string }): Promise<void>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface ParkTriageResult {
  /** 开关关着、用途没配模型、碰到全局熔断上限：这一轮没看（或没看全），原因在这。 */
  skipped?: string;
  noModel?: boolean;
  /** 被全局上限挡住：这一轮记 partial。 */
  capped?: boolean;
  listed: number;
  /** 正停着、够条件交指挥官的张数。 */
  candidates: number;
  claimed: number;
  acted: { ref: string; action: CommanderAction; source: 'verdict' | 'default' }[];
  /** 留给人（三种理由类别之一）或执行没成的。 */
  left: { ref: string; why: string }[];
  /** 会话没起成、下一轮再看的。 */
  retrying: { ref: string; why: string }[];
  problems: string[];
}

const refOf = (row: ParkedRetryRow) => `${row.owner}/${row.name}#${row.issueNumber}`;
const claimKey = (workflowId: string, seq: number) => `${workflowId}#${seq}`;
const noticeKey = (item: ParkTriageItem) => `commander:${item.workflowId}:park:${item.park.seq}`;
const kindOf = (item: ParkTriageItem): TriageKind => item.kind ?? triageKindOf(item.park);

// —— 会话的回答 ——

const Text = (max: number) => z.string().trim().min(1).max(max);
const Subtask = z.object({
  title: Text(100),
  scene: Text(3000),
  modules: Text(2000).optional(),
  done: z.array(Text(500)).min(1).max(12),
});
type Subtask = z.infer<typeof Subtask>;
const Option = z.object({
  label: Text(60),
  detail: Text(300),
  recommended: z.boolean().optional(),
});
type Option = z.infer<typeof Option>;
const Verdict = z.object({
  issue: z.number().int().positive(),
  parkSeq: z.number().int().positive(),
  action: Text(40),
  reason: Text(1200),
  leaveReason: z.string().trim().max(40).optional(),
  options: z.array(z.unknown()).max(6).optional(),
  subtasks: z.array(z.unknown()).max(10).optional(),
});
const AcceptanceTarget = z.object({
  id: z.number().int().positive(),
  generation: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  head: Text(100),
});
const AcceptanceVerdict = z.object({
  issue: z.number().int().positive(),
  dutyId: z.number().int().positive(),
  generation: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  head: Text(100),
  action: z.enum(['settle', 'supersede', 'leave']),
  reason: Text(1200),
  evidence: z.string().trim().max(4000).optional(),
  humanOnly: z.string().trim().max(1200).optional(),
  target: AcceptanceTarget.optional(),
  coverage: z.array(z.unknown()).max(100).optional(),
});

export interface ParsedVerdict {
  issue: number;
  parkSeq: number;
  action: string;
  reason: string;
  leaveReason?: string;
  /** 留给人写卡时会话给的选项（格式不对的丢掉）。 */
  options?: Option[];
  subtasks: Subtask[];
  /** 拆单里格式不对的子单数。 */
  badSubtasks: number;
}

export interface ParsedCommanderAnswer {
  summary: string;
  verdicts: ParsedVerdict[];
  acceptanceVerdicts: ParsedAcceptanceVerdict[];
  /** 格式不对的条目：没有执行。 */
  rejected: string[];
}

/** 会话的回答 → 裁决清单。整份认不出回 ok:false；单条认不出进 rejected，别的条照办。 */
export function parseCommanderAnswer(
  answer: string,
): ({ ok: true } & ParsedCommanderAnswer) | { ok: false; why: string } {
  const raw = extractJson(answer);
  if (raw === undefined) {
    return { ok: false, why: '会话的回答里找不到裁决清单（要有一段 ```json 围栏，里面是一个对象）' };
  }
  const obj = raw as Record<string, unknown>;
  const rejected: string[] = [];
  const list = Array.isArray(obj.verdicts) ? obj.verdicts : [];
  if (obj.verdicts !== undefined && !Array.isArray(obj.verdicts))
    rejected.push('「verdicts」不是列表：没有执行');
  const verdicts: ParsedVerdict[] = [];
  list.forEach((entry, index) => {
    const parsed = Verdict.safeParse(entry);
    if (!parsed.success) {
      rejected.push(
        `verdicts[${index}]：${parsed.error.issues.map((i) => `${i.path.join('.') || '整条'}：${i.message}`).join('；')}`,
      );
      return;
    }
    const subs = (parsed.data.subtasks ?? []).map((s) => Subtask.safeParse(s));
    const options = (parsed.data.options ?? []).flatMap((o) => {
      const got = Option.safeParse(o);
      return got.success ? [got.data] : [];
    });
    verdicts.push({
      issue: parsed.data.issue,
      parkSeq: parsed.data.parkSeq,
      action: parsed.data.action,
      reason: parsed.data.reason,
      ...(parsed.data.leaveReason ? { leaveReason: parsed.data.leaveReason } : {}),
      ...(options.length > 0 ? { options } : {}),
      subtasks: subs.flatMap((s) => (s.success ? [s.data] : [])),
      badSubtasks: subs.filter((s) => !s.success).length,
    });
  });
  const acceptanceVerdicts: ParsedAcceptanceVerdict[] = [];
  const acceptanceList = Array.isArray(obj.acceptanceVerdicts) ? obj.acceptanceVerdicts : [];
  if (obj.acceptanceVerdicts !== undefined && !Array.isArray(obj.acceptanceVerdicts))
    rejected.push('「acceptanceVerdicts」不是列表：没有执行');
  acceptanceList.forEach((entry, index) => {
    const parsed = AcceptanceVerdict.safeParse(entry);
    if (!parsed.success) {
      rejected.push(
        `acceptanceVerdicts[${index}]：${parsed.error.issues.map((i) => `${i.path.join('.') || '整条'}：${i.message}`).join('；')}`,
      );
      return;
    }
    acceptanceVerdicts.push({
      issue: parsed.data.issue,
      dutyId: parsed.data.dutyId,
      generation: parsed.data.generation,
      prNumber: parsed.data.prNumber,
      head: parsed.data.head,
      action: parsed.data.action,
      reason: parsed.data.reason,
      ...(parsed.data.evidence === undefined ? {} : { evidence: parsed.data.evidence }),
      ...(parsed.data.humanOnly === undefined ? {} : { humanOnly: parsed.data.humanOnly }),
      ...(parsed.data.target === undefined ? {} : { target: parsed.data.target }),
      ...(parsed.data.coverage === undefined ? {} : { coverage: parsed.data.coverage }),
    });
  });
  const summary = typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 600) : '';
  return { ok: true, summary, verdicts, acceptanceVerdicts, rejected };
}

// —— 提示词 ——

/** 停下原文的指纹：记进执行记录，下一次停下比「一字不差」。 */
export const detailHashOf = (detail: string): string =>
  createHash('sha256').update(detail).digest('hex').slice(0, 32);

const parkFactsOf = (item: ParkTriageItem): ParkFacts => ({
  kind: kindOf(item),
  handoff: item.handoff,
  ...(item.legacy ? { legacy: true } : {}),
  ...(item.noContinue === undefined ? {} : { noContinue: item.noContinue }),
});

const defaultOf = (item: ParkTriageItem): DefaultAction =>
  defaultAction({ ...parkFactsOf(item), continuedBefore: item.continuedBefore === true }, item.spin);

function defaultWords(d: DefaultAction): string {
  if (d.action === 'continue') return `继续${d.widenBudget ? '并放宽一档额度预算' : ''}（${d.why}）`;
  if (d.action === 'redo') return `重做（${d.why}）`;
  return d.leaveReason === 'standard' ? '贴「本机做」交本机指挥官' : '留给人并写卡（只有人能做）';
}

function allowedLines(item: ParkTriageItem): string[] {
  const table = allowedActions(parkFactsOf(item), item.spin);
  return (Object.keys(table) as CommanderAction[]).map((a) => {
    const v = table[a];
    if (a === 'leave') return `  - leave（留给人）：只有带 leaveReason（${LEAVE_REASONS.join(' / ')}）才放行`;
    return v === true
      ? `  - ${a}（${COMMANDER_ACTION_WORDS[a]}）：放行`
      : `  - ${a}（${COMMANDER_ACTION_WORDS[a]}）：不放行，${v}`;
  });
}

export function renderParkTriagePrompt(input: {
  repo: string;
  items: readonly ParkTriageItem[];
  mainHead: string;
  now: Date;
}): string {
  const blocks = input.items.map((item) => {
    const park = item.park;
    const kind = kindOf(item);
    const lines = [
      `### #${item.row.issueNumber}（parkSeq ${park.seq}）`,
      `- 停法：${PARK_KIND_WORDS[kind]}${item.handoff ? '（已继续满三次仍没过，交指挥官）' : ''}${item.legacy ? '（老历史：停法从提醒正文认的）' : ''}`,
      `- 停下的标题：${park.title}`,
      `- 停下的时刻：${stamp(new Date(park.at))}（北京时间）${park.head ? `，PR 头 ${park.head.slice(0, 12)}` : ''}`,
      ...(park.code || park.rule ? [`- 失败码：${park.code ?? '没有'}，规则：${park.rule ?? '没有'}`] : []),
      `- 原因原文：${item.detail ?? '没读到'}`,
    ];
    if (item.rounds === null) lines.push('- 回合记录：没读到');
    else if (item.rounds.length === 0) lines.push('- 回合记录：还没有收场的回合');
    else {
      lines.push('- 最近回合（旧的在前）：');
      for (const r of item.rounds.slice(-6))
        lines.push(
          `  - ${r.outcome}，改动行数 ${r.addedLines ?? '没量成'}，返工意见：${(r.reworkSummary ?? '无').replace(/\s+/g, ' ').slice(0, 200)}`,
        );
    }
    if (park.kind === 'quota') {
      lines.push(`- 引擎对空转的判断：${item.spin === null ? '没法判（回合没读到）' : item.spin.summary}`);
    }
    lines.push('- 引擎白名单：', ...allowedLines(item));
    lines.push(`- 你不给裁决、或交的裁决不放行时，引擎的默认动作：${defaultWords(defaultOf(item))}`);
    return lines.join('\n');
  });
  return [
    `你是法国引擎的临时指挥官。仓 ${input.repo}（主线 ${input.mainHead.slice(0, 12)}，工作目录是它的只读检出）里有下面这些任务停下了。`,
    '人不处理停下的单，只看结果：拍板交给你。你的活：对每张单读懂为什么停、该怎么办，交一个裁决加理由。你没有 GitHub 令牌，不要改文件、不要推代码、不要执行任何写操作；',
    '你交的裁决由引擎按白名单核过才执行；白名单没放行的、没给裁决的，引擎按每张单写的默认动作执行。',
    '',
    '可选的裁决（action）：',
    '- continue：继续（接着做）。',
    '- redo：重做（叫停这一代、换路由或换模型另起一代；新一代自己重新选路）。',
    '- split：拆单（体量太大或反复空转时拆成 2~5 张互相独立的子单，每张写 title、scene、done；原单随后收尾）。',
    '- stop：停掉并报原因（只有额度超预算且引擎判成空转时才放行）。',
    `- leave：留给人。只有三种理由能留给人，必须写 leaveReason：${LEAVE_REASONS.map((r) => `${r}＝${LEAVE_REASON_WORDS[r]}`).join('；')}。`,
    '  new-money、irreversible 会写成「要你拍」卡：再给 options（2~4 项，每项 label、detail，恰好一项 recommended:true）。standard 会给单子贴「本机做」交本机指挥官。',
    '  拿不准不是留给人的理由：照你的判断选一个动作，或者不给裁决让引擎按默认动作执行。',
    '运行环境的问题（换路由续不上、会话总时长到顶、进程被杀、连不上执行机）不是单子的问题：继续，或者重做换一条路由。',
    '额度超预算不是看花了多少钱，而是看有没有空转：回合有新提交、失败原因在变就是有进展，可以继续；同一个原因连着失败、没有新提交、命令反复失败就是空转，不许原样继续。',
    '',
    '要处理的单：',
    '',
    ...blocks,
    '',
    '最后只回一段 ```json 围栏，里面是一个对象，每张单最多一条裁决，别的话不用写：',
    '```json',
    '{"summary":"一句话总结","verdicts":[{"issue":123,"parkSeq":1,"action":"continue","reason":"为什么这么判（给人看的诊断）"},' +
      '{"issue":124,"parkSeq":2,"action":"split","reason":"…","subtasks":[{"title":"…","scene":"…","done":["…"]}]},' +
      '{"issue":125,"parkSeq":1,"action":"leave","leaveReason":"new-money","reason":"…","options":[{"label":"…","detail":"…","recommended":true},{"label":"…","detail":"…"}]}]}',
    '```',
  ].join('\n');
}

export function renderAcceptanceTriagePrompt(input: {
  repo: string;
  tasks: readonly CommanderAcceptanceTask[];
  mainHead: string;
  now: Date;
}): string {
  const blocks = input.tasks.flatMap((task) =>
    task.duties
      .filter((d) => acceptanceDutyState(d, task.duties) === 'open')
      .map((d) => {
        const terminal = task.duties.find(
          (candidate) =>
            acceptanceDutyState(candidate, task.duties) === 'settled' &&
            candidate.id !== d.id &&
            candidate.prNumber === d.prNumber,
        );
        return [
          `### ${task.owner}/${task.name}#${task.issueNumber} duty ${d.id}（第 ${d.generation} 代）`,
          `- PR：#${d.prNumber}，责任 head：${d.head}`,
          `- 当前合并 PR head：${task.head}，合并于：${stamp(task.mergedAt)}（北京时间）`,
          `- 验收项：${d.items.join('；') || '没有验收项'}`,
          `- 当前状态：open`,
          `- 可指向的已最终验收目标：${terminal ? `duty ${terminal.id}（第 ${terminal.generation} 代，head ${terminal.head}）` : '没有'}`,
        ].join('\n');
      }),
  );
  return [
    `你是法国引擎的临时指挥官。仓 ${input.repo}（主线 ${input.mainHead.slice(0, 12)}）有合并超过 30 分钟但验收责任仍 open 的责任单。`,
    '你没有 GitHub 写权限，也不能写库。只对每条 open duty 给一个验收裁决；引擎会再次核对精确的任务、责任 id、代次、PR 和 head。',
    'settle：证据足够时结清当前责任；supersede：旧 head 的责任由同单同 PR、已合并且已最终验收的目标责任替代，必须给非空 evidence 和逐条 coverage；leave：只有创始人能提供的证据仍缺，humanOnly 必须写清楚。',
    '单仍开着、PR 合并回执和责任代次都会由引擎复核；不要把 leave 当成结清。',
    '',
    '要处理的责任：',
    '',
    ...blocks,
    '',
    '最后只回一段 ```json 围栏，里面是一个对象：',
    '```json',
    '{"summary":"一句话总结","acceptanceVerdicts":[{"issue":123,"dutyId":7,"generation":1,"prNumber":456,"head":"完整 head","action":"settle","reason":"…","evidence":"…"}]}',
    '```',
  ].join('\n');
}

// —— 执行 ——

function spinOf(park: TaskParkInfo, rounds: SpinRound[] | null): SpinJudgement | null {
  return park.kind === 'quota' && rounds !== null ? judgeSpin(rounds) : null;
}

/** 要执行的一步：指挥官的裁决（核过的），或引擎替它执行的默认动作。 */
type Plan = (
  | { action: 'continue'; widenBudget: boolean }
  | { action: 'redo' }
  | { action: 'split'; subtasks: Subtask[] }
  | { action: 'stop' }
  | { action: 'leave'; leaveReason: LeaveReason | 'human-only'; options?: Option[] }
) & {
  source: 'verdict' | 'default';
  /** 给人看的理由（裁决的理由，或默认动作的原因）。 */
  reason: string;
  /** 改按默认动作执行的原因（会话没给裁决、白名单不放行……）。 */
  overrode?: string;
};

interface Outcome {
  acted: CommanderAction | null;
  /** 留给人、执行没成时给人的原因。 */
  left?: string;
  text: string;
  level: CommanderNotice['level'];
  title: string;
  options?: DecisionOption[];
  reason?: DecisionReason;
}

function planOfDefault(item: ParkTriageItem, overrode: string): Plan {
  const d = defaultOf(item);
  const base = { source: 'default' as const, reason: d.why, overrode };
  if (d.action === 'continue') return { action: 'continue', widenBudget: d.widenBudget, ...base };
  if (d.action === 'redo') return { action: 'redo', ...base };
  return { action: 'leave', leaveReason: d.leaveReason, ...base };
}

function diagnosisText(
  item: ParkTriageItem,
  model: string,
  verdict: { action: string; reason: string } | null,
  parts: string[],
): string {
  const lines = [
    `指挥官（${model}）看了 ${refOf(item.row)}：停法「${PARK_KIND_WORDS[kindOf(item)]}」，停下「${item.park.title}」。`,
  ];
  if (verdict) lines.push(`裁决：${verdict.action}。理由：${verdict.reason}`);
  if (item.spin) lines.push(`空转判断：${item.spin.summary}`);
  else if (item.park.kind === 'quota') lines.push('空转判断：回合没读到，判不了。');
  lines.push(...parts);
  return lines.join('\n');
}

/** 会话给的选项 → 「要你拍」的选项。不够两项、推荐不是恰好一项的，换成只留言的两项（满足落库的规矩）。 */
function decisionOptionsOf(options: readonly Option[] | undefined): DecisionOption[] {
  const list = (options ?? []).slice(0, 4);
  if (list.length < 2) return noteOnlyOptions();
  const picked = Math.max(
    0,
    list.findIndex((o) => o.recommended === true),
  );
  return list.map((o, i) => ({
    id: `o${i + 1}`,
    label: o.label,
    detail: o.detail,
    ...(i === picked ? { recommended: '指挥官推荐' } : {}),
    action: { kind: 'note-only' as const },
  }));
}

const DECISION_REASON_OF: Readonly<Record<'new-money' | 'irreversible' | 'human-only', DecisionReason>> = {
  'new-money': 'new-money',
  irreversible: 'irreversible-delete',
  'human-only': 'human-only',
};

const LEAVE_WORDS: Readonly<Record<LeaveReason | 'human-only', string>> = {
  ...LEAVE_REASON_WORDS,
  'human-only': '只有人能做（没权限等人闸）',
};

const OPEN_REDO_PHASES: readonly RedoFollowPhase[] = [
  'stop_sent_unconfirmed',
  'old_terminal_pending_start',
  'start_failed',
];

function isRedoIdentity(value: unknown): value is RedoExecutionIdentity {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.workflowId === 'string' &&
    row.workflowId !== '' &&
    typeof row.generation === 'number' &&
    Number.isInteger(row.generation) &&
    row.generation >= 1 &&
    typeof row.runId === 'string' &&
    row.runId !== ''
  );
}

/** 认不出的接续记录不当成「没有」或「已经做完」。调用方要报出来，并且不启动。 */
export function parseRedoFollow(value: unknown): RedoFollowIntent | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.intentId !== 'string' || row.intentId === '') return null;
  if (typeof row.phase !== 'string' || !REDO_FOLLOW_PHASES.includes(row.phase as RedoFollowPhase))
    return null;
  if (typeof row.why !== 'string' || row.why === '') return null;
  if (row.source !== 'verdict' && row.source !== 'default') return null;
  if (typeof row.reason !== 'string') return null;
  if (typeof row.seq !== 'number' || !Number.isInteger(row.seq) || row.seq < 0) return null;
  if (!Array.isArray(row.identities) || row.identities.length === 0 || !row.identities.every(isRedoIdentity))
    return null;
  const block = row.block;
  const knownBlock =
    block === 'running' ||
    block === 'unknown' ||
    block === 'identity' ||
    block === 'exists' ||
    block === 'start';
  if (block !== undefined && !knownBlock) return null;
  return {
    intentId: row.intentId,
    phase: row.phase as RedoFollowPhase,
    why: row.why,
    identities: row.identities.filter(isRedoIdentity),
    source: row.source,
    reason: row.reason,
    seq: row.seq,
    ...(knownBlock ? { block } : {}),
  };
}

function redoPhrase(phase: RedoFollowPhase): string {
  if (phase === 'stop_sent_unconfirmed') return REDO_RECEIPT.stopUnconfirmed;
  if (phase === 'old_terminal_pending_start') return REDO_RECEIPT.pendingStart;
  if (phase === 'start_failed') return REDO_RECEIPT.startFailed;
  return REDO_RECEIPT.started;
}

/** 回执正文。有部分副作用时不写「任务没动」；没确认到新执行时不写已经启动。 */
export function redoReceiptLines(redone: CommanderRedoResult): string[] {
  if (redone.ok && (redone.follow === undefined || redone.follow.phase === 'started')) {
    const lines = [
      `${REDO_RECEIPT.started}：${redone.workflowId}（第 ${redone.generation} 代，重新选路，不带原来的避让）。`,
    ];
    const prior = redone.follow?.why ?? '';
    if (prior !== '') lines.push(`先前的失败仍在：${prior}`);
    return lines;
  }
  if (!redone.ok && redone.follow) {
    const current = redone.why;
    const prior = redone.follow.why;
    // 阶段写成已启动但这次没成功：不能说新代已确认，也不能说任务没动。
    const phrase =
      redone.follow.phase === 'started' ? REDO_RECEIPT.startFailed : redoPhrase(redone.follow.phase);
    const lines = [`${phrase}。${current}`];
    if (prior !== '' && prior !== current) lines.push(`原失败：${prior}`);
    return lines;
  }
  if (redone.ok) return ['重做回执说成功，但阶段不是已确认启动，不算重做完成。'];
  if (/叫停 .+后还没停，没有另起/.test(redone.why)) return [`${REDO_RECEIPT.stopUnconfirmed}。${redone.why}`];
  return [`执行「重做」没成：${redone.why}。任务没动。`];
}

function storedRedoFollow(redone: CommanderRedoResult): RedoFollowIntent | null {
  const follow = redone.follow;
  if (!follow) return null;
  if (redone.ok) {
    if (follow.phase !== 'started') return null;
    return { ...follow, phase: 'started', seq: follow.seq + 1 };
  }
  if (follow.phase === 'started') return null;
  return { ...follow, seq: follow.seq + 1 };
}

async function execute(
  deps: ParkTriageDeps,
  repo: IntakeRepo,
  item: ParkTriageItem,
  plan: Plan,
  model: string,
  verdict: { action: string; reason: string } | null,
): Promise<Outcome> {
  const ref = refOf(item.row);
  const word = COMMANDER_ACTION_WORDS[plan.action];
  const head =
    plan.source === 'default'
      ? [
          `引擎改按这种停法的默认动作执行「${word}」：${plan.overrode ?? '会话没给裁决'}。默认动作的原因：${plan.reason}`,
        ]
      : [];
  const text = (parts: string[]) => diagnosisText(item, model, verdict, [...head, ...parts]);
  const why =
    plan.source === 'default'
      ? `默认动作「${word}」：${plan.reason}（${plan.overrode ?? '会话没给裁决'}）`
      : `${plan.reason}（引擎核对放行「${word}」）`;
  // 先记操作记录、再动手：记录写不进就不动
  try {
    await deps.audit({ item, action: plan.action, reason: why, ok: true, source: plan.source });
  } catch (err) {
    const msg = `操作记录没写进，没有执行：${errMessage(err)}`;
    return { acted: null, left: msg, text: text([msg]), level: 'alert', title: `指挥官没能处理 ${ref}` };
  }
  const failed = async (error: string): Promise<Outcome> => {
    await deps
      .audit({ item, action: plan.action, reason: why, ok: false, error, source: plan.source })
      .catch((e: unknown) => deps.log('error', '指挥官：失败的执行没记进操作记录', { error: errMessage(e) }));
    return {
      acted: null,
      left: error,
      text: text([`执行「${word}」没成：${error}。任务没动。`]),
      level: 'alert',
      title: `指挥官处理 ${ref} 没成：${word}`,
    };
  };
  const done = (parts: string[]): Outcome => ({
    acted: plan.action,
    text: text(parts),
    level: 'daily',
    title: `指挥官处理了 ${ref}：${word}${plan.source === 'default' ? '（默认动作）' : ''}`,
  });
  const settleRedo = async (redone: CommanderRedoResult): Promise<Outcome> => {
    const lines = redoReceiptLines(redone);
    const stored = storedRedoFollow(redone);
    const partial = !redone.ok && redone.follow !== undefined && redone.follow.phase !== 'started';
    if (stored) {
      try {
        await deps.audit({
          item,
          action: 'redo',
          reason: why,
          ok: redone.ok,
          ...(redone.ok ? {} : { error: stored.why || redone.why }),
          source: plan.source,
          detail: { redoFollow: stored },
        });
      } catch (err) {
        const msg = `重做接续没写进操作记录：${errMessage(err)}`;
        return {
          acted: null,
          left: msg,
          text: text([msg, ...lines]),
          level: 'alert',
          title: `指挥官重做 ${ref} 的回执没记下`,
        };
      }
    } else if (!redone.ok) {
      if (/叫停 .+后还没停，没有另起/.test(redone.why)) {
        await deps
          .audit({ item, action: 'redo', reason: why, ok: false, error: redone.why, source: plan.source })
          .catch((err: unknown) =>
            deps.log('error', '指挥官：失败的执行没记进操作记录', { error: errMessage(err) }),
          );
        return {
          acted: null,
          left: redone.why,
          text: text(lines),
          level: 'alert',
          title: `指挥官重做 ${ref}：${REDO_RECEIPT.stopUnconfirmed}`,
        };
      }
      return await failed(redone.why);
    }
    if (redone.ok && (redone.follow === undefined || redone.follow.phase === 'started')) return done(lines);
    const phrase = partial && redone.follow ? redoPhrase(redone.follow.phase) : '重做';
    return {
      acted: null,
      left: lines.join('\n'),
      text: text(lines),
      level: 'alert',
      title: `指挥官重做 ${ref}：${phrase}`,
    };
  };
  try {
    if (plan.action === 'continue') {
      const note =
        `指挥官判继续${plan.widenBudget ? '，额度预算放宽一档' : ''}${plan.source === 'default' ? '（默认动作）' : ''}：${plan.reason}`.slice(
          0,
          500,
        );
      const sent = await deps.continueTask(item.workflowId, {
        by: item.legacy ? COMMANDER_LEGACY_ACTOR : COMMANDER_ACTOR,
        note,
        parkSeq: item.park.seq,
        ...(plan.widenBudget ? { widenBudget: true } : {}),
      });
      if (sent === 'gone') return await failed('工作流已经没了，没发出继续');
      await deps
        .resolveAlert({ workflowId: item.workflowId, park: item.park, why: note })
        .catch((e: unknown) =>
          deps.log('warn', '指挥官：继续发出去了，但这一次停下的提醒没撤掉', { error: errMessage(e) }),
        );
      return done([`已执行：继续${plan.widenBudget ? '，并把这张单的额度预算放宽一档（没有空转）' : ''}。`]);
    }
    if (plan.action === 'redo') {
      // 先有操作记录里的意图，标准调度才能在进程中断或叫停迟到之后接着做。不在这里加长等待。
      const context: RedoResumeContext = {
        intentId: redoIntentId(item.workflowId, item.park.seq),
        parkSeq: item.park.seq,
        source: plan.source,
        reason: plan.reason,
      };
      let redone: CommanderRedoResult;
      try {
        redone = await deps.redoTask(item.row, item.workflowId, context);
      } catch (err) {
        redone = { ok: false, why: errMessage(err) };
      }
      return await settleRedo(redone);
    }
    if (plan.action === 'split') {
      const opened: number[] = [];
      for (const [i, sub] of plan.subtasks.entries()) {
        const body = renderNewIssueBody({
          title: sub.title,
          kind: '需求',
          scene: sub.scene,
          ...(sub.modules === undefined ? {} : { modules: sub.modules }),
          done: sub.done,
          splitFrom: item.row.issueNumber,
        });
        const got = await deps.openIssue(repo, {
          key: `commander:${item.workflowId}:${item.park.seq}:${i}`,
          title: sub.title,
          body,
          labels: ['需求'],
        });
        opened.push(got.number);
      }
      const list = opened.map((n) => `#${n}`).join('、');
      const gone = await deps.abandonTask(
        item.workflowId,
        `指挥官拆单：已拆成 ${list}，这一代收尾（分支存档）`,
      );
      return done([
        `已执行：拆单，开了 ${list}${gone === 'gone' ? '（原工作流已经没了）' : '，原来这一代收尾（分支存档）'}。`,
      ]);
    }
    if (plan.action === 'stop') {
      const sent = await deps.abandonTask(
        item.workflowId,
        `指挥官判空转，停掉：${plan.reason}`.slice(0, 500),
      );
      if (sent === 'gone') return await failed('工作流已经没了，没发出放弃');
      return done(['已执行：停掉这一代（工作树存档后删，PR 和单子不动）。']);
    }
    // 留给人：只有三种理由类别（默认动作另有「只有人能做」那一种）
    const category = plan.leaveReason;
    if (category === 'standard') {
      await deps.addLabel(repo, item.row.issueNumber, LOCAL_WORK_LABEL);
      return {
        acted: null,
        left: `留给人·${LEAVE_WORDS[category]}`,
        text: text([`已执行：给 ${ref} 贴了「${LOCAL_WORK_LABEL}」，交本机指挥官（不找创始人）。任务没动。`]),
        level: 'daily',
        title: `指挥官把 ${ref} 交本机指挥官：改标准`,
      };
    }
    return {
      acted: null,
      left: `留给人·${LEAVE_WORDS[category]}`,
      text: text([`要你拍：${LEAVE_WORDS[category]}。任务没动，等你在卡上选。`]),
      level: 'decision',
      title: `要你拍：${ref} 停下「${item.park.title}」（${LEAVE_WORDS[category]}）`,
      options: decisionOptionsOf(plan.options),
      reason: DECISION_REASON_OF[category],
    };
  } catch (err) {
    return await failed(errMessage(err));
  }
}

/** 一个仓的一批：起会话、核裁决、逐张执行。会话没起成：这一次停下不算处理过，下一轮再看；第 3 次还没起成按默认动作执行。 */
async function triageRepo(
  deps: ParkTriageDeps,
  repo: IntakeRepo,
  items: ParkTriageItem[],
  requestId: string,
  result: ParkTriageResult,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const settle = async (
    item: ParkTriageItem,
    plan: Plan,
    model: string,
    verdict: { action: string; reason: string } | null,
  ) => {
    const ref = refOf(item.row);
    // 执行前再问一次：这一次停下还停着、编号没变（会话跑了一阵，人可能已经点了继续）
    let still = false;
    try {
      const snap = await deps.status(item.workflowId);
      still =
        snap !== 'gone' &&
        snap.phase === 'parked' &&
        (item.legacy ? snap.park === undefined : snap.park?.seq === item.park.seq);
    } catch (err) {
      result.problems.push(`${ref} 执行前没问到工作流：${errMessage(err)}`);
      return;
    }
    if (!still) {
      deps.log('info', '指挥官：这一次停下已经解开，不执行', { ref });
      return;
    }
    const outcome = await execute(deps, repo, item, plan, model, verdict);
    if (outcome.acted) {
      result.acted.push({ ref, action: outcome.acted, source: plan.source });
      deps.log('info', '指挥官：已执行', { ref, action: outcome.acted, source: plan.source });
    } else {
      result.left.push({ ref, why: outcome.left ?? '留给人' });
    }
    await deps
      .notify({
        level: outcome.level,
        key: noticeKey(item),
        title: outcome.title,
        body: outcome.text,
        taskId: item.row.taskId,
        ...(outcome.options ? { options: outcome.options } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      })
      .catch((e: unknown) => {
        result.problems.push(`${ref} 的提醒没推出去：${errMessage(e)}`);
      });
  };

  const notStarted = async (why: string) => {
    for (const item of items) {
      const ref = refOf(item.row);
      const attempt = (item.attempts ?? 0) + 1;
      if (attempt >= PARK_TRIAGE_SESSION_TRIES) {
        await settle(
          item,
          planOfDefault(item, `指挥官会话第 ${attempt} 次没起成（${why}）`),
          '会话没起成',
          null,
        );
        continue;
      }
      try {
        await deps.retry({ row: item.row, workflowId: item.workflowId, park: item.park, attempt, why });
      } catch (err) {
        result.problems.push(
          `${ref} 会话没起成的记录没写进，这一次停下会被当成处理过、不再自动看：${errMessage(err)}`,
        );
      }
      result.retrying.push({ ref, why: `第 ${attempt} 次没起成：${why}` });
      await deps
        .notify({
          level: 'alert',
          key: noticeKey(item),
          title: `指挥官这一轮没看成 ${ref}（停下「${item.park.title}」）`,
          body:
            `${why}\n\n这一次停下不算处理过，下一轮（${PARK_TRIAGE_EVERY_MINUTES} 分钟后）再看；同一次停下最多试 ${PARK_TRIAGE_SESSION_TRIES} 次，` +
            `第 ${PARK_TRIAGE_SESSION_TRIES} 次还没起成就按默认动作执行：${defaultWords(defaultOf(item))}。`,
          taskId: item.row.taskId,
        })
        .catch((e: unknown) => deps.log('error', '指挥官：提醒没推出去', { error: errMessage(e) }));
    }
  };
  let mainHead: string;
  try {
    mainHead = await deps.mainHead(repo);
  } catch (err) {
    await notStarted(`没读到主线头，会话没起：${errMessage(err)}`);
    return;
  }
  const prompt = renderParkTriagePrompt({ repo: slug, items, mainHead, now: deps.now() });
  const session = await deps.runSession({
    repo,
    requestId,
    prompt,
    mainHead,
    timeoutMinutes: PARK_TRIAGE_SESSION_MINUTES,
  });
  if (!session.ok) {
    await notStarted(`指挥官会话没跑成：${session.why}`);
    return;
  }
  const model = session.model ?? session.routeId ?? '会话没报模型';
  const parsed = parseCommanderAnswer(session.answer);
  if (!parsed.ok) {
    await notStarted(`${parsed.why}（模型 ${model}）`);
    return;
  }
  for (const why of parsed.rejected) deps.log('warn', '指挥官：裁决格式不对，没有执行', { repo: slug, why });
  const seen = new Set<number>();
  const duplicated = new Set<number>();
  for (const v of parsed.verdicts) {
    if (seen.has(v.issue)) duplicated.add(v.issue);
    seen.add(v.issue);
  }
  for (const item of items) {
    const issue = item.row.issueNumber;
    const mine = parsed.verdicts.filter((v) => v.issue === issue);
    const first = mine[0];
    if (first === undefined) {
      const why = `会话没给这张单裁决（${parsed.rejected.length > 0 ? `有 ${parsed.rejected.length} 条格式不对被挡下` : '清单里没有这张单'}）`;
      await settle(item, planOfDefault(item, why), model, null);
      continue;
    }
    if (duplicated.has(issue)) {
      await settle(item, planOfDefault(item, '会话对这张单交了不止一个裁决，一个都不认'), model, null);
      continue;
    }
    if (first.parkSeq !== item.park.seq) {
      await settle(
        item,
        planOfDefault(item, `裁决带的 parkSeq ${first.parkSeq} 和这一次停下（${item.park.seq}）对不上`),
        model,
        first,
      );
      continue;
    }
    const check = checkVerdict(parkFactsOf(item), item.spin, {
      action: first.action,
      subtaskCount: first.subtasks.length + first.badSubtasks,
      leaveReason: first.leaveReason,
    });
    if (!check.ok) {
      await settle(item, planOfDefault(item, `引擎核对：${check.why}`), model, first);
      continue;
    }
    if (check.action === 'split' && first.badSubtasks > 0) {
      const why = `拆单里有 ${first.badSubtasks} 张子单格式不对（要 title、scene、done）`;
      await settle(item, planOfDefault(item, why), model, first);
      continue;
    }
    const source = 'verdict' as const;
    const reason = first.reason;
    const plan: Plan =
      check.action === 'continue'
        ? { action: 'continue', widenBudget: check.widenBudget, source, reason }
        : check.action === 'split'
          ? { action: 'split', subtasks: first.subtasks, source, reason }
          : check.action === 'leave'
            ? {
                action: 'leave',
                leaveReason: check.leaveReason ?? 'standard',
                ...(first.options ? { options: first.options } : {}),
                source,
                reason,
              }
            : { action: check.action, source, reason };
    await settle(item, plan, model, first);
  }
}

const acceptanceKeyOf = (task: CommanderAcceptanceTask) =>
  `acceptance:${task.taskId}:${task.prNumber}:${task.head}#0`;
const acceptanceRefOf = (task: CommanderAcceptanceTask) => `${task.owner}/${task.name}#${task.issueNumber}`;

async function triageAcceptanceRepo(
  deps: ParkTriageDeps,
  repo: IntakeRepo,
  tasks: CommanderAcceptanceTask[],
  requestId: string,
  result: ParkTriageResult,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  let mainHead: string;
  try {
    mainHead = await deps.mainHead(repo);
  } catch (err) {
    result.problems.push(`${slug} 验收责任没读到主线头：${errMessage(err)}`);
    return;
  }
  const prompt = renderAcceptanceTriagePrompt({ repo: slug, tasks, mainHead, now: deps.now() });
  const session = await deps.runSession({
    repo,
    requestId,
    prompt,
    mainHead,
    timeoutMinutes: PARK_TRIAGE_SESSION_MINUTES,
  });
  const model = session.ok ? (session.model ?? session.routeId ?? '会话没报模型') : '会话没起成';
  if (!session.ok) {
    for (const task of tasks) {
      result.retrying.push({
        ref: acceptanceRefOf(task),
        why: `验收责任会话没跑成：${session.why}`,
      });
      try {
        await deps.acceptanceRetry?.({ task, attempt: 1, why: session.why });
      } catch (err) {
        result.problems.push(`${acceptanceRefOf(task)} 验收重试记录没写进：${errMessage(err)}`);
      }
    }
    return;
  }
  const parsed = parseCommanderAnswer(session.answer);
  if (!parsed.ok) {
    for (const task of tasks) {
      result.retrying.push({ ref: acceptanceRefOf(task), why: `验收责任${parsed.why}` });
      try {
        await deps.acceptanceRetry?.({ task, attempt: 1, why: parsed.why });
      } catch (err) {
        result.problems.push(`${acceptanceRefOf(task)} 验收重试记录没写进：${errMessage(err)}`);
      }
    }
    return;
  }
  for (const why of parsed.rejected)
    deps.log('warn', '指挥官：验收裁决格式不对，没有执行', { repo: slug, why });

  for (const task of tasks) {
    const ref = acceptanceRefOf(task);
    const open = task.duties.filter((d) => acceptanceDutyState(d, task.duties) === 'open');
    const mine = parsed.acceptanceVerdicts.filter((v) => v.issue === task.issueNumber);
    let successful = 0;
    const left: string[] = [];
    const settledDutyIds = new Set<number>();
    for (const duty of open) {
      const verdicts = mine.filter((v) => v.dutyId === duty.id);
      const verdict = verdicts[0];
      if (!verdict || verdicts.length !== 1) {
        left.push(`${ref} duty ${duty.id} 没有唯一验收裁决`);
        continue;
      }
      const target = verdict.target
        ? task.duties.find(
            (candidate) =>
              candidate.id === verdict.target?.id &&
              acceptanceDutyState(candidate, task.duties) === 'settled',
          )
        : undefined;
      const checked: AcceptanceVerdictCheck = checkAcceptanceVerdict(duty, target, verdict);
      if (!checked.ok) {
        left.push(`${ref} duty ${duty.id}：${checked.why}`);
        continue;
      }
      if (checked.action === 'leave') {
        left.push(`${ref} duty ${duty.id}：${verdict.humanOnly}`);
        continue;
      }
      const action = checked.action;
      const reason = `${verdict.reason}（引擎核对放行「${action}」）`;
      try {
        await deps.acceptanceAudit?.({ task, duty, action, reason, ok: true });
        if (action === 'settle') {
          if (!deps.settleAcceptance) throw new Error('验收结清口子未装配');
          await deps.settleAcceptance({ task, duty, evidence: verdict.evidence ?? '' });
        } else {
          if (!deps.supersedeAcceptance || !target || !checked.coverage)
            throw new Error('验收替代收口口子或目标未装配');
          await deps.supersedeAcceptance({
            task,
            source: duty,
            target,
            evidence: verdict.evidence ?? '',
            coverage: checked.coverage,
          });
        }
        successful += 1;
        settledDutyIds.add(duty.id);
        result.acted.push({ ref: `${ref}/duty-${duty.id}`, action: 'continue', source: 'verdict' });
      } catch (err) {
        const why = errMessage(err);
        left.push(`${ref} duty ${duty.id}：${why}`);
        await deps.acceptanceAudit?.({ task, duty, action, reason, ok: false, error: why }).catch?.(() => {});
      }
    }
    const allSettled = left.length === 0 && successful === open.length && open.length > 0;
    const body = [
      `指挥官（${model}）看了 ${ref} 的验收责任。`,
      ...open.map(
        (d) =>
          `- duty ${d.id}（第 ${d.generation} 代，PR #${d.prNumber}，head ${d.head}）${
            settledDutyIds.has(d.id) ? '已按裁决收口' : '仍未收口'
          }`,
      ),
      ...(left.length ? ['仍留给创始人的证据：', ...left.map((x) => `- ${x}`)] : []),
    ].join('\n');
    for (const why of left) result.left.push({ ref, why });
    if (allSettled) {
      if (!deps.closeAcceptanceTask) {
        result.problems.push(`${ref} 验收责任都已处理，但精确关单口子未装配`);
      } else if (task.mergeCommit === null) {
        result.problems.push(`${ref} 验收责任都已处理，但 PR 镜像没有合并提交，未关单`);
      } else {
        try {
          await deps.closeAcceptanceTask(task, task.mergeCommit);
        } catch (err) {
          result.problems.push(`${ref} 验收责任已处理但精确关单没成：${errMessage(err)}`);
        }
      }
    }
    await deps
      .notify({
        level: left.length ? 'decision' : 'daily',
        key: `commander:${task.taskId}:acceptance:${task.prNumber}`,
        title: left.length ? `要你拍：${ref} 的验收责任` : `指挥官处理了 ${ref} 的验收责任`,
        body,
        taskId: task.taskId,
        ...(left.length ? { options: noteOnlyOptions(), reason: 'human-only' as const } : {}),
      })
      .catch((err: unknown) => result.problems.push(`${ref} 验收提醒没推出去：${errMessage(err)}`));
  }
}

interface AuditBook {
  /** 认领数多于没起成数的停下：处理过。 */
  handled: Set<string>;
  /** 每次停下没起成的次数。 */
  retries: Map<string, number>;
  /** 每个工作流上判过继续的停下（编号、停法）。 */
  continued: Map<string, { seq: number; kind: string | null }[]>;
  /** 24 小时内有效认领（没起成的不算）的数量；等于 claimTimes.length。 */
  claimsToday: number;
  /** 24 小时内每条有效认领的时刻（毫秒，从早到晚）：算下一个名额什么时候空出来。 */
  claimTimes: number[];
  /** 每张单（owner/name#号）24 小时内指挥官处理过几次（有效认领的停下数）。 */
  handledByRef: Map<string, number>;
  /** 每张单最近一次判「继续」时那一停的原文指纹；那条记录没存指纹是 null。 */
  lastContinueHash: Map<string, string | null>;
  /** 还没确认启动的重做。认不出的记录在 redoProblems，不当成没有、也不启动。 */
  openRedos: OpenRedoFollow[];
  redoProblems: string[];
}

interface OpenRedoFollow {
  intentId: string;
  row: ParkedRetryRow;
  workflowId: string;
  parkSeq: number;
  follow: RedoFollowIntent;
}

function readBook(audits: readonly CommanderAuditView[], now: Date): AuditBook {
  const claims = new Map<string, number>();
  const claimKind = new Map<string, string>();
  const retries = new Map<string, number>();
  const continued = new Map<string, { seq: number; kind: string | null }[]>();
  const windowStart = now.getTime() - WINDOW_MS;
  // 窗口内每个停点的有效认领：认领入栈，没起成（retry）把它前面最近一条认领出栈。没起成的不占名额，也不算处理过。
  const windowed = new Map<string, { ref: string | null; times: number[] }>();
  const lastContinueHash = new Map<string, string | null>();
  const acts: { workflowId: string; seq: number; kind: string | null }[] = [];
  const followBest = new Map<string, { at: number; open: OpenRedoFollow }>();
  const redoProblems: string[] = [];
  let anon = 0;
  for (const a of audits) {
    const after = (a.after ?? {}) as {
      workflowId?: unknown;
      parkSeq?: unknown;
      kind?: unknown;
      action?: unknown;
      ref?: unknown;
      detailHash?: unknown;
      taskId?: unknown;
      owner?: unknown;
      name?: unknown;
      issueNumber?: unknown;
      redoFollow?: unknown;
    };
    const ok = typeof after.workflowId === 'string' && typeof after.parkSeq === 'number';
    const key = ok ? claimKey(after.workflowId as string, after.parkSeq as number) : null;
    const inWindow = a.at.getTime() >= windowStart;
    if (a.action === COMMANDER_AUDIT_CLAIM) {
      if (key) {
        claims.set(key, (claims.get(key) ?? 0) + 1);
        if (typeof after.kind === 'string') claimKind.set(key, after.kind);
      }
      if (inWindow) {
        anon += 1;
        const slotKey = key ?? `#anon${anon}`;
        let slot = windowed.get(slotKey);
        if (!slot) {
          slot = { ref: null, times: [] };
          windowed.set(slotKey, slot);
        }
        if (typeof after.ref === 'string') slot.ref = after.ref;
        slot.times.push(a.at.getTime());
      }
    } else if (a.action === COMMANDER_AUDIT_RETRY) {
      if (key) retries.set(key, (retries.get(key) ?? 0) + 1);
      if (key && inWindow) windowed.get(key)?.times.pop();
    } else if (a.action === COMMANDER_AUDIT_ACT && a.ok !== false && after.action === 'continue') {
      if (typeof after.ref === 'string')
        lastContinueHash.set(after.ref, typeof after.detailHash === 'string' ? after.detailHash : null);
      if (ok)
        acts.push({
          workflowId: after.workflowId as string,
          seq: after.parkSeq as number,
          kind: typeof after.kind === 'string' ? after.kind : null,
        });
    } else if (
      a.action === COMMANDER_AUDIT_ACT &&
      after.action === 'redo' &&
      after.redoFollow !== undefined
    ) {
      const ref = typeof after.ref === 'string' ? after.ref : '这张单';
      const parsed = parseRedoFollow(after.redoFollow);
      const workflowId = typeof after.workflowId === 'string' ? after.workflowId : '';
      const parkSeq = typeof after.parkSeq === 'number' ? after.parkSeq : NaN;
      const row = redoRowOf(after);
      if (
        !parsed ||
        !row ||
        !Number.isInteger(parkSeq) ||
        parsed.intentId !== redoIntentId(workflowId, parkSeq)
      ) {
        redoProblems.push(`${ref} 的重做接续记录认不出，没有当成完成，也没有另起`);
        continue;
      }
      if (parsed.phase === 'started' && a.ok === false) {
        redoProblems.push(`${ref} 的重做接续写成已启动但记录没成功，没有当成完成`);
        continue;
      }
      const prev = followBest.get(parsed.intentId);
      const at = a.at.getTime();
      if (prev && (prev.at > at || (prev.at === at && prev.open.follow.seq > parsed.seq))) continue;
      followBest.set(parsed.intentId, {
        at,
        open: { intentId: parsed.intentId, row, workflowId, parkSeq, follow: parsed },
      });
    }
  }
  const claimTimes: number[] = [];
  const handledByRef = new Map<string, number>();
  for (const slot of windowed.values()) {
    if (slot.times.length === 0) continue;
    claimTimes.push(...slot.times);
    if (slot.ref !== null) handledByRef.set(slot.ref, (handledByRef.get(slot.ref) ?? 0) + 1);
  }
  claimTimes.sort((x, y) => x - y);
  for (const act of acts) {
    const kind = act.kind ?? claimKind.get(claimKey(act.workflowId, act.seq)) ?? null;
    continued.set(act.workflowId, [...(continued.get(act.workflowId) ?? []), { seq: act.seq, kind }]);
  }
  const handled = new Set<string>();
  for (const [key, n] of claims) if (n > (retries.get(key) ?? 0)) handled.add(key);
  const openRedos = [...followBest.values()]
    .filter((slot) => OPEN_REDO_PHASES.includes(slot.open.follow.phase))
    .sort((a, b) => a.at - b.at || a.open.follow.seq - b.open.follow.seq)
    .map((slot) => slot.open);
  return {
    handled,
    retries,
    continued,
    claimsToday: claimTimes.length,
    claimTimes,
    handledByRef,
    lastContinueHash,
    openRedos,
    redoProblems,
  };
}

function redoRowOf(after: {
  taskId?: unknown;
  owner?: unknown;
  name?: unknown;
  issueNumber?: unknown;
  ref?: unknown;
  workflowId?: unknown;
}): ParkedRetryRow | null {
  const taskId = typeof after.taskId === 'string' ? after.taskId : '';
  const workflowId = typeof after.workflowId === 'string' ? after.workflowId : '';
  let owner = typeof after.owner === 'string' ? after.owner : '';
  let name = typeof after.name === 'string' ? after.name : '';
  let issueNumber = typeof after.issueNumber === 'number' ? after.issueNumber : NaN;
  if ((!owner || !name || !Number.isInteger(issueNumber)) && typeof after.ref === 'string') {
    const matched = /^([^/]+)\/([^#]+)#(\d+)$/.exec(after.ref);
    if (matched?.[1] && matched[2] && matched[3]) {
      owner = owner || matched[1];
      name = name || matched[2];
      if (!Number.isInteger(issueNumber)) issueNumber = Number(matched[3]);
    }
  }
  if (taskId === '' || workflowId === '' || owner === '' || name === '' || !Number.isInteger(issueNumber))
    return null;
  return { taskId, owner, name, issueNumber, workflowId };
}

/** 单张单防空转：该不该不再放行「继续」（返回原因），否则 undefined。detailHash 是这一停原文的指纹（没读到是 undefined）。 */
function noContinueReason(book: AuditBook, ref: string, detailHash: string | undefined): string | undefined {
  const handled = book.handledByRef.get(ref) ?? 0;
  if (handled >= PARK_TRIAGE_SPIN_HANDLED)
    return `这张单 24 小时内指挥官已经处理 ${handled} 次（满 ${PARK_TRIAGE_SPIN_HANDLED} 次），再原样继续是空转`;
  if (detailHash !== undefined && book.lastContinueHash.get(ref) === detailHash)
    return '这一次停下的原文和上一次判「继续」时一字不差，原样继续只会再停一次';
  return undefined;
}

function resumeItem(open: OpenRedoFollow, at: Date): ParkTriageItem {
  const park: TaskParkInfo = {
    kind: 'transient',
    seq: open.parkSeq,
    at: at.toISOString(),
    title: '重做接续',
    head: null,
    retriedBefore: false,
  };
  return {
    row: open.row,
    workflowId: open.workflowId,
    park,
    handoff: false,
    detail: null,
    rounds: null,
    spin: null,
  };
}

/**
 * 沿已经记下来的重做裁决接续。不再开会话、不再认领。
 * 旧代仍在跑、查不到或身份变了，只拒绝；启动新代是 redoTask 在重新核完之后的事。
 */
async function resumeOpenRedos(
  deps: ParkTriageDeps,
  book: AuditBook,
  result: ParkTriageResult,
): Promise<void> {
  for (const open of book.openRedos) {
    const ref = refOf(open.row);
    const item = resumeItem(open, deps.now());
    const context: RedoResumeContext = {
      intentId: open.intentId,
      parkSeq: open.parkSeq,
      source: open.follow.source,
      reason: open.follow.reason,
      follow: open.follow,
    };
    let redone: CommanderRedoResult;
    try {
      redone = await deps.redoTask(open.row, open.workflowId, context);
    } catch (err) {
      const why = errMessage(err);
      result.problems.push(`${ref} 重做接续没查成：${why}`);
      continue;
    }
    const lines = redoReceiptLines(redone);
    const stored = storedRedoFollow(redone);
    if (stored) {
      try {
        await deps.audit({
          item,
          action: 'redo',
          reason: open.follow.reason,
          ok: redone.ok,
          ...(redone.ok ? {} : { error: stored.why || (!redone.ok ? redone.why : '没成') }),
          source: open.follow.source,
          detail: { redoFollow: stored },
        });
      } catch (err) {
        result.problems.push(`${ref} 重做接续没写进操作记录：${errMessage(err)}`);
      }
    }
    const confirmed = redone.ok && (redone.follow === undefined || redone.follow.phase === 'started');
    if (confirmed && redone.ok) {
      result.acted.push({ ref, action: 'redo', source: open.follow.source });
      deps.log('info', '指挥官：重做接续已确认启动', { ref, workflowId: redone.workflowId });
    } else if (!redone.ok) {
      result.left.push({ ref, why: lines.join('\n') });
      if (redone.follow?.block === 'unknown') {
        result.problems.push(`${ref} 重做接续没查清上一代，没有另起：${redone.why}`);
      }
    }
    const phrase = !redone.follow
      ? REDO_RECEIPT.stopUnconfirmed
      : !redone.ok && redone.follow.phase === 'started'
        ? REDO_RECEIPT.startFailed
        : redoPhrase(redone.follow.phase);
    await deps
      .notify({
        level: confirmed ? 'daily' : 'alert',
        key: noticeKey(item),
        title: confirmed ? `指挥官处理了 ${ref}：重做` : `指挥官重做 ${ref}：${phrase}`,
        body: lines.join('\n'),
        taskId: open.row.taskId,
      })
      .catch((err: unknown) => result.problems.push(`${ref} 的重做接续提醒没推出去：${errMessage(err)}`));
  }
}

/** 过一遍停着的引擎任务，够条件的交指挥官。列不出、读不到操作记录照抛。 */
export async function triageParkedTasks(deps: ParkTriageDeps): Promise<ParkTriageResult> {
  const result: ParkTriageResult = {
    listed: 0,
    candidates: 0,
    claimed: 0,
    acted: [],
    left: [],
    retrying: [],
    problems: [],
  };
  const sw = await deps.enabled();
  if (!sw.on) {
    result.skipped = `开关关着：${sw.why}`;
    return result;
  }
  const now = deps.now();
  if (!(await deps.purposeConfigured())) {
    result.noModel = true;
    result.skipped = '路由用途「指挥官」没配模型，停下的任务没有人看';
    await deps
      .notify({
        level: 'alert',
        key: 'commander:no-model',
        title: '指挥官没配模型：用途「指挥官」下没有模型，停下的任务没人看',
        body: '路由页的「指挥官」一栏是空的（默认顺序 grok-4.7 → sonnet-5.5 → opus-5.5）。给它配上模型，指挥官会话才会去看停下超过 15 分钟的任务；配好之前这些任务只靠引擎续停。',
        taskId: null,
      })
      .catch((e: unknown) => deps.log('error', '指挥官：没配模型的警报没推出去', { error: errMessage(e) }));
    return result;
  }
  await deps.resolveNoModelAlert().catch((err: unknown) => {
    const problem = `指挥官缺模型提醒解除失败：${errMessage(err)}`;
    result.problems.push(problem);
    // 后续业务读取仍可能抛错；立即留证，不能让那个错误覆盖解除失败。
    deps.log('error', problem);
  });
  // 认领记录不能只看最近几天：一个停点可以挂很久，过了窗口再认领就违反「每次停下最多处理一次」。
  // 每日上限仍只按下面的 24 小时窗口计算；这里读的是 commander 自己的审计记录，不把历史操作混进来。
  const book = readBook(await deps.audits(new Date(0)), now);
  result.problems.push(...book.redoProblems);
  await resumeOpenRedos(deps, book, result);
  let remaining = PARK_TRIAGE_DAILY_CAP - book.claimsToday;
  const rows = await deps.tasks();
  result.listed = rows.length;
  interface Waiting {
    row: ParkedRetryRow;
    workflowId: string;
    park: TaskParkInfo;
    kind: TriageKind;
    legacy: boolean;
    attempts: number;
    continuedBefore: boolean;
    detail: string | null | undefined;
    at: number;
  }
  const waiting: Waiting[] = [];
  for (const row of rows) {
    if (!row.workflowId) continue;
    const ref = refOf(row);
    try {
      const snap = await deps.status(row.workflowId);
      if (snap === 'gone' || snap.phase !== 'parked') continue;
      let park: TaskParkInfo;
      let legacy = false;
      let detail: string | null | undefined;
      if (snap.park) park = snap.park;
      else {
        // 老历史：查询里没有停法。停在哪一次从开着的停下提醒读，停法按提醒和任务行认。
        legacy = true;
        const open = await deps.openPark(row.workflowId);
        if (open === null) {
          result.problems.push(
            `${ref} 停着但查询里没记停法、也没有开着的停下提醒，认不出停在哪一次，没交指挥官`,
          );
          continue;
        }
        let kind = legacyParkKind([open.title, open.body, row.lastProblem]);
        if (kind === null) {
          result.problems.push(`${ref} 老历史的停下认不出停法（「${open.title}」），按「按临时的办」处理`);
          kind = 'transient';
        }
        park = {
          kind,
          seq: open.seq,
          at: open.at.toISOString(),
          title: open.title,
          head: null,
          retriedBefore: false,
        };
        detail = open.body;
      }
      const key = claimKey(row.workflowId, park.seq);
      if (book.handled.has(key)) continue;
      const at = Date.parse(park.at);
      const handoff = park.title === ROUNDS_HANDOFF_TITLE;
      if (!handoff && !(Number.isFinite(at) && now.getTime() - at >= PARK_TRIAGE_AFTER_MINUTES * 60_000))
        continue;
      const kind = triageKindOf(park);
      const prior = (book.continued.get(row.workflowId) ?? []).filter(
        (c) => c.seq < park.seq && (c.kind === null || c.kind === kind),
      );
      waiting.push({
        row,
        workflowId: row.workflowId,
        park,
        kind,
        legacy,
        attempts: book.retries.get(key) ?? 0,
        continuedBefore: park.retriedBefore || prior.length > 0,
        detail,
        at: Number.isFinite(at) ? at : 0,
      });
    } catch (err) {
      result.problems.push(`${ref} 没问到工作流：${errMessage(err)}`);
    }
  }
  result.candidates = waiting.length;
  waiting.sort((a, b) => a.at - b.at);
  const claimedIds = new Set<string>();
  const byRepo = new Map<string, Waiting[]>();
  for (const w of waiting) {
    const key = `${w.row.owner}/${w.row.name}`.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), w]);
  }
  let sessions = 0;
  for (const group of byRepo.values()) {
    if (sessions >= PARK_TRIAGE_MAX_SESSIONS || remaining <= 0) break;
    const first = group[0];
    if (!first) continue;
    let repo: IntakeRepo | null;
    try {
      repo = await deps.findRepo(first.row.owner, first.row.name);
    } catch (err) {
      result.problems.push(`${first.row.owner}/${first.row.name} 没查到受管的仓：${errMessage(err)}`);
      continue;
    }
    if (repo === null) {
      result.problems.push(`${first.row.owner}/${first.row.name} 不是受管的仓，不交指挥官`);
      continue;
    }
    const requestId = `park-triage:${repo.owner}/${repo.name}:${now.getTime()}`;
    const items: ParkTriageItem[] = [];
    for (const w of group.slice(0, Math.min(PARK_TRIAGE_BATCH, remaining))) {
      try {
        await deps.claim({
          row: w.row,
          workflowId: w.workflowId,
          park: w.park,
          requestId,
          kind: w.kind,
          legacy: w.legacy,
          attempt: w.attempts + 1,
        });
      } catch (err) {
        result.problems.push(`${refOf(w.row)} 认领没记进操作记录，这一轮不处理：${errMessage(err)}`);
        continue;
      }
      remaining -= 1;
      result.claimed += 1;
      claimedIds.add(w.workflowId);
      const [detail, rounds] = await Promise.all([
        w.detail !== undefined
          ? Promise.resolve(w.detail)
          : deps.detail(w.workflowId, w.park.seq).catch(() => null),
        deps.rounds(w.row.taskId).catch(() => null),
      ]);
      const detailHash = detail === null ? undefined : detailHashOf(detail);
      items.push({
        row: w.row,
        workflowId: w.workflowId,
        park: w.park,
        kind: w.kind,
        legacy: w.legacy,
        attempts: w.attempts,
        continuedBefore: w.continuedBefore,
        handoff: w.park.title === ROUNDS_HANDOFF_TITLE,
        detail,
        detailHash,
        noContinue: noContinueReason(book, refOf(w.row), detailHash),
        rounds,
        spin: spinOf(w.park, rounds),
      });
    }
    if (items.length === 0) continue;
    sessions += 1;
    try {
      await triageRepo(deps, repo, items, requestId, result);
    } catch (err) {
      result.problems.push(`${repo.owner}/${repo.name} 这一批没处理完：${errMessage(err)}`);
    }
  }
  const acceptanceWaiting: CommanderAcceptanceTask[] = [];
  if (deps.acceptanceTasks) {
    try {
      for (const task of await deps.acceptanceTasks()) {
        if (
          !book.handled.has(acceptanceKeyOf(task)) &&
          (!deps.acceptanceIssueOpen || (await deps.acceptanceIssueOpen(task)))
        )
          acceptanceWaiting.push(task);
      }
    } catch (err) {
      result.problems.push(`验收责任候选没查成：${errMessage(err)}`);
    }
  }
  result.candidates += acceptanceWaiting.length;
  const acceptanceClaimed = new Set<string>();
  const acceptanceByRepo = new Map<string, CommanderAcceptanceTask[]>();
  for (const task of acceptanceWaiting) {
    const key = `${task.owner}/${task.name}`.toLowerCase();
    acceptanceByRepo.set(key, [...(acceptanceByRepo.get(key) ?? []), task]);
  }
  for (const group of acceptanceByRepo.values()) {
    if (sessions >= PARK_TRIAGE_MAX_SESSIONS || remaining <= 0) break;
    const first = group[0];
    if (!first) continue;
    const repo = await deps.findRepo(first.owner, first.name);
    if (!repo) {
      result.problems.push(`${first.owner}/${first.name} 不是受管的仓，不交验收指挥官`);
      continue;
    }
    const requestId = `park-triage:acceptance:${repo.owner}/${repo.name}:${now.getTime()}`;
    const batch: CommanderAcceptanceTask[] = [];
    for (const task of group.slice(0, Math.min(PARK_TRIAGE_BATCH, remaining))) {
      if (!deps.claimAcceptance) {
        result.problems.push(`${acceptanceRefOf(task)} 验收认领口子未装配`);
        continue;
      }
      try {
        await deps.claimAcceptance({ task, requestId, attempt: 1 });
        batch.push(task);
        acceptanceClaimed.add(acceptanceKeyOf(task));
        remaining -= 1;
        result.claimed += 1;
      } catch (err) {
        result.problems.push(`${acceptanceRefOf(task)} 验收认领没记进操作记录：${errMessage(err)}`);
      }
    }
    if (batch.length === 0) continue;
    sessions += 1;
    try {
      await triageAcceptanceRepo(deps, repo, batch, requestId, result);
    } catch (err) {
      result.problems.push(`${repo.owner}/${repo.name} 这一批验收责任没处理完：${errMessage(err)}`);
    }
  }
  const blocked = remaining <= 0 ? waiting.filter((w) => !claimedIds.has(w.workflowId)) : [];
  const blockedAcceptance =
    remaining <= 0 ? acceptanceWaiting.filter((task) => !acceptanceClaimed.has(acceptanceKeyOf(task))) : [];
  if (blocked.length > 0 || blockedAcceptance.length > 0)
    await raiseCapAlert(
      deps,
      result,
      blocked.map((w) => ({ row: w.row, park: w.park })),
      blockedAcceptance,
      book,
      now,
    );
  else
    await deps.resolveCapAlert().catch((err: unknown) => {
      result.problems.push(`${PARK_TRIAGE_CAP_ALERT_KEY} 撤不掉：${errMessage(err)}`);
    });
  return result;
}

const CAP_ALERT_LISTED = 20;

/** 被全局上限挡住：记在结果上（这一轮记 partial），发 commander:daily-cap，列在等的单和下一个名额什么时候空出来。 */
async function raiseCapAlert(
  deps: ParkTriageDeps,
  result: ParkTriageResult,
  blocked: readonly { row: ParkedRetryRow; park: TaskParkInfo }[],
  blockedAcceptance: readonly CommanderAcceptanceTask[],
  book: AuditBook,
  now: Date,
): Promise<void> {
  const used = book.claimsToday + result.claimed;
  const times = result.claimed > 0 ? [...book.claimTimes, now.getTime()] : book.claimTimes;
  const first = times[0];
  const nextSlot =
    first === undefined
      ? '算不出来（窗口里没有有效认领的记录）'
      : `${stamp(new Date(first + WINDOW_MS))}（北京时间；窗口里最早那条认领 + 24 小时）`;
  result.capped = true;
  result.skipped = `24 小时内已有 ${used} 张有效认领，到熔断上限 ${PARK_TRIAGE_DAILY_CAP}，还有 ${blocked.length} 张等着`;
  const listed = blocked
    .slice(0, CAP_ALERT_LISTED)
    .map((w) => `- ${refOf(w.row)}：停下「${w.park.title}」（第 ${w.park.seq} 次）`);
  const acceptanceListed = blockedAcceptance
    .slice(0, Math.max(0, CAP_ALERT_LISTED - listed.length))
    .map((task) => `- ${acceptanceRefOf(task)}：验收责任 PR #${task.prNumber}（合并超过 30 分钟）`);
  const more = blocked.length + blockedAcceptance.length - listed.length - acceptanceListed.length;
  const body = [
    `指挥官 24 小时内已有 ${used} 张有效认领（没起成的不算），到全局熔断上限 ${PARK_TRIAGE_DAILY_CAP}：这一轮不再起会话，下面这些停下的单没人看：`,
    ...listed,
    ...acceptanceListed,
    ...(more > 0 ? [`……还有 ${more} 张`] : []),
    `下一个名额空出来的时刻：${nextSlot}。`,
    '这个上限只防失控：用到它，多半是有几张单在反复停、反复被认领；先看这些单为什么一直停，回到上限以下这张提醒自动撤。',
  ].join('\n');
  await deps
    .notify({
      level: 'alert',
      key: PARK_TRIAGE_CAP_ALERT_KEY,
      title: `指挥官的认领到了 24 小时熔断上限（${PARK_TRIAGE_DAILY_CAP}），停下的单没人看`,
      body,
      taskId: null,
    })
    .catch((e: unknown) => {
      result.problems.push(`${PARK_TRIAGE_CAP_ALERT_KEY} 的提醒没推出去：${errMessage(e)}`);
    });
}

export class ParkTriageFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'ParkTriageFailedError';
    this.runId = runId;
  }
}

/** 跑一轮。记开始就失败（库连不上）原样抛；没跑成记 failed 再抛 ParkTriageFailedError。 */
export async function runParkTriageJob(deps: ParkTriageDeps): Promise<ScheduleResult> {
  const runId = await deps.runs.start(PARK_TRIAGE_JOB.id, deps.now());
  let result: ScheduleResult;
  let got: ParkTriageResult | undefined;
  try {
    got = await triageParkedTasks(deps);
    const line = `停着的引擎任务 ${got.listed} 张，指挥官候选（含验收责任）${got.candidates} 张，认领 ${got.claimed} 张，执行 ${got.acted.length} 张，留给人 ${got.left.length} 张，会话没起成下一轮再看 ${got.retrying.length} 张`;
    if (got.noModel) result = { outcome: 'partial', why: `${got.skipped ?? '没配模型'}；${line}` };
    else if (got.capped || got.problems.length > 0)
      result = {
        outcome: 'partial',
        why: [got.capped ? got.skipped : null, line, ...got.problems.slice(0, 3)]
          .filter((s): s is string => typeof s === 'string' && s !== '')
          .join('；'),
      };
    else
      result = {
        outcome: 'ok',
        scanned: Math.max(1, got.listed),
        found: got.acted.length + got.left.length + got.retrying.length,
        why: got.skipped ? `${got.skipped}；${line}` : line,
      };
  } catch (err) {
    result = { outcome: 'failed', why: `指挥官会话没跑成：${errMessage(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome === 'failed') {
    deps.log('error', '指挥官这一轮没跑成', { runId, why: result.why });
    throw new ParkTriageFailedError(runId, result.why);
  }
  // 被上限挡住、没配模型、有读不到的东西（partial）也照样打这些字段：日志里能直接看到为什么这一轮没动。
  deps.log(result.outcome === 'partial' ? 'warn' : 'info', '指挥官这一轮跑完', {
    runId,
    outcome: result.outcome,
    skipped: got?.skipped,
    candidates: got?.candidates ?? 0,
    claimed: got?.claimed ?? 0,
    acted: got?.acted ?? [],
    left: got?.left ?? [],
    retrying: got?.retrying ?? [],
    problems: got?.problems ?? [],
  });
  return result;
}
