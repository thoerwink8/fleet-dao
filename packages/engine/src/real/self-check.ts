// 动手会话收场后，引擎自己在会话的树里跑一遍测试和类型检查（selfCheck，决定 0093）：仓的测试命令（repos.test_command），
// 再加 tsc（树里有 tsconfig.json 和装好的 tsc 才跑）。红了工作流把精炼输出续进同一个会话再改一次；结果也交给冷验收当材料。
//
// 改这里之前必须知道：
// - 不抛：树不在、没装依赖、没有命令、超时、起不来，一律回 skipped 加原因（或那一条记 skipped），原流程照旧推 PR 交给 CI。
//   只有入参认不出才抛。要全跑之后改跑受影响包的那次超时例外：记没过（自测超时），不当成过了。
// - 以树主人（会话用户）的身份跑（经 exec，和读交付同一条路）：引擎不以自己的身份在会话的树里跑东西（design 十四）。
// - 不带 FLEET_RUN_ID：pnpm test:changed 见到它会全跑（会话里那套），这里只要跑改到的。退出 2（没算成要跑什么、
//   排不上本机测试槽）不是测试没过，记 skipped。退出 3（要全跑）不再只跑 tsc：在整机同一时刻只跑一个的锁下
//   再跑 `pnpm test:changed --affected`（受影响的包），锁被占就排队、不跳过。这一段和前面共用测试时限。
// - 有时限（测试 SELF_CHECK_TEST_MS、tsc SELF_CHECK_TSC_MS）：普通那次超了记 skipped，不算红——慢不等于错，交给 CI。
//   要全跑之后改跑受影响包的那次超了记「自测超时」，算没过。
// - 精炼输出：挑出像失败的行（FAIL、error、×、AssertionError、TSxxxx）再加末尾一段，限 SELF_CHECK_DIGEST_MAX 字。

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionUser } from '@fleet-dao/adapters';
import { errMessage } from '@fleet-dao/shared/util';
import { type PortContext, PortError } from '../ports.ts';
import {
  SELF_CHECK_DIGEST_MAX,
  type SelfCheckInput,
  type SelfCheckResult,
  type SelfCheckStep,
} from '../task-contract.ts';
import type { UserCommandResult, UserExec } from './exec.ts';

/** 测试命令最多跑多久（毫秒）。要全跑时，排队和改跑受影响包合起来也算在这一段里。 */
export const SELF_CHECK_TEST_MS = 8 * 60_000;
/** tsc 最多跑多久（毫秒）。 */
export const SELF_CHECK_TSC_MS = 5 * 60_000;
/** 多久报一次心跳（活动的心跳超时是 limits.heartbeatSeconds，默认 120 秒）。 */
const HEARTBEAT_MS = 30_000;
/** 会话用户的 PATH：node、pnpm 在 /usr/bin 或 /usr/local/bin（法国 pnpm 在 /usr/local/bin）。 */
const PATH = '/usr/local/bin:/usr/bin:/bin';
const SH = '/bin/sh';
const TSC = 'node_modules/.bin/tsc';
/** 锁目录放哪（几个引擎进程共用）。测试和特殊机器用。 */
const ENV_LOCK_DIR = 'FLEET_SELF_CHECK_LOCK_DIR';
/** 一把锁最多算数多久：测试时限再加一分钟，超时当持有者已死。 */
const LOCK_STALE_MS = SELF_CHECK_TEST_MS + 60_000;
const LOCK_POLL_MS = 250;

/** test:changed 的退出码 2：没算成要跑什么，不是测试没过（packages/conventions/src/bin/test-changed.ts）。 */
const TEST_CHANGED_NOT_RUN: Readonly<Record<number, string>> = {
  2: '没算成要跑哪些测试（读不到主线、排不上本机测试槽……）',
};

/** 整机同一时刻只跑一个「要全跑时改跑受影响包」。acquire 在 signal 中止时抛错。 */
export interface SelfCheckFullLock {
  acquire(signal: AbortSignal): Promise<() => void | Promise<void>>;
}

export interface SelfCheckDeps {
  trees: { ownerOf(dir: string): Promise<SessionUser | null> };
  exec: UserExec;
  /** 测试里调短。 */
  testMs?: number;
  tscMs?: number;
  /** 不给就用整机文件锁（排队）。测试换成可控的。 */
  fullLock?: SelfCheckFullLock;
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

/** 锁目录还算不算被占着。没有 holder、进程已死、或持有超过上限，都当可以拆。 */
async function lockStale(lockDir: string, staleMs: number): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(lockDir, 'holder'), 'utf8');
  } catch {
    try {
      const s = await stat(lockDir);
      return Date.now() - s.mtimeMs > staleMs;
    } catch {
      return true;
    }
  }
  const [pidRaw, startedRaw] = text.split('\n');
  const pid = Number(pidRaw);
  const started = Number(startedRaw);
  if (!Number.isFinite(started) || Date.now() - started > staleMs) return true;
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return true;
  return false;
}

/**
 * 整机一把锁：目录 mkdir 是原子的，占着就隔一会儿再试（排队），不跳过。
 * 死进程或持有太久的锁拆掉再占。signal 中止时抛 LockAbort，已经占上的会放掉。
 */
export function createAffectedLock(
  dir: string,
  opts?: { pollMs?: number; staleMs?: number },
): SelfCheckFullLock {
  const pollMs = opts?.pollMs ?? LOCK_POLL_MS;
  const staleMs = opts?.staleMs ?? LOCK_STALE_MS;
  const lockDir = join(dir, 'affected.lock');
  return {
    async acquire(signal: AbortSignal): Promise<() => Promise<void>> {
      await mkdir(dir, { recursive: true });
      for (;;) {
        if (signal.aborted) throw new LockAbort();
        try {
          await mkdir(lockDir);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST') throw e;
          if (await lockStale(lockDir, staleMs)) {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
          await sleep(pollMs, signal);
          continue;
        }
        if (signal.aborted) {
          await rm(lockDir, { recursive: true, force: true });
          throw new LockAbort();
        }
        try {
          await writeFile(join(lockDir, 'holder'), `${process.pid}\n${Date.now()}\n`);
        } catch (e) {
          await rm(lockDir, { recursive: true, force: true });
          throw e;
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await rm(lockDir, { recursive: true, force: true });
        };
      }
    },
  };
}

let defaultLock: SelfCheckFullLock | undefined;

/** 引擎进程共用的那把锁。用户目录读不到就 acquire 抛错，调用方记没跑成，不当成过了。 */
function machineAffectedLock(): SelfCheckFullLock {
  if (defaultLock) return defaultLock;
  const given = process.env[ENV_LOCK_DIR]?.trim();
  const home = homedir();
  if ((given === undefined || given === '') && home === '') {
    return {
      async acquire() {
        throw new Error(`读不到用户目录，没法放自测锁（可设 ${ENV_LOCK_DIR}）`);
      },
    };
  }
  defaultLock = createAffectedLock(given || join(home, '.fleet-dao', 'self-check-locks'));
  return defaultLock;
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 去掉终端颜色码
  const clean = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
  const lines = clean.split('\n').map((l) => l.trimEnd());
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

/** 要全跑之后那次没在时限里跑完：算没过，不当成跳过。 */
function timeoutStep(command: string): SelfCheckStep {
  return { command, outcome: 'fail', exitCode: null, digest: '自测超时' };
}

/** 一条命令跑完怎么记：超时、被叫停、起不来记 skipped，不算红。要全跑之后那次的超时不走这里。 */
function stepOf(
  command: string,
  r: UserCommandResult,
  timeoutMs: number,
  notRunCodes: Readonly<Record<number, string>> = {},
): SelfCheckStep {
  const output = `${r.stdout.toString('utf8')}${r.stderr ? `\n${r.stderr}` : ''}`;
  if (r.spawnError) return notRun(command, `起不来：${r.spawnError}`);
  if (r.timedOut) return notRun(command, `超过 ${Math.round(timeoutMs / 60_000)} 分钟没跑完，交给 CI`);
  if (r.aborted) return notRun(command, '被叫停了');
  if (r.code === null) return notRun(command, `没正常退出：${digestOutput(output, 500)}`);
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

export function createSelfCheck(deps: SelfCheckDeps) {
  const testMs = deps.testMs ?? SELF_CHECK_TEST_MS;
  const tscMs = deps.tscMs ?? SELF_CHECK_TSC_MS;
  const fullLock = deps.fullLock ?? machineAffectedLock();

  return async (input: SelfCheckInput, ctx: PortContext): Promise<SelfCheckResult> => {
    if (input?.schemaVersion !== 1 || !input.taskId || !input.worktreePath || !input.repo) {
      throw new PortError('INVALID_INPUT', '自测：要有 taskId、仓和工作树', { retryable: false });
    }
    const beat = setInterval(() => ctx.heartbeat({ selfCheck: input.taskId }), HEARTBEAT_MS);
    try {
      let user: SessionUser | null;
      try {
        user = await deps.trees.ownerOf(input.worktreePath);
      } catch (error) {
        return { state: 'skipped', reason: `读不到工作树的主人：${errMessage(error)}`, steps: [] };
      }
      if (!user) return { state: 'skipped', reason: `工作树 ${input.worktreePath} 不在`, steps: [] };
      const owner = user;
      const sh = async (what: string, script: string, timeoutMs: number) =>
        deps.exec({
          user: owner,
          cwd: input.worktreePath,
          argv: [SH, '-c', `PATH=${PATH}; export PATH; ${script} 2>&1`],
          timeoutMs,
          signal: ctx.signal,
          scopeId: scopeId(input.taskId, what),
        });
      /** 排队拿到锁再跑受影响的包。时限到了、或命令自己超时，都记自测超时、算没过。被叫停记没跑。 */
      const runAffected = async (command: string, budgetMs: number): Promise<SelfCheckStep> => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), budgetMs);
        const onAbort = () => ac.abort();
        if (ctx.signal.aborted) ac.abort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
        const started = Date.now();
        let release: (() => void | Promise<void>) | undefined;
        try {
          release = await fullLock.acquire(ac.signal);
          if (ctx.signal.aborted) return notRun(command, '被叫停了');
          const left = budgetMs - (Date.now() - started);
          if (left <= 0) return timeoutStep(command);
          const r = await sh('affected', command, left);
          if (r.timedOut) return timeoutStep(command);
          return stepOf(command, r, left, TEST_CHANGED_NOT_RUN);
        } catch (error) {
          if (ctx.signal.aborted) return notRun(command, '被叫停了');
          if (ac.signal.aborted) return timeoutStep(command);
          return notRun(command, `整机测试锁没用上：${errMessage(error)}`);
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          try {
            await release?.();
          } catch (error) {
            deps.log?.('自测的整机锁没放掉', { taskId: input.taskId, error: errMessage(error) });
          }
        }
      };
      // 没装依赖就什么都跑不起来：整个跳过，不算红
      const probe = await sh('probe', 'test -d node_modules && echo yes || echo no', 30_000);
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

      const steps: SelfCheckStep[] = [];
      const testCommand = input.repo.testCommand?.trim() ?? '';
      if (testCommand === '') {
        steps.push(notRun('（测试命令）', '这个仓没配测试命令（repos.test_command）'));
      } else {
        const testStarted = Date.now();
        const r = await sh('test', testCommand, testMs);
        const changed = /\btest:changed\b/.test(testCommand);
        if (changed && fullRunRefusal(r)) {
          steps.push({
            command: testCommand,
            outcome: 'skipped',
            exitCode: 3,
            digest: '改动要全跑，本机不跑全量；改在锁下跑受影响的包',
          });
          const left = testMs - (Date.now() - testStarted);
          const command = affectedCommand(testCommand);
          steps.push(left <= 0 ? timeoutStep(command) : await runAffected(command, left));
        } else {
          steps.push(stepOf(testCommand, r, testMs, changed ? TEST_CHANGED_NOT_RUN : {}));
        }
      }
      if (ctx.signal.aborted) return { state: 'skipped', reason: '被叫停了', steps };

      const tscCommand = `${TSC} -b --pretty false`;
      const has = await sh(
        'has-tsc',
        `test -f tsconfig.json && test -x ${shQuote(TSC)} && echo yes || echo no`,
        30_000,
      );
      if (has.code === 0 && has.stdout.toString('utf8').trim() === 'yes') {
        const r = await sh('tsc', tscCommand, tscMs);
        steps.push(stepOf(tscCommand, r, tscMs));
      } else {
        steps.push(notRun(tscCommand, '树里没有 tsconfig.json 或没装 tsc'));
      }

      if (steps.some((s) => s.outcome === 'fail')) return { state: 'red', steps };
      if (steps.some((s) => s.outcome === 'pass')) return { state: 'green', steps };
      return { state: 'skipped', reason: steps.map((s) => `${s.command}：${s.digest}`).join('；'), steps };
    } catch (error) {
      deps.log?.('自测没跑成，照旧往下走', { taskId: input.taskId, error: errMessage(error) });
      return { state: 'skipped', reason: `自测没跑成：${errMessage(error)}`, steps: [] };
    } finally {
      clearInterval(beat);
    }
  };
}
