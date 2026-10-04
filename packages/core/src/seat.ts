// 名字校验（原来还有认领账那一套：#299 的每张单一行认领、「认领对得上」，2026-10-03 起整张删掉，#556，
// 创始人回「选 1」）。读写库、调 ssh 是外壳的事，这里只判名字对不对。
// 改这里之前必须知道：
// - 读不到、认不出一律算「没查成」，不算「没事」。
// - 帅位座位（接班、租约、任期、交接、帅位栏）2026-10-01 起整张删掉（#531，docs/goals.md「六、要删的，和怎么删」，
//   创始人 2026-09-29「要删的东西都要删」）；认领账（issue_claims、seat_leases）跟着在 #556 删掉。
//   这里只剩名字校验，给 alert-cli 认机器名、会话名用。

// —— 名字 ——

const MACHINE = /^[\p{L}\p{N}_.-]{1,32}$/u;
const SESSION = /^[\p{L}\p{N}_.:-]{1,64}$/u;
const DRILL = /^drill:[\p{L}\p{N}_.-]{1,32}$/u;

/** 真帅位的座位；演练用 `drill:<名字>`，和它互不影响。 */
export const MAIN_SEAT = 'main';

/** 座位名：`main` 或 `drill:<名字>`。不对返回原因。 */
export function seatScopeProblem(scope: string): string | null {
  return scope === MAIN_SEAT || DRILL.test(scope)
    ? null
    : `座位「${scope}」不行：真帅位是 main，演练写 drill:<名字>（32 字以内的字母、汉字、数字、点、横线、下划线）`;
}

export function isDrillScope(scope: string | null | undefined): boolean {
  return typeof scope === 'string' && DRILL.test(scope);
}

/** 机器名：32 字以内的一段字母、汉字、数字、点、横线、下划线。 */
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
