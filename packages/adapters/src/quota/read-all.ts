// 一轮读完所有账号池：各读取器并发、各自有超时；每个池一定有一条结果——读不成的带明确原因，绝不静默丢掉。
// mirasim-relay 超时在本轮里先短退避、再试一次（换一条连接、重新掐一份同样的时限）。立刻再连会落在同一次
// 单线程堵住里（MS-08，40–58 秒）。退避默认 MIRASIM_RETRY_BACKOFF_MS；测试用 deps.retryDelayMs 调成 0。
// 一次尝试的整体时限：池上的 timeoutMs 优先于顶层。mirasim-relay 生产单独 90 秒，对齐桥接自己的建连重试预算；
// 顶层 30 秒会先把桥接掐掉，原因写成「整体 30 秒用完」（#2854，2026-10-16 21:34 CST）。那次不是上游额度接口慢
// （getRelay 零次上游），也不是发版排空把读取掐死（告警在约 21:35 排空之前已写成）。跟 #2838 分开：那是动手
// 会话的桥接超时挂整单。跟 #2307 分开：那是额度告警反复报撤。试两次仍失败按这一次的原因交回，不在这里写库。
// 原因三句分开：读取器写「桥接连不上」「连上了等不到 relay 帧」，这一层到点写「整体 N 秒用完」，不再笼统写「N 秒内没读完」。
// 换掉读取器的测试不重试，免得把故意卡住的用例拖长。
import { setTimeout as sleep } from 'node:timers/promises';
import {
  QUOTA_IO_KEYS,
  type QuotaDeps,
  type Reader,
  type ReaderContext,
  type ReaderOutput,
} from './context.ts';
import { readClaudeUsage } from './readers/claude.ts';
import { readCursorDashboard } from './readers/cursor.ts';
import { readEstimate } from './readers/estimate.ts';
import { readGrokBilling } from './readers/grok.ts';
import { mirasimOverallBudgetMessage, readMirasimRelay } from './readers/mirasim.ts';
import { readReclaudeCarpool } from './readers/reclaude.ts';
import type {
  PoolConfig,
  PoolQuotaResult,
  QuotaConfig,
  QuotaError,
  QuotaReading,
  QuotaReport,
  ReaderType,
} from './types.ts';
import { QuotaReadError } from './types.ts';
import { redact } from './util.ts';

export const READERS: Record<ReaderType, Reader> = {
  'claude-usage': readClaudeUsage,
  'reclaude-carpool': readReclaudeCarpool,
  'mirasim-relay': readMirasimRelay,
  'cursor-dashboard': readCursorDashboard,
  'grok-billing': readGrokBilling,
  estimate: readEstimate,
};

/** 默认超时：Claude 要起一次 Claude Code（reclaude 首跑还要同步配置），给足；Cursor 令牌被拒时还要起一次 cursor-agent status 刷新，也给足；Grok 访问令牌过期时还要起一次 grok models 让 CLI 自己续，也给足；其余是一两次 HTTP / 本机调用。 */
export const DEFAULT_TIMEOUT_MS: Record<ReaderType, number> = {
  'claude-usage': 120_000,
  'reclaude-carpool': 20_000,
  'mirasim-relay': 20_000,
  'cursor-dashboard': 60_000,
  'grok-billing': 60_000,
  estimate: 20_000,
};

/**
 * mirasim-relay 超时后、再开一条连接之前等多久。
 * 几秒就够让上一次被掐掉的桥接退出单线程堵住；不是再等一整轮（15 分钟）。
 */
export const MIRASIM_RETRY_BACKOFF_MS = 3_000;

/**
 * 外部能力（进程、网络、文件、家目录、环境）必须全部注入，少一样当场抛错——
 * 库函数不自己拿真的，免得测试或调用方悄悄碰到真机器。生产传 productionQuotaIo()。
 */
export async function readAllQuotas(config: QuotaConfig, deps: QuotaDeps): Promise<QuotaReport> {
  const missing = QUOTA_IO_KEYS.filter((k) => (deps as Partial<QuotaDeps> | undefined)?.[k] === undefined);
  if (missing.length) {
    throw new Error(
      `readAllQuotas 缺注入：${missing.join('、')}（生产环境传 productionQuotaIo()，测试传假的）`,
    );
  }
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const shared = new Map<string, Promise<unknown>>();
  const results = await Promise.all(config.pools.map((pool) => readPool(pool, config, deps, shared)));
  return { startedAt, finishedAt: now().toISOString(), results };
}

function toQuotaError(e: unknown): QuotaError {
  if (e instanceof QuotaReadError) return { code: e.code, message: redact(e.message, 500) };
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return { code: 'crashed', message: `读取器出了没预料到的错：${redact(message, 500)}` };
}

/**
 * 读取器交回来的数再过一道：窗口必须属于这个池、名字不重、数字是有限数。
 * 不合格的丢掉并写进 notes——丢了也要说，不静默；交回来的全被丢掉就不算读成（抛 bad_response）。
 */
function vetWindows(poolId: string, windows: readonly QuotaReading[], notes: string[]): QuotaReading[] {
  const out: QuotaReading[] = [];
  const labels = new Set<string>();
  const dropped: string[] = [];
  for (const w of windows) {
    const bad =
      w.poolId !== poolId
        ? '池不对'
        : !w.label
          ? '没有名字'
          : labels.has(w.label)
            ? '名字重复'
            : [w.used, w.limit, w.utilization].some((n) => n !== undefined && !Number.isFinite(n))
              ? '数字不是有限数'
              : undefined;
    if (bad) {
      dropped.push(`窗口 ${w.label || '（无名）'} ${bad}，没收`);
      continue;
    }
    labels.add(w.label);
    out.push(w);
  }
  if (windows.length > 0 && out.length === 0) {
    throw new QuotaReadError(
      'bad_response',
      `读取器交回 ${windows.length} 个窗口，一个都不合格：${dropped.join('；')}`,
    );
  }
  notes.push(...dropped);
  return out;
}

function timeoutMessage(reader: ReaderType, timeoutMs: number): string {
  const span = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
  // mirasim 的整体预算到点单独一句，跟读取器里的「桥接连不上」「连上了等不到 relay 帧」分开。
  if (reader === 'mirasim-relay') return mirasimOverallBudgetMessage(timeoutMs);
  return `${span}内没读完`;
}

/** 内置的 mirasim-relay 读超时才重试。换上假读取器的测试、别的读取器、连不上 / 上游拒绝都不重试。 */
function retryMirasimTimeout(pool: PoolConfig, deps: QuotaDeps, result: PoolQuotaResult): boolean {
  return (
    pool.reader === 'mirasim-relay' &&
    deps.readers?.[pool.reader] === undefined &&
    !result.ok &&
    result.error.code === 'timeout'
  );
}

/** 再试之前的短退避。没给用默认；0 或认不出就不等。 */
function retryBackoffMs(deps: QuotaDeps): number {
  const n = deps.retryDelayMs ?? MIRASIM_RETRY_BACKOFF_MS;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readPool(
  pool: PoolConfig,
  config: QuotaConfig,
  deps: QuotaDeps,
  shared: Map<string, Promise<unknown>>,
): Promise<PoolQuotaResult> {
  const t0 = Date.now();
  let result = await readPoolAttempt(pool, config, deps, shared);
  if (retryMirasimTimeout(pool, deps, result)) {
    const delay = retryBackoffMs(deps);
    if (delay > 0) await sleep(delay);
    result = await readPoolAttempt(pool, config, deps, shared);
    if (result.ok) {
      result = { ...result, notes: [...result.notes, '上一次超时，本轮重试一次读成'] };
    }
  }
  return { ...result, durationMs: Date.now() - t0 };
}

async function readPoolAttempt(
  pool: PoolConfig,
  config: QuotaConfig,
  deps: QuotaDeps,
  shared: Map<string, Promise<unknown>>,
): Promise<PoolQuotaResult> {
  const now = deps.now ?? (() => new Date());
  const fetchedAt = now().toISOString();
  const t0 = Date.now();
  const base = { poolId: pool.poolId, channelId: pool.channelId, reader: pool.reader, startedAt: fetchedAt };
  const reader = deps.readers?.[pool.reader] ?? READERS[pool.reader];
  if (!reader) {
    return {
      ...base,
      ok: false,
      durationMs: 0,
      notes: [],
      error: { code: 'config', message: `没有这种读取器：${String(pool.reader)}` },
    };
  }
  const timeoutMs = pool.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS[pool.reader] ?? 20_000;
  const controller = new AbortController();
  const user = deps.asUser?.readers.includes(pool.reader) ? deps.asUser : undefined;
  const ctx: ReaderContext = {
    pool,
    fetchedAt,
    now,
    signal: controller.signal,
    fetch: deps.fetch,
    runCommand: user?.runCommand ?? deps.runCommand,
    readFile: user?.readFile ?? deps.readFile,
    listDir: deps.listDir,
    openWebSocket: deps.openWebSocket,
    workDir: user?.workDir ?? deps.workDir,
    homeDir: user?.homeDir ?? deps.homeDir,
    env: deps.env,
    shared<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let p = shared.get(key) as Promise<T> | undefined;
      if (!p) {
        p = fn();
        shared.set(key, p);
      }
      return p;
    },
  };
  if (deps.usageRecords) ctx.usageRecords = deps.usageRecords;
  if (user?.connectMirasim) ctx.connectMirasim = user.connectMirasim;
  // 续期命令按读取器接：Cursor 是 cursor-agent status，Grok 是 grok models。别把另一家的命令接到这个池上。
  const refresh =
    pool.reader === 'cursor-dashboard'
      ? user?.refreshCursorLogin
      : pool.reader === 'grok-billing'
        ? user?.refreshGrokLogin
        : undefined;
  if (refresh) ctx.refreshLogin = () => refresh(controller.signal);

  // 定时器先于读取器的中断回调把标志立上。两边谁先拒绝，只要预算到了，mirasim 的原因都写成「整体 N 秒用完」。
  let budgetExhausted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      budgetExhausted = true;
      controller.abort();
      reject(new QuotaReadError('timeout', timeoutMessage(pool.reader, timeoutMs)));
    }, timeoutMs);
  });
  try {
    const out: ReaderOutput = await Promise.race([reader(ctx), timeout]);
    const notes = [...(out.notes ?? [])];
    const windows = vetWindows(pool.poolId, out.windows, notes);
    const result: PoolQuotaResult = { ...base, ok: true, durationMs: Date.now() - t0, windows, notes };
    if (out.subscription) result.subscription = out.subscription;
    if (out.scopeModels) result.scopeModels = out.scopeModels;
    return result;
  } catch (e) {
    const error =
      pool.reader === 'mirasim-relay' && budgetExhausted
        ? { code: 'timeout' as const, message: mirasimOverallBudgetMessage(timeoutMs) }
        : toQuotaError(e);
    return { ...base, ok: false, durationMs: Date.now() - t0, notes: [], error };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
