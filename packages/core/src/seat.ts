// 帅位只一个（#299，specs/299-帅位只一个/方案.md）：帅位租约和每张单的认领怎么判。读写库、调 ssh 是外壳的事，这里只判。
// 改这里之前必须知道：
// - 时间一律用库的 now()：外壳读库时把库的「现在」一起取回来交给这里，不拿各机器的时钟判过期（钟差、休眠都会骗人）。
// - 任期号就是栅栏号：接班一次加一，受保护动作带着任期号来，库里对不上当场拒。过期只说明联系不上，没有别人接班时
//   同一个持有人续约照样续得上；现查、受保护动作按过期算「不是帅位」（fail closed），续约成了再动手。
// - 读不到、认不出一律算「不是帅位」，不算「没事」。

/** 真帅位的座位；演练用 `drill:<名字>`，和它互不影响。 */
export const MAIN_SEAT = 'main';

/** 租期、认领宽限期的默认值：`settings` 表的 `seat.leaseMinutes`、`seat.claimGraceMinutes` 没写时用（改那两项生效，不用发版）。 */
export const SEAT_DEFAULTS: SeatSettings = { leaseMinutes: 45, claimGraceMinutes: 120 };

/** settings 表里的两项（键就是 SEAT_SETTING_KEYS 那两个）。 */
export const SEAT_SETTING_KEYS = {
  leaseMinutes: 'seat.leaseMinutes',
  claimGraceMinutes: 'seat.claimGraceMinutes',
} as const;

export interface SeatSettings {
  /** 帅位多久没续约算过期（分钟）。帅位每 15 分钟续一次。 */
  leaseMinutes: number;
  /** 本机的认领多久没心跳就作废（分钟），默认两小时；认领时可以单独给（演练调短）。 */
  claimGraceMinutes: number;
}

const MAX_MINUTES = 7 * 24 * 60;

export type SeatSettingsRead =
  | { ok: true; settings: SeatSettings; source: 'settings' | 'default' }
  | { ok: false; why: string };

/** settings 表里那两项的原值（没写是 undefined）：没写的用默认（写明用的默认）；写了却认不出就明确失败，不拿默认顶。 */
export function readSeatSettings(raw: {
  leaseMinutes?: unknown;
  claimGraceMinutes?: unknown;
}): SeatSettingsRead {
  const pick = (key: keyof SeatSettings): number | string => {
    const x = raw[key];
    if (x === undefined) return SEAT_DEFAULTS[key];
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > MAX_MINUTES)
      return `设置 ${SEAT_SETTING_KEYS[key]} 要是 1 到 ${MAX_MINUTES} 之间的整数（分钟），现在是 ${JSON.stringify(x)}`;
    return x;
  };
  const lease = pick('leaseMinutes');
  const grace = pick('claimGraceMinutes');
  if (typeof lease === 'string') return { ok: false, why: lease };
  if (typeof grace === 'string') return { ok: false, why: grace };
  const source =
    raw.leaseMinutes === undefined && raw.claimGraceMinutes === undefined ? 'default' : 'settings';
  return { ok: true, settings: { leaseMinutes: lease, claimGraceMinutes: grace }, source };
}

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

// —— 帅位租约 ——

export interface SeatLease {
  scope: string;
  /** 第几任：接班一次加一，只增不减。 */
  term: number;
  holderMachine: string;
  holderSession: string;
  acquiredAt: string;
  renewedAt: string;
  previousMachine: string | null;
  previousSession: string | null;
  /** 最新一份交接说明（只算补充，交接以现算的为准）。 */
  handoff: string | null;
  handoffAt: string | null;
}

export interface SeatClaimant {
  machine: string;
  session: string;
  term: number;
}

export type SeatVerdict =
  | { ok: true; term: number; expiresAt: string }
  | { ok: false; reason: 'vacant' | 'replaced' | 'expired' | 'unreadable'; why: string };

export const holderText = (lease: Pick<SeatLease, 'holderMachine' | 'holderSession'>) =>
  `${lease.holderMachine}/${lease.holderSession}`;

export function seatExpiresAt(lease: Pick<SeatLease, 'renewedAt'>, leaseMinutes: number): string | null {
  const at = Date.parse(lease.renewedAt);
  return Number.isFinite(at) ? new Date(at + leaseMinutes * 60_000).toISOString() : null;
}

function minutesText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

/**
 * 这个会话此刻还是不是帅位（现查、受保护动作前都照这个判）。dbNow 是库的 now()。
 * - 座位上没人：vacant；
 * - 任期、持有人对不上：replaced，写明现在是谁、第几任（旧帅位据此说「帅位已交给 X」）；
 * - 对得上、但过了租期没续上：expired（fail closed：先续约再动手）；
 * - 时刻认不出：unreadable，同样不算帅位。
 */
export function seatVerdict(
  lease: SeatLease | null,
  me: SeatClaimant,
  dbNow: string,
  leaseMinutes: number,
): SeatVerdict {
  if (lease === null) return { ok: false, reason: 'vacant', why: '座位上没人：还没有谁接过班' };
  if (lease.term !== me.term || lease.holderMachine !== me.machine || lease.holderSession !== me.session) {
    return {
      ok: false,
      reason: 'replaced',
      why: `帅位已经是 ${holderText(lease)}（第 ${lease.term} 任），不是 ${me.machine}/${me.session}（第 ${me.term} 任）`,
    };
  }
  const expiresAt = seatExpiresAt(lease, leaseMinutes);
  const now = Date.parse(dbNow);
  if (expiresAt === null || !Number.isFinite(now)) {
    return {
      ok: false,
      reason: 'unreadable',
      why: `没查成：续约时刻（${lease.renewedAt}）或库的时钟（${dbNow}）认不出，按不是帅位算`,
    };
  }
  if (now >= Date.parse(expiresAt)) {
    return {
      ok: false,
      reason: 'expired',
      why: `租约过期了：上次续约是 ${minutesText(now - Date.parse(lease.renewedAt))}前（租期 ${leaseMinutes} 分钟）；续约成了再动手`,
    };
  }
  return { ok: true, term: lease.term, expiresAt };
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
 * 本机的认领过了宽限期没心跳：该作废（dbNow 是库的 now()）。引擎的认领不按心跳作废：它的死活归工作流和停滞检测管。
 * 心跳时刻认不出也不作废（不拿认不出当过期，作废是要撤自动合并的）：由调用方报出来。
 */
export function claimExpired(c: IssueClaim, dbNow: string): boolean {
  if (c.ownerKind === 'engine' || !isActiveClaim(c.state)) return false;
  const beat = Date.parse(c.heartbeatAt);
  const now = Date.parse(dbNow);
  if (!Number.isFinite(beat) || !Number.isFinite(now)) return false;
  return now - beat > c.graceMinutes * 60_000;
}

/** 给人看的一行：谁、什么状态、上次心跳多久以前、PR、最近一句进度。 */
export function describeClaim(c: IssueClaim, dbNow: string): string {
  const now = Date.parse(dbNow);
  const beat = Date.parse(c.heartbeatAt);
  const ago =
    Number.isFinite(now) && Number.isFinite(beat) ? `${minutesText(now - beat)}前` : '不知道多久以前';
  const prs = c.prNumbers.length > 0 ? `，PR ${c.prNumbers.map((n) => `#${n}`).join('、')}` : '';
  const note = c.note ? `：${c.note}` : '';
  const ended = isActiveClaim(c.state) ? '' : `（${c.endReason ?? '没写原因'}）`;
  const late = claimExpired(c, dbNow) ? '，过了宽限期没心跳，下一轮作废' : '';
  return `${claimOwnerText(c)} ${claimStateText(c.state)}${ended}${note}（认领 ${c.claimId.slice(0, 8)}，上次心跳 ${ago}${prs}${late}）`;
}
