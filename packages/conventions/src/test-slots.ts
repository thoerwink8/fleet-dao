// 本机「同时最多跑 N 个测试」的槽（pnpm test:changed 真起 vitest 之前拿一个，跑完还）。
// 为什么：几个会话、几个代理各在自己的工作树里同时起 vitest，机器被拖垮、单次跑十几分钟甚至超时（2026-10-04 夜实测）；
// AGENTS.md 早就规定本机只跑 test:changed，但没人拦着「同时跑」，所以拦在这个必经的入口上。只管本机：CI 里不拿槽。
//
// 改这里之前必须知道：
// - 纯 Node、跨平台（Windows、WSL、法国都要能跑，不用 flock）：槽 = 用户级目录（默认 ~/.fleet-dao/test-slots/，几个工作树共用同一把）
//   里的 slot-<序号>.json，里头记持有者的进程号、主机名、开始时间、工作目录。
// - 所有「看有几个槽被占、清死的、占一个」都在目录互斥锁（mkdir 是原子的）里做，不然两个进程同时发现同一个死槽、
//   各自删了再各自建，会双双拿到。互斥锁只在这几毫秒里持有；真有进程死在里面，超过 10 秒的互斥锁被后来者拆掉。
// - 槽文件先写临时文件再改名：别的进程不会读到半截的文件。
// - 回收：持有者进程号不存在（同一台主机才能判；别的主机只看时长）、或持有超过上限时长（防进程号被别的进程复用、防卡死）。
// - 读不到槽目录、写不进、槽文件格式认不出、等太久都抛 TestSlotError，调用方必须当没跑成，绝不能当成拿到了槽继续跑。
// - 不排队公平：谁在轮询的那一刻看到空槽谁拿，没有先来后到。要公平得加等候票，那又多一类会留在盘上的残骸，本机几个会话用不上。
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export class TestSlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestSlotError';
  }
}

export interface SlotConfig {
  /** 槽目录。几个工作树要共用，所以在用户级目录里、不在仓根 _tmp/。 */
  dir: string;
  /** 同时最多几个。 */
  slots: number;
  /** 拿不到槽最多等多久（毫秒），超了抛错。 */
  maxWaitMs: number;
  /** 一个槽最多持有多久（毫秒），超了当持有者已死、回收。 */
  maxHoldMs: number;
  /** 抢不到时隔多久再试（毫秒）。 */
  pollMs: number;
  /** 等的时候隔多久打一行（毫秒）。 */
  reportMs: number;
}

export const DEFAULT_SLOTS = 2;
export const DEFAULT_MAX_WAIT_MIN = 15;
export const DEFAULT_MAX_HOLD_MIN = 30;

/** 环境变量：同时几个 / 槽目录（测试和特殊机器用）/ 最多等几分钟 / 最多持有几分钟。 */
export const ENV_SLOTS = 'FLEET_LOCAL_TEST_SLOTS';
export const ENV_DIR = 'FLEET_LOCAL_TEST_SLOTS_DIR';
export const ENV_WAIT_MIN = 'FLEET_LOCAL_TEST_WAIT_MIN';
export const ENV_HOLD_MIN = 'FLEET_LOCAL_TEST_MAX_HOLD_MIN';
/** 拿到槽后写进 vitest 的环境：vitest 里再起的 test:changed（测试里真跑入口的那几条）看到它就不再抢槽，免得自己等自己。 */
export const ENV_HELD = 'FLEET_LOCAL_TEST_SLOT_HELD';

type Env = Readonly<Record<string, string | undefined>>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new TestSlotError(`${name}=${JSON.stringify(raw)} 不是正整数`);
  }
  return Number(raw);
}

function positiveNumber(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new TestSlotError(`${name}=${JSON.stringify(raw)} 不是正数`);
  return n;
}

/** 从环境变量读配置；写错了（不是数、小于 1）抛 TestSlotError，不悄悄用默认值。home 读不到也抛。 */
export function readSlotConfig(env: Env, home: () => string = homedir): SlotConfig {
  const given = env[ENV_DIR]?.trim();
  let dir: string;
  if (given !== undefined && given !== '') {
    dir = given;
  } else {
    const h = home();
    if (h === '')
      throw new TestSlotError('读不到用户目录，没法放槽文件（可设 FLEET_LOCAL_TEST_SLOTS_DIR 指定槽目录）');
    dir = join(h, '.fleet-dao', 'test-slots');
  }
  return {
    dir,
    slots: positiveInt(env, ENV_SLOTS, DEFAULT_SLOTS),
    maxWaitMs: positiveNumber(env, ENV_WAIT_MIN, DEFAULT_MAX_WAIT_MIN) * 60_000,
    maxHoldMs: positiveNumber(env, ENV_HOLD_MIN, DEFAULT_MAX_HOLD_MIN) * 60_000,
    pollMs: 1000,
    reportMs: 10_000,
  };
}

/** 要不要拿槽：CI 里不拿（GitHub 的机器一台跑一个任务，不改 CI 怎么跑测试）；已经在拿着槽的 vitest 里（ENV_HELD）不再拿。 */
export function slotPolicy(env: Env): { kind: 'lock' } | { kind: 'skip'; why: string } {
  const held = env[ENV_HELD]?.trim();
  if (held !== undefined && held !== '') return { kind: 'skip', why: '外层已经拿着本机测试槽' };
  const ci = env.CI?.trim().toLowerCase();
  if (ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0') return { kind: 'skip', why: '在 CI 里' };
  return { kind: 'lock' };
}

/** 槽文件里写的。 */
export interface Holder {
  v: 1;
  token: string;
  pid: number;
  host: string;
  /** 拿到槽的时刻（毫秒）。 */
  startedAt: number;
  cwd: string;
}

/** 能换成假的部分：时间、睡觉、进程是否还活着、本进程是谁。 */
export interface SlotDeps {
  now(): number;
  /** 同步睡（本入口整条链都是同步的：spawnSync 跑 vitest）。 */
  sleep(ms: number): void;
  pidAlive(pid: number): boolean;
  pid: number;
  host: string;
  cwd: string;
  log(line: string): void;
}

/** 进程号是否还在：signal 0 只探测不发信号；EPERM 是在、只是不归我们。 */
export function realPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function realSlotDeps(log: (line: string) => void): SlotDeps {
  return {
    now: () => Date.now(),
    sleep(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    pidAlive: realPidAlive,
    pid: process.pid,
    host: hostname(),
    cwd: process.cwd(),
    log,
  };
}

const SLOT_FILE = /^slot-([0-9]+)\.json$/;
const TMP_PREFIX = '.tmp-';
const MUTEX = '.mutex';
/** 互斥锁正常只持有几毫秒；超过这么久还在，当持有它的进程死在里面了。 */
const MUTEX_STALE_MS = 10_000;
const MUTEX_WAIT_MS = 5000;
/** 槽目录里留下的临时文件（写到一半被杀）过这么久就清掉。 */
const TMP_STALE_MS = 10 * 60_000;

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

function fail(what: string, dir: string, e: unknown): never {
  const c = code(e);
  throw new TestSlotError(
    `本机测试槽没法用：${what}（${dir}${c ? `，${c}` : ''}：${e instanceof Error ? e.message : String(e)}）。` +
      '要绕过它就直接 pnpm exec vitest run <路径>，但那会不受「同时最多几个」管',
  );
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    fail('槽目录建不出来、或那个路径是个文件', dir, e);
  }
}

/** 在目录互斥锁里干活。拿不到（5 秒）、建不了（权限、路径不对）都抛 TestSlotError。 */
function withMutex<T>(cfg: SlotConfig, deps: SlotDeps, fn: () => T): T {
  const lock = join(cfg.dir, MUTEX);
  const deadline = deps.now() + MUTEX_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      const c = code(e);
      // Windows 上刚被删的目录再建会报 EPERM/EBUSY，和「已经有了」一样等一下再试
      if (c !== 'EEXIST' && c !== 'EPERM' && c !== 'EBUSY') fail('槽目录写不进', cfg.dir, e);
      try {
        if (Date.now() - statSync(lock).mtimeMs > MUTEX_STALE_MS) rmdirSync(lock);
      } catch {
        // 刚好被别人放掉了：下一圈再试
      }
      if (deps.now() >= deadline) fail(`互斥锁 ${MUTEX} 等了 ${MUTEX_WAIT_MS / 1000} 秒还被占着`, cfg.dir, e);
      deps.sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // 放不掉：超过 MUTEX_STALE_MS 后会被后来者拆掉
    }
  }
}

function parseHolder(text: string, file: string): Holder {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    v = undefined;
  }
  const h = v as Partial<Holder> | null | undefined;
  if (
    h === null ||
    typeof h !== 'object' ||
    h.v !== 1 ||
    typeof h.token !== 'string' ||
    typeof h.pid !== 'number' ||
    typeof h.host !== 'string' ||
    typeof h.startedAt !== 'number' ||
    typeof h.cwd !== 'string'
  ) {
    throw new TestSlotError(
      `槽文件格式认不出：${file}。不知道是谁占着，不当成空槽；确认没有测试在跑后删掉它（或整个槽目录）再试`,
    );
  }
  return h as Holder;
}

/** 这个持有者还算不算数。dead = 同一台主机上进程号已不存在；expired = 持有超过上限时长。 */
export function staleReason(h: Holder, cfg: SlotConfig, deps: SlotDeps): 'dead' | 'expired' | undefined {
  if (deps.now() - h.startedAt > cfg.maxHoldMs) return 'expired';
  if (h.host === deps.host && !deps.pidAlive(h.pid)) return 'dead';
  return undefined;
}

export interface SlotHandle {
  /** 槽文件里的 token，也是 ENV_HELD 要写的值。 */
  token: string;
  release(): void;
}

export type TryResult = { kind: 'got'; handle: SlotHandle } | { kind: 'busy'; holders: Holder[] };

/** 试一次：有空槽就占（回 got），满了回 busy 和在跑的那些。死的、超时的槽先清掉。出任何岔子抛 TestSlotError。 */
export function tryAcquire(cfg: SlotConfig, deps: SlotDeps): TryResult {
  ensureDir(cfg.dir);
  return withMutex(cfg, deps, () => {
    let names: string[];
    try {
      names = readdirSync(cfg.dir);
    } catch (e) {
      return fail('读不了槽目录', cfg.dir, e);
    }
    const live = new Map<number, Holder>();
    for (const name of names) {
      const file = join(cfg.dir, name);
      if (name.startsWith(TMP_PREFIX)) {
        try {
          if (Date.now() - statSync(file).mtimeMs > TMP_STALE_MS) unlinkSync(file);
        } catch {
          // 别人刚清掉了
        }
        continue;
      }
      const m = SLOT_FILE.exec(name);
      if (m === null) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (e) {
        if (code(e) === 'ENOENT') continue;
        return fail(`读不了槽文件 ${name}`, cfg.dir, e);
      }
      const holder = parseHolder(text, file);
      const why = staleReason(holder, cfg, deps);
      if (why === undefined) {
        live.set(Number(m[1]), holder);
        continue;
      }
      deps.log(
        `回收本机测试槽 ${name}：${why === 'dead' ? `持有者进程 ${holder.pid} 已经不在` : `持有超过 ${Math.round(cfg.maxHoldMs / 60_000)} 分钟`}（${holder.cwd}）`,
      );
      try {
        unlinkSync(file);
      } catch (e) {
        if (code(e) !== 'ENOENT') return fail(`删不掉死槽 ${name}`, cfg.dir, e);
      }
    }
    if (live.size >= cfg.slots) return { kind: 'busy', holders: [...live.values()] };
    // 空着的最小序号：占着的最多 live.size < slots 个，所以 0..slots-1 里一定有空
    let index = 0;
    while (live.has(index)) index += 1;
    const token = randomBytes(8).toString('hex');
    const holder: Holder = {
      v: 1,
      token,
      pid: deps.pid,
      host: deps.host,
      startedAt: deps.now(),
      cwd: deps.cwd,
    };
    const slotFile = join(cfg.dir, `slot-${index}.json`);
    const tmp = join(cfg.dir, `${TMP_PREFIX}${token}`);
    try {
      writeFileSync(tmp, JSON.stringify(holder));
      renameSync(tmp, slotFile);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // 没建出来
      }
      return fail('写不进槽文件', cfg.dir, e);
    }
    return { kind: 'got', handle: { token, release: () => releaseSlot(slotFile, token, deps) } };
  });
}

/** 还槽：只删自己的（token 对得上）；槽已被回收、被别人占了就不动。放不掉只警告：别因此盖掉测试本身的结果。 */
function releaseSlot(file: string, token: string, deps: SlotDeps): void {
  try {
    const h = parseHolder(readFileSync(file, 'utf8'), file);
    if (h.token === token) unlinkSync(file);
  } catch (e) {
    if (code(e) === 'ENOENT') return;
    deps.log(`没能还本机测试槽 ${file}：${e instanceof Error ? e.message : String(e)}（过期后会被别人回收）`);
  }
}

function describeHolders(holders: readonly Holder[], now: number): string {
  return holders
    .map((h) => `进程 ${h.pid}（${h.cwd}，已跑 ${Math.round((now - h.startedAt) / 1000)} 秒）`)
    .join('；');
}

/** 拿一个槽，满了就排队：每 reportMs 打一行；等过 maxWaitMs 抛 TestSlotError。 */
export function acquireSlot(cfg: SlotConfig, deps: SlotDeps): SlotHandle {
  const start = deps.now();
  let lastReport = Number.NEGATIVE_INFINITY;
  let first = true;
  for (;;) {
    const r = tryAcquire(cfg, deps);
    if (r.kind === 'got') {
      if (!first) deps.log(`拿到本机测试槽，共等了 ${Math.round((deps.now() - start) / 1000)} 秒`);
      return r.handle;
    }
    const now = deps.now();
    const waited = now - start;
    if (waited >= cfg.maxWaitMs) {
      throw new TestSlotError(
        `本机测试槽等了 ${Math.round(waited / 1000)} 秒还是满的（同时最多 ${cfg.slots} 个；占着的：${describeHolders(r.holders, now)}）。` +
          `没跑测试，不是测试没过：等前面的跑完再来；确认前面的已经卡死就删槽目录 ${cfg.dir} 里对应的 slot-*.json`,
      );
    }
    if (now - lastReport >= cfg.reportMs) {
      deps.log(
        `本机测试槽满了（同时最多 ${cfg.slots} 个）：前面还有 ${r.holders.length} 个在跑，已等 ${Math.round(waited / 1000)} 秒` +
          (first ? `；占着的：${describeHolders(r.holders, now)}` : ''),
      );
      lastReport = now;
    }
    first = false;
    deps.sleep(Math.min(cfg.pollMs, Math.max(1, cfg.maxWaitMs - waited)));
  }
}

/** 和 test-changed.ts 的 vitest 依赖同一个形状：退出码（被信号杀掉是 null）、信号、起不来的原因。 */
export interface RunResult {
  status: number | null;
  signal?: string | null;
  error?: Error | undefined;
}

/**
 * pnpm test:changed 真起 vitest 的那一步：按 slotPolicy 决定拿不拿槽，拿了就带着 ENV_HELD 跑 run。
 * 拿不到槽（满了等太久、槽目录用不了、环境变量写错）回 {status: null, error}——上游当「没跑成」（退出码 2），
 * 不是测试没过，更不会当成拿到了槽继续跑。
 */
export function runInSlot(env: Env, deps: SlotDeps, run: (held: string | undefined) => RunResult): RunResult {
  if (slotPolicy(env).kind === 'skip') return run(undefined);
  try {
    return withTestSlot(readSlotConfig(env), deps, (handle) => run(handle.token));
  } catch (e) {
    if (e instanceof TestSlotError) return { status: null, error: e };
    throw e;
  }
}

/** 拿槽、跑 fn、还槽（fn 抛了也还）。拿不到抛 TestSlotError，fn 不会被调用。 */
export function withTestSlot<T>(cfg: SlotConfig, deps: SlotDeps, fn: (handle: SlotHandle) => T): T {
  const handle = acquireSlot(cfg, deps);
  try {
    return fn(handle);
  } finally {
    handle.release();
  }
}
