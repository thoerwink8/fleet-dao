// 动手会话收场后，引擎自己在会话的树里跑一遍测试和类型检查（selfCheck，决定 0093）：仓的测试命令（repos.test_command），
// 再加 tsc（树里有 tsconfig.json 和装好的 tsc 才跑）。红了工作流把精炼输出续进同一个会话再改一次；结果也交给冷验收当材料。
//
// 改这里之前必须知道：
// - 不抛：树不在、没装依赖、没有命令、超时、起不来，一律回 skipped 加原因（或那一条记 skipped），原流程照旧推 PR 交给 CI。
//   只有入参认不出才抛。要全跑之后改跑受影响包的那次超时例外：记没过（自测超时），不当成过了。
// - 以树主人（会话用户）的身份跑（经 exec，和读交付同一条路）：引擎不以自己的身份在会话的树里跑东西（design 十四）。
// - 不带 FLEET_RUN_ID：pnpm test:changed 见到它会全跑（会话里那套），这里只要跑改到的。退出 2（没算成要跑什么、
//   排不上本机测试槽）不是测试没过，记 skipped。退出 3（要全跑）不再只跑 tsc：在整机同一时刻只跑一个的锁下
//   再跑 `pnpm test:changed --affected`（受影响的包），锁被占就排队、不跳过。
// - 同机测试容量各有一个主人，不叠两层：
//   · vitest 的容量归 test:changed 自己的本机测试槽（packages/conventions/src/test-slots.ts）：会话里、人手跑的
//     test:changed 和引擎自测在同一组槽上排队。测试命令是 test:changed 时引擎不另占名额，也不设「已持槽」的环境变量冒充拿着槽。
//   · 自测名额（锁目录里的 slot-0、slot-1，SELF_CHECK_SLOTS 个）只管 tsc 和不走 test:changed 的测试命令（go test 这类）。
// - 排队和真执行分开计时（数字在 self-check-budget.ts）：所有排队（本机测试槽、整机锁、自测名额）合起来 SELF_CHECK_QUEUE_MS；
//   测试真执行 SELF_CHECK_TEST_MS 从 test:changed 打出「拿到本机测试槽」（老的树没排队时不打，认 vitest 开跑的 RUN 横幅）起算，
//   别的命令从拿到名额起算；tsc SELF_CHECK_TSC_MS。排队超了、执行超了都杀掉命令，各记各的原因。
// - 心跳带阶段：probe（看目录）、queue（等什么）、test、tsc、done，阶段起点和最后一次有输出的时刻；不编完成了几条。
// - 普通那次超时记 skipped，不算红——慢不等于错，交给 CI；但超时前输出里已经有没过的（FAIL、×）记没过，不掩盖。
//   超时、被叫停、没正常退出都把已有输出精炼、脱敏后留在摘要里，写明在哪个阶段、跑了多久。
// - 精炼输出：挑出像失败的行（FAIL、error、×、AssertionError、TSxxxx）再加末尾一段，限 SELF_CHECK_DIGEST_MAX 字。

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redact, type SessionUser } from '@fleet-dao/adapters';
import type { RepoWithProfile } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type PortContext, PortError } from '../ports.ts';
import {
  SELF_CHECK_CLEANUP_MS,
  SELF_CHECK_PROBE_MS,
  SELF_CHECK_QUEUE_MS,
  SELF_CHECK_SLOTS,
  SELF_CHECK_TEST_MS,
  SELF_CHECK_TSC_MS,
} from '../self-check-budget.ts';
import {
  SELF_CHECK_DIGEST_MAX,
  type SelfCheckInput,
  type SelfCheckResult,
  type SelfCheckStep,
} from '../task-contract.ts';
import type { UserCommandResult, UserExec } from './exec.ts';

export {
  SELF_CHECK_ACTIVITY_MS,
  SELF_CHECK_CLEANUP_MS,
  SELF_CHECK_PROBE_MS,
  SELF_CHECK_QUEUE_MS,
  SELF_CHECK_SLOTS,
  SELF_CHECK_TEST_MS,
  SELF_CHECK_TSC_MS,
} from '../self-check-budget.ts';

/** 多久报一次心跳（活动的心跳超时是 limits.heartbeatSeconds，默认 120 秒）。排队等名额时也按这个间隔打；换阶段时当下补一下。 */
export const SELF_CHECK_HEARTBEAT_MS = 30_000;
/**
 * 会话用户的 PATH：node、pnpm 在 /usr/bin 或 /usr/local/bin（法国 pnpm 在 /usr/local/bin）。
 * Go 不在这三处：本机装在会话用户家里的 ~/.local/go/bin，官方包在 /usr/local/go/bin。
 * mirasim-reclaude 的测试要起 go test；不带上的话 spawn 报 ENOENT，整段自测红。
 * $HOME 由会话用户的 shell 展开。
 */
const PATH = '$HOME/.local/go/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin';
/** 这些工具链表示仓要 Node 依赖。pnpm / npm / yarn 单独写、不带 node 时也算。 */
const NODE_TOOLS: ReadonlySet<string> = new Set(['node', 'pnpm', 'npm', 'yarn']);
const SH = '/bin/sh';
const TSC = 'node_modules/.bin/tsc';
/** 锁目录放哪（几个引擎进程共用）。测试和特殊机器用。 */
const ENV_LOCK_DIR = 'FLEET_SELF_CHECK_LOCK_DIR';
/** 受影响包那把锁最多算数多久：持有期间要等本机测试槽、再跑测试、收尾，再加一分钟，超时当持有者已死。 */
const LOCK_STALE_MS = SELF_CHECK_QUEUE_MS + SELF_CHECK_TEST_MS + SELF_CHECK_CLEANUP_MS + 60_000;
/** 一个名额最多算数多久：测试加 tsc 加收尾再加一分钟。活进程占着这么久才当它已死；死进程当下就拆。 */
const SLOT_STALE_MS = SELF_CHECK_TEST_MS + SELF_CHECK_TSC_MS + SELF_CHECK_CLEANUP_MS + 60_000;
const LOCK_POLL_MS = 250;

/** test:changed 的退出码 2：没算成要跑什么，不是测试没过（packages/conventions/src/bin/test-changed.ts）。 */
const TEST_CHANGED_NOT_RUN: Readonly<Record<number, string>> = {
  2: '没算成要跑哪些测试（读不到主线、排不上本机测试槽……）',
};

/**
 * test:changed 真开跑测试的标记：拿到本机测试槽时一定打的那一行（packages/conventions/src/test-slots.ts 的
 * SLOT_ACQUIRED_LINE，改字两边一起改），或 vitest 开跑的 RUN 横幅（老的树没排队时不打那一行）。见到之前都算在排队。
 */
const SLOT_ACQUIRED = /拿到本机测试槽|^\s*RUN\s+v\d/m;
/** 认标记时只看最近这么多字（标记可能被切在两段输出之间）。 */
const MARKER_WINDOW = 2_000;

/** 整机同一时刻只跑一个「要全跑时改跑受影响包」。acquire 在 signal 中止时抛错。 */
export interface SelfCheckFullLock {
  acquire(signal: AbortSignal): Promise<() => void | Promise<void>>;
}

export interface SelfCheckDeps {
  trees: { ownerOf(dir: string): Promise<SessionUser | null> };
  exec: UserExec;
  /** 测试里调短。testMs 是测试真执行的上限，queueMs 是一次自测所有排队合起来的上限。 */
  testMs?: number;
  tscMs?: number;
  queueMs?: number;
  /** 不给就用整机文件锁（排队）。测试换成可控的。 */
  fullLock?: SelfCheckFullLock;
  /**
   * 同时跑的名额（默认整机 SELF_CHECK_SLOTS 个）。测试换成一直有名额的，或换到临时目录。
   * tsc 和不走 test:changed 的测试命令先拿到名额再跑（test:changed 在它自己的本机测试槽上排队）；等名额吃排队预算，不吃测试预算。
   */
  slots?: SelfCheckFullLock;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

class LockAbort extends Error {
  constructor() {
    super('aborted');
    this.name = 'LockAbort';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new LockAbort());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LockAbort());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function codeOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/** 一代锁的文件名：16 位十六进制。拆锁只删这个名字，不按目录路径整棵删。 */
const TOKEN_NAME = /^[0-9a-f]{16}$/;
const PENDING_PREFIX = 'pending-';

function holderStale(text: string, staleMs: number): boolean {
  const [pidRaw, startedRaw] = text.split('\n');
  const pid = Number(pidRaw);
  const started = Number(startedRaw);
  if (!Number.isFinite(started) || Date.now() - started > staleMs) return true;
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return true;
  return false;
}

/** 丢掉还没公布的那一代。改名成功之后目录已经不在这个路径上，删不掉别人的锁。 */
async function discardPending(pending: string, token: string): Promise<void> {
  try {
    await unlink(join(pending, token));
  } catch {
    // 文件还没写出来，或已经跟着目录改名走了
  }
  try {
    await rmdir(pending);
  } catch {
    // 目录已经不在
  }
}

/**
 * 放掉自己这一代。先删自己的令牌文件：删不到（被人收走了）就不动目录，
 * 避免把后拿到的新锁整棵删掉。目录空了才 rmdir；里面有下一代的文件时 rmdir 会失败，留下。
 */
async function releaseGeneration(lockDir: string, token: string): Promise<void> {
  try {
    await unlink(join(lockDir, token));
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return;
    throw e;
  }
  try {
    await rmdir(lockDir);
  } catch {
    // 下一代已经放进文件，或目录已经被拆掉
  }
}

/** 崩溃留下的 pending-*：过了时限才收。正在公布的那一代是新的，不会被收走。 */
async function sweepPending(dir: string, staleMs: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(PENDING_PREFIX)) continue;
    const pending = join(dir, name);
    try {
      const s = await stat(pending);
      if (now - s.mtimeMs <= staleMs) continue;
      for (const child of await readdir(pending)) {
        await unlink(join(pending, child)).catch(() => undefined);
      }
      await rmdir(pending).catch(() => undefined);
    } catch {
      // 刚好被主人公布或自己收掉了
    }
  }
}

/**
 * 过期的那一代拆掉，好让调用方再公布。只 unlink 当时看见的令牌文件名，再 rmdir。
 * 不 rm 整棵目录：几个等待者都判定过期之后，先拿到新锁的人已经换成了另一个文件名，
 * 后动手的 unlink 对不上那个名字，删不掉新锁。一次 unlink 都没成功就不 rmdir。
 */
async function stealStale(
  lockDir: string,
  staleMs: number,
  hooks: { beforeRemove?: () => Promise<void> | void; afterRemove?: () => Promise<void> | void },
): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(lockDir);
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return true;
    throw e;
  }
  const tokens = names.filter((name) => TOKEN_NAME.test(name));
  if (tokens.length === 0) {
    let s: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      s = await stat(lockDir);
    } catch (e) {
      if (codeOf(e) === 'ENOENT') return true;
      throw e;
    }
    if (s === undefined || Date.now() - s.mtimeMs <= staleMs) return false;
    await hooks.beforeRemove?.();
    try {
      await rmdir(lockDir);
    } catch {
      // 新锁已经放进令牌文件（非空目录删不掉），或目录没了
      return false;
    }
    await hooks.afterRemove?.();
    return true;
  }
  const staleNames: string[] = [];
  for (const name of tokens) {
    let text: string;
    try {
      text = await readFile(join(lockDir, name), 'utf8');
    } catch (e) {
      if (codeOf(e) === 'ENOENT') continue;
      throw e;
    }
    if (holderStale(text, staleMs)) staleNames.push(name);
  }
  if (staleNames.length === 0 || staleNames.length !== tokens.length) return false;
  await hooks.beforeRemove?.();
  let unlinked = 0;
  for (const name of staleNames) {
    try {
      await unlink(join(lockDir, name));
      unlinked += 1;
    } catch (e) {
      if (codeOf(e) !== 'ENOENT') throw e;
    }
  }
  await hooks.afterRemove?.();
  if (unlinked === 0) return false;
  try {
    await rmdir(lockDir);
  } catch {
    // 下一代的令牌文件已经在里面，rmdir 失败就留下
  }
  return true;
}

/**
 * 把已经写好令牌的私有目录改名成锁目录。改名是原子的：目标里已经有别人的令牌文件时会失败，
 * 不会盖掉那一把。失败只丢掉自己的 pending，不动锁目录。
 */
async function publish(dir: string, lockDir: string, token: string, signal: AbortSignal): Promise<boolean> {
  try {
    await stat(lockDir);
    return false;
  } catch (e) {
    if (codeOf(e) !== 'ENOENT') throw e;
  }
  const pending = join(dir, `${PENDING_PREFIX}${token}`);
  let published = false;
  try {
    await discardPending(pending, token);
    await mkdir(pending);
    await writeFile(join(pending, token), `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
    if (signal.aborted) throw new LockAbort();
    try {
      await rename(pending, lockDir);
      published = true;
      return true;
    } catch (e) {
      const code = codeOf(e);
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOENT') return false;
      throw e;
    }
  } finally {
    if (!published) await discardPending(pending, token);
  }
}

/**
 * 整机一把锁：同一时刻只有一个公布成功的目录。占着就隔一会儿再试（排队），不跳过。
 * 死进程或持有太久的那一代，只按当时看见的令牌文件名拆；signal 中止时抛 LockAbort。
 * beforeRemove / afterRemove 只给测试把「判定过期」和「真删」拆开。
 */
export function createAffectedLock(
  dir: string,
  opts?: {
    pollMs?: number;
    staleMs?: number;
    beforeRemove?: () => Promise<void> | void;
    afterRemove?: () => Promise<void> | void;
  },
): SelfCheckFullLock {
  const pollMs = opts?.pollMs ?? LOCK_POLL_MS;
  const staleMs = opts?.staleMs ?? LOCK_STALE_MS;
  const hooks: {
    beforeRemove?: () => Promise<void> | void;
    afterRemove?: () => Promise<void> | void;
  } = {};
  if (opts?.beforeRemove !== undefined) hooks.beforeRemove = opts.beforeRemove;
  if (opts?.afterRemove !== undefined) hooks.afterRemove = opts.afterRemove;
  const lockDir = join(dir, 'affected.lock');
  return {
    async acquire(signal: AbortSignal): Promise<() => Promise<void>> {
      const token = randomBytes(8).toString('hex');
      await mkdir(dir, { recursive: true });
      await sweepPending(dir, staleMs);
      for (;;) {
        if (signal.aborted) throw new LockAbort();
        if (await publish(dir, lockDir, token, signal)) {
          if (signal.aborted) {
            await releaseGeneration(lockDir, token);
            throw new LockAbort();
          }
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            await releaseGeneration(lockDir, token);
          };
        }
        const stole = await stealStale(lockDir, staleMs, hooks);
        if (!stole) await sleep(pollMs, signal);
      }
    },
  };
}

/**
 * 同一目录里最多 slots 个名额（默认 SELF_CHECK_SLOTS）。每个名额是一把现成的目录锁
 * （slot-0、slot-1……），和受影响包那把锁同一套公布、拆死进程，不另引依赖。
 * 满了就隔一会儿再试，signal 中止抛错。
 */
export function createSelfCheckSlots(
  dir: string,
  opts?: { slots?: number; pollMs?: number; staleMs?: number },
): SelfCheckFullLock {
  const slots = opts?.slots ?? SELF_CHECK_SLOTS;
  const pollMs = opts?.pollMs ?? LOCK_POLL_MS;
  const staleMs = opts?.staleMs ?? SLOT_STALE_MS;
  return {
    async acquire(signal: AbortSignal): Promise<() => Promise<void>> {
      const token = randomBytes(8).toString('hex');
      await mkdir(dir, { recursive: true });
      await sweepPending(dir, staleMs);
      for (;;) {
        if (signal.aborted) throw new LockAbort();
        for (let i = 0; i < slots; i++) {
          const lockDir = join(dir, `slot-${i}`);
          await stealStale(lockDir, staleMs, {});
          if (await publish(dir, lockDir, token, signal)) {
            if (signal.aborted) {
              await releaseGeneration(lockDir, token);
              throw new LockAbort();
            }
            let released = false;
            return async () => {
              if (released) return;
              released = true;
              await releaseGeneration(lockDir, token);
            };
          }
        }
        await sleep(pollMs, signal);
      }
    },
  };
}

let defaultLock: SelfCheckFullLock | undefined;
let defaultSlots: SelfCheckFullLock | undefined;

function selfCheckLockRoot(): string | null {
  const given = process.env[ENV_LOCK_DIR]?.trim();
  if (given) return given;
  const home = homedir();
  if (home === '') return null;
  return join(home, '.fleet-dao', 'self-check-locks');
}

function missingLock(): SelfCheckFullLock {
  return {
    async acquire() {
      throw new Error(`读不到用户目录，没法放自测锁（可设 ${ENV_LOCK_DIR}）`);
    },
  };
}

/** 引擎进程共用的那把锁。用户目录读不到就 acquire 抛错，调用方记没跑成，不当成过了。 */
function machineAffectedLock(): SelfCheckFullLock {
  if (defaultLock) return defaultLock;
  const root = selfCheckLockRoot();
  if (root === null) return missingLock();
  defaultLock = createAffectedLock(root);
  return defaultLock;
}

/** 引擎进程共用的名额。和受影响包的锁放在同一棵目录下。 */
function machineSelfCheckSlots(): SelfCheckFullLock {
  if (defaultSlots) return defaultSlots;
  const root = selfCheckLockRoot();
  if (root === null) return missingLock();
  defaultSlots = createSelfCheckSlots(join(root, 'slots'));
  return defaultSlots;
}

let seq = 0;
function scopeId(taskId: string, what: string): string {
  seq = (seq + 1) % 1_000_000;
  return `selfcheck-${what}-${taskId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24)}-${seq}`;
}

/** 单引号包一层给 sh：里面的单引号拆开转义。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const FAILURE_LINE = /\bFAIL\b|\b[Ee]rror\b|ERR!|×|✗|AssertionError|\bTS\d{4}\b|\bfailed\b|Expected|Received/;
const TAIL_LINES = 40;

/**
 * 精炼输出：像失败的行（去掉连着重复的）先列，再加末尾一段（vitest、tsc 的汇总都在末尾），合起来限 max 字。
 * 控制字符（颜色码）去掉。纯函数，测试直接调。
 */
export function digestOutput(raw: string, max = SELF_CHECK_DIGEST_MAX): string {
  const lines = cleanText(raw)
    .split('\n')
    .map((l) => l.trimEnd());
  const tail = lines.filter((l) => l.trim() !== '').slice(-TAIL_LINES);
  const tailSet = new Set(tail);
  const picked: string[] = [];
  for (const line of lines) {
    if (!FAILURE_LINE.test(line) || tailSet.has(line)) continue;
    if (picked[picked.length - 1] === line) continue;
    picked.push(line);
  }
  const tailText = tail.join('\n');
  // 末尾一段优先保住（汇总在那里），失败行占剩下的
  const room = Math.max(0, max - tailText.length - 20);
  let head = '';
  for (const line of picked) {
    if (head.length + line.length + 1 > room) {
      head += '…（中间省略）\n';
      break;
    }
    head += `${line}\n`;
  }
  const out = head ? `${head}……\n${tailText}` : tailText;
  return out.length > max ? `…${out.slice(out.length - max + 1)}` : out;
}

function notRun(command: string, why: string): SelfCheckStep {
  return { command, outcome: 'skipped', exitCode: null, digest: why };
}

/** 要全跑之后那次没在时限里跑完：算没过，不当成跳过。detail 写在哪一段超的、已有的输出。 */
function timeoutStep(command: string, detail?: string): SelfCheckStep {
  return { command, outcome: 'fail', exitCode: null, digest: detail ? `自测超时：${detail}` : '自测超时' };
}

/** 没跑完时留下的证据最多多少字（再加阶段、时刻那一行，不超过 SELF_CHECK_DIGEST_MAX）。 */
const EVIDENCE_MAX = 2_500;
/** 输出里已经有没过的：vitest 的 FAIL、×，go test 的 --- FAIL，AssertionError，「N failed」。 */
const KNOWN_FAILURE = /^\s*(?:---\s+)?FAIL\b|^\s*[×✗]\s|AssertionError|\b\d+ failed\b/m;

function cleanText(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 去掉终端颜色码
  return raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
}

/** 没跑完时的已有输出：精炼、逐行脱敏（令牌、邮箱、IP、长串），限 EVIDENCE_MAX 字。没有输出就照实说。 */
function evidence(output: string): string {
  if (cleanText(output).trim() === '') return '没有任何输出。';
  const lines = digestOutput(output, EVIDENCE_MAX)
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : redact(line, 400)));
  return `已有输出（精炼、脱敏）：\n${lines.join('\n')}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

/** 一条命令跑下来的样子：结果，加上排队、执行各从哪一刻起，最后一次有输出的时刻，是被哪一段的上限停掉的。 */
interface Ran {
  r: UserCommandResult;
  output: string;
  spawnedAt: number;
  /** 真开跑的时刻；一直在排队（或没认出标记）是 null。 */
  execStartedAt: number | null;
  /** 跑完（或被停）的时刻。 */
  endedAt: number;
  lastOutputAt: number | null;
  /** 被哪一段的上限停掉：queue = 排队超了，exec = 执行超了。 */
  over?: 'queue' | 'exec';
  /** 活动被叫停。 */
  cancelled: boolean;
  /** 等的是什么（在命令里排队时）。 */
  waitingFor?: string;
}

/** 阶段、时刻那一行：每个时刻都是 ISO（UTC），能和日志对。 */
function timingLine(ran: Ran): string {
  const parts: string[] = [];
  if (ran.waitingFor !== undefined) {
    const queuedUntil = ran.execStartedAt ?? ran.endedAt;
    parts.push(`等${ran.waitingFor} ${duration(queuedUntil - ran.spawnedAt)}（${iso(ran.spawnedAt)} 起）`);
  }
  parts.push(
    ran.execStartedAt === null
      ? '没开跑'
      : `执行 ${duration(ran.endedAt - ran.execStartedAt)}（${iso(ran.execStartedAt)} 起）`,
  );
  parts.push(`最后一次输出 ${ran.lastOutputAt === null ? '没有' : iso(ran.lastOutputAt)}`);
  return `${parts.join('；')}。`;
}

/**
 * 一条命令跑完怎么记。没跑完的（超时、被叫停、没正常退出）一律带阶段、时刻和已有的输出：
 * - 超时前输出里已经有没过的：记没过（exitCode null），不当成跳过。
 * - strict（要全跑之后那次）：超时（排队或执行）记自测超时、没过。
 * - 其余没跑完的、起不来的记 skipped，不算红——慢不等于错，交给 CI。
 */
function stepOfRun(
  command: string,
  ran: Ran,
  limitMs: number,
  notRunCodes: Readonly<Record<number, string>>,
  strict: boolean,
): SelfCheckStep {
  const { r, output } = ran;
  if (r.spawnError) return notRun(command, `起不来：${r.spawnError}`);
  const unfinished = (why: string) => `${why}\n${timingLine(ran)}\n${evidence(output)}`;
  if (ran.cancelled) return notRun(command, unfinished('被叫停了，没跑完'));
  // exec 自己的时限只是兜底，按段的计时器先到；兜底到了按执行超时记
  const over = ran.over ?? (r.timedOut ? 'exec' : undefined);
  if (over !== undefined) {
    const why =
      over === 'queue'
        ? `排队超过剩下的排队预算（一次自测合计 ${Math.round(SELF_CHECK_QUEUE_MS / 60_000)} 分钟），没开跑`
        : `执行超过 ${duration(limitMs)}，没跑完`;
    if (KNOWN_FAILURE.test(cleanText(output))) {
      return { command, outcome: 'fail', exitCode: null, digest: unfinished(`${why}；超时前已经有没过的`) };
    }
    if (strict) return timeoutStep(command, unfinished(why));
    return notRun(command, unfinished(`${why}，交给 CI`));
  }
  if (r.aborted || r.code === null) return notRun(command, unfinished('没正常退出'));
  const why = notRunCodes[r.code];
  if (why !== undefined) return { command, outcome: 'skipped', exitCode: r.code, digest: why };
  return {
    command,
    outcome: r.code === 0 ? 'pass' : 'fail',
    exitCode: r.code,
    digest: digestOutput(output),
  };
}

/** test:changed 退出 3：判出要全跑、本机没跑。超时、被叫停、起不来不是这个码。 */
function fullRunRefusal(r: UserCommandResult): boolean {
  return r.code === 3 && !r.timedOut && !r.aborted && r.spawnError === undefined;
}

function affectedCommand(testCommand: string): string {
  if (/(^|\s)--affected(\s|$)/.test(testCommand)) return testCommand;
  return `${testCommand} --affected`;
}

type Phase = 'probe' | 'queue' | 'test' | 'tsc' | 'done';

/** 在名额、锁上排队的结局。 */
type Waited =
  | { release: () => void | Promise<void> }
  | { why: 'aborted' }
  | { why: 'queue' }
  | { why: 'error'; error: unknown };

export function createSelfCheck(deps: SelfCheckDeps) {
  const testMs = deps.testMs ?? SELF_CHECK_TEST_MS;
  const tscMs = deps.tscMs ?? SELF_CHECK_TSC_MS;
  const queueMs = deps.queueMs ?? SELF_CHECK_QUEUE_MS;
  const fullLock = deps.fullLock ?? machineAffectedLock();
  const slots = deps.slots ?? machineSelfCheckSlots();

  return async (input: SelfCheckInput, ctx: PortContext): Promise<SelfCheckResult> => {
    if (input?.schemaVersion !== 1 || !input.taskId || !input.worktreePath || !input.repo) {
      throw new PortError('INVALID_INPUT', '自测：要有 taskId、仓和工作树', { retryable: false });
    }
    // 现在在哪一段、这一段从哪一刻起、最后一次有输出是什么时候：心跳带上，看得出在排队、在跑还是失联
    const progress: {
      phase: Phase;
      phaseStartedAt: number;
      lastOutputAt: number | null;
      waitingFor?: string;
    } = { phase: 'probe', phaseStartedAt: Date.now(), lastOutputAt: null };
    const beatNow = () => {
      try {
        ctx.heartbeat({
          selfCheck: input.taskId,
          phase: progress.phase,
          phaseStartedAt: iso(progress.phaseStartedAt),
          lastOutputAt: progress.lastOutputAt === null ? null : iso(progress.lastOutputAt),
          ...(progress.waitingFor === undefined ? {} : { waitingFor: progress.waitingFor }),
        });
      } catch {
        // 心跳发不出去不搅自测本身（活动已被叫停时 Temporal 这边会拒）
      }
    };
    const enter = (phase: Phase, waitingFor?: string) => {
      progress.phase = phase;
      progress.phaseStartedAt = Date.now();
      if (waitingFor === undefined) delete progress.waitingFor;
      else progress.waitingFor = waitingFor;
      beatNow();
    };
    const beat = setInterval(beatNow, SELF_CHECK_HEARTBEAT_MS);
    // 一次自测里所有排队合起来的预算：每段排队用掉多少扣多少
    let queueLeft = queueMs;
    const spendQueue = (ms: number) => {
      queueLeft = Math.max(0, queueLeft - ms);
    };
    try {
      let user: SessionUser | null;
      try {
        user = await deps.trees.ownerOf(input.worktreePath);
      } catch (error) {
        return { state: 'skipped', reason: `读不到工作树的主人：${errMessage(error)}`, steps: [] };
      }
      if (!user) return { state: 'skipped', reason: `工作树 ${input.worktreePath} 不在`, steps: [] };
      const owner = user;
      const sh = async (
        what: string,
        script: string,
        timeoutMs: number,
        signal: AbortSignal = ctx.signal,
        onOutput?: (chunk: Buffer) => void,
      ) =>
        deps.exec({
          user: owner,
          cwd: input.worktreePath,
          argv: [SH, '-c', `PATH=${PATH}; export PATH; unset FLEET_RUN_ID; ${script} 2>&1`],
          timeoutMs,
          signal,
          scopeId: scopeId(input.taskId, what),
          ...(onOutput === undefined ? {} : { onOutput }),
        });

      /** 在名额或锁上排队，最多等剩下的排队预算。等了多久都从排队预算里扣，不碰执行预算。 */
      const waitFor = async (lock: SelfCheckFullLock, waitingFor: string): Promise<Waited> => {
        if (ctx.signal.aborted) return { why: 'aborted' };
        if (queueLeft <= 0) return { why: 'queue' };
        enter('queue', waitingFor);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), queueLeft);
        const onAbort = () => ac.abort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        const started = Date.now();
        try {
          const release = await lock.acquire(ac.signal);
          if (ctx.signal.aborted) {
            await release();
            return { why: 'aborted' };
          }
          return { release };
        } catch (error) {
          if (ctx.signal.aborted) return { why: 'aborted' };
          if (ac.signal.aborted) return { why: 'queue' };
          return { why: 'error', error };
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          spendQueue(Date.now() - started);
        }
      };

      /**
       * 跑一条命令，排队和执行分开计时。slotInside：命令自己先在本机测试槽上排队（test:changed），
       * 见到 SLOT_ACQUIRED 之前算排队（上限是剩下的排队预算），见到之后才开始算执行（上限 execMs）。
       * 不是 slotInside 的从起来就算执行。哪一段超了就停掉命令、记下是哪一段。
       */
      const run = async (
        what: string,
        script: string,
        opts: { execMs: number; phase: 'test' | 'tsc'; slotInside: boolean },
      ): Promise<Ran> => {
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        if (ctx.signal.aborted) ac.abort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
        const spawnedAt = Date.now();
        let execStartedAt: number | null = null;
        let lastOutputAt: number | null = null;
        let over: 'queue' | 'exec' | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stopAfter = (ms: number, which: 'queue' | 'exec') => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            over = which;
            ac.abort();
          }, ms);
        };
        const startExec = () => {
          execStartedAt = Date.now();
          stopAfter(opts.execMs, 'exec');
          enter(opts.phase);
          progress.lastOutputAt = lastOutputAt;
        };
        const waitingFor = opts.slotInside ? '本机测试槽（test:changed）' : undefined;
        progress.lastOutputAt = null;
        if (waitingFor !== undefined) {
          enter('queue', waitingFor);
          stopAfter(queueLeft, 'queue');
        } else {
          startExec();
        }
        let window = '';
        const onOutput = (chunk: Buffer) => {
          lastOutputAt = Date.now();
          progress.lastOutputAt = lastOutputAt;
          if (execStartedAt !== null) return;
          window = (window + chunk.toString('utf8')).slice(-MARKER_WINDOW);
          if (SLOT_ACQUIRED.test(window)) {
            spendQueue(Date.now() - spawnedAt);
            startExec();
          }
        };
        try {
          // exec 自己的时限只是兜底：真正按段停的是上面的计时器
          const cap = (waitingFor === undefined ? 0 : queueLeft) + opts.execMs;
          const r = await sh(what, script, cap, ac.signal, onOutput);
          const endedAt = Date.now();
          if (waitingFor !== undefined && execStartedAt === null) spendQueue(endedAt - spawnedAt);
          return {
            r,
            output: `${r.stdout.toString('utf8')}${r.stderr ? `\n${r.stderr}` : ''}`,
            spawnedAt,
            execStartedAt,
            endedAt,
            lastOutputAt,
            ...(over === undefined ? {} : { over }),
            cancelled: ctx.signal.aborted,
            ...(waitingFor === undefined ? {} : { waitingFor }),
          };
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
        }
      };

      /** 执行用掉了多少：没开跑是 0。 */
      const execUsed = (ran: Ran) => (ran.execStartedAt === null ? 0 : ran.endedAt - ran.execStartedAt);

      /**
       * 排队拿到整机锁再跑受影响的包。排队超了、执行超了，都记自测超时、算没过。被叫停记没跑。
       * 等锁吃排队预算；执行只有 execMs（和前面那次合用的测试预算剩下的）。
       */
      const runAffected = async (command: string, execMs: number): Promise<SelfCheckStep> => {
        if (execMs <= 0) return timeoutStep(command, `测试预算已经用完（${duration(testMs)}）`);
        const got = await waitFor(fullLock, '整机锁（要全跑改跑受影响的包）');
        if ('why' in got) {
          if (got.why === 'aborted') return notRun(command, '被叫停了');
          if (got.why === 'queue') {
            return timeoutStep(
              command,
              `等整机锁超过剩下的排队预算（一次自测合计 ${Math.round(queueMs / 60_000)} 分钟），没开跑`,
            );
          }
          return notRun(command, `整机测试锁没用上：${errMessage(got.error)}`);
        }
        try {
          const ran = await run('affected', command, { execMs, phase: 'test', slotInside: true });
          return stepOfRun(command, ran, execMs, TEST_CHANGED_NOT_RUN, true);
        } finally {
          try {
            await got.release();
          } catch (error) {
            deps.log?.('自测的整机锁没放掉', { taskId: input.taskId, error: errMessage(error) });
          }
        }
      };
      const profile = (input.repo as RepoWithProfile).profile;
      // 没写档案的老仓按 Node 仓算。写了档案的：工具链里有 node / pnpm / npm / yarn 才看 node_modules；
      // 只有 go、cargo、python 这类的，没有 node_modules 也要跑档案里的测试命令。
      const needsNodeModules =
        profile === undefined || profile.toolchain.some((tool) => NODE_TOOLS.has(tool));
      if (needsNodeModules) {
        // Node 仓没装依赖就什么都跑不起来：整个跳过，不算红；非 Node 仓不看 node_modules。
        const probe = await sh('probe', 'test -d node_modules && echo yes || echo no', SELF_CHECK_PROBE_MS);
        if (probe.code !== 0) {
          return {
            state: 'skipped',
            reason: `看不了树里装没装依赖：${digestOutput(probe.stdout.toString('utf8') || probe.stderr, 300)}`,
            steps: [],
          };
        }
        if (probe.stdout.toString('utf8').trim() !== 'yes') {
          return { state: 'skipped', reason: '树里没装依赖（没有 node_modules），交给 CI', steps: [] };
        }
      }

      const settled = (steps: SelfCheckStep[]): SelfCheckResult => {
        if (steps.some((s) => s.outcome === 'fail')) return { state: 'red', steps };
        if (steps.some((s) => s.outcome === 'pass')) return { state: 'green', steps };
        return {
          state: 'skipped',
          reason: steps.map((s) => `${s.command}：${s.digest}`).join('；'),
          steps,
        };
      };
      const testCommand = (profile?.testCommand ?? input.repo.testCommand)?.trim() ?? '';
      const tscCommand = `${TSC} -b --pretty false`;
      // 看有没有 tsc 是轻的，不占名额。真正的测试命令和 tsc 才要名额。
      const has = await sh(
        'has-tsc',
        `test -f tsconfig.json && test -x ${shQuote(TSC)} && echo yes || echo no`,
        SELF_CHECK_PROBE_MS,
      );
      const willTsc = has.code === 0 && has.stdout.toString('utf8').trim() === 'yes';
      if (testCommand === '' && !willTsc) {
        return settled([
          notRun('（测试命令）', '这个仓没配测试命令（repos.test_command）'),
          notRun(tscCommand, '树里没有 tsconfig.json 或没装 tsc'),
        ]);
      }

      // test:changed 自己在本机测试槽上排队（vitest 的容量归它），引擎不另占名额；别的测试命令和 tsc 占自测名额
      const changed = /\btest:changed\b/.test(testCommand);
      let releaseSlot: (() => void | Promise<void>) | undefined;
      try {
        const steps: SelfCheckStep[] = [];
        if (testCommand === '') {
          steps.push(notRun('（测试命令）', '这个仓没配测试命令（repos.test_command）'));
        } else if (changed) {
          const first = await run('test', testCommand, { execMs: testMs, phase: 'test', slotInside: true });
          if (fullRunRefusal(first.r)) {
            steps.push({
              command: testCommand,
              outcome: 'skipped',
              exitCode: 3,
              digest: '改动要全跑，本机不跑全量；改在锁下跑受影响的包',
            });
            steps.push(await runAffected(affectedCommand(testCommand), testMs - execUsed(first)));
          } else {
            steps.push(stepOfRun(testCommand, first, testMs, TEST_CHANGED_NOT_RUN, false));
          }
        } else {
          const got = await waitFor(slots, '自测名额');
          if ('why' in got) {
            if (got.why === 'aborted') return { state: 'skipped', reason: '被叫停了', steps: [] };
            if (got.why === 'queue') {
              return {
                state: 'skipped',
                reason: `等自测名额超过排队预算（${Math.round(queueMs / 60_000)} 分钟），没跑`,
                steps: [],
              };
            }
            return { state: 'skipped', reason: `自测名额没用上：${errMessage(got.error)}`, steps: [] };
          }
          releaseSlot = got.release;
          const ran = await run('test', testCommand, { execMs: testMs, phase: 'test', slotInside: false });
          steps.push(stepOfRun(testCommand, ran, testMs, {}, false));
        }
        if (ctx.signal.aborted) return { state: 'skipped', reason: '被叫停了', steps };

        if (!willTsc) {
          steps.push(notRun(tscCommand, '树里没有 tsconfig.json 或没装 tsc'));
          return settled(steps);
        }
        if (releaseSlot === undefined) {
          const got = await waitFor(slots, '自测名额');
          if ('why' in got) {
            if (got.why === 'aborted') return { state: 'skipped', reason: '被叫停了', steps };
            steps.push(
              notRun(
                tscCommand,
                got.why === 'queue'
                  ? `等自测名额超过剩下的排队预算（一次自测合计 ${Math.round(queueMs / 60_000)} 分钟），没跑`
                  : `自测名额没用上：${errMessage(got.error)}`,
              ),
            );
            return settled(steps);
          }
          releaseSlot = got.release;
        }
        const ran = await run('tsc', tscCommand, { execMs: tscMs, phase: 'tsc', slotInside: false });
        steps.push(stepOfRun(tscCommand, ran, tscMs, {}, false));
        return settled(steps);
      } finally {
        try {
          await releaseSlot?.();
        } catch (error) {
          deps.log?.('自测名额没放掉', { taskId: input.taskId, error: errMessage(error) });
        }
      }
    } catch (error) {
      deps.log?.('自测没跑成，照旧往下走', { taskId: input.taskId, error: errMessage(error) });
      return { state: 'skipped', reason: `自测没跑成：${errMessage(error)}`, steps: [] };
    } finally {
      clearInterval(beat);
      enter('done');
    }
  };
}
