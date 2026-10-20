// 测试卡在哪一步的阶段记录（#3372）：vitest 的 5000ms 超时只报「Test timed out」，看不出时间花在渲染、等异步还是整个进程没拿到 CPU。
// 这里只加观测，不改超时、不改断言：
// - 记下每次 findBy / waitFor 的进出（用测试文件里的行号标，来源是调用栈，不放页面内容），
// - 另开一个定时器量事件循环晚到多久（同步工作占住本线程、进程没排上 CPU、GC 都会让定时器晚到，这里只量得出「晚到」，分不出是哪一种），
// - 离超时还剩一截时（默认 4000ms）测试还没收尾就把阶段、晚到最久的一次、进程 CPU 用量各打一行 stderr，超时红了日志里就能读到。
//
// 能读出什么、读不出什么（别把读数当根因）：
// - 「晚到最久一次」只给它的时间区间，和哪些等待的区间有交集；交集不等于「发生在那一步里」，没有交集也不等于不在测试里。
// - 进程 CPU 时间是整个进程所有线程的合计（含 GC、工作线程），除以墙钟：低不等于没排上 CPU（空等也低），高不等于本测试在烧。
// - 事件循环利用率高只说明主线程没闲着：同步等待（如 spawnSync）能让 CPU 空闲而它仍是 1。
// - Windows 的 os.loadavg() 恒为 0，不是「负载 0」，输出写「未知」。
// - 归属：findBy / waitFor 属于哪个测试靠 AsyncLocalStorage 跟着异步链走，不看「当前是哪个测试」的全局状态；
//   超时的旧测试迟到的等待记进它自己（已收尾，丢弃），不会算到下一个测试头上；认不出归属的只计数。
// 输出有界：阶段最多 STAGE_CAP 条，测试名、位置、整行都有字节上限，超了写明已截断；输出口抛错不会冒成测试失败，只计「输出失败」次数，并尽力在 stderr 留一行。
import { AsyncLocalStorage } from 'node:async_hooks';
import { cpus, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { configure, getConfig } from '@testing-library/react';
import { afterAll, aroundEach } from 'vitest';

/** 一次测试最多记多少段阶段（超出的只计数，不再展开）。 */
export const STAGE_CAP = 24;
/** 测试名、位置、整行的字节上限（UTF-8）。 */
export const TEST_NAME_MAX_BYTES = 160;
export const STAGE_AT_MAX_BYTES = 64;
export const LINE_MAX_BYTES = 4096;
/** 事件循环探针的节拍：晚到超过这个数的才算「被挡」。 */
const PROBE_MS = 25;
const BLOCK_MS = 100;
const ELLIPSIS = '…';

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
  /**
   * 事件循环探针晚到超过 BLOCK_MS 的次数；最长一次晚到的毫秒数、它的时间区间（相对本测试开始，毫秒取整），
   * 以及已记的等待里和这个区间有交集的序号。区间交集不是「发生在那一步」；有等待没展开（droppedStages>0）时 overlapComplete=false，交集可能不全。
   */
  blocked: {
    count: number;
    maxMs: number;
    maxFromMs: number | null;
    maxToMs: number | null;
    overlapStages: number[];
    overlapComplete: boolean;
  };
  /** 本进程（所有线程合计）拿到的 CPU 时间（用户+内核）占墙钟的比例。 */
  processCpuShare: number;
  /** 事件循环利用率（performance.eventLoopUtilization），高 ≠ 一定在计算。 */
  loopUtilization: number;
  /** 1 分钟平均负载；平台不支持（Windows）为 null = 未知。 */
  loadavg1: number | null;
  cores: number;
  /** 输出口抛错的次数（0 才表示每次输出都送出去了）。 */
  outputFailures: number;
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

/** 控制字符换成空格（防一行日志被拆成几行）。 */
function stripControl(text: string): string {
  return Array.from(text, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || c === 0x7f ? ' ' : ch;
  }).join('');
}

/** 去掉控制字符，再按 UTF-8 字节截到 maxBytes 以内（不切断字符），截了在尾巴补「…」。 */
export function clipBytes(text: string, maxBytes: number): string {
  const clean = stripControl(text);
  if (Buffer.byteLength(clean, 'utf8') <= maxBytes) return clean;
  const room = Math.max(0, maxBytes - Buffer.byteLength(ELLIPSIS, 'utf8'));
  let out = '';
  let used = 0;
  for (const ch of clean) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > room) break;
    out += ch;
    used += size;
  }
  return maxBytes < Buffer.byteLength(ELLIPSIS, 'utf8') ? '' : out + ELLIPSIS;
}

/** 整行不超过 LINE_MAX_BYTES；超了截断并写明原来多少字节。 */
export function boundLine(line: string, maxBytes: number = LINE_MAX_BYTES): string {
  const clean = stripControl(line);
  const bytes = Buffer.byteLength(clean, 'utf8');
  if (bytes <= maxBytes) return clean;
  const marker = `…[已截断，原 ${bytes} 字节]`;
  return (
    clipBytes(clean, Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))).replace(/…$/, '') + marker
  );
}

function errorText(e: unknown): string {
  return clipBytes(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 120);
}

/** 往 stderr 写一行，写不出去也不抛（最后一道兜底）。 */
function writeStderr(line: string): boolean {
  try {
    process.stderr.write(`${boundLine(line)}\n`);
    return true;
  } catch {
    return false;
  }
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
  private blockedFrom: number | null = null;
  private blockedTo: number | null = null;
  private blockedOverlap: number[] = [];
  private blockedOverlapComplete = true;
  private lastTick = performance.now();
  private probe: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private finished = false;
  private outputFailures = 0;
  /** 收尾之后才到的等待个数（迟到的旧测试），不进报告。 */
  lateWaits = 0;

  readonly test: string;
  private readonly emit: (line: string) => void;

  constructor(test: string, watchAtMs: number, emit: (line: string) => void) {
    this.test = clipBytes(test, TEST_NAME_MAX_BYTES);
    this.emit = emit;
    try {
      this.probe = setInterval(() => this.sample(), PROBE_MS);
      this.watchdog = setTimeout(() => {
        // 这是定时器回调：任何异常都不能冒出去变成未捕获异常或别的测试的失败。
        try {
          this.send(`[阶段记录·快超时] ${format(this.report())}`);
        } catch (e) {
          this.noteOutputFailure(e);
        }
      }, watchAtMs);
    } catch (e) {
      this.clearTimers();
      throw e;
    }
  }

  private sample(): void {
    try {
      const now = performance.now();
      const expected = this.lastTick + PROBE_MS;
      const late = now - expected;
      this.lastTick = now;
      if (late > BLOCK_MS) {
        this.blockedCount += 1;
        if (late > this.blockedMax) {
          const from = round(expected - this.t0);
          const to = round(now - this.t0);
          this.blockedMax = late;
          this.blockedFrom = from;
          this.blockedTo = to;
          this.blockedOverlap = this.stages
            .filter((s) => s.startMs <= to && (s.endMs === null || s.endMs >= from))
            .map((s) => s.n);
          this.blockedOverlapComplete = this.dropped === 0;
        }
      }
    } catch {
      /* 探针自己出错不影响测试 */
    }
  }

  enter(at: string): StageEntry | null {
    if (this.finished) {
      this.lateWaits += 1;
      return null;
    }
    this.count += 1;
    if (this.stages.length >= STAGE_CAP) {
      this.dropped += 1;
      return null;
    }
    const e: StageEntry = {
      n: this.count,
      at: clipBytes(at, STAGE_AT_MAX_BYTES),
      startMs: round(performance.now() - this.t0),
      endMs: null,
    };
    this.stages.push(e);
    return e;
  }

  leave(e: StageEntry | null): void {
    if (e && !this.finished) e.endMs = round(performance.now() - this.t0);
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
      blocked: {
        count: this.blockedCount,
        maxMs: round(this.blockedMax),
        maxFromMs: this.blockedFrom,
        maxToMs: this.blockedTo,
        overlapStages: [...this.blockedOverlap],
        overlapComplete: this.blockedOverlapComplete,
      },
      processCpuShare: wallMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 100) / 100 : 0,
      loopUtilization: Math.round(elu.utilization * 100) / 100,
      loadavg1: loadavgOrUnknown(),
      cores: cpus().length,
      outputFailures: this.outputFailures,
    };
  }

  /** 把一行送到输出口：整行先截到字节上限；输出口抛错就计数并尽力往 stderr 留一行，绝不往外抛。 */
  send(line: string): boolean {
    try {
      this.emit(boundLine(line));
      return true;
    } catch (e) {
      this.noteOutputFailure(e);
      return false;
    }
  }

  private noteOutputFailure(e: unknown): void {
    this.outputFailures += 1;
    writeStderr(`[阶段记录·输出失败] test=${this.test} 第 ${this.outputFailures} 次：${errorText(e)}`);
  }

  private clearTimers(): void {
    if (this.probe) clearInterval(this.probe);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.probe = null;
    this.watchdog = null;
  }

  /** 收尾：停定时器（先停，后面出什么错都不会留着它），返回最终报告。 */
  finish(): StageReport {
    this.finished = true;
    this.clearTimers();
    return this.report();
  }
}

function round(n: number): number {
  return Math.round(n);
}

/** Windows 上 os.loadavg() 恒为 [0,0,0]（平台不支持），不是负载 0，返回 null = 未知。 */
function loadavgOrUnknown(): number | null {
  if (process.platform === 'win32') return null;
  const v = loadavg()[0];
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/** 一行里读完，各读数的含义见文件头：别把它们读成根因。整行经 send 输出时不超过 LINE_MAX_BYTES，超了截断并写明。 */
export function format(r: StageReport): string {
  const stages = r.stages
    .map((s) => `#${s.n} ${s.at} ${s.startMs}→${s.endMs === null ? '…' : s.endMs}ms`)
    .join('，');
  const more = r.droppedStages > 0 ? `，另有 ${r.droppedStages} 次未展开` : '';
  const b = r.blocked;
  let blocked: string;
  if (b.count === 0 || b.maxFromMs === null || b.maxToMs === null) {
    blocked = '探针没晚到过';
  } else {
    const hit =
      b.overlapStages.length > 0
        ? `与等待 ${b.overlapStages.map((n) => `#${n}`).join('、')} 的区间有交集`
        : '与已记的等待区间都无交集';
    const incomplete = b.overlapComplete ? '' : '（有等待没展开，交集可能不全）';
    blocked = `探针晚到超过 ${BLOCK_MS}ms 共 ${b.count} 次，最长 ${b.maxMs}ms（区间 ${b.maxFromMs}→${b.maxToMs}ms，${hit}${incomplete}）`;
  }
  const load = r.loadavg1 === null ? '未知（平台不支持）' : String(r.loadavg1);
  const out = r.outputFailures > 0 ? `；输出失败 ${r.outputFailures} 次` : '';
  return (
    `test=${r.test} 已过 ${r.elapsedMs}ms；${blocked}；` +
    `进程 CPU 时间/墙钟 ${r.processCpuShare}（含所有线程）；事件循环利用率 ${r.loopUtilization}；负载 ${load}；逻辑核 ${r.cores}${out}；等待：${stages}${more}`
  );
}

interface TaskLike {
  name?: string;
  type?: string;
  suite?: TaskLike;
}

/** 用例全名（describe > test），沿 task 往上走，不读「当前测试」的全局状态（并发时它会错）。 */
function nameOf(task: TaskLike | undefined): string {
  const parts: string[] = [];
  for (let t = task; t && t.type !== 'file'; t = t.suite) if (t.name) parts.unshift(t.name);
  return parts.join(' > ') || '?';
}

/**
 * 在一个测试文件里装上：每个测试开始记、结束收；findBy / waitFor 经 testing-library 的 asyncWrapper 记进出。
 * 离超时 `watchAtMs` 还没收尾打一行；收尾时总耗时过了 `reportOverMs` 也打一行（为了在没红的慢跑里也能看到）。
 *
 * asyncWrapper 是全局的，所以只装一份共用的，靠 AsyncLocalStorage 找到「这次等待是谁的异步链发起的」：
 * 超时的旧测试迟到的等待仍属于它自己（已收尾，丢弃）；认不出归属的不猜、只计数（文件收尾时打一行）。
 * 最后一个测试收尾（或文件收尾）时把 asyncWrapper 还原。
 */
export function installStageTrace(
  opts: { watchAtMs?: number; reportOverMs?: number; emit?: (line: string) => void } = {},
): void {
  const watchAtMs = opts.watchAtMs ?? 4000;
  const reportOverMs = opts.reportOverMs ?? 2500;
  const emit = opts.emit ?? ((line: string) => process.stderr.write(`${line}\n`));
  const owner = new AsyncLocalStorage<StageTrace>();
  let installed = 0;
  let base: ReturnType<typeof getConfig>['asyncWrapper'] | null = null;
  let unowned = 0;

  const wrapper: ReturnType<typeof getConfig>['asyncWrapper'] = async (cb) => {
    const inner = base ?? ((fn: () => Promise<unknown>) => fn());
    const trace = owner.getStore();
    if (!trace) {
      unowned += 1;
      return inner(cb);
    }
    const entry = trace.enter(callerOf(new Error().stack));
    try {
      return await inner(cb);
    } finally {
      trace.leave(entry);
    }
  };

  const note = (line: string) => {
    try {
      emit(boundLine(line));
    } catch {
      writeStderr(line);
    }
  };

  function acquire(): void {
    if (installed === 0) {
      // 上一次还原失败时全局里还是我们自己的 wrapper：不能把它当成 base（会自己调自己）。
      const current = getConfig().asyncWrapper;
      if (current !== wrapper) base = current;
      configure({ asyncWrapper: wrapper });
    }
    installed += 1;
  }

  function release(): void {
    installed = Math.max(0, installed - 1);
    if (installed === 0 && base) configure({ asyncWrapper: base });
  }

  // 用 aroundEach 而不是 beforeEach/afterEach：测试（含它的 beforeEach/afterEach）在 owner.run 里跑，归属随异步链走；
  // 在 beforeEach 里 enterWith 设的归属，describe 里串行超时之后会被旧测试的链带歪（实测），不用。
  aroundEach(async (use, ctx) => {
    let trace: StageTrace | null = null;
    let acquired = false;
    try {
      trace = new StageTrace(nameOf(ctx?.task as TaskLike | undefined), watchAtMs, emit);
      acquire();
      acquired = true;
    } catch (e) {
      // 观测没装上：清掉已建的定时器，留一行说明（不报「观测成功」），测试照常跑。
      trace?.finish();
      trace = null;
      note(`[阶段记录·没装上] ${errorText(e)}`);
    }
    try {
      await (trace ? owner.run(trace, () => use()) : use());
    } finally {
      // 不管测试怎么结束，先停定时器、再还原 asyncWrapper、最后输出；每一步出错都只留一行，不外冒、不盖过测试自己的结果。
      let report: StageReport | null = null;
      try {
        report = trace?.finish() ?? null;
      } catch (e) {
        note(`[阶段记录·收尾失败] ${errorText(e)}`);
      }
      if (acquired) {
        try {
          release();
        } catch (e) {
          note(`[阶段记录·还原失败] ${errorText(e)}`);
        }
      }
      if (trace && report && report.elapsedMs >= reportOverMs)
        trace.send(`[阶段记录·偏慢] ${format(report)}`);
    }
  });

  afterAll(() => {
    try {
      if (getConfig().asyncWrapper === wrapper && base) configure({ asyncWrapper: base });
    } catch (e) {
      note(`[阶段记录·还原失败] ${errorText(e)}`);
    }
    if (unowned > 0)
      note(`[阶段记录·归属未知] 有 ${unowned} 次 findBy / waitFor 认不出是哪个测试发起的，没有记进任何测试`);
  });
}
