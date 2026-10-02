// #555-2 的装配侧：把 #555-1 那次冷调用（verifier-invoke.ts）的结论贴成 PR 当前头上的提交状态 cold-verify，
// 合并闸只读这条状态（packages/conventions/src/merge-gate.ts）。
//
// **为什么结论要贴成状态、而不是让合并闸自己去起调用**：合并闸跑在 CI 里，判法必须确定——同一份代码什么时候跑
// 结果都一样（design 第五节「必过检查分两种说准」）。起模型调用是花钱、看时刻、看额度的事，放进闸里就把闸变成
// 不确定的检查了。所以分工是：**装配侧起调用、写状态；闸只读状态**。
//
// **一条都不能漏成 success**（通用段底线第三条）。verifier-invoke 的每条明确失败路径（读不到 diff、空 diff、
// 读不到单子、没家族可挑、冷调用没跑成）都已经回 pass=false；这里再钉一遍：只有 **pass === true** 才写 success，
// 其余一律 failure。**没有「不确定」这一档**：装配侧没跑成不许悄悄不贴（不贴 = 闸判「还没验」= 卡住，看得见），
// 也不许贴 pending 假装在跑（那是没在跑）。pending 留给真的还在跑那一种（round 2 忘了写之前先贴上，见下面）。
//
// 轮数（specs/555 第 3 条：默认 1 轮、最多 2 轮）在这一层判：到顶了还不过就是不过，不许拿第 3 轮盖过去——
// 起调用那一步只知道这一轮的结论，判上限、决定还起不起下一轮的是装配侧。

import type { VerifierInvokeOutput } from './verifier-invoke.ts';

/** 和 packages/github 的 CommitStatusInput.state 同一套取值（这里不 import 那个包：engine 不依赖它）。 */
export type ColdVerifyState = 'success' | 'failure' | 'error' | 'pending';

/** 冷调用最多几轮（specs/555 第 3 条）。和 packages/conventions 的 COLD_VERIFY_MAX_ROUND 是同一个数：合并闸那边
 * 只拿它写给人看的话，真正拦第 3 轮的是这里。两处都改才算改完（测试各钉一份）。 */
export const COLD_VERIFY_ROUNDS_MAX = 2;
/** 默认轮数（specs/555 第 3 条：默认 1 轮）。 */
export const COLD_VERIFY_ROUNDS_DEFAULT = 1;

/** GitHub 提交状态的 description 上限（140 个字符，和 packages/conventions 的 DESCRIPTION_MAX 同一个数）。 */
const DESCRIPTION_MAX = 140;

export interface ColdVerifyStatus {
  state: ColdVerifyState;
  /** 人看的一行（上限 140，这里先截好）。 */
  description: string;
}

/**
 * 把一次冷调用的结论翻成交给 GitHub 的状态。**纯函数**，不碰网络：这一层错了就是「没验成却显示验过了」，
 * 要和起调用那一层分开测。
 *
 * 映射（不许出现「拿不到当没问题」）：
 * - `pass === true` → success
 * - `pass === false` → failure（problems 里那句写进 description）
 *
 * 没有第三档：装配侧压根没跑起来（起进程就抛了之类）由调用方自己写 failure（见 `coldVerifyNotRun`），
 * 不许绕过这里直接写 success。
 */
export function coldVerifyStatus(
  out: Pick<VerifierInvokeOutput, 'pass' | 'problems' | 'round'>,
): ColdVerifyStatus {
  if (out.pass) {
    return { state: 'success', description: fit(`验收通过（第 ${out.round} 轮冷调用）`) };
  }
  const first = out.problems.find((p) => p.trim() !== '');
  return {
    state: 'failure',
    description: fit(
      first === undefined
        ? `验收没过（第 ${out.round} 轮）：模型没写问题、也没说清为什么`
        : `验收没过（第 ${out.round} 轮）：${first}`,
    ),
  };
}

/**
 * 装配侧压根没跑成这一次冷调用（起进程前就抛了：拿不到 diff、连不上 GitHub、挑不出模型的那个进程起不来）。
 * **必须是 failure，不是 pending、更不是 success**：pending 会被合并闸读成「还在跑、等一会儿就好」，
 * 而这一种是「什么都没跑」——不贴或贴 pending 都等于让闸一直等一个不会来的结论。
 */
export function coldVerifyNotRun(why: string): ColdVerifyStatus {
  return { state: 'failure', description: fit(`没验成：冷调用这一次没跑起来（${why}）`) };
}

/** 第 N 轮还在跑（起调用那一步先贴一条，免得闸在这几分钟里显示成「还没验」）。 */
export function coldVerifyPending(round: number): ColdVerifyStatus {
  return {
    state: 'pending',
    description: fit(
      `第 ${round} 轮冷调用跑着（默认 ${COLD_VERIFY_ROUNDS_DEFAULT} 轮、最多 ${COLD_VERIFY_ROUNDS_MAX} 轮）`,
    ),
  };
}

/** 到轮数上限了还不过：不再起第 2/3 轮，交人看。 */
export function coldVerifyExhausted(round: number): ColdVerifyStatus {
  return {
    state: 'failure',
    description: fit(`验收没过：第 ${round} 轮是最后一轮（最多 ${COLD_VERIFY_ROUNDS_MAX} 轮），交人看`),
  };
}

/**
 * 还能不能再起一轮。`round` 是已经跑完的轮数：跑完 1 轮（默认）算到顶，跑完 2 轮（上限）也到顶。
 * 到顶时**不许**再起一轮盖掉结论——那是自循环（specs/509 第 7 条：每类都带总次数上限，超了停下报人）。
 */
export function canStartRound(roundsDone: number): boolean {
  return roundsDone < COLD_VERIFY_ROUNDS_MAX;
}

/**
 * 下一次该起第几轮；到顶了回 null（调用方照 coldVerifyExhausted 贴结论、别再起调用）。
 * 入参是已经跑完的轮数（0 = 还没跑过）。
 */
export function nextRound(roundsDone: number): 1 | 2 | null {
  if (roundsDone <= 0) return 1;
  if (roundsDone === 1) return COLD_VERIFY_ROUNDS_MAX === 2 ? 2 : null;
  return null;
}

/** 截到 GitHub 的 description 上限（140 个字符，按字符数不是字节数）。 */
function fit(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > DESCRIPTION_MAX ? `${chars.slice(0, DESCRIPTION_MAX - 1).join('')}…` : chars.join('');
}

/** 写状态的接口：装配时给真实现（packages/github 的 claims.setStatus），测试给 fake。 */
export type WriteColdVerifyStatus = (args: {
  prNumber: number;
  head: string;
  status: ColdVerifyStatus;
}) => Promise<void>;

/** 状态写在哪个头：GitHub 的提交状态挂在 sha 上，头一变旧状态自然不算（和 second-opinion 同一个规矩）。 */
export type ColdVerifyTarget = { prNumber: number; head: string };
