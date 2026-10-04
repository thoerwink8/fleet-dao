// 每个渠道（账号池）的额度留量线（#194 方案 v2 4.8）：引擎最多用到这里就停，剩下的留给自己用。纯判法，选路（engine 的
// routing/filter.ts）、切号（engine 的 jobs/org-decision.ts）、驾驶舱额度页（api 的 reserve-view.ts）、设置页读同一份，口径一个。
//
// 配置只存在库里的设置键 engine.quotaReserve（形状见 web-api.ts 的 QuotaReserveSettingSchema）：{池编号: {窗口: 比例 | null}}。
// 代码里不留任何具体数值的默认（创始人 2026-10-05：「独享留量线 5 小时窗 80%、周窗 70%，这个不应该写死，应该是驾驶舱可以配置的」）：
// 起始值写在种子文件 packages/db/quota-reserve.default.json，由装载器只补缺装进库（和路由骨架 routing.default.json 同一条链路），
// 之后全由驾驶舱设置页改。库里这个池没有线 = 明确「不限」（驾驶舱写「未配置」），不是悄悄套默认。
//
// 改这里之前必须知道：
// - 读不到、认不出一律明确失败，不当成「不限」：设置在库里根本没有（种子没装上）、整份认不出、某个池那一项认不出，都返回
//   ok:false 带原因，由调用方不派、不切并报出来；只有「设置读到了、认得出、这个池没写」才是不限；
// - 线是「已用比例到了这个数就停」（用了 70%、线 70% = 到线）；读数缺这个窗口、读数算不出已用多少，是「额度未知」，单独列出来，
//   照现有选路规矩照派，但调用方要把它写进原因里，不当成没事；
// - 读数旧了（stale）算数：旧读数已经超线、窗口还没清零，只会更高不会更低（滚动窗口例外，但那种清零时刻很近），不能把证据扔掉；
//   旧读数没超线、读不到、已经过了清零时刻（reset）都是额度未知。
import type { QuotaWindowKind } from './domain.ts';
import { PoolReserveLinesSchema, QuotaReserveSettingSchema } from './web-api.ts';

/** 设置表里留量线那一项的键（和 web-api 的 SETTING_SCHEMAS 里同名）。 */
export const QUOTA_RESERVE_SETTING = 'engine.quotaReserve';

/** 种子装载器写进设置行的 updatedBy：驾驶舱据此写「来自种子」；人在驾驶舱改过一次，这一栏就变成改的人。 */
export const QUOTA_RESERVE_SEED_ACTOR = 'seed:quota-reserve.default.json';

/** 一个池的线：窗口种类 → 已用比例（0–1）。没有的窗口 = 不限。 */
export type ReserveLines = Partial<Record<QuotaWindowKind, number>>;

export type PoolReserve = { ok: true; lines: ReserveLines } | { ok: false; why: string };

const issueText = (issue: { path: PropertyKey[]; message: string } | undefined): string =>
  issue ? `${issue.path.map(String).join('.') || '整份'}：${issue.message}` : '格式不对';

/** 设置在库里根本没有：种子没装进库（发布时 packages/db/src/bin/routing.ts 那一步没跑成），不是「不限」。 */
export const RESERVE_NOT_LOADED = `设置 ${QUOTA_RESERVE_SETTING} 在库里没有：额度留量线的种子没装进库（发布时 packages/db/src/bin/routing.ts 那一步没跑成？），不当成不限`;

/**
 * 一个池此刻的线。setting 是设置表里读到的原值：undefined = 库里没有这一行（种子没装上，明确失败）；别的值必须过
 * QuotaReserveSettingSchema，整份认不出（不是对象、被人直接改库）所有池都返回失败；只是这个池那一项认不出，只有这个池失败，
 * 别的池照常。读到了、认得出、这个池没写 = 不限（空线表）；写 null 的窗口也是不限。
 */
export function resolvePoolReserve(setting: unknown, pool: { poolId: string }): PoolReserve {
  if (setting === undefined) return { ok: false, why: RESERVE_NOT_LOADED };
  if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
    return {
      ok: false,
      why: `设置 ${QUOTA_RESERVE_SETTING} 的值不是 {池编号: {窗口: 比例}}：${JSON.stringify(setting)}`,
    };
  }
  const entry = (setting as Record<string, unknown>)[pool.poolId];
  if (entry === undefined) return { ok: true, lines: {} };
  const parsed = PoolReserveLinesSchema.safeParse(entry);
  if (!parsed.success) {
    return {
      ok: false,
      why: `设置 ${QUOTA_RESERVE_SETTING} 里 ${pool.poolId} 的留量线认不出（${issueText(parsed.error.issues[0])}）`,
    };
  }
  const lines: ReserveLines = {};
  for (const [kind, v] of Object.entries(parsed.data) as [QuotaWindowKind, number | null | undefined][]) {
    if (typeof v === 'number') lines[kind] = v;
  }
  return { ok: true, lines };
}

/** 整份设置认不认得出（设置页、检查用）：认得出回 null，认不出回原因；库里没有这一行（undefined）也是问题。 */
export function reserveSettingProblem(setting: unknown): string | null {
  if (setting === undefined) return RESERVE_NOT_LOADED;
  const parsed = QuotaReserveSettingSchema.safeParse(setting);
  return parsed.success ? null : `${QUOTA_RESERVE_SETTING}：${issueText(parsed.error.issues[0])}`;
}

/** 一个额度窗的读数（只取判留量线要的几项）。used 是已用比例，通常 0–1，超额可以大于 1；算不出为 null。 */
export interface ReserveReading {
  /** 上游原名（5h、7d、7d_claude……）。 */
  label: string;
  window: QuotaWindowKind;
  scope?: string | null | undefined;
  /** 和选路、额度表同一个判法（db 的 windowState）。 */
  state: 'ok' | 'exhausted' | 'stale' | 'reset';
  used: number | null;
  resetsAt: string | null;
}

export interface ReserveHit {
  label: string;
  window: QuotaWindowKind;
  scope: string | null;
  /** 到线那条读数的已用比例；窗口用满了但读数没给比例为 null。 */
  used: number | null;
  line: number;
  resetsAt: string | null;
}

export interface ReserveUnknown {
  window: QuotaWindowKind;
  line: number;
  why: string;
}

export interface ReserveVerdict {
  /** 到了线的读数（一个窗口种类下有几条读数到线就几条）。空 = 没有已知到线的。 */
  hits: ReserveHit[];
  /** 配了线、却判不了的窗口种类（读数里没有这个窗口、读数没给已用多少、已过清零时刻等新读数）。 */
  unknown: ReserveUnknown[];
}

/** 线配成了不合法的数（调用方没经过 resolvePoolReserve 直接给的）：程序错，抛出来，不当成不限。 */
export class ReserveInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReserveInputError';
  }
}

/** 比较容差：0.7 对 0.7 算到线，浮点误差不让它漏过去。 */
const EPSILON = 1e-9;

/** 已用比例：上游给了百分比（utilization）就用它，否则 used / limit；都算不出为 null。 */
export function usedRatioOf(w: {
  utilization?: number | null | undefined;
  used?: number | null | undefined;
  limit?: number | null | undefined;
}): number | null {
  if (typeof w.utilization === 'number') return w.utilization;
  if (typeof w.used === 'number' && typeof w.limit === 'number' && w.limit > 0) return w.used / w.limit;
  return null;
}

/** 这些读数对着这些线：哪些到线了、哪些判不了。线和读数的顺序不影响结果（unknown 按窗口种类的固定顺序）。 */
export function evaluateReserve(lines: ReserveLines, readings: readonly ReserveReading[]): ReserveVerdict {
  const hits: ReserveHit[] = [];
  const unknown: ReserveUnknown[] = [];
  for (const [kind, line] of Object.entries(lines) as [QuotaWindowKind, number | undefined][]) {
    if (line === undefined) continue;
    if (typeof line !== 'number' || !Number.isFinite(line) || line < 0 || line > 1) {
      throw new ReserveInputError(`留量线要 0 到 1 之间的数，${kind} 给的是 ${JSON.stringify(line)}`);
    }
    const mine = readings.filter((r) => r.window === kind);
    let known = false;
    let why = '读数里没有这个窗口';
    for (const r of mine) {
      if (r.state === 'exhausted') {
        // 用满了一定在任何 ≤ 1 的线之上，哪怕读数没给比例
        known = true;
        hits.push(hit(r, line));
        continue;
      }
      if (r.state === 'reset') {
        why = `${r.label} 已过清零时刻，等新读数`;
        continue;
      }
      if (r.used === null || !Number.isFinite(r.used) || r.used < 0) {
        why =
          r.used === null
            ? `${r.label} 读数没给已用多少`
            : `${r.label} 的已用比例认不出（${String(r.used)}）`;
        continue;
      }
      known = true;
      if (r.used + EPSILON >= line) hits.push(hit(r, line));
    }
    if (!known) unknown.push({ window: kind, line, why });
  }
  return { hits, unknown };
}

function hit(r: ReserveReading, line: number): ReserveHit {
  return {
    label: r.label,
    window: r.window,
    scope: r.scope ?? null,
    used: r.used !== null && Number.isFinite(r.used) ? r.used : null,
    line,
    resetsAt: r.resetsAt,
  };
}

/** 「周额度」「claude 周额度」「5 小时额度」「月额度（auto）」。（选路、驾驶舱说窗口都用这一份。） */
export function quotaWindowName(w: {
  window: QuotaWindowKind;
  scope?: string | null;
  label: string;
}): string {
  const scoped = (name: string) => (w.scope ? `${name}（${w.scope}）` : name);
  switch (w.window) {
    case '5h':
      return scoped('5 小时额度');
    case '7d':
      return scoped('周额度');
    case '7d_model':
      return `${w.scope ?? w.label} 周额度`;
    case 'month_usd':
      return scoped('月额度');
    case 'period_usd':
      return scoped('账期额度');
    case 'points':
      return scoped('点数额度');
    default:
      return `额度窗 ${w.label}`;
  }
}

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** 一条到线的读数，说成人话：「周额度用了 75%，到了留量线 70%」。 */
export function reserveHitText(h: ReserveHit): string {
  const name = quotaWindowName(h);
  return h.used === null
    ? `${name}已用满，到了留量线 ${pct(h.line)}`
    : `${name}用了 ${pct(h.used)}，到了留量线 ${pct(h.line)}`;
}

/** 判不了的窗口，说成人话。 */
export function reserveUnknownText(u: ReserveUnknown): string {
  return `${quotaWindowName({ window: u.window, label: u.window })}（线 ${pct(u.line)}）判不了：${u.why}`;
}
