// 收轮前对账（单 #2731）：会话收不收这一轮，不只看「还有没有东西在跑」，还看「还有没有活」。
// 10-16 15:06 旧会话说「本机现在没有工人在跑」就收了，队列里还有 4 件；以前的判据（unattended.mjs）只数 background_tasks 的条数、
// 只在无人值守时判，人在场时什么都不查。
//
// 判法（人在不在场都判，stop.mjs 在无人值守那一段之前调）：
// 1. 有子代理在跑（Stop 输入 background_tasks 里 type 不是 shell、monitor 的：subagent、workflow、teammate……）或有定时唤醒
//    （session_crons）→ 放行，它们收口会把会话叫回来。只有后台命令、监视器在跑不算：照样往下判。
// 2. 这个会话的无人值守是 done / needs-you（paused）→ 放行：它已经说了做完、或在等人拍。
// 3. 本机队列（仓里的 `node packages/conventions/src/bin/work.ts queue --json`，就是 pnpm work queue）有可接的活；
// 4. 本机容量够（capacity.mjs：空闲内存 ≥ 4G、1 分钟负载 ≤ 核数×0.8；不数在跑几个工人）；
// 两样都成 → 挡回这一轮，理由列可接的前三件和读数。连着挡 MAX_STREAK（3）次放行一次（决定 0093 同一个数），计数记在
// <状态目录>/<会话号>.queue.json（状态目录和无人值守同一个，FLEET_UNATTENDED_DIR 可改）。
// 读不成：会话目录不在 fleet-dao 的检出里（找不到 work.ts）→ 不管、不出声；队列命令跑不成、容量读不到 → 不挡，明说「没查成」，
// 不当成没活、也不当成够。这里任何一步自己出错一律放行（只提示），不能把人困住。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { judgeCapacity, readCapacityAsync } from './capacity.mjs';
import { cleanId, MAX_STREAK, readState } from './unattended.mjs';

/** 队列命令最多等多久（毫秒）：两条 gh 并行，平常两三秒；收尾钩子整个只有 10 秒 */
export const QUEUE_TIMEOUT_MS = 7000;
/** 仓里队列命令的相对路径 */
export const QUEUE_BIN = join('packages', 'conventions', 'src', 'bin', 'work.ts');
/** 不算「子代理在跑」的后台活：后台命令和监视器 */
const NOT_AGENT_TASKS = new Set(['shell', 'monitor']);

/** @typedef {{ issue: number, title: string, takeable: boolean }} QueueItemLite */
/** @typedef {{ ok: true, items: QueueItemLite[], problems: string[] } | { ok: false, why: string }} QueueRead 读队列：成、没查成 */
/**
 * @typedef {{
 *   input: unknown,
 *   dir: string,
 *   sessionId: string,
 *   readQueue?: (root: string) => Promise<QueueRead>,
 *   readCap?: () => Promise<import('./capacity.mjs').Reading>,
 * }} QueueStopOpts
 */

/**
 * @param {unknown} o
 * @param {string} k
 * @returns {unknown}
 */
const prop = (o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined);
/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Stop 输入里有没有子代理（或别的会叫回会话的非命令活）、定时唤醒在跑。只有后台命令和监视器不算。
 * @param {unknown} input
 */
export function agentRunning(input) {
  const tasks = prop(input, 'background_tasks');
  const crons = prop(input, 'session_crons');
  if (Array.isArray(crons) && crons.length > 0) return true;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((t) => {
    const type = prop(t, 'type');
    return !(typeof type === 'string' && NOT_AGENT_TASKS.has(type));
  });
}

/**
 * 从 cwd 往上找 fleet-dao 的检出（有 packages/conventions/src/bin/work.ts 的那一层）。找不到 null。
 * @param {string} cwd
 */
export function repoRootOf(cwd) {
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, QUEUE_BIN))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * 真读队列：在仓根跑 node packages/conventions/src/bin/work.ts queue --json。
 * @param {string} root repoRootOf 找到的仓根
 * @returns {Promise<QueueRead>}
 */
export function realReadQueue(root) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [join(root, QUEUE_BIN), 'queue', '--json'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: QUEUE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const how = err.killed
            ? `${QUEUE_TIMEOUT_MS} 毫秒没跑完，杀掉了`
            : typeof err.code === 'number'
              ? `退出码 ${err.code}：${(stderr || stdout || '').trim().slice(0, 300)}`
              : `没跑起来（${err.message}）`;
          done({ ok: false, why: `队列命令${how}` });
          return;
        }
        done(parseQueue(stdout));
      },
    );
  });
}

/**
 * 读 pnpm work queue --json 的输出；认不出算没查成。
 * @param {string} text
 * @returns {QueueRead}
 */
export function parseQueue(text) {
  /** @type {unknown} */
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, why: `队列命令的输出不是 JSON：${text.trim().slice(0, 200)}` };
  }
  const items = prop(v, 'items');
  const problems = prop(v, 'problems');
  if (!Array.isArray(items) || !Array.isArray(problems)) return { ok: false, why: '队列命令的输出认不出' };
  /** @type {QueueItemLite[]} */
  const out = [];
  for (const i of items) {
    const issue = prop(i, 'issue');
    const title = prop(i, 'title');
    const takeable = prop(i, 'takeable');
    if (typeof issue !== 'number' || typeof title !== 'string' || typeof takeable !== 'boolean') {
      return { ok: false, why: '队列命令的输出里有一张单认不出' };
    }
    out.push({ issue, title, takeable });
  }
  return { ok: true, items: out, problems: problems.map(String) };
}

/**
 * @param {string} dir
 * @param {string} sessionId
 */
const streakFile = (dir, sessionId) => join(dir, `${sessionId}.queue.json`);

/**
 * @param {string} dir
 * @param {string} sessionId
 * @returns {{ streak: number, releases: number }}
 */
function readStreak(dir, sessionId) {
  try {
    const v = JSON.parse(readFileSync(streakFile(dir, sessionId), 'utf8'));
    const streak = Number(prop(v, 'streak'));
    const releases = Number(prop(v, 'releases'));
    return {
      streak: Number.isInteger(streak) && streak >= 0 ? streak : 0,
      releases: Number.isInteger(releases) && releases >= 0 ? releases : 0,
    };
  } catch {
    return { streak: 0, releases: 0 };
  }
}

/**
 * @param {string} dir
 * @param {string} sessionId
 * @param {{ streak: number, releases: number }} s
 */
function writeStreak(dir, sessionId, s) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(streakFile(dir, sessionId), `${JSON.stringify(s)}\n`);
}

/**
 * 不挡时把连着挡的计数清零（只在不是 0 时写）。
 * @param {string} dir
 * @param {string} sessionId
 */
function resetStreak(dir, sessionId) {
  const s = readStreak(dir, sessionId);
  if (s.streak !== 0) writeStreak(dir, sessionId, { ...s, streak: 0 });
}

/**
 * 挡回去的理由：前三件可接的、读数、怎么办。
 * @param {QueueItemLite[]} takeable
 * @param {string} capText
 * @param {number} streak 这是连着第几次挡
 */
export function queueReason(takeable, capText, streak) {
  const top = takeable
    .slice(0, 3)
    .map((i) => `#${i.issue} ${i.title}`)
    .join('；');
  return (
    `收轮前对账：本机队列还有 ${takeable.length} 件可接的活（前三件：${top}），${capText}，而且没有子代理在跑——先派工人再收这一轮` +
    `（连着第 ${streak} 次挡，到 ${MAX_STREAK} 次放行一次）。` +
    '派法：Agent 子代理 subagent_type: "general-purpose"，交代写单号、分支 local/<单号>-<短名>、怎么算做完；同时在跑的工人不改同一批文件。' +
    '只有后台命令、监视器在跑不算有人在干活。看全队列：pnpm work queue。' +
    '这件真不该现在接（等创始人拍、方向没定）：给单贴「要人拍」或摘掉「本机做」交给法国，它就不再算可接。'
  );
}

/**
 * 收轮前对账：要不要挡。不抛。
 * @param {QueueStopOpts} opts
 * @returns {Promise<{ block: true, reason: string } | { block: false, notice?: string }>}
 */
export async function decideQueueStop({
  input,
  dir,
  sessionId,
  readQueue = realReadQueue,
  readCap = readCapacityAsync,
}) {
  try {
    if (!cleanId(sessionId)) return { block: false };
    if (agentRunning(input)) {
      resetStreak(dir, sessionId);
      return { block: false };
    }
    const un = readState(dir, sessionId);
    if (un.ok && un.state !== null && (un.state.state === 'done' || un.state.state === 'paused')) {
      resetStreak(dir, sessionId);
      return { block: false };
    }
    const cwdRaw = prop(input, 'cwd');
    const cwd = typeof cwdRaw === 'string' && cwdRaw !== '' ? cwdRaw : process.cwd();
    const root = repoRootOf(cwd);
    if (root === null) return { block: false };
    // 队列和容量一起读（起 node 读 gh、起 PowerShell 读 CIM 各要两三秒，收尾钩子整个只有 10 秒）
    const [q, reading] = await Promise.all([readQueue(root), readCap()]);
    if (q.ok === false) return { block: false, notice: `收轮前对账没查成本机队列：${q.why}（这一轮不挡）` };
    const takeable = q.items.filter((i) => i.takeable);
    if (takeable.length === 0) {
      resetStreak(dir, sessionId);
      return { block: false };
    }
    const cap = judgeCapacity(reading);
    if (cap.enough !== true) {
      resetStreak(dir, sessionId);
      return cap.enough === null
        ? {
            block: false,
            notice: `收轮前对账：队列还有 ${takeable.length} 件可接，但${cap.text}（不当成够，这一轮不挡）`,
          }
        : { block: false };
    }
    const s = readStreak(dir, sessionId);
    if (s.streak >= MAX_STREAK) {
      writeStreak(dir, sessionId, { streak: 0, releases: s.releases + 1 });
      return {
        block: false,
        notice: `收轮前对账：队列还有 ${takeable.length} 件可接、容量够，连着挡了 ${MAX_STREAK} 次也没派工人，这一轮放行（第 ${s.releases + 1} 次）。`,
      };
    }
    writeStreak(dir, sessionId, { streak: s.streak + 1, releases: s.releases });
    return { block: true, reason: queueReason(takeable, cap.text, s.streak + 1) };
  } catch (e) {
    return { block: false, notice: `收轮前对账自己出错了（${why(e)}）：这一轮不挡。` };
  }
}
