// 一个额度窗扣不扣某条路由：读额度的（adapters）、选路由的（db 的候选路由、引擎）都用这一份，免得两边判法不一样。
import type { QuotaWindow, ScopeMembership } from './domain.ts';

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
