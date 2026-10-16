// 创始人「发了什么」的账：读 Mirasim 自己的会话记录（~/.mirasim/sessions/claude/<会话>/turns.jsonl）。
//
// 为什么要有它：prompt-log.mjs 记的是 Claude Code **收到**的话（UserPromptSubmit 那一刻），而他在一轮跑着的时候打的字走的是
// Mirasim 的「引导」（steer）：Mirasim 把它攒着、等这一轮下一次调模型时才塞进去；这一轮在那之前被打断（他点停、他又发一条）、出错
// （上游断连）或就此结束，那条引导就没了——Mirasim 界面上照样显示「已引导」，Claude Code 的任何钩子都没见过它。10-05 起 14 条引导
// 丢了 8 条、83 条提问丢了 8 条（被打断的那一轮、进程还没起来就被打断的）。所以只看「收到的账」永远查不出「没收到的」：
// 得拿「发了的账」和「收到的账」对，差集就是丢的。
//
// Mirasim 的记录：一个 Mirasim 会话一个目录，turns.jsonl 一行一轮；一轮里 prompt 是开这一轮的话、startedAt 是开始
// 时刻（毫秒），steers 是这一轮中途打的字（{ text, at }）；record.json 的 workdir 是这个会话开在哪个目录。一个 Mirasim 会话会换好几个
// Claude 原生会话号（/compact、换模型），每一轮的 sessionId 是当时的原生会话号，和 prompt-log 里记的同一个。
//
// 改这里之前必须知道：
// - 这是读别人家的文件：格式变了要能认出来——整份读不了、一行认不出都照实说「没读成」，不当成「没有」。目录不存在（这台没装
//   Mirasim、或会话不是它起的）才是真的「没有」，不出声。
// - 对账认同一条：① 同一家（同一条血缘；收到的认不出血缘才按原生会话号）后来收到了开头一样的话（不限 15 分钟）；② MATCH_MS 以内、同一家收到的话以丢的那句开头
//   （带下文重发）。一条收到的在「时间最近」配对里只对掉一条发的；「之后重发已收到」可以清掉更早的同句/短句。
// - 对账范围是「上一轮（含）以来」（一轮能跑一个多小时，固定 60 分钟窗口会漏掉开头发的引导）：每一个 Mirasim 会话各自算——把该目录 turns.jsonl 按 startedAt 排，倒数第二轮（上一轮；最后一轮是刚开的
//   这一轮）的开始时刻往后的 prompt 和 steers 都对，不管那一轮多长。只有一轮的会话没有「上一轮」，按固定窗口。不再把各会话的范围取并集
//   （并集会把别的会话丢的话算进每个会话的账，所以只读本血缘那一个目录，见下一条）。固定窗口 RECENT_MS 是下限（上一轮短于它时仍看最近 RECENT_MS），
//   MAX_LOOKBACK_MS 是上限（上一轮再早也不回头超过它）。返回的 since 是各会话范围起点的最早值，收到的账也要读到它。
// - 认主按「Mirasim 会话」这条血缘：一个
//   Mirasim 会话目录用过的全部原生会话号算一家。开会话钩子只给本血缘列它的话、对它的账；别的 Mirasim 会话的话一概不列
//   （原来「最近 60 分钟落盘的话」把所有会话的话列给每个会话，另一个项目的会话把 fleet-dao 的活当成自己的办了）。
//   找不到血缘（不是 Mirasim 起的、这台没装）返回「无血缘」，不猜、不拿别的会话的话顶。
// - 以前钩子转进来过的引导也算收到：现在不再往这份里写。旧记录还在，
//   不进 prompt-log；它只记在 ~/.fleet-dao/steer-shown/<原生会话号>.json（{ at: 最后转过的那条的 Mirasim 时刻 }）。
//   本血缘任一号的 at 以前（含）的本 Mirasim 会话的引导算收到（relayedUpTo）。那份读不了、认不出照实说没核成，不当成收到。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { inboxSeenDir } from './inbox-tick.mjs';
import { dayOf, logDir } from './prompt-log.mjs';
import { shownFile, steerShownDir } from './steer-shown.mjs';
import { isMachineOpening, isMachineSession } from './unattended.mjs';

/** 最近多久以内的话算数（和 session-start.mjs 列「收到的话」同一个窗口） */
export const RECENT_MS = 60 * 60_000;
/** 上一轮再早，对账也不回头超过这么久 */
export const MAX_LOOKBACK_MS = 24 * 60 * 60_000;
/** 「发了」和「收到」时刻差在这以内、开头一样，算同一条 */
export const MATCH_MS = 15 * 60_000;
/** 对账时话取多长的开头 */
const KEY_CHARS = 80;

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

/** 对账用的键：去掉附图那一行、压掉空白、取开头 @param {unknown} text */
export function promptKey(text) {
  return String(text).replace(ATTACHMENT_NOTE, '').replace(/\s+/g, ' ').trim().slice(0, KEY_CHARS);
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
 * 「上一轮（含）以来」他在 Mirasim 里发出的话（范围见文件开头）：开一轮的提问和中途的引导都算。
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

/**
 * 发了的和收到的是不是同一家（对账、重发识别都按家各算各的）：收到的那条认得出血缘，就按血缘比（同一个 Mirasim 会话换了
 * 原生号，换号前发的、换号后收到的也算同一家）；认不出血缘才退回按原生会话号比。
 * @param {Sent} s
 * @param {Received} r
 */
function sameSession(s, r) {
  if (typeof r.line === 'string') return r.line === s.line;
  return typeof s.sessionId === 'string' && s.sessionId === r.sessionId;
}

/**
 * 钩子（main-thread.mjs）把本血缘的引导转进来到了哪一刻：读本血缘每个原生会话号的 steer-shown 记录，取最晚的 at（毫秒）。
 * 一份都没有（没转过）给 null。某一份读不了、认不出：记进 problems、不拿它算（宁可照没收到列，也不把丢的藏起来）。
 * @param {{ home: string, sessionIds: string[], env?: Record<string, string | undefined> }} opts
 * @returns {{ at: number | null, problems: string[] }}
 */
export function relayedUpTo({ home, sessionIds, env = process.env }) {
  const dir = steerShownDir(env, home);
  /** @type {number | null} */
  let at = null;
  /** @type {string[]} */
  const problems = [];
  for (const id of sessionIds) {
    const file = shownFile(dir, id);
    let text;
    try {
      text = readOrNull(file);
    } catch (err) {
      problems.push(`${file} 读不了（${errCode(err)}）`);
      continue;
    }
    if (text === null) continue;
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(text)?.at;
    } catch {
      value = undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      problems.push(`${file} 认不出（不是 { at: 毫秒 }）`);
      continue;
    }
    if (at === null || value > at) at = value;
  }
  return { at, problems };
}

/**
 * 对账：发了的里面哪些没收到。received 是 prompt-log 里的（{ at: 毫秒, text, sessionId }），一条收到的只对掉一条发的。
 * relayed 给了：血缘 line 里、at 以前（含）的引导是钩子转进来过的（relayedUpTo），没在 prompt-log 里对上也算收到。
 * 返回 { lost, matched, relayed }：lost 是没对上的发了的话；matched 是对上的，带上收到它的那个会话号（看是不是本会话）；
 * relayed 是靠钩子转进来算收到的引导。
 * @param {Sent[]} sent
 * @param {Received[]} received
 * @param {{ relayed?: { line: string, at: number | null } | null }} [opts]
 * @returns {{ lost: Sent[], matched: Array<Sent & { receivedBy: string | null }>, relayed: Sent[] }}
 */
export function reconcile(sent, received, { relayed = null } = {}) {
  /** @type {Array<Received & { key: string, used: boolean }>} */
  const recv = received.map((r) => ({ ...r, key: promptKey(r.text), used: false }));
  /** @type {Array<Sent & { key: string, hit: (Received & { key: string, used: boolean }) | null }>} */
  const sentRows = sent.map((s) => ({ ...s, key: promptKey(s.text), hit: null }));
  // 先配时间最近的一对（引导丢了、他 3 分钟后原话重发并收到：重发那条配上，丢的那条才算丢，不能让早的那条抢走）
  /** @type {Array<{ s: (typeof sentRows)[number], r: (typeof recv)[number], gap: number }>} */
  const pairs = [];
  for (const s of sentRows)
    for (const r of recv) {
      const gap = Math.abs(r.at - s.at);
      if (sameSession(s, r) && r.key === s.key && gap <= MATCH_MS) pairs.push({ s, r, gap });
    }
  pairs.sort((a, b) => a.gap - b.gap);
  for (const { s, r } of pairs) {
    if (s.hit || r.used) continue;
    s.hit = r;
    r.used = true;
  }
  /** 丢了、但同会话之后重发并收到了：① 原话（不限 15 分钟）；② MATCH_MS 内带下文（收到的以丢句开头） */
  const coveredLater = (/** @type {(typeof sentRows)[number]} */ s) =>
    recv.some((r) => {
      if (!sameSession(s, r) || r.at < s.at) return false;
      if (r.key === s.key) return true;
      return r.at - s.at <= MATCH_MS && r.key.startsWith(s.key);
    });
  /** @type {Array<Sent & { receivedBy: string | null }>} */
  const matched = [];
  /** 钩子转进来过：本血缘的引导、不晚于转过的那一刻 */
  const relayedIn = (/** @type {(typeof sentRows)[number]} */ s) =>
    relayed !== null &&
    relayed.at !== null &&
    s.kind === 'steer' &&
    s.line === relayed.line &&
    s.at <= relayed.at;
  /** @type {Sent[]} */
  const lost = [];
  /** @type {Sent[]} */
  const viaHook = [];
  for (const s of sentRows) {
    const row = { at: s.at, text: s.text, sessionId: s.sessionId, kind: s.kind, line: s.line };
    if (s.hit) matched.push({ ...row, receivedBy: s.hit.sessionId ?? null });
    else if (relayedIn(s)) viaHook.push(row);
    else if (!coveredLater(s)) lost.push(row);
  }
  return { lost, matched, relayed: viaHook };
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

// —— 对账（开会话钩子和主线程每次工具调用后的钩子共用）和「本会话已见」名单 ——

/** 后台任务完成、系统提醒也会以「用户消息」的身份进 UserPromptSubmit，落盘时原样记，列的时候不算创始人的话（和 session-start.mjs 原来的一样） */
const LOGGED_SYSTEM_PROMPT = /^\s*(?:<task-notification|<system-reminder|\[SYSTEM NOTIFICATION)/;

/**
 * 发了的账和收到的账对一遍（session-start.mjs 的开场对账、inbox-tick.mjs 的轮中对账都走这一个，不各抄一份）。
 * 返回：
 * - { status: 'none' }：无血缘（不是 Mirasim 起的、这台没装），不出声；
 * - { status: 'unchecked', why }：认不出本会话是哪个 Mirasim 会话；
 * - { status: 'ok', line, sent, received, readError, relayProblems, lost }：readError 非空 = prompt-log 没读成（别的字段不可信）；
 *   sent 是 sentByFounder 的原样结果（absent / problems 在里面）；lost 是发了、没收到的（sent.absent 时为空）。
 * @param {{ home: string, now?: number, sessionId: unknown, env?: Record<string, string | undefined>, dir?: string | null, lineage?: Lineage | null }} opts
 */
export function reconcileInbox({
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
  const base = dir ?? logDir(process.env, home);
  // 发了的账（本血缘那一个 Mirasim 会话目录）：对账范围是「上一轮（含）以来」，可能比 RECENT_MS 早得多（文件开头），收到的账也读到那么早
  const sent = sentByFounder({ home, now, env, only: line.dir });
  const since = sent.absent ? now - RECENT_MS : Math.min(now - RECENT_MS, sent.since);
  const days = new Set([dayOf(now), dayOf(since)]);
  for (let t = since; t < now; t += 12 * 3_600_000) days.add(dayOf(t));
  /** @type {Received[]} 收到的账：本血缘里哪个原生会话号收到的都记，别的会话收到的不记 */
  const received = [];
  for (const day of days) {
    const file = join(base, `${day}.jsonl`);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (errCode(err) === 'ENOENT') continue;
      return {
        status: /** @type {const} */ ('ok'),
        line,
        sent,
        received: [],
        relayProblems: [],
        lost: [],
        readError: `创始人落盘的话没读成：${file} 读不了（${errCode(err)}）；这个会话没送到的话可能在里面。`,
      };
    }
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      try {
        const e = JSON.parse(row);
        const at = Date.parse(e?.at);
        if (
          typeof e?.prompt === 'string' &&
          typeof e.sessionId === 'string' &&
          family.has(e.sessionId) &&
          !LOGGED_SYSTEM_PROMPT.test(e.prompt) &&
          !isMachineOpening(e.prompt) &&
          !isMachineSession({ env: {}, cwd: e.cwd }) &&
          Number.isFinite(at) &&
          at >= since &&
          at <= now + 60_000
        )
          received.push({ at, text: e.prompt, sessionId: e.sessionId, line: line.dir });
      } catch {
        // 坏的一行跳过：别因为一行坏了就把别的话也藏起来
      }
    }
  }
  /** @type {Sent[]} */
  let lost = [];
  /** @type {string[]} */
  let relayProblems = [];
  if (!sent.absent) {
    // 现在不再往 steer-shown 写。旧记录还在：转过的仍算收到，免得把已经转过的再列一遍
    const relay = relayedUpTo({ home, sessionIds: line.sessionIds, env });
    relayProblems = relay.problems;
    lost = reconcile(sent.entries, received, { relayed: { line: line.dir, at: relay.at } }).lost;
  }
  return {
    status: /** @type {const} */ ('ok'),
    line,
    sent,
    received,
    relayProblems,
    lost,
    readError: /** @type {string | null} */ (null),
  };
}

/** 已见名单里最多留多久（比 MAX_LOOKBACK_MS 长一点，过了的条目对账也不会再翻出来） */
const SEEN_KEEP_MS = MAX_LOOKBACK_MS + 60 * 60_000;

/** 一条发出的话在已见名单里的键：发出时刻 + 话的开头 @param {{ at: number, text: string }} s */
export const seenKey = (s) => `${Math.round(s.at)}:${promptKey(s.text)}`;

/** @param {string} dir @param {string} lineDir */
const seenFile = (dir, lineDir) => join(dir, `seen-${lineDir.replace(/[^\w.-]/g, '_')}.json`);

/**
 * 读本血缘的已见名单。没有文件 = 空名单；读不了、认不出给 problem（调用方明说，名单当空）。
 * @param {{ home: string, env?: Record<string, string | undefined>, lineDir: string }} opts
 * @returns {{ keys: Set<string>, problem: string | null }}
 */
export function readSeen({ home, env = process.env, lineDir }) {
  const file = seenFile(inboxSeenDir(env, home), lineDir);
  let text;
  try {
    text = readOrNull(file);
  } catch (err) {
    return { keys: new Set(), problem: `${file} 读不了（${errCode(err)}）` };
  }
  if (text === null) return { keys: new Set(), problem: null };
  try {
    const seen = JSON.parse(text)?.seen;
    if (seen && typeof seen === 'object' && !Array.isArray(seen))
      return { keys: new Set(Object.keys(seen)), problem: null };
  } catch {
    // 落到下面的「认不出」
  }
  return { keys: new Set(), problem: `${file} 认不出（不是 { seen: { 键: 时刻 } }）` };
}

/**
 * 把这些话记进本血缘的已见名单（合并旧的、丢掉过期的）。写不了抛。
 * @param {{ home: string, env?: Record<string, string | undefined>, lineDir: string, entries: Array<{ at: number, text: string }>, now?: number }} opts
 */
export function markSeen({ home, env = process.env, lineDir, entries, now = Date.now() }) {
  if (entries.length === 0) return;
  const dir = inboxSeenDir(env, home);
  const file = seenFile(dir, lineDir);
  /** @type {Record<string, number>} */
  const seen = {};
  try {
    const old = JSON.parse(readOrNull(file) ?? '{}')?.seen;
    if (old && typeof old === 'object')
      for (const [k, v] of Object.entries(old))
        if (typeof v === 'number' && now - v <= SEEN_KEEP_MS) seen[k] = v;
  } catch {
    // 旧名单坏了：重写一份新的
  }
  for (const e of entries) seen[seenKey(e)] = now;
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, seen }), 'utf8');
  renameSync(tmp, file);
}
