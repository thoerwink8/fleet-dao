// 一个额度窗扣不扣某条路由：读额度的（adapters）、选路由的（db 的候选路由、引擎）都用这一份，免得两边判法不一样。
// 一个额度窗的消耗进度（按时间该用多少、实际用了多少）：选路排同一模型的几个渠道、额度页每格那一行都用这一份（#2363）。
import type { QuotaWindow, QuotaWindowKind, ScopeMembership } from './domain.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 推不出窗口长度时按这么长算（并标「估算」）：Cursor 的桶、按账期的窗多是一个月。 */
export const PACE_FALLBACK_SPAN_MS = 30 * DAY;

/**
 * 窗口有多长：先看种类（5h、7d、7d_model、按月 / 按账期按 30 天），种类是 other 的再看标签开头的「数字 + h/d/w」
 * （Mirasim 的 30d、中转的 5h_x）；都推不出按 30 天，estimated = true。
 */
export function quotaWindowSpan(w: { window: QuotaWindowKind; label?: string | null }): {
  ms: number;
  estimated: boolean;
} {
  switch (w.window) {
    case '5h':
      return { ms: 5 * HOUR, estimated: false };
    case '7d':
    case '7d_model':
      return { ms: 7 * DAY, estimated: false };
    case 'month_usd':
    case 'period_usd':
      return { ms: 30 * DAY, estimated: false };
    default: {
      const m = /^(\d+(?:\.\d+)?)([hdw])(?:_|$)/i.exec((w.label ?? '').trim());
      const n = m ? Number(m[1]) : Number.NaN;
      const unit = m?.[2]?.toLowerCase();
      if (Number.isFinite(n) && n > 0 && unit) {
        const per = unit === 'h' ? HOUR : unit === 'd' ? DAY : 7 * DAY;
        return { ms: n * per, estimated: false };
      }
      return { ms: PACE_FALLBACK_SPAN_MS, estimated: true };
    }
  }
}

export interface QuotaPace {
  /** 窗口已过的比例（0–1）：按时间该用到这么多。 */
  elapsed: number;
  /** 已用比例（原样，超额可以大于 1）。 */
  used: number;
  /** 落后量 = 已过比例 − 已用比例：正 = 用得比时间慢（清零时会剩下作废），负 = 用得比时间快。 */
  behind: number;
  /** 窗口长度（毫秒）。 */
  spanMs: number;
  /** 窗口长度是推不出、按 30 天估的。 */
  estimated: boolean;
}

/**
 * 消耗进度：输入窗口的已用比例、清零时刻、种类和标签（取窗口长度）。已用或清零时刻缺、认不出、清零时刻已过：算不出，返回 null
 * （不拿 0 顶）。离清零比窗口长度还远（估的长度偏短）时已过比例记 0。
 */
export function quotaPace(
  w: {
    window: QuotaWindowKind;
    label?: string | null;
    used: number | null | undefined;
    resetsAt: string | null | undefined;
  },
  now: number,
): QuotaPace | null {
  if (w.used === null || w.used === undefined || !Number.isFinite(w.used)) return null;
  if (!w.resetsAt) return null;
  const resetAt = Date.parse(w.resetsAt);
  if (!Number.isFinite(resetAt) || resetAt <= now) return null;
  const span = quotaWindowSpan(w);
  const elapsed = Math.min(1, Math.max(0, 1 - (resetAt - now) / span.ms));
  return { elapsed, used: w.used, behind: elapsed - w.used, spanMs: span.ms, estimated: span.estimated };
}

export interface ModelRef {
  /** 模型目录里的 id，例如 opus-5.5。 */
  id: string;
  family?: string;
  /** 这条路由在上游的名字：插头实际发的模型串，加上别名（Route.upstreamModel / upstreamAliases）。 */
  upstreamNames?: readonly string[];
}

/** yes = 扣；no = 不扣；unknown = 判不了（池给了成员表，但不知道这条路由在上游叫什么），按额度未知算。 */
export type WindowApplies = 'yes' | 'no' | 'unknown';

/** 组名与模型名比较前统一大小写和分隔符：`claude_opus` 与 `claude-opus-5-5`、`opus-5.5` 与 `opus-5-5` 都算同一种写法。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_.]+/g, '-');
}

/**
 * 账号级窗口（没有 scope）扣所有模型。模型组窗口只扣本组：
 * - 池给了这个组的成员表（上游自己的叫法，例如 Cursor 的 autoBucketModels）：只和路由在上游的名字比，
 *   不拿模型目录的 id 硬凑；路由没填上游名字就判不了，返回 unknown，不默认落进「除了这些都扣」的桶。
 * - 没给成员表：看模型 id 是否含组名、或模型族是否等于组名（中转的 7d_claude、7d_fable）。
 */
export function windowAppliesTo(
  window: Pick<QuotaWindow, 'scope'>,
  model: ModelRef,
  scopeModels?: Record<string, ScopeMembership>,
): WindowApplies {
  if (!window.scope) return 'yes';
  const membership = scopeModels?.[window.scope];
  if (membership) {
    // 空名单的 in = 谁都不扣（只显示的窗口，例如 Cursor 有桶读数时的账期美元），不必知道路由的上游名字。
    if ('in' in membership && membership.in.length === 0) return 'no';
    const names = (model.upstreamNames ?? []).filter((n) => n !== '').map(norm);
    if (names.length === 0) return 'unknown';
    const listed = (m: string) => names.includes(norm(m));
    if ('in' in membership) return membership.in.some(listed) ? 'yes' : 'no';
    return membership.notIn.some(listed) ? 'no' : 'yes';
  }
  const scope = norm(window.scope);
  const matched =
    (model.family !== undefined && norm(model.family) === scope) || norm(model.id).includes(scope);
  return matched ? 'yes' : 'no';
}
