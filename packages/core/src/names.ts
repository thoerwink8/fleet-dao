// 名字校验：机器名、会话号，给 alert-cli 认「谁做的」用。
// 改这里之前必须知道：
// - 读不到、认不出一律算「没查成」，不算「没事」。
// - 帅位座位（接班、租约、任期、交接、帅位栏）2026-10-01 起整张删掉（#531，docs/goals.md「六、要删的，和怎么删」，
//   创始人 2026-09-29「要删的东西都要删」）；认领账（issue_claims、seat_leases）在 #556 删掉。座位名的校验
//   （MAIN_SEAT、seatScopeProblem、isDrillScope）#901 审查时发现没有生产调用方，一并删了。

const MACHINE = /^[\p{L}\p{N}_.-]{1,32}$/u;
const SESSION = /^[\p{L}\p{N}_.:-]{1,64}$/u;

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
