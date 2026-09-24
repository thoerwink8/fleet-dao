// 一个额度窗扣不扣某个模型：读额度的（adapters）、选路由的（db 的候选路由、引擎）都用这一份，免得两边判法不一样。
import type { QuotaWindow, ScopeMembership } from './domain.ts';

export interface ModelRef {
  id: string;
  family?: string;
}

/** 组名与模型 id 比较前统一大小写和分隔符：`claude_opus` 与 `claude-opus-5-5`、`opus-5.5` 与 `opus-5-5` 都算同一种写法。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_.]+/g, '-');
}

/**
 * 账号级窗口（没有 scope）扣所有模型；模型组窗口只扣本组——
 * 有成员表（pool.scopeModels）按成员表，没有就看模型 id 是否含组名、或模型族是否等于组名。
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
