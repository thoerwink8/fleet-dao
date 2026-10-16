// 创始人轮中发的引导，下一次工具调用后就进会话（单 #2382）。
// 为什么：他在一轮跑着时打的字走 Mirasim 的「引导」，Mirasim 等下一次调模型才塞进去，那一轮被打断、出错就丢了（founder-inbox.mjs 开头）。
// 以前只有开会话钩子（session-start.mjs）每一轮开头对一次账，一轮跑一两个小时，中途发的话要等下一轮才冒出来，他以为你看到了。
// 现在主线程每次工具调用时（main-thread.mjs 调这里）也对一遍：
// - 对账用 founder-inbox.mjs 的 reconcileInbox，和开会话那段是同一个函数，不另抄；
// - 节流：每个会话号每 60 秒最多读一次账（状态记在 ~/.fleet-dao/inbox-seen/tick-<会话号>.json）；没到点的调用只读这一个小文件就返回，
//   founder-inbox.mjs 和它依赖的东西到点才加载；
// - 发了、本血缘还没见过的话，原文照贴、写明发出时间，当场作为 additionalContext 塞给会话，并记进已见名单（founder-inbox.mjs 的 markSeen），
//   同一条不塞第二遍；开会话那段读同一份名单，塞过的不再列成没收到；
// - 这个会话的记录里已经有这条的 queued_command（Mirasim 正常送到了）算送到了，记已见、不塞；
// - 读账失败塞一行「对账没查成：<原因>」，不当成没有新话；同样的失败 10 分钟内不重复说；
// - 子代理里的调用（输入带 agent_id）不管，只主线程。
// 钩子永远不抛：出错也只塞那一行。
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 两次读账之间至少隔这么久（每个会话号） */
export const TICK_MS = 60_000;
/** 同一句「对账没查成」在这以内不重复说 */
export const NOTICE_REPEAT_MS = 10 * 60_000;
/** 一条话塞给会话时最多贴多少字（超了截断并写明） */
export const SHOWN_CHARS = 2000;
/** 看这个会话的记录末尾多少字节，找已经送到的引导 */
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * 已见名单和节流状态放哪：~/.fleet-dao/inbox-seen/；测试用 FLEET_INBOX_SEEN_DIR 换。
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 */
export function inboxSeenDir(env, home) {
  const o = env.FLEET_INBOX_SEEN_DIR;
  return typeof o === 'string' && o ? o : join(home, '.fleet-dao', 'inbox-seen');
}

/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 北京时间 MM-DD HH:mm @param {number} ms */
const stamp = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');

/**
 * 这个会话的记录末尾里，已经作为 queued_command 送到的引导（话的开头，已按对账的键压过）。读不了就是空（只是少一道去重，不影响塞）。
 * @param {unknown} path
 * @param {(text: string) => string} keyOf
 * @returns {Set<string>}
 */
function deliveredKeys(path, keyOf) {
  const keys = new Set();
  if (typeof path !== 'string' || path === '') return keys;
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"queued_command"')) continue;
      try {
        const att = JSON.parse(line)?.attachment;
        if (att?.type !== 'queued_command') continue;
        const p = att.prompt;
        const text =
          typeof p === 'string'
            ? p
            : Array.isArray(p)
              ? p.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('')
              : '';
        if (text.trim() !== '') keys.add(keyOf(text));
      } catch {
        // 截断的第一行、写到一半的最后一行
      }
    }
  } catch {
    // 记录读不了：不去重，宁可多塞一条
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return keys;
}

/**
 * 主线程一次工具调用后要不要塞话给会话。返回要塞的文字（additionalContext），没有就 null。永远不抛。
 * @param {unknown} input 钩子输入（解析好的 JSON）
 * @param {{
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 *   now?: number,
 *   load?: () => Promise<typeof import('./founder-inbox.mjs')>,
 * }} [opts] 测试换掉家目录、时钟、加载
 * @returns {Promise<string | null>}
 */
export async function tick(
  input,
  { home = homedir(), env = process.env, now = Date.now(), load = () => import('./founder-inbox.mjs') } = {},
) {
  if (!isObj(input)) return null;
  // 子代理里的调用只在子代理里带 agent_id（code.claude.com/docs/en/hooks）：不管
  if (typeof input.agent_id === 'string' && input.agent_id.trim() !== '') return null;
  const sessionId = input.session_id;
  // Grok 等借道读设置的几家是 camelCase、没有 session_id：认不出就不查
  if (typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)) return null;

  const dir = inboxSeenDir(env, home);
  const stateFile = join(dir, `tick-${sessionId}.json`);
  /** @type {Record<string, unknown>} */
  let state = {};
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (isObj(parsed)) state = parsed;
  } catch {
    // 没有或坏了：当没读过
  }
  const last = Number(state.checkedAt);
  if (Number.isFinite(last) && now >= last && now - last < TICK_MS) return null;

  /** @param {Record<string, unknown>} next */
  const save = (next) => {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), 'utf8');
      renameSync(tmp, stateFile);
    } catch {
      // 记不下节流状态：这次照常读，下次也会读（宁可多读）
    }
  };
  // 先记「这次读过」再读：读账慢或半路崩了，也不会每次工具调用都重读
  save({ checkedAt: now, lastNotice: state.lastNotice, noticeAt: state.noticeAt });

  /** @type {string[]} */
  const notices = [];
  /** @type {string[]} */
  const shown = [];
  try {
    const inbox = await load();
    const rec = inbox.reconcileInbox({ home, now, sessionId, env });
    if (rec.status === 'unchecked') {
      notices.push(`对账没查成：认不出本会话是哪个 Mirasim 会话（${rec.why}）`);
    } else if (rec.status === 'ok') {
      if (rec.readError) notices.push(`对账没查成：${rec.readError}`);
      else if (!rec.sent.absent) {
        for (const p of rec.sent.problems) notices.push(`对账没查成：创始人在 Mirasim 里发的话没读全：${p}`);
        for (const p of rec.relayProblems) notices.push(`对账没查成：旧的引导记录没核成：${p}`);
        const seen = inbox.readSeen({ home, env, lineDir: rec.line.dir });
        if (seen.problem) notices.push(`对账没查成：已见名单没读成：${seen.problem}`);
        const fresh = rec.lost.filter((s) => !seen.keys.has(inbox.seenKey(s)));
        if (fresh.length > 0) {
          const delivered = deliveredKeys(input.transcript_path, inbox.promptKey);
          const sentAlready = fresh.filter((s) => delivered.has(inbox.promptKey(s.text)));
          const toShow = fresh.filter((s) => !sentAlready.includes(s));
          try {
            inbox.markSeen({ home, env, lineDir: rec.line.dir, entries: fresh, now });
          } catch (err) {
            notices.push(`对账没查成：已见名单写不进（${why(err)}），这几条之后可能再塞一遍`);
          }
          for (const s of toShow) {
            const cut =
              s.text.length > SHOWN_CHARS ? `${s.text.slice(0, SHOWN_CHARS)}……（太长，后面省略）` : s.text;
            shown.push(`［${stamp(s.at)} 北京时间发出］${cut}`);
          }
        }
      }
    }
  } catch (err) {
    notices.push(`对账没查成：${why(err)}`);
  }

  const noticeText = notices.join('；');
  const repeated =
    noticeText !== '' &&
    state.lastNotice === noticeText &&
    Number.isFinite(Number(state.noticeAt)) &&
    now - Number(state.noticeAt) < NOTICE_REPEAT_MS;
  if (noticeText === '') save({ checkedAt: now });
  else if (!repeated) save({ checkedAt: now, lastNotice: noticeText, noticeAt: now });

  /** @type {string[]} */
  const out = [];
  if (shown.length > 0) {
    out.push(
      `创始人在你干活的这一轮中间发了、但 Claude Code 没收到的话（Mirasim 的「引导」没送进来，他以为你看到了；共 ${shown.length} 条，原文如下）。先用一句话回它们，再接着干：`,
      ...shown,
    );
  }
  if (noticeText !== '' && !repeated) out.push(noticeText);
  return out.length > 0 ? out.join('\n') : null;
}
