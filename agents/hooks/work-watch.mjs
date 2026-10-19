// pnpm work run 派出的工人只在终态叫醒派它的会话（单 #2761）。挂在 Stop 上、asyncRewake（plugin-catalog.mjs）：Claude Code 让它在后台跑，
// 收尾不等它；它以退出码 2 结束时，stderr 作为提示塞给主线程、把闲着的主线程叫醒。
// 为什么：工人脱离了聊天进程（packages/conventions/src/work-run.ts），不再是子代理，没有「子代理完成通知」叫回主线程；
// 又不能让主线程手写轮询（钩子拦，#2730）。所以收尾时由这个钩子盯着，只在终态叫一次：中间的心跳、网关断了在续，都不叫。
// 做法：
// - 找这个会话派的（state.json / spec.json 的 dispatcher = 本会话号）、还没叫醒过（没有 reported 文件）的运行记录；一件都没有就退 0；
// - 每 WATCH_TICK_MS 看一次：有 result.json 的是终态（做完、没做成、已停不再派工）；state.json 是 waiting 的
//   （审查未结或外部交付还不能终结）不盯、不叫，心跳再旧也不当成看护进程丢了；其余不是终态、beatAt 超过
//   BEAT_STALE_MS 没动（没有 state.json 就看 spec.json 的修改时间）的是看护进程没了，也叫：要人再跑一次 pnpm work run <单号> 续；
// - 叫之前用独占创建 reported 文件占住（同一件只叫一次，几个盯着的进程抢，只有一个叫）；把每件一两句打到 stderr，退出码 2；
// - 同一会话只留一个盯着的（锁 <运行目录根>/watch-<会话号>.lock，后来的接班），最长等 3 小时，起它的 Claude Code 没了也退 0；
// - 子代理收尾（带 agent_id）、引擎无头、机器派的会话（工人自己）：直接退 0。
// 文件形状和 work-run.ts 同一份（那边是 TypeScript，这里是装到各机器的纯 node，引不了；两边的测试各自钉着）。
// 节拍和上限测试里用 FLEET_WORK_WATCH_TICK_MS、FLEET_WORK_WATCH_MAX_MS 换；运行目录根用 FLEET_WORK_RUNS_DIR 换。
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from './is-main.mjs';
import { cleanSessionId } from './session-id.mjs';
import { isMachineSession } from './unattended.mjs';

/** 多久看一次 */
export const WATCH_TICK_MS = 10_000;
/** 最长等多久（Stop 钩子登记的 timeout 要比它长，见 plugin-catalog.mjs） */
export const WATCH_MAX_MS = 3 * 3_600_000;
/** 看护进程的心跳这么久没动就算没了（work-run.ts 的 BEAT_STALE_MS） */
export const BEAT_STALE_MS = 3 * 60_000;
/** 结果里最多贴多少字 */
const SUMMARY_SHOWN = 1500;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/** @param {Record<string, string | undefined>} env @param {string} key @param {number} fallback */
function msFrom(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {Record<string, string | undefined>} env @param {string} home */
export const runsRootOf = (env, home) => env.FLEET_WORK_RUNS_DIR || join(home, '.fleet-dao', 'work-runs');

/**
 * 读 JSON；没有、坏了都是 null（坏了的下一拍再读，写的那边是原子改名）。
 * @param {string} path
 * @returns {Record<string, unknown> | null}
 */
function readObj(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'EPERM');
  }
}

/** 起它的 Claude Code 还在不在（往它读着的 stdout 写一个换行） */
function hostAlive() {
  return new Promise((done) => {
    try {
      process.stdout.write('\n', (e) => done(!e));
    } catch {
      done(false);
    }
  });
}

/**
 * @typedef {{ dir: string, issue: number | null, kind: 'done' | 'failed' | 'stopped' | 'lost', text: string }} Ended 到终态的一件
 */

/**
 * 这个会话派的、还没叫醒过的运行目录。
 * @param {string} root
 * @param {string} sessionId
 * @returns {string[]}
 */
export function pendingRuns(root, sessionId) {
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .map((n) => join(root, n))
    .filter((dir) => {
      try {
        statSync(join(dir, 'reported'));
        return false;
      } catch {
        // 没叫醒过
      }
      const state = readObj(join(dir, 'state.json'));
      // 审查等待或外部交付还不能终结：不是还在写码。留在名单里会让 Stop 空等满 3 小时，并可能被说成看护进程丢了。
      if (state?.state === 'waiting' && !readObj(join(dir, 'result.json'))) return false;
      const owner = state?.dispatcher ?? readObj(join(dir, 'spec.json'))?.dispatcher;
      return owner === sessionId;
    });
}

/**
 * 一件到没到终态；没到是 null。
 * @param {string} dir
 * @param {number} now
 * @returns {Ended | null}
 */
export function endedOf(dir, now) {
  const result = readObj(join(dir, 'result.json'));
  const state = readObj(join(dir, 'state.json'));
  const issueRaw = result?.issue ?? state?.issue ?? readObj(join(dir, 'spec.json'))?.issue;
  const issue = typeof issueRaw === 'number' ? issueRaw : null;
  const tag = issue === null ? dir : `#${issue}`;
  if (result) {
    const attempts = typeof result.attempts === 'number' ? `第 ${result.attempts} 次` : '';
    if (result.state === 'done') {
      const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
      const shown = summary.length > SUMMARY_SHOWN ? `${summary.slice(0, SUMMARY_SHOWN)}…` : summary;
      return {
        dir,
        issue,
        kind: 'done',
        text: `${tag} 工人做完了（${attempts}）：${shown || '（最后一条回复是空的）'}\n结果文件 ${join(dir, 'result.json')}`,
      };
    }
    if (result.state === 'stopped') {
      return {
        dir,
        issue,
        kind: 'stopped',
        text: `${tag} 已停，不再派工（${attempts}）：${typeof result.why === 'string' ? result.why : '（没写原因）'}\n结果文件 ${join(dir, 'result.json')}。工作树和会话留在 state.json，不要再派工人`,
      };
    }
    return {
      dir,
      issue,
      kind: 'failed',
      text: `${tag} 工人没做成（${attempts}）：${typeof result.why === 'string' ? result.why : '（没写原因）'}\n结果文件 ${join(dir, 'result.json')}，每次的输出在同目录 attempt-*.err.log`,
    };
  }
  // 审查等待或外部交付未终结：故意停着，不是看护进程丢了，不要叫人去续跑工人。
  if (state?.state === 'waiting') return null;
  let beat = typeof state?.beatAt === 'string' ? Date.parse(state.beatAt) : Number.NaN;
  if (!state) {
    try {
      beat = statSync(join(dir, 'spec.json')).mtimeMs;
    } catch {
      return null;
    }
  }
  if (Number.isFinite(beat) && now - beat <= BEAT_STALE_MS) return null;
  return {
    dir,
    issue,
    kind: 'lost',
    text: `${tag} 工人的看护进程没了（最后心跳 ${Number.isFinite(beat) ? new Date(beat).toISOString() : '没有'}，没到终态）：pnpm work run ${issue ?? '<单号>'} 接着同一个会话续`,
  };
}

/**
 * 独占创建 reported：抢到了 true（这件由我叫），别人已经叫过 false。
 * @param {string} dir
 * @param {number} now
 */
function claimReport(dir, now) {
  try {
    const fd = openSync(join(dir, 'reported'), 'wx');
    writeFileSync(fd, `${new Date(now).toISOString()}\n`);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * 盯着。返回退出码：2 = 有工人到终态要叫醒主线程、0 = 没事退出。永远不抛。
 * @param {unknown} input Stop 钩子的输入
 * @param {{
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 *   clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pid?: number,
 *   parentAlive?: () => boolean | Promise<boolean>,
 *   err?: (text: string) => void,
 * }} [opts]
 * @returns {Promise<number>}
 */
export async function watchRuns(
  input,
  {
    home = homedir(),
    env = process.env,
    clock = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pid = process.pid,
    parentAlive = () => alive(process.ppid),
    err = (text) => process.stderr.write(`${text}\n`),
  } = {},
) {
  if (!isObj(input)) return 0;
  if (env.FLEET_HEADLESS === '1') return 0;
  if (typeof input.agent_id === 'string' && input.agent_id.trim() !== '') return 0;
  const sessionId = cleanSessionId(input.session_id);
  if (sessionId === null) return 0;
  if (isMachineSession({ env, cwd: input.cwd })) return 0;
  const root = runsRootOf(env, home);
  if (pendingRuns(root, sessionId).length === 0) return 0;

  const tickMs = msFrom(env, 'FLEET_WORK_WATCH_TICK_MS', WATCH_TICK_MS);
  const maxMs = msFrom(env, 'FLEET_WORK_WATCH_MAX_MS', WATCH_MAX_MS);
  const lockFile = join(root, `watch-${sessionId}.lock`);
  const startedAt = clock();
  const token = JSON.stringify({ pid, startedAt });
  let locked = false;
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(lockFile, token);
    locked = true;
  } catch {
    // 锁写不进照样盯：reported 独占创建保证同一件只叫一次
  }
  const mine = () => {
    if (!locked) return true;
    try {
      return readFileSync(lockFile, 'utf8') === token;
    } catch (e) {
      return !(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT');
    }
  };
  try {
    for (let first = true; ; first = false) {
      if (!first) {
        await sleep(tickMs);
        if (!mine()) return 0;
        if (!(await parentAlive())) return 0;
        if (clock() - startedAt >= maxMs) return 0;
      }
      const now = clock();
      const pending = pendingRuns(root, sessionId);
      if (pending.length === 0) return 0;
      /** @type {Ended[]} */
      const ended = [];
      for (const dir of pending) {
        const e = endedOf(dir, now);
        if (e && claimReport(dir, now)) ended.push(e);
      }
      if (ended.length > 0) {
        err([`本机工人到终态 ${ended.length} 件：`, ...ended.map((e) => e.text)].join('\n'));
        return 2;
      }
    }
  } catch (e) {
    err(`工人盯账自己出错了（${why(e)}）：pnpm work runs 看各工人的状态`);
    return 2;
  } finally {
    if (locked && mine()) rmSync(lockFile, { force: true });
  }
}

if (isMainModule(import.meta)) {
  let input = {};
  try {
    const raw = readFileSync(0, 'utf8');
    input = JSON.parse((raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) || '{}');
  } catch {
    // 读不懂输入：认不出会话，不盯
  }
  process.stdout.on('error', () => {});
  process.exitCode = await watchRuns(input, {
    parentAlive: async () => alive(process.ppid) && (await hostAlive()),
  });
}
