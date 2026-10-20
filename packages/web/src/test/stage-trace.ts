// 测试卡在哪一步的阶段记录（#3372）：vitest 的 5000ms 超时只报「Test timed out」，看不出时间花在渲染、等异步还是整个进程没拿到 CPU。
// 这里只加观测，不改超时、不改断言：
// - 记下每次 findBy / waitFor 的进出（用测试文件里的行号标，来源是调用栈，不放页面内容），
// - 另开一个定时器量事件循环被挡了多久（本线程被同步工作占住或进程没排上 CPU，定时器都会晚到），
// - 离超时还剩一截时（默认 4000ms）测试还没收尾就把阶段、挡住最久的一次、CPU 用量占比各打一行 stderr，超时红了日志里就能读到。
// 输出有界：阶段最多 STAGE_CAP 条，只含阶段序号、行号、毫秒数、负载数字，不含环境变量、路径以外的页面内容。
import { cpus, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { configure, getConfig } from '@testing-library/react';
import { afterEach, beforeEach, expect } from 'vitest';

/** 一次测试最多记多少段阶段（超出的只计数，不再展开）。 */
export const STAGE_CAP = 24;
/** 事件循环探针的节拍：晚到超过这个数的才算「被挡」。 */
const PROBE_MS = 25;
const BLOCK_MS = 100;

export interface StageEntry {
  /** 第几次等待。 */
  n: number;
  /** 测试文件里发起等待的 `文件:行`，认不出写 `?`。 */
  at: string;
  startMs: number;
  /** 还没结束的写 null（卡在这一步）。 */
  endMs: number | null;
}

export interface StageReport {
  test: string;
  elapsedMs: number;
  stages: StageEntry[];
  droppedStages: number;
  /** 事件循环被挡超过 BLOCK_MS 的次数、最长一次的毫秒数、发生在第几次等待之内（0 = 还没进任何等待）。 */
  blocked: { count: number; maxMs: number; maxAtStage: number };
  /** 本进程在这段时间里拿到的 CPU 时间（用户+内核）占墙钟的比例；远小于 1 说明进程没排上 CPU，接近或大于 1 说明自己在烧。 */
  cpuShare: number;
  /** 事件循环利用率（performance.eventLoopUtilization）：高 = 线程几乎一直在忙。 */
  loopUtilization: number;
  loadavg1: number;
  cores: number;
}

/** 从调用栈里找测试文件的 `文件名:行`。 */
export function callerOf(
  stack: string | undefined,
  testFileHint: RegExp = /([^\\/()\s]+\.test\.tsx?):(\d+):\d+/,
): string {
  if (!stack) return '?';
  for (const line of stack.split('\n')) {
    const m = testFileHint.exec(line);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return '?';
}

export class StageTrace {
  private readonly t0 = performance.now();
  private readonly cpu0 = process.cpuUsage();
  private readonly elu0 = performance.eventLoopUtilization();
  readonly stages: StageEntry[] = [];
  private dropped = 0;
  private count = 0;
  private blockedCount = 0;
  private blockedMax = 0;
  private blockedAt = 0;
  private lastTick = performance.now();
  private open: StageEntry | null = null;
  private probe: NodeJS.Timeout;
  private watchdog: NodeJS.Timeout | null = null;
  private finished = false;

  readonly test: string;
  private readonly emit: (line: string) => void;

  constructor(test: string, watchAtMs: number, emit: (line: string) => void) {
    this.test = test;
    this.emit = emit;
    this.probe = setInterval(() => {
      const now = performance.now();
      const late = now - this.lastTick - PROBE_MS;
      this.lastTick = now;
      if (late > BLOCK_MS) {
        this.blockedCount += 1;
        if (late > this.blockedMax) {
          this.blockedMax = late;
          this.blockedAt = this.open?.n ?? 0;
        }
      }
    }, PROBE_MS);
    this.watchdog = setTimeout(() => {
      this.emit(`[阶段记录·快超时] ${format(this.report())}`);
    }, watchAtMs);
  }

  enter(at: string): StageEntry | null {
    this.count += 1;
    if (this.stages.length >= STAGE_CAP) {
      this.dropped += 1;
      return null;
    }
    const e: StageEntry = { n: this.count, at, startMs: round(performance.now() - this.t0), endMs: null };
    this.stages.push(e);
    this.open = e;
    return e;
  }

  leave(e: StageEntry | null): void {
    if (e) e.endMs = round(performance.now() - this.t0);
    if (this.open === e) this.open = null;
  }

  report(): StageReport {
    const wallMs = performance.now() - this.t0;
    const cpu = process.cpuUsage(this.cpu0);
    const elu = performance.eventLoopUtilization(this.elu0);
    return {
      test: this.test,
      elapsedMs: round(wallMs),
      stages: this.stages.map((s) => ({ ...s })),
      droppedStages: this.dropped,
      blocked: { count: this.blockedCount, maxMs: round(this.blockedMax), maxAtStage: this.blockedAt },
      cpuShare: wallMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 100) / 100 : 0,
      loopUtilization: Math.round(elu.utilization * 100) / 100,
      loadavg1: Math.round((loadavg()[0] ?? 0) * 100) / 100,
      cores: cpus().length,
    };
  }

  /** 收尾：停定时器，返回最终报告。 */
  finish(): StageReport {
    if (!this.finished) {
      this.finished = true;
      clearInterval(this.probe);
      if (this.watchdog) clearTimeout(this.watchdog);
    }
    return this.report();
  }
}

function round(n: number): number {
  return Math.round(n);
}

/** 一行里读完：`test=… 总 N ms；被挡 K 次最长 M ms（第 S 次等待内）；CPU 占比 …；事件循环利用率 …；负载 …/核 …；等待：#1 france-release.test.tsx:91 0→120ms，#2 …（… = 没结束）`。 */
export function format(r: StageReport): string {
  const stages = r.stages
    .map((s) => `#${s.n} ${s.at} ${s.startMs}→${s.endMs === null ? '…' : s.endMs}ms`)
    .join('，');
  const more = r.droppedStages > 0 ? `，另有 ${r.droppedStages} 次未展开` : '';
  return (
    `test=${r.test} 已过 ${r.elapsedMs}ms；事件循环被挡 ${r.blocked.count} 次、最长 ${r.blocked.maxMs}ms（第 ${r.blocked.maxAtStage} 次等待内）；` +
    `CPU 占墙钟 ${r.cpuShare}；事件循环利用率 ${r.loopUtilization}；负载 ${r.loadavg1}/${r.cores} 核；等待：${stages}${more}`
  );
}

/**
 * 在一个测试文件里装上：每个测试开始记、结束收；findBy / waitFor 经 testing-library 的 asyncWrapper 记进出。
 * 离超时 `watchAtMs` 还没收尾打一行；收尾时总耗时过了 `reportOverMs` 也打一行（为了在没红的慢跑里也能看到）。
 */
export function installStageTrace(
  opts: { watchAtMs?: number; reportOverMs?: number; emit?: (line: string) => void } = {},
): void {
  const watchAtMs = opts.watchAtMs ?? 4000;
  const reportOverMs = opts.reportOverMs ?? 2500;
  const emit = opts.emit ?? ((line: string) => process.stderr.write(`${line}\n`));
  let current: StageTrace | null = null;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    current = new StageTrace(expect.getState().currentTestName ?? '?', watchAtMs, emit);
    const original = getConfig().asyncWrapper;
    const trace = current;
    configure({
      asyncWrapper: async (cb) => {
        const entry = trace.enter(callerOf(new Error().stack));
        try {
          return await original(cb);
        } finally {
          trace.leave(entry);
        }
      },
    });
    restore = () => configure({ asyncWrapper: original });
  });

  afterEach(() => {
    restore?.();
    restore = null;
    const r = current?.finish();
    current = null;
    if (r && r.elapsedMs >= reportOverMs) emit(`[阶段记录·偏慢] ${format(r)}`);
  });
}
