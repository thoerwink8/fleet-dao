// #3647：走真实 runEngineWorker -> 信号处理 -> startEngineTimers 接线，SDK run 卡在收尾时不再接新钟点。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEngineWorker } from '../src/worker.ts';

const f = vi.hoisted(() => ({
  ready: () => {},
  workerRun: Promise.resolve(),
  body: vi.fn(async () => {}),
  shutdown: vi.fn(),
}));
vi.mock('@temporalio/client', () => ({
  Connection: { connect: async () => ({ close: async () => {} }) },
  Client: class {},
}));
vi.mock('@temporalio/worker', () => ({
  Runtime: { install: () => {} },
  NativeConnection: { connect: async () => ({ close: async () => {} }) },
  bundleWorkflowCode: async () => ({}),
  Worker: {
    create: async () => ({
      getState: () => 'RUNNING',
      shutdown: f.shutdown,
      run: () => {
        f.ready();
        return f.workerRun;
      },
    }),
  },
}));
vi.mock('../src/activities.ts', () => ({ createActivities: () => ({}) }));
vi.mock('../src/drain-control.ts', () => ({
  ownReleaseSha: () => 'a'.repeat(40),
  createDrainControl: () => ({ resumed: async () => {}, tick: async () => {}, start: () => () => {} }),
}));
vi.mock('../src/drain-file.ts', () => ({
  startDrainStatusFile: () => ({ flush: async () => {}, stop: () => {} }),
}));
vi.mock('../src/cli-upgrade-files.ts', () => ({
  cliUpgradeDir: () => 'unused',
  restoreCliUpgradeCordon: async () => {},
}));
vi.mock('../src/real/index.ts', () => ({
  realPortsFromEnv: () => ({
    stateDir: 'unused',
    drainControl: { stopSessions: () => [] },
    ports: {},
    jobs: {},
    registerJobs: async () => {},
    master: { refresh: async () => true, start: () => () => {} },
    recordSkippedRun: async () => {},
    closeInterruptedScheduleRuns: async () => [],
    jobLastStartedAt: async () => new Map([['hourly-reconcile', new Date(Date.now())]]),
    close: async () => {},
  }),
}));
vi.mock('../src/jobs/engine-timers.ts', () => ({
  engineTimerJobs: () => [
    {
      id: 'hourly-reconcile',
      everyMinutes: 60,
      offsetMinutes: 41,
      catchupMinutes: 60,
      overdueMinutes: 15,
      run: f.body,
    },
  ],
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('停机信号与 worker 收尾间的定时任务接线', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s 一到即不再接新轮次，SDK run 未交回也不例外，重复信号幂等',
    async (signal) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-22T22:40:48.963Z'));
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const handlers = new Map<string, () => void>();
      vi.spyOn(process, 'on').mockImplementation((name, handler) => {
        handlers.set(String(name), handler);
        return process;
      });
      vi.spyOn(process, 'off').mockImplementation((name) => {
        handlers.delete(String(name));
        return process;
      });
      let release!: () => void;
      f.workerRun = new Promise<void>((resolve) => (release = resolve));
      const ready = new Promise<void>((resolve) => (f.ready = resolve));
      const running = runEngineWorker({ FLEET_ENGINE_PORTS: 'real' });
      try {
        await ready;
        expect(f.body).not.toHaveBeenCalled();
        handlers.get(signal)?.();
        await vi.advanceTimersByTimeAsync(12_000);
        expect(f.shutdown).toHaveBeenCalledTimes(1);
        expect(f.body).not.toHaveBeenCalled();
        handlers.get(signal)?.();
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(f.shutdown).toHaveBeenCalledTimes(1);
        expect(f.body).not.toHaveBeenCalled();
      } finally {
        release();
        await running;
      }
      expect(handlers.size).toBe(0);
    },
  );
});
