// #2742：点名 sonnet、读回 opus[1m]。归类是发版叫停之后误续上一段 opus 会话
// （续会话不比模型），不是比对串把 [1m] 剥错，不是 #1298 那种名单里没有才换模，也不是 #2797 的叫停本身。
// 失败分流 MD3 的标题拼出来就是下面这一句，写进 tasks.last_problem，doing 前面再加「停下等人：」。
// 新失败不再用这句把整张单挂住。已经挂上的在途单，看门狗靠这一句认出来再发「继续」。

/** classifyFailure 对 model_mismatch 判停下时的 reason，一字不差。 */
export const LEGACY_MODEL_MISMATCH_STALL = '回话的模型不是点名的那个（model_mismatch）：挂起并报警';

/** 没有还能派的路由时的新挂起。不靠看门狗叫醒：叫醒了还是没有路由。 */
export const NO_ROUTE_MODEL_MISMATCH_STALL = '没有还能派的路由：点名和读回的模型对不上';

/**
 * 库里的进度或 last_problem 是不是「旧规则把 model_mismatch 挂了整张单」。
 * 新挂起（没有还能派的路由）对不上这一句。
 */
export function isLegacyModelMismatchStall(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(LEGACY_MODEL_MISMATCH_STALL);
}
