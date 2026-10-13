// 一段会话用掉的 CPU 秒数（#1980）：从会话 scope 的 cgroup 读 cpu.stat 的 usage_usec（微秒，只增不减），
// 收场时折成秒写进 runs.cpu_seconds。
//
// 改这里之前必须知道：
// - scope 是 `systemd-run --scope --collect` 起的，最后一个进程一退 cgroup 就被收走，收场之后再读经常已经读不到了。
//   所以会话跑着时每隔一小会儿读一次，收场再读最后一次；收场那次读不到就用跑着时读成的最大一次（usage 只增不减，
//   那是真实用量的下限，漏掉的只是最后一个间隔）。
// - 读不到、认不出、读到 0 一律不写数：返回 why（进日志和 `_tmp/<runId>/result.json`），runs 那一列留空。不拿 0 顶、
//   不拿别的 cgroup（比如父节点 fleet-agents.slice，那是几个会话的总和）顶。
// - 起之前 scope 还没建出来、收场之后 scope 没了，文件不在（ENOENT）是正常的；整段一次都没读到才算没读到。
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { AGENT_SLICE_PATH, CGROUP_ROOT } from './memory-admission.ts';

/** 采样间隔：和内存峰值同一档（分钟级会话，半秒一次读一个小文件）。 */
export const CPU_USAGE_INTERVAL_MS = 500;

export interface CpuUsageDeps {
  readText(path: string): Promise<string>;
  cgroupRoot: string;
  slicePath: string;
  intervalMs: number;
}

export function productionCpuUsage(overrides: Partial<CpuUsageDeps> = {}): CpuUsageDeps {
  return {
    readText: (path) => readFile(path, 'utf8'),
    cgroupRoot: CGROUP_ROOT,
    slicePath: AGENT_SLICE_PATH,
    intervalMs: CPU_USAGE_INTERVAL_MS,
    ...overrides,
  };
}

export type CpuUsageResult = { seconds: number; why?: undefined } | { seconds?: undefined; why: string };

/**
 * cpu.stat 里的 usage_usec：微秒、大于 0。没有这一行、不是整数、是 0，都抛（调用方记原因，不写数）。
 * 0 不当成「用了 0 秒」：读不到和真没用满 1 微秒分不清，列上留空。
 */
export function parseCpuUsageUsec(text: string): number {
  const raw = /^usage_usec (\d+)$/m.exec(text)?.[1];
  if (raw === undefined) {
    throw new Error(
      `cpu.stat 里认不出 usage_usec 那一行（前 80 字节）：${JSON.stringify(text.slice(0, 80))}`,
    );
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`cpu.stat 的 usage_usec 认不出（要大于 0 的整数微秒）：${raw.slice(0, 40)}`);
  }
  return n;
}

export function scopeCpuStatPath(
  deps: Pick<CpuUsageDeps, 'cgroupRoot' | 'slicePath'>,
  scopeId: string,
): string {
  return posix.join(deps.cgroupRoot, deps.slicePath, `fleet-agent-${scopeId}.scope`, 'cpu.stat');
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** usage_usec（微秒）→ CPU 秒数，向上取整，至少 1。折不成（0、太大）返回 undefined。 */
export function cpuSecondsFromUsec(usec: number): number | undefined {
  if (!Number.isSafeInteger(usec) || usec <= 0) return undefined;
  const seconds = Math.ceil(usec / 1_000_000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * 开始采样这个 scope 的 cpu.stat；会话收场后调 stop() 拿结果。stop() 里再读一次（收场那一读），之后不再读。
 * 没读成的原因：从头到尾文件都不在、文件在但读不了、内容认不出。
 */
export function sampleCpuUsage(deps: CpuUsageDeps, scopeId: string): { stop(): Promise<CpuUsageResult> } {
  const path = scopeCpuStatPath(deps, scopeId);
  let bestUsec = 0;
  let sawMissing = false;
  let lastProblem: string | undefined;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const readOnce = async (): Promise<void> => {
    try {
      const usec = parseCpuUsageUsec(await deps.readText(path));
      if (usec > bestUsec) bestUsec = usec;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') sawMissing = true;
      else lastProblem = message(err);
    }
  };
  const tick = () => {
    if (stopped) return;
    inFlight = inFlight.then(readOnce);
  };
  tick();
  const timer = setInterval(tick, deps.intervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      // 收场再读一次：scope 还在就用这一下（含最后一段）；已经被 --collect 收走就用跑着时的最大一次
      await readOnce();
      const seconds = cpuSecondsFromUsec(bestUsec);
      if (seconds !== undefined) return { seconds };
      if (lastProblem !== undefined) return { why: `CPU 秒数没读成（${path}）：${lastProblem}` };
      return {
        why: sawMissing
          ? `CPU 秒数没读成：会话跑着的这段时间里 ${path} 一直不在（这台没有 cgroup，或 scope 没建出来）`
          : `CPU 秒数没读成：会话收场前一次采样都没来得及做（${path}）`,
      };
    },
  };
}
