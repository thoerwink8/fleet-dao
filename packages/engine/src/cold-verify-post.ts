// #555-2 装配侧的第二块：把「起一次冷调用 → 把结论贴成 PR 当前头上的 cold-verify 状态」串起来。
//
// 和 cold-verify-status.ts 的分工：那一份是**纯翻译**（结论 → 状态），这一份管**顺序和兜底**：
// 没跑成就贴 failure（不贴 = 闸一直判「还没验」，看得见但没信息；贴 pending = 假装在跑，更坏）。
//
// 三条硬约束：
// 1. **头要对**：结论只贴在被验的那个头上（推了新提交的，旧头上的状态自然不算——和第二意见同一个规矩）。
// 2. **写不成也按没验成算**：写状态本身抛错时**不能吞**——吞了就是「验过了但闸看不到」，那是死锁。
//    这里把它包成 ColdVerifyWriteError 抛出去，让调用方（会话交活那一侧）当成失败处理、报出来。
// 3. **只贴一次**：同一次运行的重试不许贴出第二条冲突的状态（同一 context 同一头再贴就是覆盖，GitHub 只留最新一条，
//    但重试时旧的那条已经写上了就不该再动——万一第二轮结论不一样，覆盖掉第一轮的风险由调用方按轮数决定）。

import { errMessage } from '@fleet-dao/shared/util';
import {
  type ColdVerifyStatus,
  type ColdVerifyTarget,
  coldVerifyNotRun,
  coldVerifyStatus,
  type WriteColdVerifyStatus,
} from './cold-verify-status.ts';
import type { VerifierInvokeInput, VerifierInvokeOutput } from './verifier-invoke.ts';

/** 写状态没写成：调用方必须按「没验成」处理，不许吞。 */
export class ColdVerifyWriteError extends Error {
  readonly prNumber: number;
  readonly head: string;
  constructor(target: ColdVerifyTarget, cause: unknown) {
    super(
      `PR #${target.prNumber} 的头 ${target.head.slice(0, 7)} 上没贴上 cold-verify 状态（${errMessage(
        cause,
      )}）：这条状态是合并闸的输入，没贴成就不算验过，别当成贴上了`,
    );
    this.name = 'ColdVerifyWriteError';
    this.prNumber = target.prNumber;
    this.head = target.head;
  }
}

export interface ColdVerifyRunDeps {
  /** 跑一轮（#555-1 的 invokeVerifier；注入进来，这一层只管顺序和贴状态）。 */
  invoke: (input: VerifierInvokeInput) => Promise<VerifierInvokeOutput>;
  /** 贴状态。 */
  writeStatus: WriteColdVerifyStatus;
}

export interface ColdVerifyRunResult {
  status: ColdVerifyStatus;
  /** 真的起了调用就有这个：那一轮的结论。 */
  verdict?: VerifierInvokeOutput;
}

/**
 * 跑一轮冷调用并把结论贴到头上。
 *
 * - `invoke` 抛错（起进程就炸了之类）→ 贴 **failure**（coldVerifyNotRun），不抛出去让状态空着。
 * - `invoke` 正常回 → 照 coldVerifyStatus 翻（pass→success、其余→failure）。
 * - 贴状态抛错 → 抛 ColdVerifyWriteError（**不吞**）。
 */
export async function runColdVerifyAndPost(
  input: VerifierInvokeInput,
  target: ColdVerifyTarget,
  deps: ColdVerifyRunDeps,
): Promise<ColdVerifyRunResult> {
  let verdict: VerifierInvokeOutput;
  try {
    verdict = await deps.invoke(input);
  } catch (err) {
    const status = coldVerifyNotRun(errMessage(err));
    await post(target, status, deps.writeStatus);
    return { status };
  }
  const status = coldVerifyStatus(verdict);
  await post(target, status, deps.writeStatus);
  return { status, verdict };
}

async function post(
  target: ColdVerifyTarget,
  status: ColdVerifyStatus,
  write: WriteColdVerifyStatus,
): Promise<void> {
  try {
    await write({ prNumber: target.prNumber, head: target.head, status });
  } catch (err) {
    throw new ColdVerifyWriteError(target, err);
  }
}
