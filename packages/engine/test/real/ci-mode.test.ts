// 等 CI 的时候盯合并方式（real/ci-mode.ts，#1877）：等的过程中仓被切成「不强制 CI」就不用再等了。
// 内层 waitCi 用一个只在被叫停时才返回的替身；盯合并方式的休眠换成可控的。

import type { CiMode } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { CiResult } from '../../src/decisions/types.ts';
import type { PortContext, WaitCiInput } from '../../src/ports.ts';
import { waitCiUnlessSkipped } from '../../src/real/ci-mode.ts';

const REPO = { owner: 'o', name: 'r', defaultBranch: 'main', testCommand: 'x' };
const input = { repo: REPO, head: 'a'.repeat(40) } as unknown as WaitCiInput;
const GREEN: CiResult = { state: 'green', head: 'a'.repeat(40), failedChecks: [] };

function ctxOf(signal: AbortSignal): PortContext {
  return { signal, heartbeat: () => undefined, attempt: 1, lastHeartbeat: undefined };
}

/** 内层 waitCi：一直等，直到收到叫停才抛（和真的 gh.waitCi 在叫停时的样子一样）。 */
const hangUntilAborted: Parameters<typeof waitCiUnlessSkipped>[0] = (_input, ctx) =>
  new Promise<CiResult>((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason ?? new Error('aborted')), {
      once: true,
    });
  });

/** 每次休眠让出一个宏任务，放行盯合并方式的循环往前走。 */
const tick = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    setTimeout(resolve, 0);
  });

describe('等 CI 时盯合并方式', () => {
  it('等的时候被切成不强制 CI：不再等，回 skipped（头原样带回，没有检查结论）', async () => {
    const modes: CiMode[] = ['required', 'required', 'skip'];
    let reads = 0;
    const wait = waitCiUnlessSkipped(hangUntilAborted, {
      mode: async () => modes[Math.min(reads++, modes.length - 1)] ?? 'required',
      sleep: tick,
    });
    const got = await wait(input, ctxOf(new AbortController().signal));
    expect(got).toMatchObject({ state: 'skipped', head: 'a'.repeat(40), failedChecks: [] });
    expect(reads).toBe(3);
  });

  it('一直是强制 CI：内层怎么回就怎么回，盯合并方式的循环随之收工', async () => {
    let reads = 0;
    const wait = waitCiUnlessSkipped(async () => GREEN, {
      mode: async () => {
        reads += 1;
        return 'required';
      },
      sleep: tick,
    });
    expect(await wait(input, ctxOf(new AbortController().signal))).toEqual(GREEN);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('【故意造出的失败】读合并方式失败：记日志、接着按强制 CI 等，不放过去', async () => {
    const logs: string[] = [];
    let reads = 0;
    const own = new AbortController();
    const wait = waitCiUnlessSkipped(hangUntilAborted, {
      mode: async () => {
        reads += 1;
        if (reads >= 3) own.abort(new Error('叫停'));
        throw new Error('库连不上');
      },
      sleep: tick,
      log: (m) => logs.push(m),
    });
    await expect(wait(input, ctxOf(own.signal))).rejects.toThrow('叫停');
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain('接着按强制 CI 等');
  });

  it('【故意造出的失败】真被叫停（放弃、超时）：往外抛，不当成 skipped', async () => {
    const stop = new AbortController();
    const wait = waitCiUnlessSkipped(hangUntilAborted, {
      mode: async () => {
        stop.abort(new Error('被叫停了'));
        return 'skip'; // 叫停的同时读到不强制：叫停优先
      },
      sleep: tick,
    });
    await expect(wait(input, ctxOf(stop.signal))).rejects.toThrow('被叫停了');
  });
});
