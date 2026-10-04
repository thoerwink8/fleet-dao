// 一段会话的内存峰值（#948，#632 第 3 条「单会话内存 ≤ 0.5G，runs 里记着」）：从会话 scope 的 cgroup 读 memory.peak
// （cgroup v2，字节，只增不减），写进 runs.memory_peak_mb。
//
// 改这里之前必须知道：
// - scope 是 `systemd-run --scope --collect` 起的，最后一个进程一退 cgroup 就被收走，收场之后再读已经读不到了。所以是会话
//   跑着时每隔一小会儿读一次、留最后一次读成的数——peak 本身只增不减，最后一次读数是真实峰值的下限（漏掉的只是最后一个
//   间隔里新长出来的那一点）。
// - 读不到、认不出一律不写数：返回 why 写明原因（进日志和 `_tmp/<runId>/result.json`），runs 那一列留空；不拿 0 顶、不拿别的
//   cgroup（比如父节点 fleet-agents.slice，那是几个会话的总和）顶。读到 0 也算认不出（跑着的会话不可能 0）。
// - 起之前 scope 还没建出来、收场之后 scope 没了，文件不在（ENOENT）是正常的，不算失败；整段一次都没读到才算没读到。
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { AGENT_SLICE_PATH, CGROUP_ROOT } from './memory-admission.ts';

/** 采样间隔：会话是分钟级的，半秒一次读一个小文件，成本可以忽略。 */
export const MEMORY_PEAK_INTERVAL_MS = 500;

export interface MemoryPeakDeps {
  readText(path: string): Promise<string>;
  cgroupRoot: string;
  slicePath: string;
  intervalMs: number;
}

export function productionMemoryPeak(overrides: Partial<MemoryPeakDeps> = {}): MemoryPeakDeps {
  return {
    readText: (path) => readFile(path, 'utf8'),
    cgroupRoot: CGROUP_ROOT,
    slicePath: AGENT_SLICE_PATH,
    intervalMs: MEMORY_PEAK_INTERVAL_MS,
    ...overrides,
  };
}

export type MemoryPeakResult = { mb: number; why?: undefined } | { mb?: undefined; why: string };

/** memory.peak 那一行：纯数字、字节、大于 0。认不出抛（调用方记原因，不写数）。 */
export function parseMemoryPeakBytes(text: string): number {
  const trimmed = text.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`memory.peak 的内容认不出（前 80 字节）：${JSON.stringify(trimmed.slice(0, 80))}`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) throw new Error(`memory.peak 的数太大，认不出：${trimmed.slice(0, 40)}`);
  return n;
}

export function scopePeakPath(
  deps: Pick<MemoryPeakDeps, 'cgroupRoot' | 'slicePath'>,
  scopeId: string,
): string {
  return posix.join(deps.cgroupRoot, deps.slicePath, `fleet-agent-${scopeId}.scope`, 'memory.peak');
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 开始采样这个 scope 的 memory.peak；会话收场后调 stop() 拿结果。stop() 之后不再读。
 * 没读成的原因：从头到尾文件都不在（scope 没建出来，或这台没有 cgroup）、文件在但读不了、内容认不出。
 */
export function sampleMemoryPeak(
  deps: MemoryPeakDeps,
  scopeId: string,
): { stop(): Promise<MemoryPeakResult> } {
  const path = scopePeakPath(deps, scopeId);
  let bestBytes = 0;
  let sawMissing = false;
  let lastProblem: string | undefined;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const readOnce = async (): Promise<void> => {
    try {
      const bytes = parseMemoryPeakBytes(await deps.readText(path));
      if (bytes > bestBytes) bestBytes = bytes;
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
      if (bestBytes > 0) return { mb: Math.ceil(bestBytes / (1024 * 1024)) };
      if (lastProblem !== undefined) return { why: `内存峰值没读成（${path}）：${lastProblem}` };
      return {
        why: sawMissing
          ? `内存峰值没读成：会话跑着的这段时间里 ${path} 一直不在（这台没有 cgroup，或 scope 没建出来）`
          : `内存峰值没读成：会话收场前一次采样都没来得及做（${path}）`,
      };
    },
  };
}
