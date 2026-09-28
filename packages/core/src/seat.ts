// 帅位只一个（specs/446-帅位认领简化/需求.md）：帅位记录「现在是谁」，每张单的认领怎么判。读写库、调 ssh 是外壳的事，
// 这里只判。改这里之前必须知道：
// - 2026-09-28 下午起帅位不再是锁：删了租约、续约、任期号当栅栏号、受保护动作前的现查（#446，替掉 #299 那一套 fail-closed
//   判法）。接班（seat take）永远成功、后说的算；认领、帅位栏都不再按「是不是现在的帅位」拦——换班后旧帅位靠 SKILL.md
//   里教的做法自己退（派活前看一眼 seat show），不是系统判定的锁。
// - lastActivityAt 只给人看（像 Kubernetes Lease 的 renewTime，但没人读它来判断谁能写）：帅位接班、写交接、写进度板时
//   顺手顶成现在；`seat show`、驾驶舱帅位栏拿它算「最后活动 N 分钟前」。只是显示，多久没动过也照样能写、不自动让位。
// - 时间一律用库的 now()：外壳读库时把库的「现在」一起取回来交给这里，不拿各机器的时钟判。
// - 读不到、认不出的地方（比如帅位栏的形状）依然明确失败，不拿空的顶；但这和「是不是帅位」无关了。

import type { TaskState } from '@fleet-dao/shared';

/** 真帅位的座位；演练用 `drill:<名字>`，和它互不影响。 */
export const MAIN_SEAT = 'main';

/**
 * 本机认领没心跳、没人管的时候写在行里的宽限期（分钟，纯记录用）：#446 起不再有任何东西按它自动作废认领——心跳宽限期
 * 作废、撤自动合并那一套是「拦人」的部分，跟着 claim sweep 一起删了。这里只是给新认领一个说得过去的默认值。
 */
export const DEFAULT_CLAIM_GRACE_MINUTES = 120;

// —— 名字 ——

const MACHINE = /^[\p{L}\p{N}_.-]{1,32}$/u;
const SESSION = /^[\p{L}\p{N}_.:-]{1,64}$/u;
const DRILL = /^drill:[\p{L}\p{N}_.-]{1,32}$/u;

/** 座位名：`main` 或 `drill:<名字>`。不对返回原因。 */
export function seatScopeProblem(scope: string): string | null {
  return scope === MAIN_SEAT || DRILL.test(scope)
    ? null
    : `座位「${scope}」不行：真帅位是 main，演练写 drill:<名字>（32 字以内的字母、汉字、数字、点、横线、下划线）`;
}

export function isDrillScope(scope: string | null | undefined): boolean {
  return typeof scope === 'string' && DRILL.test(scope);
}

/** 机器名和帅位技能里 doing.mjs 的机器名同一个写法（会公开写在单上：本机、法国、笔记本……）。 */
export function machineProblem(name: string): string | null {
  return MACHINE.test(name)
    ? null
    : `机器名「${name}」不行：32 字以内的一段字母、汉字、数字、点、横线、下划线`;
}

/** 会话号、工人名：64 字以内，比机器名多允许冒号。 */
export function sessionProblem(name: string, what = '会话号'): string | null {
  return SESSION.test(name)
    ? null
    : `${what}「${name}」不行：64 字以内的一段字母、汉字、数字、点、冒号、横线、下划线`;
}

// —— 帅位 ——

export interface SeatLease {
  scope: string;
  /** 第几任：接班一次加一，只增不减；纯记录（给「上一任」「现在第几任」这类话用），不再是栅栏号，没人拿它拦写入。 */
  term: number;
  holderMachine: string;
  holderSession: string;
  acquiredAt: string;
  /** 最后一次真活动（接班、写交接、写进度板）：只给人看（像 K8s Lease 的 renewTime），没人读它来判断谁能写。 */
  lastActivityAt: string;
  previousMachine: string | null;
  previousSession: string | null;
  /** 最新一份交接说明（只算补充，交接以现算的为准）。 */
  handoff: string | null;
  handoffAt: string | null;
}

export const holderText = (lease: Pick<SeatLease, 'holderMachine' | 'holderSession'>) =>
  `${lease.holderMachine}/${lease.holderSession}`;

function minutesText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

/** 给人看的一句：「最后活动 N 分钟前」；时刻认不出就说没读到，不拿「刚刚」顶。 */
export function lastActivityText(lastActivityAt: string, dbNow: string): string {
  const at = Date.parse(lastActivityAt);
  const now = Date.parse(dbNow);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '最后活动：没读到';
  return `最后活动 ${minutesText(Math.max(0, now - at))}前`;
}

// —— 认领 ——

export type ClaimOwnerKind = 'engine' | 'seat' | 'worker';
export const CLAIM_OWNER_KINDS: readonly ClaimOwnerKind[] = ['engine', 'seat', 'worker'];

/** pending_start 只有引擎有（先写待起，再起工作流）；done / released / voided 是结束了的。 */
export const CLAIM_STATES = [
  'pending_start',
  'claimed',
  'doing',
  'pr_open',
  'done',
  'released',
  'voided',
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];
export const ACTIVE_CLAIM_STATES: readonly ClaimState[] = ['pending_start', 'claimed', 'doing', 'pr_open'];
export const ENDED_CLAIM_STATES: readonly ClaimState[] = ['done', 'released', 'voided'];

export function isActiveClaim(state: ClaimState): boolean {
  return ACTIVE_CLAIM_STATES.includes(state);
}

export interface IssueClaim {
  repoId: string;
  issueNumber: number;
  /** 认领号：每认领一次换一个，工人的栅栏号。 */
  claimId: string;
  ownerKind: ClaimOwnerKind;
  /** 本机的：哪台机器、哪个会话或工人；引擎的是 null。 */
  ownerMachine: string | null;
  ownerLabel: string | null;
  /** 哪个座位、第几任帅位认领的（引擎自动派的是 null）。 */
  seatScope: string | null;
  seatTerm: number | null;
  state: ClaimState;
  /** 引擎的：要起的工作流编号（照旧 req:<仓>#<号>）。 */
  workflowId: string | null;
  /** 这份认领开过的 PR。 */
  prNumbers: number[];
  graceMinutes: number;
  claimedAt: string;
  heartbeatAt: string;
  updatedAt: string;
  endedAt: string | null;
  endReason: string | null;
  /** 最近一句进度。 */
  note: string | null;
}

export function claimOwnerText(c: Pick<IssueClaim, 'ownerKind' | 'ownerMachine' | 'ownerLabel'>): string {
  if (c.ownerKind === 'engine') return '引擎';
  return `${c.ownerMachine ?? '?'}/${c.ownerLabel ?? '?'}${c.ownerKind === 'seat' ? '（帅位自己）' : ''}`;
}

const STATE_TEXT: Record<ClaimState, string> = {
  pending_start: '待起',
  claimed: '认领了',
  doing: '在做',
  pr_open: '开了 PR',
  done: '做完了',
  released: '放下了',
  voided: '作废了',
};

export function claimStateText(state: ClaimState): string {
  return STATE_TEXT[state];
}

/**
 * 给人看的一行：谁、什么状态、上次心跳多久以前、PR、最近一句进度。#446 起没有任何东西按心跳宽限期自动作废认领了
 * （心跳、宽限期只留作记录，「过了宽限期没心跳，下一轮作废」那句话没有了——不会再有下一轮）。
 */
export function describeClaim(c: IssueClaim, dbNow: string): string {
  const now = Date.parse(dbNow);
  const beat = Date.parse(c.heartbeatAt);
  const ago =
    Number.isFinite(now) && Number.isFinite(beat) ? `${minutesText(now - beat)}前` : '不知道多久以前';
  const prs = c.prNumbers.length > 0 ? `，PR ${c.prNumbers.map((n) => `#${n}`).join('、')}` : '';
  const note = c.note ? `：${c.note}` : '';
  const ended = isActiveClaim(c.state) ? '' : `（${c.endReason ?? '没写原因'}）`;
  return `${claimOwnerText(c)} ${claimStateText(c.state)}${ended}${note}（认领 ${c.claimId.slice(0, 8)}，上次心跳 ${ago}${prs}）`;
}

// —— 引擎的认领 ——

/**
 * 待起的引擎认领过了几分钟还没改成在做，GitHub 对账（每 15 分钟）就照行里的工作流编号补起一次：起工作流没成的投递最多自动
 * 重放 5 次，之后不再重放；交单时 Temporal 连不上也留着待起。
 */
export const ENGINE_PENDING_RESTART_MINUTES = 5;

/**
 * 任务到了结束状态，这张单上引擎的认领跟着结束（写快照的同一个事务里）：做完的记做完；叫停、没做成的记放下，本机能接着认领。
 * 没结束的回 null：写快照时引擎的认领还在待起就改成在做（工作流在跑了）。
 */
export function engineClaimEnd(taskState: TaskState): { state: 'done' | 'released'; reason: string } | null {
  if (taskState === 'done') return { state: 'done', reason: 'Fusion 做完了' };
  if (taskState === 'stopped') return { state: 'released', reason: '任务叫停了' };
  if (taskState === 'failed') return { state: 'released', reason: 'Fusion 没做成（任务 failed）' };
  return null;
}

/** 引擎要拿这张单时别人拿着：给人看的一句（接活的投递说明、交单被拒的原因）。 */
export function heldByOtherText(c: IssueClaim, dbNow: string): string {
  const seat =
    c.ownerKind !== 'engine' && c.seatScope ? `（${c.seatScope} 第 ${c.seatTerm} 任帅位认领的）` : '';
  return `这张单${c.ownerKind === 'engine' ? '' : '本机'}认领着${seat}：${describeClaim(c, dbNow)}`;
}

// —— 帅位栏（#199）：一份板是一个项目的进度。判法在这里，外壳只负责锁行和时钟。

export const BOARD_STEP_STATUSES = ['done', 'doing', 'waiting', 'needs', 'blocked'] as const;
export type BoardStepStatus = (typeof BOARD_STEP_STATUSES)[number];
/** 最近动态只留这么多条，新的在前。 */
export const BOARD_LOG_KEEP = 60;

const BOARD_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BOARD_REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BOARD_URL = /^https?:\/\/[^\s]+$/i;
const BOARD_TEXT = 500;

export function boardProjectProblem(name: string): string | null {
  return BOARD_PROJECT.test(name)
    ? null
    : `项目名「${name}」不行：写成仓名（字母、数字、点、横线、下划线，一段）`;
}

export interface BoardLink {
  label: string;
  url: string;
}
export interface BoardStep {
  id: string;
  order: number;
  title: string;
  status: BoardStepStatus;
  detail: string;
  updatedAt: string;
  links: BoardLink[];
}
export interface BoardLogEntry {
  at: string;
  text: string;
}
export interface BoardNeed {
  id: string;
  question: string;
  options: string[];
  recommended: string;
  repo: string;
  issue: number;
}
export interface BoardAnswer extends BoardNeed {
  option: string;
  answeredAt: string;
  answeredBy: string;
  ackedAt: string | null;
}
export interface SeatBoardDoc {
  headline: string;
  steps: BoardStep[];
  log: BoardLogEntry[];
  needs: BoardNeed[];
  answers: BoardAnswer[];
}

export function emptySeatBoard(): SeatBoardDoc {
  return { headline: '', steps: [], log: [], needs: [], answers: [] };
}

export type BoardWrite =
  | { kind: 'head'; text: string }
  | { kind: 'add'; id: string; order: number; title: string; detail: string }
  | { kind: 'step'; id: string; status: string; detail?: string | undefined }
  | { kind: 'link'; id: string; label: string; url: string }
  | { kind: 'log'; text: string }
  | {
      kind: 'need';
      id: string;
      question: string;
      options: string[];
      recommended: string;
      repo: string;
      issue: number;
    }
  | { kind: 'clear-needs' }
  | { kind: 'answer'; id: string; option: string; by: string }
  | { kind: 'ack'; id: string };

export type BoardWriteResult =
  | { ok: true; doc: SeatBoardDoc }
  | { ok: false; reason: 'bad' | 'missing' | 'already'; why: string };

const isStr = (v: unknown): v is string => typeof v === 'string';
const isIso = (v: unknown): v is string => isStr(v) && Number.isFinite(Date.parse(v));
const isStatus = (v: unknown): v is BoardStepStatus =>
  isStr(v) && (BOARD_STEP_STATUSES as readonly string[]).includes(v);

function textProblem(value: string, what: string): string | null {
  const t = value.trim();
  if (t === '') return `${what}是空的`;
  if ([...t].length > BOARD_TEXT) return `${what}太长（最多 ${BOARD_TEXT} 个字）`;
  return null;
}

function idProblem(id: string, what: string): string | null {
  return BOARD_ID.test(id) ? null : `${what}「${id}」不行：64 字以内的字母、数字、点、横线、下划线`;
}

/** 从库里读回来的四段。认不出就失败，不拿空的顶。 */
export function readSeatBoard(raw: {
  headline: unknown;
  steps: unknown;
  log: unknown;
  needs: unknown;
  answers: unknown;
}): { ok: true; doc: SeatBoardDoc } | { ok: false; why: string } {
  const problems: string[] = [];
  if (!isStr(raw.headline)) problems.push('headline 不是字符串');
  const steps = readSteps(raw.steps, problems);
  const log = readLog(raw.log, problems);
  const needs = readNeeds(raw.needs, problems);
  const answers = readAnswers(raw.answers, problems);
  if (!isStr(raw.headline) || !steps || !log || !needs || !answers) {
    return { ok: false, why: `这份板认不出：${problems.slice(0, 5).join('；')}` };
  }
  return { ok: true, doc: { headline: raw.headline, steps, log, needs, answers } };
}

function readSteps(raw: unknown, problems: string[]): BoardStep[] | null {
  if (!Array.isArray(raw)) {
    problems.push('steps 不是列表');
    return null;
  }
  const steps: BoardStep[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') {
      problems.push(`steps[${i}] 不是对象`);
      return null;
    }
    const s = item as Record<string, unknown>;
    if (!isStr(s.id) || !BOARD_ID.test(s.id) || seen.has(s.id)) {
      problems.push(`steps[${i}].id 不行`);
      return null;
    }
    seen.add(s.id);
    if (typeof s.order !== 'number' || !Number.isFinite(s.order)) {
      problems.push(`steps[${i}].order 不是数`);
      return null;
    }
    if (!isStr(s.title) || !isStatus(s.status) || !isStr(s.detail) || !isIso(s.updatedAt)) {
      problems.push(`steps[${i}] 缺标题、状态、说明或更新时间`);
      return null;
    }
    if (!Array.isArray(s.links)) {
      problems.push(`steps[${i}].links 不是列表`);
      return null;
    }
    const links: BoardLink[] = [];
    for (const link of s.links) {
      if (!link || typeof link !== 'object') {
        problems.push(`steps[${i}].links 里有不是对象的`);
        return null;
      }
      const l = link as Record<string, unknown>;
      if (!isStr(l.url) || !BOARD_URL.test(l.url) || !isStr(l.label)) {
        problems.push(`steps[${i}].links 每项要有名字和 http(s) 网址`);
        return null;
      }
      links.push({ label: l.label, url: l.url });
    }
    steps.push({
      id: s.id,
      order: s.order,
      title: s.title,
      status: s.status,
      detail: s.detail,
      updatedAt: s.updatedAt,
      links,
    });
  }
  return steps;
}

function readLog(raw: unknown, problems: string[]): BoardLogEntry[] | null {
  if (!Array.isArray(raw)) {
    problems.push('log 不是列表');
    return null;
  }
  const log: BoardLogEntry[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') {
      problems.push(`log[${i}] 不是对象`);
      return null;
    }
    const e = item as Record<string, unknown>;
    if (!isIso(e.at) || !isStr(e.text)) {
      problems.push(`log[${i}] 要有时间和文字`);
      return null;
    }
    log.push({ at: e.at, text: e.text });
  }
  return log;
}

function readNeed(item: unknown, at: string, problems: string[]): BoardNeed | null {
  if (!item || typeof item !== 'object') {
    problems.push(`${at} 不是对象`);
    return null;
  }
  const n = item as Record<string, unknown>;
  if (!isStr(n.id) || !BOARD_ID.test(n.id)) {
    problems.push(`${at}.id 不行`);
    return null;
  }
  if (!isStr(n.question) || !isStr(n.repo) || !BOARD_REPO.test(n.repo)) {
    problems.push(`${at} 缺问题或仓名不对`);
    return null;
  }
  if (typeof n.issue !== 'number' || !Number.isInteger(n.issue) || n.issue <= 0) {
    problems.push(`${at}.issue 不是正整数`);
    return null;
  }
  if (!Array.isArray(n.options) || n.options.length < 2 || !n.options.every(isStr)) {
    problems.push(`${at}.options 至少要两个选项`);
    return null;
  }
  const options = n.options as string[];
  if (new Set(options).size !== options.length || options.some((o) => o.trim() === '')) {
    problems.push(`${at}.options 有空的或重复的`);
    return null;
  }
  if (!isStr(n.recommended) || !options.includes(n.recommended)) {
    problems.push(`${at}.recommended 不在选项里`);
    return null;
  }
  return {
    id: n.id,
    question: n.question,
    options,
    recommended: n.recommended,
    repo: n.repo,
    issue: n.issue,
  };
}

function readNeeds(raw: unknown, problems: string[]): BoardNeed[] | null {
  if (!Array.isArray(raw)) {
    problems.push('needs 不是列表');
    return null;
  }
  const needs: BoardNeed[] = [];
  for (const [i, item] of raw.entries()) {
    const n = readNeed(item, `needs[${i}]`, problems);
    if (!n) return null;
    needs.push(n);
  }
  return needs;
}

function readAnswers(raw: unknown, problems: string[]): BoardAnswer[] | null {
  if (!Array.isArray(raw)) {
    problems.push('answers 不是列表');
    return null;
  }
  const answers: BoardAnswer[] = [];
  for (const [i, item] of raw.entries()) {
    const n = readNeed(item, `answers[${i}]`, problems);
    if (!n || !item || typeof item !== 'object') return null;
    const a = item as Record<string, unknown>;
    if (!isStr(a.option) || !n.options.includes(a.option) || !isIso(a.answeredAt) || !isStr(a.answeredBy)) {
      problems.push(`answers[${i}] 缺选中的选项、回答时间或是谁答的`);
      return null;
    }
    if (a.ackedAt !== null && !isIso(a.ackedAt)) {
      problems.push(`answers[${i}].ackedAt 认不出`);
      return null;
    }
    answers.push({
      ...n,
      option: a.option,
      answeredAt: a.answeredAt,
      answeredBy: a.answeredBy,
      ackedAt: a.ackedAt === null ? null : a.ackedAt,
    });
  }
  return answers;
}

function cloneBoard(doc: SeatBoardDoc): SeatBoardDoc {
  return {
    headline: doc.headline,
    steps: doc.steps.map((s) => ({ ...s, links: s.links.map((l) => ({ ...l })) })),
    log: doc.log.map((e) => ({ ...e })),
    needs: doc.needs.map((n) => ({ ...n, options: [...n.options] })),
    answers: doc.answers.map((a) => ({ ...a, options: [...a.options] })),
  };
}

function needShape(input: {
  id: string;
  question: string;
  options: string[];
  recommended: string;
  repo: string;
  issue: number;
}): string | null {
  return (
    idProblem(input.id, '编号') ??
    textProblem(input.question, '问题') ??
    (BOARD_REPO.test(input.repo) ? null : `仓「${input.repo}」要写成 owner/仓名`) ??
    (Number.isInteger(input.issue) && input.issue > 0 ? null : '单号要是正整数') ??
    (input.options.length >= 2 ? null : '至少要两个选项') ??
    (new Set(input.options).size === input.options.length && input.options.every((o) => o.trim() !== '')
      ? null
      : '选项有空的或重复的') ??
    (input.options.includes(input.recommended) ? null : `推荐的「${input.recommended}」不在选项里`)
  );
}

/**
 * 改一份板。now 是库的 now()（ISO）。不改入参。
 * 状态写错、选项不在列表里：reason = bad，原样不动。
 * 没有这一步、没有这一问：reason = missing。
 * 这一问已经拍过：reason = already。
 */
export function applyBoardWrite(doc: SeatBoardDoc, op: BoardWrite, now: string): BoardWriteResult {
  if (!isIso(now)) return { ok: false, reason: 'bad', why: `库的时钟（${now}）认不出` };
  const next = cloneBoard(doc);
  switch (op.kind) {
    case 'head': {
      const why = textProblem(op.text, '现状');
      if (why) return { ok: false, reason: 'bad', why };
      next.headline = op.text.trim();
      return { ok: true, doc: next };
    }
    case 'add': {
      const why = idProblem(op.id, '步骤编号') ?? textProblem(op.title, '标题');
      if (why) return { ok: false, reason: 'bad', why };
      if (!Number.isFinite(op.order)) return { ok: false, reason: 'bad', why: '序号不是数' };
      if (op.detail.trim() !== '' && textProblem(op.detail, '说明')) {
        return { ok: false, reason: 'bad', why: textProblem(op.detail, '说明') ?? '' };
      }
      if (next.steps.some((s) => s.id === op.id)) {
        return { ok: false, reason: 'bad', why: `已经有 ${op.id} 这一步` };
      }
      next.steps.push({
        id: op.id,
        order: op.order,
        title: op.title.trim(),
        status: 'waiting',
        detail: op.detail.trim(),
        updatedAt: now,
        links: [],
      });
      return { ok: true, doc: next };
    }
    case 'step': {
      if (!isStatus(op.status)) {
        return {
          ok: false,
          reason: 'bad',
          why: `状态「${op.status}」不行，只能是 ${BOARD_STEP_STATUSES.join('、')}`,
        };
      }
      const step = next.steps.find((s) => s.id === op.id);
      if (!step) return { ok: false, reason: 'missing', why: `没有 ${op.id} 这一步` };
      if (op.detail !== undefined && op.detail.trim() !== '' && textProblem(op.detail, '说明')) {
        return { ok: false, reason: 'bad', why: textProblem(op.detail, '说明') ?? '' };
      }
      step.status = op.status;
      if (op.detail !== undefined) step.detail = op.detail.trim();
      step.updatedAt = now;
      return { ok: true, doc: next };
    }
    case 'link': {
      if (!isStr(op.url) || !BOARD_URL.test(op.url)) {
        return { ok: false, reason: 'bad', why: '链接要是 http(s) 网址' };
      }
      const why = textProblem(op.label, '链接名字');
      if (why) return { ok: false, reason: 'bad', why };
      const step = next.steps.find((s) => s.id === op.id);
      if (!step) return { ok: false, reason: 'missing', why: `没有 ${op.id} 这一步` };
      step.links = [...step.links.filter((l) => l.url !== op.url), { label: op.label.trim(), url: op.url }];
      step.updatedAt = now;
      return { ok: true, doc: next };
    }
    case 'log': {
      const why = textProblem(op.text, '动态');
      if (why) return { ok: false, reason: 'bad', why };
      next.log = [{ at: now, text: op.text.trim() }, ...next.log].slice(0, BOARD_LOG_KEEP);
      return { ok: true, doc: next };
    }
    case 'need': {
      const options = op.options.map((o) => o.trim());
      const why = needShape({ ...op, question: op.question.trim(), options });
      if (why) return { ok: false, reason: 'bad', why };
      if (next.needs.some((n) => n.id === op.id) || next.answers.some((a) => a.id === op.id)) {
        return { ok: false, reason: 'bad', why: `已经有 ${op.id} 这一问` };
      }
      next.needs.push({
        id: op.id,
        question: op.question.trim(),
        options,
        recommended: op.recommended,
        repo: op.repo,
        issue: op.issue,
      });
      return { ok: true, doc: next };
    }
    case 'clear-needs':
      next.needs = [];
      return { ok: true, doc: next };
    case 'answer': {
      if (next.answers.some((a) => a.id === op.id)) {
        return { ok: false, reason: 'already', why: '这一问已经有人拍过了' };
      }
      const need = next.needs.find((n) => n.id === op.id);
      if (!need) return { ok: false, reason: 'missing', why: `没有 ${op.id} 这一问` };
      if (!need.options.includes(op.option)) {
        return { ok: false, reason: 'bad', why: `「${op.option}」不在选项里` };
      }
      if (op.by.trim() === '') return { ok: false, reason: 'bad', why: '没有记下是谁拍的' };
      next.needs = next.needs.filter((n) => n.id !== op.id);
      next.answers.push({
        ...need,
        options: [...need.options],
        option: op.option,
        answeredAt: now,
        answeredBy: op.by,
        ackedAt: null,
      });
      return { ok: true, doc: next };
    }
    case 'ack': {
      const answer = next.answers.find((a) => a.id === op.id);
      if (!answer) return { ok: false, reason: 'missing', why: `没有 ${op.id} 这条已拍的` };
      if (answer.ackedAt === null) answer.ackedAt = now;
      return { ok: true, doc: next };
    }
  }
}

/** 已拍、会话还没写进单子的。 */
export function pendingBoardAnswers(doc: SeatBoardDoc): BoardAnswer[] {
  return doc.answers.filter((a) => a.ackedAt === null);
}
