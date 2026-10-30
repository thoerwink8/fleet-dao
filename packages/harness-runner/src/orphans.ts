// 内核重启后收上一代没收尾的运行（旧坑 A7：schedule_runs 留下 ended_at 为空的孤儿行，看着永远在跑）。
// 只收确认进程已经不在的（按会话标记看进程，不只看心跳时刻）；进程还在的留给接回，查不了的照实报「没查成」。

export interface OpenRun {
  runId: string;
}

export interface OrphanSweep {
  /** 进程确认不在了：调用方把它们记成「被重启打断」。 */
  interrupted: string[];
  /** 进程还在：交给接回，不收。 */
  alive: string[];
  /** 查不了（没有 /proc）：不收、不当成在跑，报出来。 */
  unknown: string[];
}

export function sweepOrphans(
  open: readonly OpenRun[],
  isAlive: (runId: string) => boolean | undefined,
): OrphanSweep {
  const out: OrphanSweep = { interrupted: [], alive: [], unknown: [] };
  for (const { runId } of open) {
    const a = isAlive(runId);
    if (a === undefined) out.unknown.push(runId);
    else if (a) out.alive.push(runId);
    else out.interrupted.push(runId);
  }
  return out;
}
