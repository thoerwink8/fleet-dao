// 把 Mirasim 记下、但没送进会话的创始人插话补回落盘记录（创始人 2026-10-04「怎么样你才能收到引导呢」）。
//
// 为什么有它：他在我干活时插的话，先排在 Mirasim 客户端的队列里，等我下一次调工具才送进来；队列里的话遇上会话进程死掉就丢了，
// UserPromptSubmit 钩子（prompt-log.mjs）因为从头没被触发，也就没落盘。但 Mirasim 自己把每条插话记在
// ~/.mirasim/sessions/claude/<会话号>/turns.jsonl 每行的 `steers: [{ text, at }]` 里（含我没收到的）——
// 开会话时拿它和 prompt-log 比一遍，多出来的就是没送到的，补进 prompt-log 并说出来。
//
// 改这里之前必须知道：
// - **没有 Mirasim 目录（别的机器、别的客户端）一声不吭**；有目录但读不了、认不出，要说一句「没查成」，不当成「没丢」。
// - 比对用「落盘的某条话里包含这条插话的文字」：有的插话带图片前缀，落盘那条比 steer 长，所以是包含、不是全等。
// - 补进去的条目 promptId 固定为 `mirasim-steer-<毫秒时间>`，prompt-log 的去重靠它，反复开会话不会重复补。
// - 只看最近 LOOKBACK_MS 内动过的 turns.jsonl 和这段时间内的插话：这文件会涨到几 MB，别每次开会话全扫历史。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendEntry, dayOf } from './prompt-log.mjs';

export const LOOKBACK_MS = 6 * 60 * 60_000;
export const SHOW_CHARS = 200;

const SYSTEM_PROMPT = /^\s*(?:<task-notification|<system-reminder|\[SYSTEM NOTIFICATION)/;
const NOT_CHECKED = '没送到的插话没查成';

/** 读最近几天的落盘记录，返回全部 prompt 文字；读不了（非「没有」）抛出带原因的 Error */
function loggedPrompts(logDir, now) {
  const out = [];
  for (const day of new Set([dayOf(now), dayOf(now - LOOKBACK_MS)])) {
    const file = join(logDir, `${day}.jsonl`);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw new Error(`${file} 读不了（${err?.code ?? err}）`);
    }
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      try {
        const e = JSON.parse(row);
        if (typeof e?.prompt === 'string') out.push(e.prompt);
      } catch {
        // 坏的一行跳过
      }
    }
  }
  return out;
}

/** 最近动过的 turns.jsonl 里、时间在窗口内的全部插话，按 at+text 去重 */
function mirasimSteers(sessionsDir, now) {
  let ids;
  try {
    ids = readdirSync(sessionsDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return null; // 没有 Mirasim：不出声
    throw new Error(`${sessionsDir} 读不了（${err?.code ?? err}）`);
  }
  const seen = new Map();
  for (const id of ids) {
    const file = join(sessionsDir, id, 'turns.jsonl');
    let text;
    try {
      if (now - statSync(file).mtimeMs > LOOKBACK_MS) continue;
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw new Error(`${file} 读不了（${err?.code ?? err}）`);
    }
    for (const row of text.split(/\r?\n/)) {
      if (!row.includes('"steers":[{')) continue; // 先粗筛，几 MB 的文件别每行都 parse
      let rec;
      try {
        rec = JSON.parse(row);
      } catch {
        continue;
      }
      if (!Array.isArray(rec?.steers)) continue;
      for (const s of rec.steers) {
        if (typeof s?.text !== 'string' || !s.text.trim() || !Number.isFinite(s?.at)) continue;
        if (now - s.at > LOOKBACK_MS || s.at > now + 60_000) continue;
        seen.set(`${s.at}\u0000${s.text}`, { at: s.at, text: s.text, sessionId: id });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.at - b.at);
}

/**
 * 返回 { lines, recovered }：lines 是要对会话说的话（没丢、没 Mirasim 都是空），recovered 是这次补回的条数。
 * 补回 = 追加进 prompt-log（带 recovered 标记）。
 */
export function recoverSteers({ home, now = Date.now(), sessionsDir = null, logDir = null }) {
  const sessions = sessionsDir ?? join(home, '.mirasim', 'sessions', 'claude');
  const log = logDir ?? join(home, '.fleet-dao', 'prompt-log');
  let steers;
  let logged;
  try {
    steers = mirasimSteers(sessions, now);
    if (steers === null || steers.length === 0) return { lines: [], recovered: 0 };
    logged = loggedPrompts(log, now);
  } catch (err) {
    return { lines: [`${NOT_CHECKED}：${err.message}；你插过的话有没有丢，这次判不了。`], recovered: 0 };
  }
  const lost = steers.filter(
    (s) => !SYSTEM_PROMPT.test(s.text) && !logged.some((p) => p.includes(s.text.trim())),
  );
  const done = [];
  const failed = [];
  for (const s of lost) {
    const r = appendEntry(
      {
        at: new Date(s.at).toISOString(),
        sessionId: s.sessionId,
        promptId: `mirasim-steer-${s.at}`,
        cwd: null,
        prompt: s.text,
        recovered: 'mirasim-steers',
      },
      { dir: log, now: s.at },
    );
    (r.ok ? done : failed).push({ s, why: r.why });
  }
  const hhmm = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 16);
  const cut = (t) => (t.length > SHOW_CHARS ? `${t.slice(0, SHOW_CHARS)}……` : t).replace(/\s+/g, ' ');
  const lines = [];
  if (done.length > 0)
    lines.push(
      `Mirasim 记着、但上一个会话没送到的创始人插话 ${done.length} 条（已补进落盘记录，当他刚说的办，办完标已处理）：${done
        .map((d) => `［${hhmm(d.s.at)}］${cut(d.s.text)}`)
        .join(' ')}`,
    );
  if (failed.length > 0)
    lines.push(
      `Mirasim 记着、没送到的创始人插话 ${failed.length} 条没补进落盘记录（${failed[0].why}）：${failed
        .map((d) => `［${hhmm(d.s.at)}］${cut(d.s.text)}`)
        .join(' ')}`,
    );
  return { lines, recovered: done.length };
}
