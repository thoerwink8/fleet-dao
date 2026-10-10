// 创始人「发了什么」的账：读 Mirasim 自己的会话记录（~/.mirasim/sessions/claude/<会话>/turns.jsonl）。
//
// 为什么要有它（创始人 2026-10-06 11:35「你好像没接收到【选方案a】，能不能把这个问题修复好」，12:00「如果收不到，我建议要么改写钩子，
// 要么不要钩子」）：prompt-log.mjs 记的是 Claude Code **收到**的话（UserPromptSubmit 那一刻），而他在一轮跑着的时候打的字走的是
// Mirasim 的「引导」（steer）：Mirasim 把它攒着、等这一轮下一次调模型时才塞进去；这一轮在那之前被打断（他点停、他又发一条）、出错
// （上游断连）或就此结束，那条引导就没了——Mirasim 界面上照样显示「已引导」，Claude Code 的任何钩子都没见过它。10-05 起 14 条引导
// 丢了 8 条、83 条提问丢了 8 条（被打断的那一轮、进程还没起来就被打断的）。所以只看「收到的账」永远查不出「没收到的」：
// 得拿「发了的账」和「收到的账」对，差集就是丢的。
//
// Mirasim 的记录（0.0.42x 实测）：一个 Mirasim 会话一个目录，turns.jsonl 一行一轮；一轮里 prompt 是开这一轮的话、startedAt 是开始
// 时刻（毫秒），steers 是这一轮中途打的字（{ text, at }）；record.json 的 workdir 是这个会话开在哪个目录。一个 Mirasim 会话会换好几个
// Claude 原生会话号（/compact、换模型），每一轮的 sessionId 是当时的原生会话号，和 prompt-log 里记的同一个。
//
// 改这里之前必须知道：
// - 这是读别人家的文件：格式变了要能认出来——整份读不了、一行认不出都照实说「没读成」，不当成「没有」。目录不存在（这台没装
//   Mirasim、或会话不是它起的）才是真的「没有」，不出声。
// - 对账只按「话的开头 + 时间相近」认：同一句话 15 分钟内发过两次、只收到一次，算丢了一次（一条收到的只能对掉一条发的）。
// - 每个 Mirasim 会话从「上一轮（含）」开始对（倒数第二轮的 startedAt），至少 RECENT_MS、至多 MAX_LOOKBACK_MS。原来只看最近
//   RECENT_MS：一轮跑了 95 分钟，开头丢的引导到下一轮开头已过窗口，报不出来（#1725，10-10 05:04「我确定了，可见」）。
//   再早的他早重发或放弃了，列出来只会让会话去办已经办过的事；丢了之后他原话重发并收到了的也不列（reconcile）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMachineOpening, isMachineSession } from './unattended.mjs';

/** 对账至少看最近多久（和 session-start.mjs 列「收到的话」同一个窗口） */
export const RECENT_MS = 60 * 60_000;
/** 对账最多往回看多久：上一轮开得再早也只看这么久 */
export const MAX_LOOKBACK_MS = 24 * 60 * 60_000;
/** 「发了」和「收到」时刻差在这以内、开头一样，算同一条 */
export const MATCH_MS = 15 * 60_000;
/** 对账时话取多长的开头 */
const KEY_CHARS = 80;

/** 后台任务完成、系统提醒、上下文接续这些不是他的话（和 session-start.mjs 的 SYSTEM_PROMPT 一样） */
const SYSTEM_PROMPT = /^\s*(?:<task-notification|<system-reminder|<prior-conversation|\[SYSTEM NOTIFICATION)/;
/** Mirasim 附图时在话前面加的一行 */
const ATTACHMENT_NOTE = /\[The image above is also on disk at:[^\]]*\]\s*/g;

/** @typedef {{ at: number, text: string, sessionId: string | null, kind: 'prompt' | 'steer' }} Sent 他发出的一条 */
/** @typedef {{ at: number, text: string, sessionId: string | null }} Received Claude Code 收到的一条（prompt-log 里的） */

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

/**
 * 一个 Mirasim 会话从哪一刻开始对账：上一轮（倒数第二轮）的 startedAt，夹在 [now - MAX_LOOKBACK_MS, now - RECENT_MS] 里；
 * 不到两轮按 now - RECENT_MS。这一轮在开会话那一刻记没记进 turns.jsonl 都不要紧：没记进就多看一轮，宁多勿漏。
 * @param {number[]} starts 这个会话各轮的 startedAt
 * @param {number} now
 */
export function windowStart(starts, now) {
  const sorted = starts.filter((t) => t <= now + 60_000).sort((a, b) => b - a);
  const prev = sorted[1] ?? now;
  return Math.min(now - RECENT_MS, Math.max(prev, now - MAX_LOOKBACK_MS));
}

/**
 * 他在 Mirasim 里发出的话（开一轮的提问和中途的引导都算），每个会话从它的 windowStart 起。
 * since 是各会话里最早的起点（没有会话就是 now - RECENT_MS），收到的账要从这再往前 MATCH_MS 读起才配得上。
 * @param {{ home: string, now?: number, env?: Record<string, string | undefined> }} opts
 * @returns {{ absent: true } | { absent: false, entries: Sent[], problems: string[], since: number }}
 */
export function sentByFounder({ home, now = Date.now(), env = process.env }) {
  const base = join(mirasimDir(env, home), 'sessions', 'claude');
  if (!existsSync(base)) return { absent: true };
  /** @type {Sent[]} */
  const entries = [];
  /** @type {string[]} */
  const problems = [];
  let since = now - RECENT_MS;
  let dirs;
  try {
    dirs = readdirSync(base);
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
    /** @type {Sent[]} */
    const mine = [];
    /** @type {number[]} */
    const starts = [];
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
      // 系统消息开的轮也是一轮：窗口按轮算，不按是不是他的话
      if (Number.isFinite(startedAt) && startedAt > 0) starts.push(startedAt);
      if (isFounderText(turn.prompt) && Number.isFinite(startedAt) && startedAt > 0)
        mine.push({ at: startedAt, text: turn.prompt, sessionId, kind: 'prompt' });
      for (const s of Array.isArray(turn.steers) ? turn.steers : []) {
        const at = Number(s?.at);
        if (isFounderText(s?.text) && Number.isFinite(at) && at > 0)
          mine.push({ at, text: s.text, sessionId, kind: 'steer' });
      }
    }
    if (bad > 0) problems.push(`${file} 里有 ${bad} 行认不出（Mirasim 换格式了？）`);
    const from = windowStart(starts, now);
    since = Math.min(since, from);
    for (const e of mine) if (e.at >= from && e.at <= now + 60_000) entries.push(e);
  }
  entries.sort((a, b) => a.at - b.at);
  return { absent: false, entries, problems, since };
}

/**
 * 对账：发了的里面哪些没收到。received 是 prompt-log 里的（{ at: 毫秒, text, sessionId }），一条收到的只对掉一条发的。
 * 返回 { lost, matched }：lost 是没对上的发了的话；matched 是对上的，带上收到它的那个会话号（看是不是本会话）。
 * @param {Sent[]} sent
 * @param {Received[]} received
 * @returns {{ lost: Sent[], matched: Array<Sent & { receivedBy: string | null }> }}
 */
export function reconcile(sent, received) {
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
      if (r.key === s.key && gap <= MATCH_MS) pairs.push({ s, r, gap });
    }
  pairs.sort((a, b) => a.gap - b.gap);
  for (const { s, r } of pairs) {
    if (s.hit || r.used) continue;
    s.hit = r;
    r.used = true;
  }
  /** @type {Array<Sent & { receivedBy: string | null }>} */
  const matched = [];
  /** @type {Sent[]} */
  const lost = [];
  for (const s of sentRows) {
    if (s.hit)
      matched.push({
        at: s.at,
        text: s.text,
        sessionId: s.sessionId,
        kind: s.kind,
        receivedBy: s.hit.sessionId ?? null,
      });
    // 丢了、但他之后原话重发并收到了（隔多久都算：窗口能到 24 小时）：那条已经办了，不再当丢的列
    else if (!recv.some((r) => r.key === s.key && r.at >= s.at))
      lost.push({ at: s.at, text: s.text, sessionId: s.sessionId, kind: s.kind });
  }
  return { lost, matched };
}
