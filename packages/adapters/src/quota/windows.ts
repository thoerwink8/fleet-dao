// 窗口归类、上游状态字、模型组匹配。窗口集合不固定：认不出的归 other，原名留在 label，不丢。
import type { QuotaStatus, QuotaWindow } from '@fleet-dao/shared';
import type { ReadingWindowKind, ScopeMembership } from './types.ts';

export interface WindowClass {
  window: ReadingWindowKind;
  scope?: string;
}

/**
 * 按标签归类：`5h`、`7d`、`7d_<组>`（只扣这一组模型，组名 = 时长后面那段，与中转的约定一致）；其它形状一律 other。
 * 上游标了 modelScoped 而标签不是「时长_组名」的形状时，取最后一个下划线之后当组名，没有下划线就整个标签当组名——
 * 模型组窗口绝不能当成账号级，否则一个模型用满会把所有路由一起卡住。
 * 反过来，没标 modelScoped、也不是「时长_组名」的标签（例如 on_demand）按账号级收：宁可多卡，不漏卡。
 */
export function classifyLabel(label: string, modelScoped = false): WindowClass {
  const text = label.trim();
  const m = /^(\d+(?:\.\d+)?[hdw])(?:_(.+))?$/i.exec(text);
  const span = m?.[1]?.toLowerCase();
  let scope = m?.[2]?.toLowerCase();
  if (!scope && modelScoped) {
    const cut = text.lastIndexOf('_');
    scope = (cut > 0 ? text.slice(cut + 1) : text).toLowerCase();
  }
  const weekly = span === '7d' || span === '1w';
  if (scope) return { window: weekly ? '7d_model' : 'other', scope };
  if (span === '5h') return { window: '5h' };
  if (weekly) return { window: '7d' };
  return { window: 'other' };
}

const STATUS_WORDS: Record<string, QuotaStatus> = {
  allowed: 'allowed',
  normal: 'allowed',
  ok: 'allowed',
  warning: 'warning',
  allowed_warning: 'warning',
  // Claude 的 severity 还有 critical：服务端说「很紧」，但没说「已经不让用了」。
  critical: 'warning',
  limit_reached: 'limit_reached',
  rejected: 'limit_reached',
  exhausted: 'limit_reached',
};

/** 上游状态字 → 三态。认不出的只留原字，不归类，也不自己按百分比打分。 */
export function normalizeStatus(raw: unknown): { upstreamStatus?: QuotaStatus; statusRaw?: string } {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const word = raw.trim();
  const mapped = STATUS_WORDS[word.toLowerCase()];
  return mapped ? { upstreamStatus: mapped, statusRaw: word } : { statusRaw: word };
}

export interface ModelRef {
  id: string;
  family?: string;
}

/** 组名与模型 id 比较前统一大小写和分隔符：`claude_opus` 与 `claude-opus-5-5`、`opus-5.5` 与 `opus-5-5` 都算同一种写法。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_.]+/g, '-');
}

/**
 * 这个窗口扣不扣这个模型：账号级窗口（没有 scope）扣所有模型；
 * 模型组窗口只扣本组——有成员表按成员表，没有就看模型 id 是否含组名、或模型族是否等于组名。
 */
export function windowAppliesTo(
  window: Pick<QuotaWindow, 'scope'>,
  model: ModelRef,
  scopeModels?: Record<string, ScopeMembership>,
): boolean {
  if (!window.scope) return true;
  const scope = norm(window.scope);
  const id = norm(model.id);
  const membership = scopeModels?.[window.scope];
  if (membership) {
    if ('in' in membership) return membership.in.some((m) => norm(m) === id);
    return !membership.notIn.some((m) => norm(m) === id);
  }
  return (model.family !== undefined && norm(model.family) === scope) || id.includes(scope);
}

/** 一个模型在这组读数里要看的窗口：账号级的全要，模型组的只要本组。 */
export function windowsForModel<W extends Pick<QuotaWindow, 'scope'>>(
  windows: readonly W[],
  model: ModelRef,
  scopeModels?: Record<string, ScopeMembership>,
): W[] {
  return windows.filter((w) => windowAppliesTo(w, model, scopeModels));
}
