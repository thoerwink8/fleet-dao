// 拼车「用不了」是哪一种、拼车「恢复了」凭什么认（#194，specs/194-拼车自动切换/方案-v2.md 4.2、4.4、第六节）。纯判法，
// 还没接线：切号（jobs/org-switch.ts）照旧只认「窗口用满」，接到切号上是后面的切片。
//
// 改这里之前必须知道：
// - 判「用满」以真请求被拒为准，判「恢复」以「被拒之后的新读数」为准（创始人 2026-10-04 06:45「8按照你推荐」）；
//   拼车 5 小时窗到点是一下子归零还是一笔笔退回来没人说清，所以这里不按清零时刻推算，只认读数。
// - 读不到、认不出、对不上一律明确失败（unknown / not-yet 带原因），不当成「拼车能用」、不当成到点了、不当成 0 或满。
// - 本人被拒就是用到头了，不管车上几个人（创始人 2026-10-04 06:08：80 刀 / 5 小时是防一人多用的额外闸）。
import { RL1_TEXT } from '../failure/rules.ts';
import { waitFromText } from '../failure/scan.ts';
import type { ApiOrgAccount } from './org-accounts.ts';

/**
 * 拼车用不了的三种（方案 4.2）：
 * E1 本人 5 小时额度用满（接口 used ≥ quota，或被拒原文是 reclaude 拼车那句）；
 * E2 整辆车的官方窗口被用光（被拒原文是官方那句，接口却说本人还有余额，或接口读不到分不清）；
 * E3 拼车组织本身用不了（没有拼车组织、没分到 Claude 账号、到期；或被拒原文是这一类）。
 */
export type CarpoolOutageKind = 'E1' | 'E2' | 'E3';

export const OUTAGE_NAMES: Readonly<Record<CarpoolOutageKind, string>> = {
  E1: '拼车本人 5 小时额度用满',
  E2: '拼车整辆车的官方窗口被用光',
  E3: '拼车组织本身用不了',
};

/** 拼车组织的状况（GET /api/v1/orgs 读出来的）：unknown = 组织接口没读成或认不出。 */
export type CarpoolOrgState = 'ok' | 'none' | 'no-account' | 'expired' | 'unknown';

const ORG_TEXT: Readonly<Record<Exclude<CarpoolOrgState, 'ok'>, string>> = {
  none: '账号下没有拼车组织',
  'no-account': '拼车组织没分到 Claude 账号',
  expired: '拼车组织已到期',
  unknown: '拼车组织的状况没读成',
};

/** 拼车本人那一层（GET /api/v1/carpool/quota）。 */
export interface CarpoolQuota {
  usedUsd: number;
  limitUsd: number;
  resetsAt: Date | null;
  /** 上游原字（status / state）；没给为 null。只有 active 算正常。 */
  status: string | null;
}

/**
 * 读一次开放接口（账号级，挂着独享也读得到拼车）。接线时由 real/ 从 adapters 的 reclaude 读取器填。
 * quota 为 null = 上游说这个成员没设上限（enabled: false）。
 */
export type CarpoolApiRead =
  | {
      ok: true;
      /** 我们发请求的时刻（本机钟）。 */
      requestedAt: Date;
      /** 回包头 Date（服务端钟）；没给为 null。 */
      serverDate: Date | null;
      /** 回包头 Age（秒）：有就说明是缓存；没给为 null。 */
      ageSeconds: number | null;
      quota: CarpoolQuota | null;
      org: CarpoolOrgState;
      /** 接口里每个组织（账号）的事实：账号数量不固定，切号前逐个查状态用（jobs/org-accounts.ts）。读法没给就没有。 */
      accounts?: readonly ApiOrgAccount[];
    }
  | {
      ok: false;
      requestedAt: Date;
      /** network 网断超时；http 5xx 等；auth Key 失效（401）；bad_response 回包认不出；throttled 接口自己限流（429）。 */
      code: 'network' | 'http' | 'auth' | 'bad_response' | 'throttled';
      why: string;
    };

/** 一次拼车会话（或探针）被拒的证据：插头交来的结构化码、HTTP 状态、原文。 */
export interface CarpoolRejection {
  at: Date;
  code?: string;
  httpStatus?: number;
  /** 上游在被拒那一帧里给的清零时刻（Claude 流里的额度读数）；原文里没写「约 N 分钟」时拿它当恢复时刻。 */
  resetsAt?: Date;
  text: string;
}

/** 一次「拼车用不了」：切去独享那一刻落库的「拼车恢复条件」就是它（方案 4.4）。 */
export interface CarpoolOutage {
  kind: CarpoolOutageKind;
  /** 认定的时刻（被拒那一刻，或读到接口说用不了的那一刻）。判恢复只认这之后的读数。 */
  since: Date;
  /** 预计几点恢复；不知道为 null（E3 一律 null）。 */
  resetsAt: Date | null;
  /** 恢复时刻从哪来：api 接口的 resets_at_ms（准）；text 被拒原文的「约 N 分钟后」；null 不知道。 */
  resetsFrom: 'api' | 'text' | null;
  /** 给人看、进操作记录：凭什么认的。 */
  evidence: string;
  /** 接口读数和被拒对不上（接口说本人有余额、请求却被拒）：照被拒办，另记一笔（方案第六节第 4 条）。 */
  mismatch?: string;
}

/** 被拒的分流结果：只有 outage 切号；device、throttle 不切（切了也没用 / 不是额度用满）；other 交给失败分流。 */
export type RejectionVerdict =
  | { kind: 'outage'; outage: CarpoolOutage }
  | { kind: 'device'; why: string }
  | { kind: 'throttle'; why: string }
  | { kind: 'other'; why: string };

// 设备级（方案 4.2「不切号的」）：两个组织在同一台设备上，切了也没用。原文出处：401 device_revoked、
// 403 x-claude-code-session-id missing（CLI 版本低）是 reclaude 文档「排查问题」；「此设备已被解绑」是旧系统生产记录（DV1）。
const DEVICE_TEXT = /此设备已被解绑|device[_ ]revoked|x-claude-code-session-id/i;
const DEVICE_CODES = new Set(['device_revoked']);
// reclaude 拼车本人那一层的原文（夹具 X03：「拼车 5 小时额度已用完，约 20 分钟后重置」）。
const CARPOOL_TEXT = /拼车[^，。,.]*额度(?:已)?用(?:完|尽|满)|carpool[^.]*(?:quota|limit)/i;
// 拼车组织用不了：reclaude 文档「排查问题」「订阅」原文（所选组织没有可用的绑定账号、订阅过期）。
const ORG_TEXT_RE = /没有可用的绑定账号|订阅(?:已)?过期|subscription (?:has )?expired/i;
// 官方窗口用满（和 QT1 同一个认法，否定句「not your usage limit」不认）。
const OFFICIAL_TEXT =
  /(?<!\bnot (?:your |a |the )?)usage limit|额度已用完|额度用完|额度用尽|quota (?:is )?exhausted|weekly limit|周限|\b5[- ]?hour limit/i;
const QUOTA_CODES = new Set([
  'quota_exhausted',
  'usage_limit_reached',
  'usage_limit_exceeded',
  'rate_limit_rejected',
]);
const OVERLOAD_TEXT = /overloaded|at capacity|繁忙|容量已满/i;

const EPSILON = 1e-9;

/** 接口这一次读成了、本人额度到顶了没有；读不成、没设上限、金额认不出为 null（不知道）。 */
function quotaFull(read: CarpoolApiRead | null): boolean | null {
  if (!read?.ok || !read.quota) return null;
  const q = read.quota;
  if (!Number.isFinite(q.usedUsd) || !Number.isFinite(q.limitUsd) || !(q.limitUsd > 0)) return null;
  return q.usedUsd + EPSILON >= q.limitUsd;
}

function usd(q: CarpoolQuota): string {
  return `$${q.usedUsd.toFixed(2)}/$${q.limitUsd.toFixed(2)}`;
}

/**
 * 一次拼车被拒是哪一种（方案 4.2、第六节第 4、7、8 条）。api 是最近一次读开放接口的结果（没读过给 null）：
 * 只用来分 E1 / E2、拿准一点的恢复时刻；被拒是真证据，接口说有余额也照切（记 mismatch）。
 */
export function classifyCarpoolRejection(
  rej: CarpoolRejection,
  api: CarpoolApiRead | null,
): RejectionVerdict {
  const code = rej.code?.trim().toLowerCase();
  const text = rej.text;
  if ((code && DEVICE_CODES.has(code)) || DEVICE_TEXT.test(text)) {
    return {
      kind: 'device',
      why: '设备级的问题（设备被撤、CLI 版本低）：切号也没用，整池暂停、要人重新登录',
    };
  }
  const waitSec = waitFromText(text, rej.at.getTime());
  const fromText =
    waitSec !== undefined
      ? new Date(rej.at.getTime() + waitSec * 1000)
      : rej.resetsAt && rej.resetsAt.getTime() > rej.at.getTime()
        ? rej.resetsAt
        : null;
  const full = quotaFull(api);
  const apiQuota = api?.ok ? api.quota : null;
  const apiResets = full === true && apiQuota?.resetsAt ? apiQuota.resetsAt : null;

  if (CARPOOL_TEXT.test(text)) {
    const outage: CarpoolOutage = {
      kind: 'E1',
      since: rej.at,
      resetsAt: apiResets ?? fromText,
      resetsFrom: apiResets ? 'api' : fromText ? 'text' : null,
      evidence: `被拒原文是拼车本人额度那句：${excerpt(text)}`,
    };
    if (full === false && apiQuota) {
      outage.mismatch = `接口说本人额度 ${usd(apiQuota)} 没用满，请求却被拒：照被拒办`;
    }
    return { kind: 'outage', outage };
  }
  if (ORG_TEXT_RE.test(text)) {
    return {
      kind: 'outage',
      outage: {
        kind: 'E3',
        since: rej.at,
        resetsAt: null,
        resetsFrom: null,
        evidence: `被拒原文说拼车组织用不了：${excerpt(text)}`,
      },
    };
  }
  if ((code && QUOTA_CODES.has(code)) || OFFICIAL_TEXT.test(text)) {
    if (full === true && apiQuota) {
      return {
        kind: 'outage',
        outage: {
          kind: 'E1',
          since: rej.at,
          resetsAt: apiResets ?? fromText,
          resetsFrom: apiResets ? 'api' : fromText ? 'text' : null,
          evidence: `被拒说额度用满，接口也说本人额度 ${usd(apiQuota)} 到顶：${excerpt(text)}`,
        },
      };
    }
    const outage: CarpoolOutage = {
      kind: 'E2',
      since: rej.at,
      resetsAt: fromText,
      resetsFrom: fromText ? 'text' : null,
      evidence:
        full === false && apiQuota
          ? `被拒原文是官方窗口用满，接口说本人额度 ${usd(apiQuota)} 还有余额：整辆车被用光`
          : `被拒原文是官方窗口用满，接口没读成、分不清本人满还是整车满，按整辆车被用光判恢复：${excerpt(text)}`,
    };
    if (full === false && apiQuota) {
      outage.mismatch = `接口说本人额度 ${usd(apiQuota)} 没用满，请求却被拒：照被拒办`;
    }
    return { kind: 'outage', outage };
  }
  if (
    RL1_TEXT.test(text) ||
    OVERLOAD_TEXT.test(text) ||
    rej.httpStatus === 429 ||
    rej.httpStatus === 529 ||
    code === 'rate_limited' ||
    code === 'overloaded' ||
    code === 'overloaded_error'
  ) {
    return { kind: 'throttle', why: '按分钟限流或过载，几十秒就好：短等，不切号、不记用满' };
  }
  return { kind: 'other', why: `不是拼车额度、组织的问题，交给失败分流：${excerpt(text)}` };
}

/**
 * 只看接口读数认「拼车用不了」（探针那一轮、接口提密读时用；方案 4.2 的 E1、E3）。读不成、读数说正常为 null：
 * 「读不成」不是用不了的证据——挂着拼车照用，靠真请求被拒兜底（方案第六节第 1 条）。
 */
export function outageFromApi(read: CarpoolApiRead): CarpoolOutage | null {
  if (!read.ok) return null;
  if (read.org === 'none' || read.org === 'no-account' || read.org === 'expired') {
    return {
      kind: 'E3',
      since: read.requestedAt,
      resetsAt: null,
      resetsFrom: null,
      evidence: `接口说${ORG_TEXT[read.org]}`,
    };
  }
  if (quotaFull(read) === true && read.quota) {
    const q = read.quota;
    return {
      kind: 'E1',
      since: read.requestedAt,
      resetsAt: q.resetsAt,
      resetsFrom: q.resetsAt ? 'api' : null,
      evidence: `接口说本人额度 ${usd(q)} 到顶`,
    };
  }
  return null;
}

/** 判恢复的参数（方案 4.4、4.6）。 */
export interface RecoveryPolicy {
  /** 切回线（迟滞）：E1 本人额度剩余不少于这个比例才算恢复。 */
  switchBackRemaining: number;
  /** 回包头 Age 超过这么多秒算缓存，不算一次新读数。 */
  maxAgeSeconds: number;
  /** E1 要连着两次新读数，两次至少隔这么久（毫秒）。 */
  confirmGapMs: number;
}

export const DEFAULT_RECOVERY_POLICY: Readonly<RecoveryPolicy> = Object.freeze({
  switchBackRemaining: 0.5,
  maxAgeSeconds: 60,
  confirmGapMs: 60_000,
});

type OkRead = Extract<CarpoolApiRead, { ok: true }>;

/** 一次读数的时刻：有服务端 Date 用它，没有用我们发请求的时刻。 */
function readTime(r: OkRead): number {
  return (r.serverDate ?? r.requestedAt).getTime();
}

/**
 * 从一串读数里挑出「被拒之后的真新读数」（方案 4.4、第六节第 18 条）：读成了、发请求在 since 之后、不是缓存
 * （Age 不超过上限）、服务端 Date 比上一条算数的新（两次回同一份不算两次）。reads 按发请求的时刻排好或没排都行。
 */
export function freshReads(
  reads: readonly CarpoolApiRead[],
  since: Date,
  policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
): OkRead[] {
  const sorted = reads
    .filter((r): r is OkRead => r.ok)
    .filter((r) => r.requestedAt.getTime() > since.getTime())
    .filter((r) => r.ageSeconds === null || r.ageSeconds <= policy.maxAgeSeconds)
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  const out: OkRead[] = [];
  for (const r of sorted) {
    const prev = out.at(-1);
    if (prev?.serverDate && r.serverDate && r.serverDate.getTime() <= prev.serverDate.getTime()) continue;
    out.push(r);
  }
  return out;
}

/** 这次读数说接口这边一切正常：status 是 active、拼车组织能用。 */
function apiHealthy(r: OkRead): string | null {
  if (r.org !== 'ok') return ORG_TEXT[r.org];
  if (!r.quota) return '接口说这个成员没设上限，认不出额度';
  const s = r.quota.status?.trim().toLowerCase();
  if (s !== 'active') return `本人额度的状态是 ${r.quota.status ?? '（没给）'}，不是 active`;
  return null;
}

function remainingOf(q: CarpoolQuota): number | null {
  if (!Number.isFinite(q.usedUsd) || !Number.isFinite(q.limitUsd) || !(q.limitUsd > 0)) return null;
  return 1 - q.usedUsd / q.limitUsd;
}

/**
 * 判恢复的结论：recovered 有正面证据；not-yet 读到了、还没恢复（at = 预计几点，不知道为 null）；
 * unknown 被拒之后一次新读数都没有（接口读不成、全是缓存）：要不要试探切回由防抖那一层定，这里不猜。
 */
export type RecoveryVerdict =
  | { state: 'recovered'; why: string }
  | { state: 'not-yet'; why: string; at: Date | null }
  | { state: 'unknown'; why: string };

/**
 * 拼车恢复了没有（方案 4.4、第六节第 2、5、6、14、16、18 条），只认 outage.since 之后的真新读数：
 * - E1：连着两次新读数（隔至少 confirmGapMs）都过切回线、状态 active、组织正常——不管是到点归零还是一笔笔退回来的；
 * - E2：恢复时刻已过，且有一次「那个时刻之后」的新读数说接口正常、本人没满（本机钟到点不算数）；恢复时刻不知道就是
 *   unknown（交给防抖那一层按退避试探，方案第六节第 5 条）；
 * - E3：有一次新读数说拼车组织又能用了（不管旧读数的清零时刻过没过），本人额度也没满。
 * 最小停留、白切退避、切回预算不在这里（防抖那一层）。
 */
export function judgeCarpoolRecovery(
  outage: CarpoolOutage,
  reads: readonly CarpoolApiRead[],
  policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
): RecoveryVerdict {
  const fresh = freshReads(reads, outage.since, policy);
  const failed = reads.filter((r) => !r.ok && r.requestedAt.getTime() > outage.since.getTime());
  if (fresh.length === 0) {
    const last = failed.at(-1);
    return {
      state: 'unknown',
      why:
        last && !last.ok
          ? `${OUTAGE_NAMES[outage.kind]}之后接口没读成过（最近一次：${last.why}）`
          : `${OUTAGE_NAMES[outage.kind]}之后还没有一次新读数（读数是缓存、或还没读）`,
    };
  }
  const latest = fresh.at(-1) as OkRead;
  const sick = apiHealthy(latest);
  const at = latestResets(latest) ?? outage.resetsAt;
  if (outage.kind === 'E3') {
    if (sick) return { state: 'not-yet', why: `接口还说${sick}`, at: null };
    if (quotaFull(latest) === true) {
      return { state: 'not-yet', why: '拼车组织能用了，可本人额度到顶', at: latestResets(latest) };
    }
    return { state: 'recovered', why: '接口说拼车组织又能用了' };
  }
  if (outage.kind === 'E2') {
    if (!outage.resetsAt) {
      return { state: 'unknown', why: '整辆车被用光，几点恢复不知道：按退避试探切回' };
    }
    const after = fresh.filter((r) => readTime(r) >= (outage.resetsAt as Date).getTime());
    const probe = after.at(-1);
    if (!probe) {
      return { state: 'not-yet', why: '还没有恢复时刻之后的新读数（本机钟到点不算数）', at: outage.resetsAt };
    }
    const bad = apiHealthy(probe);
    if (bad) return { state: 'not-yet', why: `恢复时刻过了，接口却说${bad}`, at: null };
    if (quotaFull(probe) !== false) {
      return {
        state: 'not-yet',
        why: '恢复时刻过了，接口说本人额度到顶（或认不出）',
        at: latestResets(probe),
      };
    }
    return {
      state: 'recovered',
      why: '整辆车的恢复时刻已过，之后的新读数说接口正常、本人没满（切回后由真请求验证）',
    };
  }
  // E1
  const passes = (r: OkRead): boolean => {
    if (apiHealthy(r) !== null || !r.quota) return false;
    const left = remainingOf(r.quota);
    return left !== null && left + EPSILON >= policy.switchBackRemaining;
  };
  if (sick) return { state: 'not-yet', why: `接口说${sick}`, at };
  const latestLeft = latest.quota ? remainingOf(latest.quota) : null;
  if (latestLeft === null) return { state: 'not-yet', why: '本人额度的金额认不出', at };
  if (latestLeft + EPSILON < policy.switchBackRemaining) {
    return {
      state: 'not-yet',
      why: `本人额度只剩 ${Math.round(latestLeft * 100)}%，不到切回线 ${Math.round(policy.switchBackRemaining * 100)}%`,
      at,
    };
  }
  // 最新一条过线：往前连着都过线的那几条里，找一条隔得够远的（中间有一条没过线就断了，不算「连着」）
  let confirmed = false;
  for (let i = fresh.length - 2; i >= 0; i--) {
    const r = fresh[i] as OkRead;
    if (!passes(r)) break;
    if (readTime(latest) - readTime(r) >= policy.confirmGapMs) {
      confirmed = true;
      break;
    }
  }
  if (!confirmed) {
    return { state: 'not-yet', why: '只有一次新读数过了切回线，等隔一分钟的第二次确认', at: null };
  }
  return {
    state: 'recovered',
    why: `连着两次新读数本人额度都剩 ${Math.round(policy.switchBackRemaining * 100)}% 以上（最新 ${usd(latest.quota as CarpoolQuota)}）`,
  };
}

function latestResets(r: OkRead): Date | null {
  return r.quota?.resetsAt ?? null;
}

function excerpt(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
