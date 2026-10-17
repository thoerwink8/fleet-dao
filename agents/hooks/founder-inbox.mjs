// Mirasim 血缘和实际历史记录的只读接口。turns 在收尾落盘，缺行不代表未投递。
// 读不到、血缘冲突或格式认不出都明确报告；不比较投递差集、不重注入原文。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dayOf, logDir } from './prompt-log.mjs';
import { isMachineOpening, isMachineSession } from './unattended.mjs';

/** 最近多久以内的话算数（和 session-start.mjs 列「收到的话」同一个窗口） */
export const RECENT_MS = 60 * 60_000;
/** 上一轮再早，实际历史也不回头超过这么久 */
export const MAX_LOOKBACK_MS = 24 * 60 * 60_000;

/** 后台任务完成、系统提醒、上下文接续这些不是他的话（和 session-start.mjs 的 SYSTEM_PROMPT 一样） */
const SYSTEM_PROMPT = /^\s*(?:<task-notification|<system-reminder|<prior-conversation|\[SYSTEM NOTIFICATION)/;
/** Mirasim 附图时在话前面加的一行 */
const ATTACHMENT_NOTE = /\[The image above is also on disk at:[^\]]*\]\s*/g;

/** @typedef {{ at: number, text: string, sessionId: string | null, kind: 'prompt' | 'steer', line: string }} Sent 他发出的一条；line 是它所在的 Mirasim 会话目录名（血缘） */
/** @typedef {{ at: number, text: string, sessionId: string | null, line?: string | null }} Received Claude Code 收到的一条（prompt-log 里的）；line 是收它的原生会话号所属的血缘，认不出不给 */
/**
 * @typedef {{ status: 'found', dir: string, sessionIds: string[] }
 *   | { status: 'none', why: string }
 *   | { status: 'unchecked', why: string }} Lineage
 * 一个原生会话号的血缘：found = 它所属的 Mirasim 会话目录名和这个目录用过的全部原生会话号；none = 无血缘（不是 Mirasim 起的、
 * 这台没装、没给会话号）；unchecked = 没查成（列不了、读不了、一个会话号出现在两个目录里），不当成无血缘。
 */

/**
 * Mirasim 的家目录：测试给 FLEET_MIRASIM_DIR 覆盖
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 */
export function mirasimDir(env, home) {
  const o = env.FLEET_MIRASIM_DIR;
  return typeof o === 'string' && o ? o : join(home, '.mirasim');
}

/** 错误的 code（ENOENT 这种），没有就整个错误 @param {unknown} err */
function errCode(err) {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : String(err);
}

/**
 * 是不是他本人打的一句话（不是系统消息、不是斜杠命令、不是机器派会话的开场白）
 * @param {unknown} text
 * @returns {text is string}
 */
function isFounderText(text) {
  if (typeof text !== 'string') return false;
  const t = text.replace(ATTACHMENT_NOTE, '').trim();
  if (!t) return false;
  if (SYSTEM_PROMPT.test(t)) return false;
  if (/^\/[a-z]/i.test(t)) return false;
  return !isMachineOpening(t);
}

/** 会话号的样子（真的是 UUID）：认不出的不拿去比 */
const SESSION_ID = /^[\w-]{1,128}$/;

/**
 * 读一个文件；不存在给 null，别的读不了抛
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 一个原生会话号属于哪条血缘：哪个 Mirasim 会话目录（~/.mirasim/sessions/claude/<目录>/）的目录名、record.json 的
 * nativeSessionId、turns.jsonl 里某一轮的 sessionId 是它。返回那个目录名和它用过的全部原生会话号（含目录名本身：
 * Mirasim 自己起的会话，第一个原生号就是目录名）。
 * @param {{ home: string, sessionId: unknown, env?: Record<string, string | undefined> }} opts
 * @returns {Lineage}
 */
export function lineageOf({ home, sessionId, env = process.env }) {
  const id = typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? sessionId : null;
  if (id === null) return { status: 'none', why: '没有会话号' };
  const base = join(mirasimDir(env, home), 'sessions', 'claude');
  if (!existsSync(base)) return { status: 'none', why: '这台没装 Mirasim' };
  let dirs;
  try {
    dirs = readdirSync(base);
  } catch (err) {
    return { status: 'unchecked', why: `${base} 列不了（${errCode(err)}）` };
  }
  /** @type {string[]} */
  const problems = [];
  /** @type {Array<{ dir: string, ids: Set<string> }>} */
  const hits = [];
  for (const d of dirs) {
    let record;
    let turns;
    try {
      record = readOrNull(join(base, d, 'record.json'));
      turns = readOrNull(join(base, d, 'turns.jsonl'));
    } catch (err) {
      problems.push(`${join(base, d)} 读不了（${errCode(err)}）`);
      continue;
    }
    // 先按原文粗筛：目录名、两份文件里都没出现这个号的，不用解析
    if (d !== id && !record?.includes(id) && !turns?.includes(id)) continue;
    /** @type {Set<string>} */
    const ids = new Set();
    if (SESSION_ID.test(d)) ids.add(d);
    if (record !== null) {
      try {
        const native = JSON.parse(record)?.nativeSessionId;
        if (typeof native === 'string' && SESSION_ID.test(native)) ids.add(native);
      } catch {
        problems.push(`${join(base, d, 'record.json')} 认不出（Mirasim 换格式了？）`);
      }
    }
    for (const row of (turns ?? '').split(/\r?\n/)) {
      if (!row.trim()) continue;
      try {
        const sid = JSON.parse(row)?.sessionId;
        if (typeof sid === 'string' && SESSION_ID.test(sid)) ids.add(sid);
      } catch {
        // 认不出的一行：sentByFounder 那边会报；这里只认得出的
      }
    }
    if (ids.has(id)) hits.push({ dir: d, ids });
  }
  if (hits.length > 1)
    return {
      status: 'unchecked',
      why: `会话号 ${id} 出现在 ${hits.length} 个 Mirasim 会话里（${hits.map((h) => h.dir).join('、')}），认不了是哪一家`,
    };
  const [hit] = hits;
  if (hit) return { status: 'found', dir: hit.dir, sessionIds: [...hit.ids].sort() };
  if (problems.length > 0) return { status: 'unchecked', why: problems.join('；') };
  return { status: 'none', why: `Mirasim 里没有会话号 ${id}（不是 Mirasim 起的会话）` };
}

/**
 * 读取上一轮（含）以来实际落盘的提问和引导；至少60分钟，最多24小时，不推断送达。
 * only 给了就只读这一个 Mirasim 会话目录（本血缘），不给读全部。
 * @param {{ home: string, now?: number, env?: Record<string, string | undefined>, only?: string | null }} opts
 * @returns {{ absent: true } | { absent: false, entries: Sent[], problems: string[], since: number }}
 */
export function sentByFounder({ home, now = Date.now(), env = process.env, only = null }) {
  const base = join(mirasimDir(env, home), 'sessions', 'claude');
  if (!existsSync(base)) return { absent: true };
  /** @type {Sent[]} */
  const entries = [];
  /** @type {string[]} */
  const problems = [];
  // 各 Mirasim 会话各自截范围；这里只记最早的起点，给收到的账读多远用
  let since = now - RECENT_MS;
  let dirs;
  try {
    dirs = only === null ? readdirSync(base) : [only];
  } catch (err) {
    return { absent: false, entries, problems: [`${base} 列不了（${errCode(err)}）`], since };
  }
  for (const d of dirs) {
    const file = join(base, d, 'turns.jsonl');
    if (!existsSync(file)) continue;
    let workdir = null;
    try {
      const rec = JSON.parse(readFileSync(join(base, d, 'record.json'), 'utf8'));
      if (typeof rec?.workdir === 'string') workdir = rec.workdir;
    } catch {
      // 没有 record.json 或读不了：按不是机器派的算（宁可多列一条，也不把他的话藏起来）
    }
    if (isMachineSession({ env: {}, cwd: workdir })) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      problems.push(`${file} 读不了（${errCode(err)}）`);
      continue;
    }
    let bad = 0;
    /** @type {number[]} 这个会话每一轮的开始时刻 */
    const starts = [];
    /** @type {Sent[]} 这个 Mirasim 目录里读到的全部，再用它自己的上一轮起点截 */
    const mine = [];
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      let turn;
      try {
        turn = JSON.parse(row);
      } catch {
        bad++;
        continue;
      }
      if (!turn || typeof turn !== 'object') {
        bad++;
        continue;
      }
      const sessionId = typeof turn.sessionId === 'string' ? turn.sessionId : null;
      const startedAt = Number(turn.startedAt);
      if (Number.isFinite(startedAt) && startedAt > 0 && startedAt <= now + 60_000) starts.push(startedAt);
      if (isFounderText(turn.prompt) && Number.isFinite(startedAt) && startedAt > 0)
        mine.push({ at: startedAt, text: turn.prompt, sessionId, kind: 'prompt', line: d });
      for (const s of Array.isArray(turn.steers) ? turn.steers : []) {
        const at = Number(s?.at);
        if (isFounderText(s?.text) && Number.isFinite(at) && at > 0)
          mine.push({ at, text: s.text, sessionId, kind: 'steer', line: d });
      }
    }
    // 上一轮 = 倒数第二轮；只截本目录，不拿别的 Mirasim 会话的起点拉长本目录的窗口
    starts.sort((a, b) => a - b);
    let dirSince = now - RECENT_MS;
    const previous = starts[starts.length - 2];
    if (previous !== undefined) dirSince = Math.min(dirSince, Math.max(previous, now - MAX_LOOKBACK_MS));
    since = Math.min(since, dirSince);
    for (const e of mine) if (e.at >= dirSince && e.at <= now + 60_000) entries.push(e);
    if (bad > 0) problems.push(`${file} 里有 ${bad} 行认不出（Mirasim 换格式了？）`);
  }
  entries.sort((a, b) => a.at - b.at);
  return { absent: false, entries, problems, since };
}

/** 主人会话闲置多久算「已不在」（自动认领它的引导） */
export const OWNER_IDLE_MS = 12 * 60 * 60_000;

/**
 * 记引导的那个 Mirasim 会话（主人）还在不在，只认本机 Mirasim 的记录（~/.mirasim/sessions/claude/<目录>/record.json）：
 * - gone：确定不在了——它把活交接给了别的会话（别的会话的 record.json 里 handoverFrom 是它）且自己没在跑；或没在跑（runPid 空）、
 *   最后一次动静（record.json 的 updatedAt、turns.jsonl 的修改时刻取晚的）离现在超过 OWNER_IDLE_MS。
 * - here：在跑，或最近 OWNER_IDLE_MS 里还动过。
 * - unknown：判不了——这台没装 Mirasim、没有这个目录（可能是别的机器记的）、record.json 读不了认不出、无主。判不了的不认领。
 * @param {{ home: string, owner: string, now?: number, env?: Record<string, string | undefined> }} opts
 * @returns {{ state: 'gone' | 'here' | 'unknown', why: string }}
 */
export function ownerPresence({ home, owner, now = Date.now(), env = process.env }) {
  if (typeof owner !== 'string' || !SESSION_ID.test(owner))
    return { state: 'unknown', why: '无主或主人名认不出' };
  const base = join(mirasimDir(env, home), 'sessions', 'claude');
  if (!existsSync(base)) return { state: 'unknown', why: '这台没装 Mirasim' };
  const dir = join(base, owner);
  if (!existsSync(dir))
    return { state: 'unknown', why: `本机没有 Mirasim 会话 ${owner}（可能是别的机器记的）` };
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  } catch (err) {
    return { state: 'unknown', why: `${owner} 的 record.json 读不了或认不出（${errCode(err)}）` };
  }
  if (!rec || typeof rec !== 'object') return { state: 'unknown', why: `${owner} 的 record.json 认不出` };
  const running = rec.runPid !== null && rec.runPid !== undefined;
  if (running) return { state: 'here', why: `${owner} 正在跑` };
  let handedTo = null;
  try {
    for (const d of readdirSync(base)) {
      if (d === owner) continue;
      const text = readOrNull(join(base, d, 'record.json'));
      if (text === null || !text.includes(owner)) continue;
      try {
        if (JSON.parse(text)?.handoverFrom === owner) handedTo = d;
      } catch {
        // 别的会话的记录认不出：不拿它当证据
      }
    }
  } catch {
    // 列不了：交接这条证据用不上，下面按闲置判
  }
  if (handedTo !== null) return { state: 'gone', why: `${owner} 已交接给 ${handedTo}，自己没在跑` };
  const updated = Date.parse(String(rec.updatedAt ?? ''));
  if (!Number.isFinite(updated))
    return { state: 'unknown', why: `${owner} 的 record.json 没有能认的 updatedAt` };
  let last = updated;
  try {
    last = Math.max(last, statSync(join(dir, 'turns.jsonl')).mtimeMs);
  } catch {
    // 没有 turns.jsonl：只按 updatedAt
  }
  const idleH = (now - last) / 3_600_000;
  if (now - last > OWNER_IDLE_MS)
    return { state: 'gone', why: `${owner} 没在跑、已闲置 ${idleH.toFixed(0)} 小时` };
  return { state: 'here', why: `${owner} ${idleH.toFixed(1)} 小时前还动过` };
}

// —— 同血缘的实际历史，只读、不推断投递状态 ——

/** 后台任务完成、系统提醒也会以「用户消息」的身份进 UserPromptSubmit，落盘时原样记，列的时候不算创始人的话（和 session-start.mjs 原来的一样） */
const LOGGED_SYSTEM_PROMPT = /^\s*(?:<task-notification|<system-reminder|\[SYSTEM NOTIFICATION)/;

/**
 * 同血缘的实际 prompt-log 历史及来源诊断。
 * @param {{ home: string, now?: number, sessionId: unknown, env?: Record<string, string | undefined>, dir?: string | null, lineage?: Lineage | null }} opts
 */
export function readFounderHistory({
  home,
  now = Date.now(),
  sessionId,
  env = process.env,
  dir = null,
  lineage = null,
}) {
  const line = lineage ?? lineageOf({ home, sessionId, env });
  if (line.status === 'none') return { status: /** @type {const} */ ('none') };
  if (line.status === 'unchecked') return { status: /** @type {const} */ ('unchecked'), why: line.why };
  const family = new Set(line.sessionIds);
  // 落盘目录和写的那边（prompt-log.mjs 的 logDir）同一份
  const base = dir ?? logDir(env, home);
  // 本血缘实际 turns 只用于来源诊断，不用于投递判断。
  const sent = sentByFounder({ home, now, env, only: line.dir });
  const since = now - RECENT_MS;
  const days = new Set([dayOf(now), dayOf(since)]);
  for (let t = since; t < now; t += 12 * 3_600_000) days.add(dayOf(t));
  /** @type {Received[]} 收到的账：本血缘里哪个原生会话号收到的都记，别的会话收到的不记 */
  const received = [];
  /** @type {string[]} */
  const problems = [];
  for (const day of days) {
    const file = join(base, `${day}.jsonl`);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (errCode(err) === 'ENOENT') continue;
      problems.push(`创始人落盘的话没读成：${file} 读不了（${errCode(err)}）；本会话历史这次没读全。`);
      continue;
    }
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      try {
        const e = JSON.parse(row);
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
          problems.push(`${file} 有一行不是历史记录对象；本会话历史这次没读全。`);
          continue;
        }
        const at = Date.parse(e?.at);
        // 只有已认出本家号的记录才校验关键字段；别家正常过滤，不扩大读取范围。
        if (
          typeof e?.sessionId === 'string' &&
          family.has(e.sessionId) &&
          (typeof e.prompt !== 'string' || typeof e.at !== 'string' || !Number.isFinite(at))
        ) {
          problems.push(`${file} 本血缘记录的 prompt 或 at 认不出；本会话历史这次没读全。`);
          continue;
        }
        if (
          typeof e?.prompt === 'string' &&
          typeof e.sessionId === 'string' &&
          family.has(e.sessionId) &&
          !LOGGED_SYSTEM_PROMPT.test(e.prompt) &&
          isFounderText(e.prompt) &&
          !isMachineOpening(e.prompt) &&
          !isMachineSession({ env: {}, cwd: e.cwd }) &&
          Number.isFinite(at) &&
          at >= since &&
          at <= now + 60_000
        )
          received.push({ at, text: e.prompt, sessionId: e.sessionId, line: line.dir });
      } catch {
        problems.push(`${file} 有一行认不出；本会话历史这次没读全。`);
      }
    }
  }
  return {
    status: /** @type {const} */ ('ok'),
    line,
    sent,
    received,
    readError: problems.length ? problems.join('；') : null,
  };
}
