// 指挥官会话交的裁决，引擎执行之前的白名单和默认动作（#3294 第 2 片、#3423）。纯函数：只看停法、失败码、空转判断和裁决本身，不读库、不读时钟。
// 停下的单由指挥官拍板到出结果（创始人 2026-10-20，引导单 #3425）：会话交「继续 / 重做 / 拆单 / 停掉 / 留给人」加理由，
// 引擎按下表核过才动手。「留给人」只剩三种理由类别；没带类别的、没给裁决的、交了表外动作的，一律改按这种停法的默认动作执行。
//
//   停法                    继续      重做      拆单      停掉      默认动作
//   运行环境                ✓*        ✓         ✗*        ✗*        继续（同一种停下继续过一次还停 → 重做）
//   认不出按临时的办 / 自动合并没挂上
//                           ✓*        ✓         ✗*        ✗*        同上
//   （带 * 的：单张单防空转生效时继续 ✗、拆单 ✓、停掉 ✓，默认动作改重做，见下）
//   轮数用尽                ✓         ✓         ✗         ✗         重做（已经继续满三次交指挥官的：继续没用，只许重做）
//   体量超预算              ✓         ✗         ✓         ✗         继续（照这一版推，工作流不再按预算打回）
//   额度超预算·没空转        ✓+放宽    ✓         ✓         ✗         继续并放宽一档（看 decisions/spin.ts：判的是空转，不是钱）
//   额度超预算·空转          ✗         ✓         ✓         ✓         重做（不许原样继续）
//   额度超预算·没法判        ✗         ✓         ✗         ✗         重做（回合没读到：不拿「没读到」当「没有空转」）
//   改标准等人闸            ✗         ✗         ✗         ✗         留给人·改标准（贴「本机做」交本机指挥官）
//   没权限等人闸、别的       ✗         ✗         ✗         ✗         留给人并写卡（只有人能做）
//
// 单张单防空转（#3460，ParkFacts.noContinue）：上表里放行「继续」的停法，只要这张单 24 小时内指挥官已经处理满 3 次，
// 或这次停下的原文和上一次判「继续」时一字不差，就不放行「继续」，只放行重做、拆单（2~5 张）、停掉；默认动作不再是继续，改成重做。
//
// 「留给人」只放行带这三种理由类别的（LEAVE_REASONS），哪种停法都可以：
//   要掏新钱、删了找不回又没备份 → 写「要你拍」卡（带选项），任务不动；
//   改标准（引擎护栏不许法国模型做）→ 给单子贴「本机做」交本机指挥官，不找创始人，任务不动。
// 运行环境类停法按失败码和失败分流的规则编号认（triageKindOf），不按标题文字猜。
// 老历史（没记 status.park）的停法从任务行和提醒正文认（legacyParkKind），认不出按「按临时的办」。

import { type AcceptanceCoverage, parseAcceptanceCoverage } from '@fleet-dao/shared';
import type { ParkKind } from '../task-contract.ts';
import { PARK_CODE_NO_ROUTE, PARK_CODE_ROUTE_SWITCH } from '../task-contract.ts';
import type { SpinJudgement } from './spin.ts';

export const COMMANDER_ACTIONS = ['continue', 'redo', 'split', 'stop', 'leave'] as const;
export type CommanderAction = (typeof COMMANDER_ACTIONS)[number];

export const COMMANDER_ACTION_WORDS: Readonly<Record<CommanderAction, string>> = {
  continue: '继续',
  redo: '重做',
  split: '拆单',
  stop: '停掉并报原因',
  leave: '留给人',
};

/** 拆成几张子单：至少 2、最多 5。 */
export const SPLIT_MIN = 2;
export const SPLIT_MAX = 5;

/** 指挥官看的停法：工作流记的 ParkKind，加上按失败码认出来的运行环境类（runtime）。 */
export type TriageKind = ParkKind | 'runtime';

export const PARK_KIND_WORDS: Readonly<Record<TriageKind, string>> = {
  runtime: '运行环境（换路由续不上、会话总时长到顶、进程被杀、连不上执行机这类）',
  transient: '认不出、按临时的办',
  unarmed: '自动合并没挂上',
  rounds: '轮数用尽',
  quota: '额度超预算',
  size: '体量超预算',
  standard: '改标准等人闸',
  other: '别的（没权限等人闸）',
};

/**
 * 运行环境类的失败分流规则（failure/rules.ts 的 id）：会话或执行机的事，不是单子本身、也不是要人修的。
 * WT1 会话总时长到顶、KL1 命令跑超时被杀、KL2 内存超限被杀、KL3 发版叫停、KL4 进程被信号杀掉、ES1 发布排空、MR1 Mirasim 重启、
 * MB1 桥接连 Mirasim 超时、ST1 会话起不来、SL1 会话卡住、SB1 流断了、SM1 续会话没续上、NT1 网络不通、NT2 超时、EN1 引擎丢了这一步、
 * MU1 模型暂时不可用、BZ1 路由繁忙。
 */
export const RUNTIME_RULES: ReadonlySet<string> = new Set([
  'WT1',
  'KL1',
  'KL2',
  'KL3',
  'KL4',
  'ES1',
  'MR1',
  'MB1',
  'ST1',
  'SL1',
  'SB1',
  'SM1',
  'NT1',
  'NT2',
  'EN1',
  'MU1',
  'BZ1',
]);

/** 运行环境类的失败码（小写）：上面那些规则的强码，加引擎自己判的选路停下（没有失败分流）。 */
export const RUNTIME_CODES: ReadonlySet<string> = new Set([
  PARK_CODE_ROUTE_SWITCH,
  PARK_CODE_NO_ROUTE,
  'wall_clock_timeout',
  'oom_killed',
  'signal_unexplained',
  'engine_stop',
  'engine_stopping',
  'session_mismatch',
  'spawn_timeout',
  'startup_timeout',
  'econnreset',
  'econnrefused',
  'econnaborted',
  'etimedout',
  'ehostunreach',
  'enetunreach',
  'transport_closed',
  'cloud_unreachable',
]);

/** 工作流记下的那一次停下里，指挥官要看的几样。 */
export interface ParkCauseView {
  kind: ParkKind;
  code?: string | undefined;
  rule?: string | undefined;
}

/**
 * 认停法：工作流归成「别的」或「按临时的办」的，失败码或规则编号是运行环境类的，算运行环境。别的照工作流记的。
 * 只看码和规则编号，不看标题。
 */
export function triageKindOf(park: ParkCauseView): TriageKind {
  if (park.kind !== 'other' && park.kind !== 'transient') return park.kind;
  const code = park.code?.trim().toLowerCase();
  if (code !== undefined && RUNTIME_CODES.has(code)) return 'runtime';
  if (park.rule !== undefined && RUNTIME_RULES.has(park.rule)) return 'runtime';
  return park.kind;
}

/**
 * 老历史（patched('park-kind') 为假，查询里没有 status.park）的停法：从停下提醒的标题、正文和任务行的 lastProblem 认。
 * 只认得出工作流写死的那几句（体量超预算、额度超预算、轮数用尽）；认不出回 null（调用方记进 problems，按「按临时的办」处理）。
 */
export function legacyParkKind(texts: readonly (string | null | undefined)[]): ParkKind | null {
  const all = texts.filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n');
  if (/改动超出体量预算/.test(all)) return 'size';
  if (/花掉的(?:额度|\s*token\s*)超了预算/.test(all)) return 'quota';
  if (/轮都没过|返工 \d+ 轮用完|仍没过，交指挥官/.test(all)) return 'rounds';
  return null;
}

/** 引擎认得的一次停下。handoff＝已继续满三次、交指挥官的那一停；legacy＝老历史（没记 status.park）。 */
export interface ParkFacts {
  kind: TriageKind;
  handoff: boolean;
  legacy?: boolean;
  /**
   * 单张单防空转（#3460）：有值就不放行「继续」（值是原因，写进白名单核对结果）。两种情况：这张单 24 小时内指挥官已经
   * 处理满 PARK_TRIAGE_SPIN_HANDLED 次；这次停下的原文和上一次判「继续」时一字不差。
   */
  noContinue?: string | undefined;
}

/** 「留给人」的三种理由类别。 */
export const LEAVE_REASONS = ['new-money', 'irreversible', 'standard'] as const;
export type LeaveReason = (typeof LEAVE_REASONS)[number];
export const LEAVE_REASON_WORDS: Readonly<Record<LeaveReason, string>> = {
  'new-money': '要掏新钱',
  irreversible: '删了找不回又没备份',
  standard: '改标准（引擎护栏不许法国模型做，交本机指挥官）',
};

/** 这一次停下，每个动作放不放行：放行 true，不放行写原因。leave 指「带了理由类别的留给人」。 */
export type ActionTable = Record<CommanderAction, true | string>;

/**
 * 按停法列出放行的动作。spin 只有额度停法用得上：null＝回合没读到，没法判（不许继续，只许重做）。
 */
export function allowedActions(park: ParkFacts, spin: SpinJudgement | null): ActionTable {
  const table = allowedByKind(park, spin);
  // 防空转：本来放行继续的，继续换成不放行，只留重做、拆单、停掉（本来就不放行继续的停法，不替它放开别的）
  if (park.noContinue !== undefined && table.continue === true) {
    return { ...table, continue: park.noContinue, redo: true, split: true, stop: true };
  }
  return table;
}

function allowedByKind(park: ParkFacts, spin: SpinJudgement | null): ActionTable {
  const base: ActionTable = {
    continue: '这种停法不许继续',
    redo: '这种停法不许重做',
    split: '这种停法不许拆单',
    stop: '只有额度超预算判成空转时才许停掉',
    leave: true,
  };
  switch (park.kind) {
    case 'rounds':
      return {
        ...base,
        continue: park.handoff ? '已经继续满三次仍没过，再继续工作流会原样再停一次，没有用' : true,
        redo: true,
      };
    case 'size':
      return { ...base, continue: true, split: true };
    case 'quota': {
      if (spin === null) {
        const why = '这张单的回合没读到，判不了空转';
        return { ...base, continue: `${why}，不许原样继续`, redo: true, split: `${why}，不拆单`, stop: why };
      }
      if (spin.spinning) {
        return {
          ...base,
          continue: `判成空转，不许原样继续：${spin.summary}`,
          redo: true,
          split: true,
          stop: true,
        };
      }
      return { ...base, continue: true, redo: true, split: true };
    }
    case 'runtime':
    case 'transient':
    case 'unarmed':
      return { ...base, continue: true, redo: true };
    default:
      return base;
  }
}

/** 会话交的一条裁决（会话原话，还没核）。 */
export interface RawVerdict {
  action: string;
  /** 拆单时会话给了几张子单（具体内容由执行那一边再核）。 */
  subtaskCount?: number | undefined;
  /** 留给人的理由类别（会话原话）。 */
  leaveReason?: string | undefined;
}

export type VerdictCheck =
  | {
      ok: true;
      action: CommanderAction;
      /** 继续时是不是把额度预算放宽一档（额度超预算、没空转、不是老历史才放宽）。 */
      widenBudget: boolean;
      /** 留给人时的理由类别。 */
      leaveReason?: LeaveReason;
    }
  | { ok: false; why: string };

/** 继续时放不放宽：额度停法才放宽；老历史收不到指挥官的放宽（工作流只认带停下编号的），照常给一份。 */
const widenOf = (park: ParkFacts) => park.kind === 'quota' && park.legacy !== true;

/** 核一条裁决。不在表里的动作名、表里没放行的、拆单数不对、留给人没带三种理由类别之一，都回 ok:false 和原因。 */
export function checkVerdict(park: ParkFacts, spin: SpinJudgement | null, verdict: RawVerdict): VerdictCheck {
  const action = COMMANDER_ACTIONS.find((a) => a === verdict.action);
  if (action === undefined) {
    return {
      ok: false,
      why: `裁决「${verdict.action}」不在白名单里（只收 ${COMMANDER_ACTIONS.join('、')}）`,
    };
  }
  if (action === 'leave') {
    const reason = LEAVE_REASONS.find((r) => r === verdict.leaveReason);
    if (reason === undefined)
      return {
        ok: false,
        why: `「留给人」要带理由类别（只收 ${LEAVE_REASONS.join('、')}：${LEAVE_REASONS.map((r) => LEAVE_REASON_WORDS[r]).join('、')}），会话给的是「${verdict.leaveReason ?? '没写'}」`,
      };
    return { ok: true, action, widenBudget: false, leaveReason: reason };
  }
  const allowed = allowedActions(park, spin)[action];
  if (allowed !== true) {
    return {
      ok: false,
      why: `停法「${PARK_KIND_WORDS[park.kind]}」不放行「${COMMANDER_ACTION_WORDS[action]}」：${allowed}`,
    };
  }
  if (action === 'split') {
    const n = verdict.subtaskCount ?? 0;
    if (n < SPLIT_MIN || n > SPLIT_MAX)
      return { ok: false, why: `拆单要给 ${SPLIT_MIN}~${SPLIT_MAX} 张子单，会话给了 ${n} 张` };
  }
  return { ok: true, action, widenBudget: action === 'continue' && widenOf(park) };
}

/** 引擎替指挥官执行的默认动作。leave 只出在人闸停法上：改标准贴「本机做」，没权限写卡（只有人能做）。 */
export type DefaultAction =
  | { action: 'continue'; widenBudget: boolean; why: string }
  | { action: 'redo'; why: string }
  | { action: 'leave'; leaveReason: 'standard' | 'human-only'; why: string };

/**
 * 这种停法的默认动作（会话没给裁决、留给人没带理由类别、交了白名单外动作、会话三次没起成时执行）。
 * continuedBefore＝同一张单同一种停下已经继续过一次还停（引擎续停续过同一原文，或指挥官之前对同一种停下判过继续）。
 */
export function defaultAction(
  park: ParkFacts & { continuedBefore: boolean },
  spin: SpinJudgement | null,
): DefaultAction {
  const action = defaultByKind(park, spin);
  // 防空转生效时默认动作不能是继续：换一代重做
  if (action.action === 'continue' && park.noContinue !== undefined)
    return { action: 'redo', why: `${park.noContinue}，不再原样继续，换一代重做` };
  return action;
}

export type AcceptanceVerdictAction = 'settle' | 'supersede' | 'leave';

export interface AcceptanceDutyIdentityView {
  id: number;
  generation: number;
  repo: string;
  issueNumber: number;
  prNumber: number;
  head: string;
  items: readonly string[];
  mergeCommit: string | null;
}

export interface RawAcceptanceVerdict {
  action: string;
  dutyId: number;
  generation: number;
  prNumber: number;
  head: string;
  reason: string;
  evidence?: string | undefined;
  target?:
    | {
        id: number;
        generation: number;
        prNumber: number;
        head: string;
      }
    | undefined;
  coverage?: readonly unknown[] | undefined;
  /** 模型自述缺什么：只是说明，不是授权，也不是转人的依据。 */
  humanOnly?: string | undefined;
}

/**
 * 引擎自己的可信来源给出的「这条责任的证据只有创始人能提供」事实：精确绑定 duty / 代次 / PR / head，
 * 由装配侧只读、限长、脱敏后给出。受限模型会话不能产生它；自由文本（humanOnly、reason）也不是它。
 * 当前真装配没有这种来源（旧历史里没有这种证明，不补造），所以生产上 leave 一律不转人。
 */
export const FOUNDER_EVIDENCE_KINDS = ['founder-decision', 'founder-onsite-check'] as const;
export interface AcceptanceFounderFact {
  dutyId: number;
  generation: number;
  prNumber: number;
  head: string;
  kind: (typeof FOUNDER_EVIDENCE_KINDS)[number];
  /** 缺的是什么（给创始人看）。 */
  what: string;
}
const FOUNDER_WHAT_MAX = 300;

/**
 * 这条责任有没有可信的创始人证据事实：duty/代次/PR/head 都要精确相等，种类认得，说明非空且不超长；
 * 同一责任有不止一条、或有一条不合格，都不算（不猜，按没有处理，调用方保留机读责任）。
 */
export function trustedFounderFact(
  duty: AcceptanceDutyIdentityView,
  facts: readonly AcceptanceFounderFact[],
): AcceptanceFounderFact | undefined {
  const mine = facts.filter((f) => f.dutyId === duty.id);
  const only = mine.length === 1 ? mine[0] : undefined;
  if (
    !only ||
    only.generation !== duty.generation ||
    only.prNumber !== duty.prNumber ||
    only.head !== duty.head ||
    !FOUNDER_EVIDENCE_KINDS.includes(only.kind) ||
    !only.what.trim() ||
    only.what.length > FOUNDER_WHAT_MAX
  )
    return undefined;
  return only;
}

export type AcceptanceVerdictCheck =
  | { ok: true; action: AcceptanceVerdictAction; coverage?: AcceptanceCoverage[] }
  | { ok: false; why: string };

const sameAcceptanceIdentity = (
  row: AcceptanceDutyIdentityView,
  input: { id: number; generation: number; prNumber: number; head: string },
) =>
  row.id === input.id &&
  row.generation === input.generation &&
  row.prNumber === input.prNumber &&
  row.head === input.head;

/** 验收责任裁决的纯白名单：不读库、不读时钟，精确身份和证据先于 DB CAS。 */
export function checkAcceptanceVerdict(
  source: AcceptanceDutyIdentityView,
  target: AcceptanceDutyIdentityView | undefined,
  verdict: RawAcceptanceVerdict,
): AcceptanceVerdictCheck {
  if (!['settle', 'supersede', 'leave'].includes(verdict.action))
    return { ok: false, why: `验收裁决动作「${verdict.action}」不在白名单里` };
  if (
    verdict.dutyId !== source.id ||
    verdict.generation !== source.generation ||
    verdict.prNumber !== source.prNumber ||
    verdict.head !== source.head
  )
    return { ok: false, why: '验收责任的 id、代次、PR 或 head 与现读不符' };
  if (!verdict.reason.trim()) return { ok: false, why: '验收裁决必须写理由' };
  if (verdict.action === 'leave') {
    if (!verdict.humanOnly?.trim()) return { ok: false, why: 'leave 必须写明只有创始人能提供的证据' };
    return { ok: true, action: 'leave' };
  }
  if (!verdict.evidence?.trim()) return { ok: false, why: '验收收口必须写非空证据' };
  if (verdict.action === 'settle') {
    if (source.mergeCommit === null) return { ok: false, why: 'PR 没有合并回执，不能结清验收责任' };
    return { ok: true, action: 'settle' };
  }
  if (!target || !verdict.target) return { ok: false, why: 'supersede 必须指向已读到的目标责任行' };
  if (!sameAcceptanceIdentity(target, verdict.target))
    return { ok: false, why: 'supersede 的目标 id、代次、PR 或 head 与现读不符' };
  if (target.id === source.id) return { ok: false, why: 'supersede 不能指向自己' };
  if (
    target.repo !== source.repo ||
    target.issueNumber !== source.issueNumber ||
    target.prNumber !== source.prNumber
  )
    return { ok: false, why: 'supersede 的目标必须是同仓同单同一个 PR' };
  if (!verdict.coverage || verdict.coverage.length === 0)
    return { ok: false, why: 'supersede 必须逐条写 coverage' };
  const coverage = parseAcceptanceCoverage(verdict.coverage);
  if (!coverage) return { ok: false, why: 'supersede 的 coverage 格式不对或没有覆盖源验收项' };
  return { ok: true, action: 'supersede', coverage };
}

/**
 * 自动 settle 的可信读证（#3579）。由装配侧只读给出，模型的裁决、evidence、PR 自述、责任行 mergeCommit 都不在这里：
 * - mergedHead：引擎现读 GitHub 得到的「这个 PR 实际已合的 head」；null＝PR 没合；
 * - items：对责任每一条原文义务（整串相等）各一项：need＝这条义务要哪一类来源才算数（由读方定，unknown＝读方分不出），
 *   got＝读方实际拿到的来源（unknown＝读取失败或没有）。run-history（真实现场/运行记录）必须带时间范围 range。
 */
export const ACCEPTANCE_EVIDENCE_SOURCES = ['platform', 'run-history'] as const;
export type AcceptanceEvidenceSource = (typeof ACCEPTANCE_EVIDENCE_SOURCES)[number];
export interface AcceptanceTrustedItem {
  item: string;
  need: AcceptanceEvidenceSource | 'unknown';
  got: AcceptanceEvidenceSource | 'unknown';
  /** 读到的范围（ISO 时间，from < to）；run-history 必须有。 */
  range?: { from: string; to: string } | undefined;
}
export interface AcceptanceTrustedRead {
  dutyId: number;
  generation: number;
  prNumber: number;
  head: string;
  mergedHead: string | null;
  items: readonly AcceptanceTrustedItem[];
}

const validRange = (range: AcceptanceTrustedItem['range']) => {
  if (!range) return false;
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
};

/**
 * settle 前的读证核对（纯函数）：可信读方必须绑定这条责任精确的 id/代次/PR/head，且实际已合的 head 就是责任 head
 * （责任行 mergeCommit 非空、最终头 CI 齐绿都不证明旧头已合）；责任的每一条原文义务都要有一项读证，来源类别与义务一致、
 * 不是 unknown，run-history 还要有时间范围。只给一项事实盖不住两项义务。返回 undefined＝可以结清，否则回原因（机读缺口）。
 */
export function acceptanceSettleTrustProblem(
  duty: AcceptanceDutyIdentityView,
  read: AcceptanceTrustedRead | undefined,
): string | undefined {
  if (!read) return '没有可信读证（读方没装配或没给），不能结清';
  if (
    read.dutyId !== duty.id ||
    read.generation !== duty.generation ||
    read.prNumber !== duty.prNumber ||
    read.head !== duty.head
  )
    return '可信读证绑定的 duty、代次、PR 或 head 与现读不符';
  if (read.mergedHead === null) return '可信读方没读到该 PR 已合并的 head，不能结清';
  if (read.mergedHead !== duty.head)
    return `该 PR 实际已合的 head 是 ${read.mergedHead}，不是这条责任的 ${duty.head}：旧头不能套最终头证据，须走同单同 PR 的 supersede`;
  if (duty.items.length === 0) return '责任没有验收项，没有可对应的读证';
  const problems: string[] = [];
  for (const item of duty.items) {
    const mine = read.items.filter((e) => e.item === item);
    const only = mine.length === 1 ? mine[0] : undefined;
    if (!only) problems.push(`义务「${item}」没有唯一的可信读证（有 ${mine.length} 项）`);
    else if (only.need === 'unknown') problems.push(`义务「${item}」读方分不出需要哪类来源`);
    else if (only.got === 'unknown') problems.push(`义务「${item}」需要 ${only.need} 来源，读取失败或没有`);
    else if (only.got !== only.need)
      problems.push(`义务「${item}」需要 ${only.need} 来源，读证只有 ${only.got}（不能互相顶替）`);
    else if (only.need === 'run-history' && !validRange(only.range))
      problems.push(`义务「${item}」的运行记录读证缺有效的时间范围`);
  }
  return problems.length > 0 ? problems.join('；') : undefined;
}

function defaultByKind(
  park: ParkFacts & { continuedBefore: boolean },
  spin: SpinJudgement | null,
): DefaultAction {
  switch (park.kind) {
    case 'runtime':
    case 'transient':
    case 'unarmed':
      return park.continuedBefore
        ? { action: 'redo', why: '同一种停下已经继续过一次还停，换一代重做' }
        : { action: 'continue', widenBudget: false, why: '运行环境或临时的问题，接着做' };
    case 'rounds':
      return { action: 'redo', why: '轮数用尽，换一代（重新选路）重做' };
    case 'size':
      return {
        action: 'continue',
        widenBudget: false,
        why: '照这一版继续推（这张单后面不再按体量预算打回）',
      };
    case 'quota':
      if (spin === null) return { action: 'redo', why: '回合没读到，判不了空转，不原样续，换一代重做' };
      if (spin.spinning) return { action: 'redo', why: `判成空转，换一代重做：${spin.summary}` };
      return {
        action: 'continue',
        widenBudget: widenOf(park),
        why: `没有空转，继续${widenOf(park) ? '并把额度预算放宽一档' : '（老历史放宽不了，照常再给一份）'}`,
      };
    case 'standard':
      return { action: 'leave', leaveReason: 'standard', why: '改标准等人闸：贴「本机做」交本机指挥官' };
    default:
      return { action: 'leave', leaveReason: 'human-only', why: '没权限等人闸：只有人能做，写卡' };
  }
}
