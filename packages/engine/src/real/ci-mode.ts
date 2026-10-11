// 等 CI 的时候盯着合并方式（#1877）：这个仓在等的过程中被切成「不强制 CI」，就不用再等了，回 skipped，工作流自己往下走。
//
// 改这里之前必须知道：
// - 盯合并方式在活动里做（读库，每 pollMs 一次），不在工作流里循环调活动：工作流里每次轮询都进历史，一场 30 分钟的等待就是几十条。
// - 读合并方式失败只记日志、接着等：等的是强制 CI 那一路，读不到就按现状（强制）继续，不会因为读不到而放过去。
// - 叫停（ctx.signal）照常往外抛，不当成 skipped。只有「是我们自己因为切成不强制才叫停内层」才回 skipped。

import type { CiMode } from '@fleet-dao/shared';
import { abortableSleep, errMessage } from '@fleet-dao/shared/util';
import type { EnginePorts } from '../ports.ts';

/** 多久看一次这个仓的合并方式（毫秒）。 */
export const CI_MODE_POLL_MS = 15_000;

export interface CiModeWatch {
  /** 这个仓现在的合并方式（读库）。 */
  mode: (repo: { owner: string; name: string }) => Promise<CiMode>;
  pollMs?: number;
  /** 休眠；叫停（signal 触发）时要抛出来。测试里换成立刻返回的。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function waitCiUnlessSkipped(inner: EnginePorts['waitCi'], watch: CiModeWatch): EnginePorts['waitCi'] {
  const pollMs = watch.pollMs ?? CI_MODE_POLL_MS;
  const sleep = watch.sleep ?? abortableSleep;
  const log = watch.log ?? (() => undefined);
  return async (input, ctx) => {
    const own = new AbortController();
    const signal = AbortSignal.any([ctx.signal, own.signal]);
    let skipped = false;
    const watcher = (async () => {
      for (;;) {
        await sleep(pollMs, signal);
        try {
          if ((await watch.mode(input.repo)) === 'skip') {
            skipped = true;
            own.abort(new Error('这个仓被切成了不强制 CI'));
            return;
          }
        } catch (error) {
          log('等 CI 时读合并方式没读成，接着按强制 CI 等', {
            repo: `${input.repo.owner}/${input.repo.name}`,
            error: errMessage(error),
          });
        }
      }
    })().catch(() => undefined); // 内层收场后 own.abort() 会把休眠打断，走到这里是正常收工
    try {
      return await inner(input, { ...ctx, signal });
    } catch (error) {
      if (skipped && !ctx.signal.aborted) {
        return {
          state: 'skipped',
          head: input.head,
          failedChecks: [],
          detail: '等 CI 的时候这个仓被切成了不强制 CI',
        };
      }
      throw error;
    } finally {
      own.abort(new Error('等 CI 收场了'));
      await watcher;
    }
  };
}
