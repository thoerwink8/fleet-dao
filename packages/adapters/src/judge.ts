// 判一次会话的结果。顺序即优先级：进程没起来 → 被我们杀掉 → 跑完才看出的不一致 → 额度用满 → 没有终帧
// → 终帧报错 → 退出码 → 交付。各家插头把自己的记录整理成 RunFacts，判法只有这一份。
import type { RunOutcome } from '@fleet-dao/shared';
import type { DeliveryCheck } from './delivery.ts';
import type { KillReason, RunUsage } from './types.ts';

export interface RunFacts {
  /** 没起来：进程起不来，或服务端（Mirasim）拒了这一针。 */
  spawnError?: string;
  killed?: KillReason;
  /** 进程退出码。不是进程的插头（Mirasim、接口外壳）不带。 */
  exitCode?: number | null;
  signal?: string | null;
  /** 跑完才看得到的不一致（终帧里的实际模型、会话号）：和中途发现被停掉的同样判失败。 */
  mismatch?: { kind: 'model' | 'session'; expected: string; observed: string };
  /** 执行体的终帧。没有 = 没交代结果就结束了。 */
  terminal?: { isError: boolean; detail: string };
  /** 过程记录里出现过「账号池额度已用满」。 */
  quotaExhausted: boolean;
  /** 执行体最后说的话（stderr 末几行、报错原文）：没有终帧时拿它当原因，不写死一个占位词。 */
  lastWords?: string;
}

/** 交给引擎的统一摘要：判定事实、实际模型（只写观测值）、续跑用的会话号、这一轮的用量。 */
export interface RunSummary {
  facts: RunFacts;
  actualModel?: string;
  sessionId?: string;
  usage: RunUsage;
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

const MISMATCH_TEXT = { model: '实际回话的模型不是点名的那个', session: '续会话没续上原来那个会话' };

/** delivery 只对要交付代码的活传；不传就只看终帧和退出码。 */
export function judgeRun(facts: RunFacts, delivery?: DeliveryCheck): RunVerdict {
  const failed = (reason: VerdictReason, detail: string): RunVerdict => ({
    outcome: 'failed',
    reason,
    detail,
  });
  if (facts.spawnError) return failed('spawn_failed', `没起来：${facts.spawnError}`);
  if (facts.killed === 'aborted') return { outcome: 'stopped', reason: 'aborted', detail: KILL_TEXT.aborted };
  if (facts.killed === 'idle_timeout') {
    return { outcome: 'stalled', reason: 'idle_timeout', detail: KILL_TEXT.idle_timeout };
  }
  if (facts.killed) return failed(facts.killed, KILL_TEXT[facts.killed]);
  if (facts.mismatch) {
    const { kind, expected, observed } = facts.mismatch;
    return failed(`${kind}_mismatch`, `${MISMATCH_TEXT[kind]}：点名 ${expected}，实际 ${observed}`);
  }
  if (facts.quotaExhausted && (!facts.terminal || facts.terminal.isError)) {
    return failed('quota_exhausted', '账号池额度已用满，换池或等清零');
  }
  const isProcess = facts.exitCode !== undefined || Boolean(facts.signal);
  const exit = facts.signal ? `信号 ${facts.signal}` : `退出码 ${facts.exitCode}`;
  if (!facts.terminal) {
    const words = facts.lastWords ? `：${facts.lastWords}` : '';
    return failed('no_result', `${isProcess ? `进程退出（${exit}）` : '会话结束'}，没有终帧${words}`);
  }
  if (facts.terminal.isError) return failed('agent_error', facts.terminal.detail);
  if (isProcess && facts.exitCode !== 0) return failed('exit_nonzero', `终帧说完成，但进程${exit}`);
  if (!delivery) return { outcome: 'ok', reason: 'answered', detail: '正常结束' };
  if (delivery.state === 'delivered') return { outcome: 'ok', reason: 'delivered', detail: delivery.detail };
  if (delivery.state === 'not_delivered') return failed('not_delivered', `说做完了，但${delivery.detail}`);
  return failed('delivery_unknown', `交付没查成：${delivery.detail}`);
}
