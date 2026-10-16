// 主线程一轮收尾后的盯账进程（单 #2488）。挂在 Stop 上、asyncRewake（plugin-catalog.mjs）：Claude Code 让它在后台跑，
// 收尾不等它；它以退出码 2 结束时，Claude Code 把 stderr 作为提示塞给主线程、把闲着的主线程叫醒（Claude Code 2.1.296 起）。
// 为什么：主线程一轮结束、后台还有子代理在跑时，Mirasim 认为这一轮还没完，创始人发的话走「引导」攒着不送；
// 主线程这段时间不调工具，轮中对账（inbox-tick.mjs，挂在主线程 PreToolUse 上）也不触发，子代理跑多久这话就卡多久。
// 做法：
// - 每 15 秒用 inbox-tick.mjs 的 pendingSteers（里面是 founder-inbox.mjs 的 reconcileInbox，和开会话、轮中对账同一个函数）
//   核一次本血缘「发了、本会话还没见过」的引导；有就记进已见名单（inbox-tick 读同一份，同一条只送一次），
//   把原文和北京时间发出时间打到 stderr，退出码 2；没有就接着等；
// - 同一会话只留一个：起来时写锁（~/.fleet-dao/inbox-seen/watch-<会话号>.lock，记 pid 和起始时刻），
//   每次醒来先看锁，锁已经是后来的那个进程的了就退 0（新的一次收尾接了班）；
// - 最长等 3 小时，到点退 0；起它的进程没了也退 0；
// - 读账连续失败 3 次：打一行「对账没查成：<原因>」退 2，不悄悄退；同一句 10 分钟内说过（和 inbox-tick 共用状态）就不再叫醒、退 0，
//   免得每次收尾都为同一个坏掉的账叫醒一次；
// - 子代理收尾走 SubagentStop，不进这里；输入带 agent_id 的、引擎无头会话、机器派的会话（工人、反方）、
//   不是 Mirasim 起的会话（无血缘）：直接退 0。
// 节拍和上限测试里用 FLEET_INBOX_WATCH_TICK_MS、FLEET_INBOX_WATCH_MAX_MS 换。
// 注意：Claude Code 只在交互会话、或 -p 带流式输入（Mirasim 就是这样起的）时把 asyncRewake 放后台；
// 不带流式输入的 `claude -p` 会同步等它。那种会话不是 Mirasim 起的，第一次对账就判无血缘退了，不拖收尾。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanSessionId,
  inboxSeenDir,
  pendingSteers,
  readTickState,
  saveTickState,
  toldRecently,
} from './inbox-tick.mjs';
import { isMachineSession } from './unattended.mjs';

/** 两次对账之间隔多久 */
export const WATCH_TICK_MS = 15_000;
/** 最长等多久（Stop 钩子登记的 timeout 要比它长，见 plugin-catalog.mjs） */
export const WATCH_MAX_MS = 3 * 3_600_000;
/** 读账连续失败几次就明说 */
export const WATCH_FAIL_LIMIT = 3;

// 叫醒时塞给主线程的前缀（rewakeMessage）和终端里那一行（rewakeSummary）登记在 plugin-catalog.mjs 和本仓 .claude/settings.json。

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/** @param {Record<string, string | undefined>} env @param {string} key @param {number} fallback */
function msFrom(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {number} pid @returns {boolean} */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程在，只是没权限发信号
    return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'EPERM');
  }
}

/**
 * 起它的 Claude Code 还在不在：往 stdout 写一个换行。stdout 是 Claude Code 读着的管道，它没了（被杀、退出）读的那头就关了，
 * 写会报 EPIPE。光看父进程不够：Windows 上钩子经 Git Bash 起，父进程是还在等它的 bash，Claude Code 被杀了 bash 也不退
 * （本机真测见过：会话杀掉一分多钟后盯账进程还在）。叫醒时 Claude Code 用的是 stderr（有 stderr 就不看 stdout），换行不进提示。
 * @returns {Promise<boolean>}
 */
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
 * 写锁：tmp 再改名，读的那边看不到写了一半的。Windows 上目标正被别人读着时改名会 EPERM，重试几次。写不成抛。
 * @param {string} file
 * @param {string} text
 */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 4) {
        rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/**
 * 盯账。返回退出码：2 = 有话要叫醒主线程（或连续读账失败）、0 = 没事退出。永远不抛。
 * @param {unknown} input Stop 钩子的输入（解析好的 JSON）
 * @param {{
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 *   clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pid?: number,
 *   parentAlive?: () => boolean | Promise<boolean>,
 *   load?: () => Promise<typeof import('./founder-inbox.mjs')>,
 *   err?: (text: string) => void,
 * }} [opts] 测试换掉家目录、时钟、等待、加载、输出
 * @returns {Promise<number>}
 */
export async function watch(
  input,
  {
    home = homedir(),
    env = process.env,
    clock = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pid = process.pid,
    parentAlive = () => alive(process.ppid),
    load,
    err = (text) => process.stderr.write(`${text}\n`),
  } = {},
) {
  if (!isObj(input)) return 0;
  if (env.FLEET_HEADLESS === '1') return 0;
  if (typeof input.agent_id === 'string' && input.agent_id.trim() !== '') return 0;
  const sessionId = cleanSessionId(input.session_id);
  if (sessionId === null) return 0;
  if (isMachineSession({ env, cwd: input.cwd })) return 0;

  const tickMs = msFrom(env, 'FLEET_INBOX_WATCH_TICK_MS', WATCH_TICK_MS);
  const maxMs = msFrom(env, 'FLEET_INBOX_WATCH_MAX_MS', WATCH_MAX_MS);
  const dir = inboxSeenDir(env, home);
  const lockFile = join(dir, `watch-${sessionId}.lock`);
  const startedAt = clock();
  const token = JSON.stringify({ pid, startedAt });
  let locked = false;
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomic(lockFile, token);
    locked = true;
  } catch {
    // 锁写不进：照样盯（最坏是前一个盯账进程也还在，各自叫醒一次；已见名单会去重）
  }
  /** 锁还是不是自己的；读不了当还是（读不了不该把自己赶走） */
  const mine = () => {
    if (!locked) return true;
    try {
      return readFileSync(lockFile, 'utf8') === token;
    } catch (e) {
      return !(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT');
    }
  };
  const release = () => {
    if (locked && mine()) rmSync(lockFile, { force: true });
  };

  let failures = 0;
  try {
    for (;;) {
      await sleep(tickMs);
      if (!mine()) return 0;
      if (!(await parentAlive())) return 0;
      const now = clock();
      if (now - startedAt >= maxMs) return 0;
      const r = await pendingSteers({
        sessionId,
        transcriptPath: input.transcript_path,
        home,
        env,
        now,
        ...(load ? { load } : {}),
      });
      if (r.status === 'none') return 0;
      if (r.shown.length > 0) {
        err([`共 ${r.shown.length} 条：`, ...r.shown, ...r.notices].join('\n'));
        return 2;
      }
      if (r.notices.length === 0) {
        failures = 0;
        continue;
      }
      failures++;
      if (failures < WATCH_FAIL_LIMIT) continue;
      const noticeText = r.notices.join('；');
      const state = readTickState(dir, sessionId);
      // 这句刚说过（轮中对账或上一个盯账进程）：不再叫醒，也不再盯（同一个坏账每次收尾叫醒一次没完没了）
      if (toldRecently(state, noticeText, now)) return 0;
      saveTickState(dir, sessionId, { ...state, lastNotice: noticeText, noticeAt: now });
      err(`${noticeText}（连续 ${failures} 次）`);
      return 2;
    }
  } catch (e) {
    err(`对账没查成：盯账进程自己出错（${why(e)}）`);
    return 2;
  } finally {
    release();
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  let input = {};
  try {
    const raw = readFileSync(0, 'utf8');
    input = JSON.parse((raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) || '{}');
  } catch {
    // 读不懂输入：认不出会话，不盯
  }
  // 读的那头关了，写出错走 'error' 事件；不接住会让进程崩出一个非 0、非 2 的码
  process.stdout.on('error', () => {});
  process.exitCode = await watch(input, {
    parentAlive: async () => alive(process.ppid) && (await hostAlive()),
  });
}
