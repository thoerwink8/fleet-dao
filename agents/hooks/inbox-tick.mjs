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
// 主线程一轮收尾、后台子代理还在跑时它一次工具都不调，这里不触发：那段由收尾时起的盯账进程（inbox-watch.mjs，单 #2488）
// 用下面的 pendingSteers 接着对账，已见名单、「没查成」说过没有都和这里共用，同一条只送一次。
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
 * 这个会话的记录末尾（原文）。读不了就是空串（只是少一道去重，不影响塞）。
 * @param {unknown} path
 */
function transcriptTail(path) {
  if (typeof path !== 'string' || path === '') return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    // 记录读不了：不去重，宁可多塞一条
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 塞给会话的一行：发出时间 + 原文（太长截断） @param {{ at: number, text: string }} s */
const shownLine = (s) =>
  `［${stamp(s.at)} 北京时间发出］${s.text.length > SHOWN_CHARS ? `${s.text.slice(0, SHOWN_CHARS)}……（太长，后面省略）` : s.text}`;

/**
 * 这一条以前已经塞进过这个会话（记录里有塞的那一行的开头；记录是 JSON 行，按 JSON 转义后的样子找）。
 * 已见名单写不进时靠它兜底：不然每次收尾起的盯账进程都会为同一条叫醒一次，没完没了。
 * @param {string} tail
 * @param {{ at: number, text: string }} s
 */
const shownBefore = (tail, s) =>
  tail !== '' && tail.includes(JSON.stringify(shownLine(s).slice(0, 40)).slice(1, -1));

/**
 * 这个会话的记录末尾里，已经作为 queued_command 送到的引导（话的开头，已按对账的键压过）。
 * @param {string} tail transcriptTail 读出来的
 * @param {(text: string) => string} keyOf
 * @returns {Set<string>}
 */
function deliveredKeys(tail, keyOf) {
  const keys = new Set();
  for (const line of tail.split('\n')) {
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
  return keys;
}

const INTERRUPTED_BACKGROUND_RE = /did(?:n['’]?t| not) finish before the previous session ended/i;
const MAX_BACKGROUND_TEXT = 1200;

/** @param {unknown} v */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v.map((b) => (isObj(b) && b.type === 'text' ? String(b.text ?? '') : '')).join('');
}

/** @param {string} text */
function shortBackgroundText(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > MAX_BACKGROUND_TEXT ? `${clean.slice(0, MAX_BACKGROUND_TEXT)}……` : clean;
}

/**
 * 从 transcript 里找上一会话收场时仍在跑的后台任务。
 * Claude Code 的任务启动、启动回执和重启通知不是固定一种 JSON 形状，所以这里同时认
 * Agent/Task/Bash 的 tool_use、回执里的 agentId，以及通知里的 task-id；认不出编号时
 * 退回 tool_use id，至少给会话一个能定位原调用的编号。
 * @param {string} tail
 * @param {unknown} input
 */
function interruptedBackgroundTasks(tail, input) {
  const rawInput = isObj(input) ? JSON.stringify(input) : '';
  const raw = `${tail}\n${rawInput}`;
  if (!INTERRUPTED_BACKGROUND_RE.test(raw)) return null;

  /** @type {{ kind: 'agent' | 'command', id: string, ref: string, taskId?: string, description: string, line: number }[]} */
  const launched = [];
  const completed = new Set();
  const stoppedIds = new Set();
  /** @type {string[]} */
  const notificationTexts = [];
  const lines = tail.split('\n');

  /** @param {unknown} value @param {number} line */
  const inspect = (value, line) => {
    if (!isObj(value)) return;
    const content = isObj(value.message) ? value.message.content : undefined;
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (!isObj(block) || block.type !== 'tool_use' || !isObj(block.input)) continue;
      const name = String(block.name ?? '');
      const spec = block.input;
      if (spec.run_in_background !== true) continue;
      const ref = typeof block.id === 'string' && block.id ? block.id : `tool-${line + 1}`;
      if (name === 'Agent' || name === 'Task') {
        launched.push({
          kind: 'agent',
          id: ref,
          ref,
          description: shortBackgroundText(
            [String(spec.description ?? ''), textOf(spec.prompt)].filter((s) => s.trim() !== '').join('；') ||
              '（没有任务说明）',
          ),
          line,
        });
      } else if (name === 'Bash' || name === 'PowerShell' || name === 'Shell') {
        launched.push({
          kind: 'command',
          id: ref,
          ref,
          description: shortBackgroundText(
            String(spec.command ?? spec.script ?? '') || String(spec.description ?? '') || '（没有命令说明）',
          ),
          line,
        });
      }
    }
    const attachment = value.attachment;
    const attachedText = isObj(attachment) ? textOf(attachment.prompt) : '';
    const messageText = textOf(content);
    const notification = `${attachedText}\n${messageText}`;
    const interrupted = INTERRUPTED_BACKGROUND_RE.test(notification);
    if (interrupted) notificationTexts.push(notification);
    const status = notification.match(/<status>\s*([^<]+?)\s*<\/status>/i)?.[1]?.toLowerCase();
    const taskId = notification.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/i)?.[1]?.trim();
    if (taskId) {
      if (interrupted || status === 'stopped' || status === 'canceled' || status === 'cancelled')
        stoppedIds.add(taskId);
      else if (status === 'completed' || status === 'succeeded' || status === 'failed' || status === 'error')
        completed.add(taskId);
    }
    if (interrupted)
      for (const m of notification.matchAll(
        /(?:agentId|agent_id|taskId|task_id)\s*[:=]\s*["']?([A-Za-z0-9_.-]+)/gi,
      ))
        if (m[1]) stoppedIds.add(m[1]);
  };

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] ?? '';
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    inspect(value, line);
    // 启动回执通常紧跟 Agent tool_use；把真实 agentId 绑回最近一个尚未编号的代理。
    const taskId = text.match(/(?:agentId|agent_id|taskId|task_id)\s*[:=]\s*["']?([A-Za-z0-9_.-]+)/i)?.[1];
    if (taskId) {
      const pending = [...launched].reverse().find((t) => !t.taskId && t.line <= line);
      if (pending) pending.taskId = taskId;
    }
  }

  if (isObj(input) && Array.isArray(input.background_tasks)) {
    for (const task of input.background_tasks) {
      if (!isObj(task)) continue;
      const kind = task.type === 'shell' || task.type === 'command' ? 'command' : 'agent';
      const id = String(task.id ?? task.task_id ?? task.agent_id ?? '').trim();
      if (!id) continue;
      launched.push({
        kind,
        id,
        ref: id,
        ...(typeof task.agent_id === 'string' ? { taskId: task.agent_id } : {}),
        description:
          shortBackgroundText(
            kind === 'command'
              ? [String(task.command ?? ''), String(task.description ?? '')]
                  .filter((s) => s.trim() !== '')
                  .join('；')
              : [String(task.description ?? ''), String(task.prompt ?? '')]
                  .filter((s) => s.trim() !== '')
                  .join('；'),
          ) || '（没有任务说明）',
        line: Number.MAX_SAFE_INTEGER,
      });
    }
  }

  // 通知若明确列了编号，只保留这些；没有列编号时取未见完成通知的后台启动项。
  const selected =
    stoppedIds.size > 0
      ? launched.filter((t) => stoppedIds.has(t.id) || (t.taskId && stoppedIds.has(t.taskId)))
      : launched.filter((t) => !t.taskId || !completed.has(t.taskId));
  const unique = [];
  const seen = new Set();
  for (const task of selected) {
    const id = task.taskId ?? task.id;
    if (seen.has(`${task.kind}:${id}`)) continue;
    seen.add(`${task.kind}:${id}`);
    unique.push({ ...task, id });
  }
  if (stoppedIds.size > 0) {
    const notice = notificationTexts.join('\n');
    const summary =
      notice
        .match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1]
        ?.replace(/\s+/g, ' ')
        .trim() ?? '（通知里没有找到当时的任务说明）';
    const kind = /\b(?:Bash|PowerShell|Shell|command)\b/i.test(summary) ? 'command' : 'agent';
    for (const id of stoppedIds) {
      if (launched.some((task) => task.id === id || task.taskId === id)) continue;
      unique.push({ kind, id, ref: id, description: shortBackgroundText(summary), line: 0 });
    }
  }
  const key = JSON.stringify({
    stopped: [...stoppedIds].sort(),
    tasks: unique.map((t) => [t.kind, t.id, t.description]),
    notification: notificationTexts.join('\n').slice(0, 2000),
  });
  return { key, tasks: unique };
}

/**
 * 重启后 Claude Code 会告诉会话「didn't finish before the previous session ended」。
 * 把它变成能直接接手的上下文；同一批只提醒一次。
 * @param {unknown} input
 * @param {string} tail
 * @param {Record<string, unknown>} state
 */
function interruptedBackgroundContext(input, tail, state) {
  const found = interruptedBackgroundTasks(tail, input);
  if (!found || found.key === state.backgroundRestartKey) return null;
  const agents = found.tasks.filter((t) => t.kind === 'agent');
  const commands = found.tasks.filter((t) => t.kind === 'command');
  if (agents.length === 0 && commands.length === 0) {
    return {
      key: found.key,
      text: '上一会话结束时有后台任务没跑完，但没从记录里认出代理编号或命令；请先查看重启通知和 transcript，再决定怎么续。',
    };
  }
  const lines = [
    '上一会话结束时没跑完、被停掉的后台任务（Claude Code 提示 “didn’t finish before the previous session ended”）：',
  ];
  if (agents.length > 0) {
    lines.push(...agents.map((t) => `子代理编号 ${t.id}：任务说明：${t.description}`));
    lines.push('请逐个用 SendMessage 按子代理编号续上；不要把已经有的任务凭空再派一遍。');
  }
  if (commands.length > 0) {
    lines.push(...commands.map((t) => `后台命令 ${t.id}：${t.description}`));
    lines.push('这些后台命令要不要重跑，由本会话判断。');
  }
  return { key: found.key, text: lines.join('\n') };
}

/** 会话号的样子；认不出的不查（Grok 等借道读设置的几家是 camelCase、没有 session_id） @param {unknown} id */
export const cleanSessionId = (id) => (typeof id === 'string' && /^[\w-]{1,128}$/.test(id) ? id : null);

/**
 * 节流和「说过哪句没查成」的状态（~/.fleet-dao/inbox-seen/tick-<会话号>.json）。没有或坏了是空对象。
 * 盯账进程（inbox-watch.mjs）也读写它：同一句「对账没查成」两边合起来 10 分钟内只说一次。
 * @param {string} dir inboxSeenDir
 * @param {string} sessionId
 * @returns {Record<string, unknown>}
 */
export function readTickState(dir, sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `tick-${sessionId}.json`), 'utf8'));
    if (isObj(parsed)) return parsed;
  } catch {
    // 没有或坏了：当没读过
  }
  return {};
}

/**
 * @param {string} dir
 * @param {string} sessionId
 * @param {Record<string, unknown>} next
 */
export function saveTickState(dir, sessionId, next) {
  const stateFile = join(dir, `tick-${sessionId}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), 'utf8');
    renameSync(tmp, stateFile);
  } catch {
    // 记不下：下次照常读（宁可多读、多说一次）
  }
}

/**
 * 这句「对账没查成」10 分钟内说过没有（按 readTickState 读出来的状态）
 * @param {Record<string, unknown>} state
 * @param {string} noticeText
 * @param {number} now
 */
export const toldRecently = (state, noticeText, now) =>
  noticeText !== '' &&
  state.lastNotice === noticeText &&
  Number.isFinite(Number(state.noticeAt)) &&
  now - Number(state.noticeAt) < NOTICE_REPEAT_MS;

/**
 * 对一遍账：本血缘「发了、本会话还没见过」的话（轮中对账和盯账进程共用这一份，不各抄一份）。
 * 新冒出来的记进已见名单（同一条只送一次）；记录里已经送到、已经塞过的也记已见、不再送。
 * - { status: 'none' }：不是 Mirasim 起的会话（无血缘），不出声；
 * - { status: 'checked', shown, notices }：shown 是要送的话（每条一行，带北京时间发出时间），notices 是「对账没查成：…」。
 * 永远不抛：出错进 notices。
 * @param {{
 *   sessionId: string,
 *   transcriptPath?: unknown,
 *   home: string,
 *   env: Record<string, string | undefined>,
 *   now: number,
 *   load?: () => Promise<typeof import('./founder-inbox.mjs')>,
 * }} opts
 * @returns {Promise<{ status: 'none' } | { status: 'checked', shown: string[], notices: string[] }>}
 */
export async function pendingSteers({
  sessionId,
  transcriptPath,
  home,
  env,
  now,
  load = () => import('./founder-inbox.mjs'),
}) {
  /** @type {string[]} */
  const notices = [];
  /** @type {string[]} */
  const shown = [];
  try {
    const inbox = await load();
    const rec = inbox.reconcileInbox({ home, now, sessionId, env });
    if (rec.status === 'none') return { status: 'none' };
    if (rec.status === 'unchecked') {
      notices.push(`对账没查成：认不出本会话是哪个 Mirasim 会话（${rec.why}）`);
    } else if (rec.readError) notices.push(`对账没查成：${rec.readError}`);
    else if (!rec.sent.absent) {
      for (const p of rec.sent.problems) notices.push(`对账没查成：创始人在 Mirasim 里发的话没读全：${p}`);
      for (const p of rec.relayProblems) notices.push(`对账没查成：旧的引导记录没核成：${p}`);
      const seen = inbox.readSeen({ home, env, lineDir: rec.line.dir });
      if (seen.problem) notices.push(`对账没查成：已见名单没读成：${seen.problem}`);
      const fresh = rec.lost.filter((s) => !seen.keys.has(inbox.seenKey(s)));
      if (fresh.length > 0) {
        const tail = transcriptTail(transcriptPath);
        const delivered = deliveredKeys(tail, inbox.promptKey);
        const toShow = fresh.filter((s) => !delivered.has(inbox.promptKey(s.text)) && !shownBefore(tail, s));
        try {
          inbox.markSeen({ home, env, lineDir: rec.line.dir, entries: fresh, now });
        } catch (err) {
          notices.push(`对账没查成：已见名单写不进（${why(err)}），这几条之后可能再塞一遍`);
        }
        for (const s of toShow) shown.push(shownLine(s));
      }
    }
  } catch (err) {
    notices.push(`对账没查成：${why(err)}`);
  }
  return { status: 'checked', shown, notices };
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
  const sessionId = cleanSessionId(input.session_id);
  if (sessionId === null) return null;

  const dir = inboxSeenDir(env, home);
  const state = readTickState(dir, sessionId);
  const last = Number(state.checkedAt);
  if (Number.isFinite(last) && now >= last && now - last < TICK_MS) return null;

  /** @param {Record<string, unknown>} next */
  const save = (next) => saveTickState(dir, sessionId, next);
  // 先记「这次读过」再读：读账慢或半路崩了，也不会每次工具调用都重读
  save({
    checkedAt: now,
    lastNotice: state.lastNotice,
    noticeAt: state.noticeAt,
    ...(state.backgroundRestartKey ? { backgroundRestartKey: state.backgroundRestartKey } : {}),
  });

  const r = await pendingSteers({ sessionId, transcriptPath: input.transcript_path, home, env, now, load });
  const shown = r.status === 'checked' ? r.shown : [];
  const noticeText = r.status === 'checked' ? r.notices.join('；') : '';
  const repeated = toldRecently(state, noticeText, now);
  const restart =
    r.status === 'checked'
      ? interruptedBackgroundContext(
          input,
          typeof input.transcript_path === 'string' ? transcriptTail(input.transcript_path) : '',
          state,
        )
      : null;
  const nextState = {
    checkedAt: now,
    ...(state.lastNotice ? { lastNotice: state.lastNotice, noticeAt: state.noticeAt } : {}),
    ...(noticeText === '' || repeated ? {} : { lastNotice: noticeText, noticeAt: now }),
    ...(state.backgroundRestartKey ? { backgroundRestartKey: state.backgroundRestartKey } : {}),
    ...(restart ? { backgroundRestartKey: restart.key } : {}),
  };
  save(nextState);

  /** @type {string[]} */
  const out = [];
  if (shown.length > 0) {
    out.push(
      `创始人在你干活的这一轮中间发了、但 Claude Code 没收到的话（Mirasim 的「引导」没送进来，他以为你看到了；共 ${shown.length} 条，原文如下）。先用一句话回它们，再接着干：`,
      ...shown,
    );
  }
  if (noticeText !== '' && !repeated) out.push(noticeText);
  if (restart) out.push(restart.text);
  return out.length > 0 ? out.join('\n') : null;
}
