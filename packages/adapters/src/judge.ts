// 判一次会话的结果。顺序即优先级：进程没起来 → 被我们杀掉 → 额度用满 → 没有终帧 → 终帧报错 → 退出码 → 交付。
// 各家插头把自己的记录整理成 RunFacts，判法只有这一份。
import type { RunOutcome } from '@fleet-dao/shared';
import type { DeliveryCheck } from './delivery.ts';
import type { KillReason } from './types.ts';

export interface RunFacts {
  spawnError?: string;
  killed?: KillReason;
  exitCode: number | null;
  signal: string | null;
  /** 执行体的终帧。没有 = 进程没交代结果就退了。 */
  terminal?: { isError: boolean; detail: string };
  /** 过程记录里出现过「账号池额度已用满」。 */
  quotaExhausted: boolean;
}

export type VerdictReason =
  | 'delivered' // 写码类：有自己的提交和内容差异
  | 'answered' // 不要求交付的活（审查、分诊……）正常结束
  | KillReason
  | 'spawn_failed'
  | 'quota_exhausted'
  | 'no_result'
  | 'agent_error'
  | 'exit_nonzero'
  | 'not_delivered'
  | 'delivery_unknown'; // 交付没查成：该重查，不该算执行体失败

export interface RunVerdict {
  outcome: RunOutcome;
  reason: VerdictReason;
  /** 一句白话，给驾驶舱和日志。 */
  detail: string;
}

const KILL_TEXT: Record<KillReason, string> = {
  startup_timeout: '起来之后迟迟没有第一帧',
  wall_clock_timeout: '总时长到顶，已强杀',
  idle_timeout: '没有工具在跑，却长时间没有动静',
  model_mismatch: '实际回话的模型不是点名的那个，已停',
  session_mismatch: '续会话没续上原来那个会话，已停',
  cli_too_old: '命令行版本低于要求，已停',
  aborted: '引擎叫停',
};

/** delivery 只对要交付代码的活传；不传就只看终帧和退出码。 */
export function judgeRun(facts: RunFacts, delivery?: DeliveryCheck): RunVerdict {
  const failed = (reason: VerdictReason, detail: string): RunVerdict => ({
    outcome: 'failed',
    reason,
    detail,
  });
  if (facts.spawnError) return failed('spawn_failed', `进程没起来：${facts.spawnError}`);
  if (facts.killed === 'aborted') return { outcome: 'stopped', reason: 'aborted', detail: KILL_TEXT.aborted };
  if (facts.killed === 'idle_timeout') {
    return { outcome: 'stalled', reason: 'idle_timeout', detail: KILL_TEXT.idle_timeout };
  }
  if (facts.killed) return failed(facts.killed, KILL_TEXT[facts.killed]);
  if (facts.quotaExhausted && (!facts.terminal || facts.terminal.isError)) {
    return failed('quota_exhausted', '账号池额度已用满，换池或等清零');
  }
  const exit = facts.signal ? `信号 ${facts.signal}` : `退出码 ${facts.exitCode}`;
  if (!facts.terminal) return failed('no_result', `进程退出（${exit}），没有终帧`);
  if (facts.terminal.isError) return failed('agent_error', facts.terminal.detail);
  if (facts.exitCode !== 0) return failed('exit_nonzero', `终帧说完成，但进程${exit}`);
  if (!delivery) return { outcome: 'ok', reason: 'answered', detail: '正常结束' };
  if (delivery.state === 'delivered') return { outcome: 'ok', reason: 'delivered', detail: delivery.detail };
  if (delivery.state === 'not_delivered') return failed('not_delivered', `说做完了，但${delivery.detail}`);
  return failed('delivery_unknown', `交付没查成：${delivery.detail}`);
}
