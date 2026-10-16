// PreToolUse 钩子。登记在 fleet-dao 仓的 .claude/settings.json（项目级，不写 matcher），不装进用户级设置。
// 只管主对话的一条：
// 引导先回。创始人在一轮中途打的字叫「引导」：transcript 里是一行 attachment（type: queued_command，commandMode: prompt），
// 附在下一次工具结果后面送进主对话。最后一条引导之后，主对话还没写过一段非空文字（和 tool_use 在同一条消息里的文字也算），就拒这次工具调用；
// 同一条引导只拒一次（之后的工具结果里已有拒的理由，就放行）。
// 不再读 diag、不再起 ui-cli。以前转过的记在 ~/.fleet-dao/steer-shown/，开会话对账还读，这边只留路径、不再写。
// 引擎的无头会话（FLEET_HEADLESS=1）读得到项目级设置，进到这里直接退出。
// 子代理里的调用（输入带 agent_id）不管。
// 读不了 transcript：不拦（拦死所有工具代价太大），但用 systemMessage 明说「引导检查没查成：原因」，不当成没有引导静默过去。
// 借道读 ~/.claude/settings.json 的几家：Grok 的输入是 camelCase、没有 transcript，认出来就不查、不说话；Devin、Cursor 的输入
// 要是不带 transcript_path，每次都会明说没查成（照实说，不装作查过）。
// 协议：stdin 一份 JSON；拒 = stdout 一份 hookSpecificOutput.permissionDecision: deny，退出码 0；没意见 = 什么都不写。
// 规矩由 agents/test/rules/main-thread.rules.test.ts、mirasim-steer.rules.test.ts 钉住：改这里的判断就是改规矩，那边会红。
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookTimer } from './hook-timing.mjs';

/** 拒的理由里最多带引导的前多少个字 */
export const DIRECTIVE_SHOWN_CHARS = 200;
/** 从尾部往回读，一块多大 */
const CHUNK_BYTES = 256 * 1024;
/** 最多往回读多少：未回的引导一定在记录末尾，读到这么远还没认出，就当没有待回的引导（不读整份大文件） */
const MAX_BACK_BYTES = 4 * 1024 * 1024;
/**
 * 见到没回的引导先等这么久再读一遍：同一条回复里先写的文字万一还没落盘，别把「已经回了话」误拦。
 * 实测落盘能比工具调用晚近 1 秒（2026-10-13 12:25：文字 20.375 写下、Monitor 21.214 发起，钩子仍没读到），
 * 所以最多读 SETTLE_TRIES 次、每次隔 SETTLE_MS；只在真有没回的引导时才等。
 */
const SETTLE_MS = 400;
const SETTLE_TRIES = 4;
/**
 * 这几样工具本身就是在回话、转话：SendMessage 把引导转给在跑的子代理（拒的理由里就叫它这么做），送达类工具把答复送到创始人手上。
 * 拦它们等于叫它照做又不让做。
 */
const REPLY_TOOLS = new Set(['SendMessage', 'mcp__mirasim__deliver_artifact', 'PushNotification']);

/** @typedef {{ deny?: string, notice?: string }} Verdict 拒（理由给模型看）、或要明说的话（systemMessage，给创始人看）；空对象是没意见 */
/** @typedef {{ kind: 'pending', text: string, seenCall: boolean } | { kind: 'clear' } | { kind: 'sidechain' }} Tail 最后一条引导回了没有；seenCall：这次的工具调用已经落盘 */
/** @typedef {{ settleMs?: number, sleep?: (ms: number) => void }} Opts 测试换掉等待 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * @param {unknown} o
 * @param {string} k
 * @returns {unknown}
 */
const prop = (o, k) => (isObj(o) ? o[k] : undefined);
/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/**
 * 同步睡一会（钩子是一次性进程，没有事件循环可让）。
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 从文件尾部往回一行一行地给（最后一行可能还没写完，照样给，解析不了由调用方跳过）。只读尾部、按块读，不整份读进来。
 * @param {string} path
 * @returns {Generator<string>}
 */
function* linesFromEnd(path) {
  const fd = openSync(path, 'r');
  try {
    const st = fstatSync(fd);
    // Windows 上目录也打得开、大小是 0，不先判就会读出「一行都没有」，被当成没有引导放过去（Linux 上 readSync 才报 EISDIR）。
    if (!st.isFile()) throw new Error('不是普通文件');
    let pos = st.size;
    let back = 0;
    let rest = Buffer.alloc(0);
    while (pos > 0) {
      // 到上限就收手：lastDirective 读完没碰到引导，结果是「没有待回的引导」
      if (back >= MAX_BACK_BYTES) return;
      const len = Math.min(CHUNK_BYTES, pos);
      pos -= len;
      back += len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      let data = rest.length > 0 ? Buffer.concat([buf, rest]) : buf;
      let nl = data.lastIndexOf(0x0a);
      while (nl !== -1) {
        const line = data.subarray(nl + 1);
        if (line.length > 0) yield line.toString('utf8');
        data = data.subarray(0, nl);
        nl = data.lastIndexOf(0x0a);
      }
      rest = Buffer.from(data);
    }
    if (rest.length > 0) yield rest.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * 是不是创始人中途打的字：queued_command、commandMode 是 prompt、来源是人（Mirasim 里不带 origin，命令行里 origin.kind 是 human）。
 * 后台任务的完成通知（commandMode: task-notification）、子代理交回的报告（origin.kind: peer）、协调者的话都不算。
 * @param {unknown} att
 */
function isFounderDirective(att) {
  if (prop(att, 'type') !== 'queued_command' || prop(att, 'commandMode') !== 'prompt') return false;
  if (prop(att, 'isMeta') === true) return false;
  const origin = prop(att, 'origin');
  return origin === undefined || origin === null || prop(origin, 'kind') === 'human';
}

/**
 * 引导的文字：prompt 是字符串，或者 [{ type: 'text', text }, { type: 'image', … }] 这样的数组。
 * @param {unknown} prompt
 */
function directiveText(prompt) {
  if (typeof prompt === 'string') return prompt.trim();
  if (!Array.isArray(prompt)) return '';
  return prompt
    .map((p) =>
      prop(p, 'type') === 'text'
        ? String(prop(p, 'text') ?? '')
        : prop(p, 'type') === 'image'
          ? '[图片]'
          : '',
    )
    .join('')
    .trim();
}

/**
 * 主对话写了一段非空文字没有。接口报错的假回复（isApiErrorMessage）不算。
 * @param {Record<string, unknown>} o
 */
function saidSomething(o) {
  if (o.type !== 'assistant' || o.isApiErrorMessage === true) return false;
  const content = prop(o.message, 'content');
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some((b) => prop(b, 'type') === 'text' && String(prop(b, 'text') ?? '').trim() !== '');
}

/** 拒的理由开头这几个字：工具结果里见到它，说明这条引导已经提醒过一次 */
const REMINDER_MARK = '你刚收到创始人的引导『';

/**
 * 工具结果里有没有本钩子拒过的理由（同一条引导只拦一次，提醒过了就不再拦）。
 * @param {Record<string, unknown>} o
 */
function remindedHere(o) {
  if (o.type !== 'user') return false;
  const content = prop(o.message, 'content');
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    if (prop(b, 'type') !== 'tool_result') return false;
    const c = prop(b, 'content');
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((p) => String(prop(p, 'text') ?? '')).join('')
          : '';
    return text.includes(REMINDER_MARK);
  });
}

/**
 * 这一行是不是这次要判的工具调用（assistant 行里 tool_use.id 等于钩子输入的 tool_use_id）。
 * 它落了盘，同一条回复里排在它前面的文字一定也落了盘，不用再等。
 * @param {Record<string, unknown>} o
 * @param {string | undefined} toolUseId
 */
function isThisCall(o, toolUseId) {
  if (toolUseId === undefined || o.type !== 'assistant') return false;
  const content = prop(o.message, 'content');
  return (
    Array.isArray(content) &&
    content.some((b) => prop(b, 'type') === 'tool_use' && prop(b, 'id') === toolUseId)
  );
}

/**
 * 创始人开了新的一轮（真的用户消息，不是工具结果、不是系统塞的 isMeta）：在它之前的引导已经过去了。
 * @param {Record<string, unknown>} o
 */
function newTurn(o) {
  if (o.type !== 'user' || o.isMeta === true) return false;
  const content = prop(o.message, 'content');
  if (typeof content === 'string') return content.trim() !== '' && !machineTurn(content);
  if (!Array.isArray(content) || content.length === 0) return false;
  if (content.some((b) => prop(b, 'type') === 'tool_result')) return false;
  return !machineTurn(content.map((b) => String(prop(b, 'text') ?? '')).join(''));
}

/**
 * 不是人说的、由 Claude Code 自己开的一轮：后台任务的完成通知把会话叫醒、Stop 钩子把收尾挡回来。
 * 把它们当成「收到了创始人的话」，Mirasim 的引导还没送到钩子就不转了。
 * @param {string} text
 */
function machineTurn(text) {
  const t = text.trimStart();
  return t.startsWith('<task-notification>') || t.startsWith('Stop hook feedback:');
}

/**
 * 从尾部往回看：先碰到主对话写的话（任何一段非空文字，和 tool_use 同一条消息也算）→ 回了；先碰到本钩子拒过的工具结果 → 这条引导提醒过了，
 * 不再拦；先碰到创始人的引导 → 没回；先碰到新一轮的开头 → 没有待回的引导。
 * 最后一行是子代理的（isSidechain: true）→ 这份是子代理的 transcript，不查。读不了就抛，由调用方明说没查成；往回读到 MAX_BACK_BYTES 还没认出就按没有待回的引导。
 * @param {string} path
 * @param {string} [toolUseId] 这次工具调用的 id：引导之后见到它那一行，pending 里的 seenCall 为 true
 * @returns {Tail}
 */
export function lastDirective(path, toolUseId) {
  let first = true;
  let seenCall = false;
  for (const line of linesFromEnd(path)) {
    /** @type {unknown} */
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 还没写完的最后一行
    }
    if (!isObj(o)) continue;
    if (first) {
      first = false;
      if (o.isSidechain === true) return { kind: 'sidechain' };
    }
    if (o.isSidechain === true) continue;
    if (saidSomething(o)) return { kind: 'clear' };
    if (remindedHere(o)) return { kind: 'clear' };
    if (isThisCall(o, toolUseId)) seenCall = true;
    if (o.type === 'attachment' && isFounderDirective(o.attachment)) {
      return { kind: 'pending', text: directiveText(prop(o.attachment, 'prompt')), seenCall };
    }
    if (newTurn(o)) return { kind: 'clear' };
  }
  return { kind: 'clear' };
}

/**
 * 子代理发的调用：Claude Code 只在子代理里的钩子调用带 agent_id（code.claude.com/docs/en/hooks：只在子代理里出现）。
 * 空的、不是字符串的不算，宁可按主对话多拦一次。
 * @param {unknown} input
 */
function isSubagentCall(input) {
  const id = prop(input, 'agent_id');
  return typeof id === 'string' && id.trim() !== '';
}

/**
 * 记「转给模型看过的引导到哪一刻」的目录（~/.fleet-dao/steer-shown）；测试用 FLEET_STEER_SHOWN_DIR 换。
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 */
export function steerShownDir(env = process.env, home = homedir()) {
  const o = env.FLEET_STEER_SHOWN_DIR;
  return typeof o === 'string' && o ? o : join(home, '.fleet-dao', 'steer-shown');
}

/**
 * 这个会话的那一份：<目录>/<会话号>.json，内容 { at: 毫秒 }。
 * @param {string} dir
 * @param {string} sessionId
 */
export function shownFile(dir, sessionId) {
  return join(dir, `${sessionId.replace(/[^\w.-]/g, '_')}.json`);
}

/** @param {string} text */
const replyFirst = (text) => {
  const shown = Array.from(text).slice(0, DIRECTIVE_SHOWN_CHARS).join('');
  return `你刚收到创始人的引导『${shown}』：先用一句话回它（问题就答，指令就说改成什么；涉及在跑的子代理就用 SendMessage 转给它并说已转），再接着调工具。`;
};

/**
 * 这次工具调用要不要拒。
 * @param {string} raw 钩子的原始输入
 * @param {Opts} [opts]
 * @returns {Verdict}
 */
export function check(raw, { settleMs = SETTLE_MS, sleep = sleepSync } = {}) {
  /** @type {unknown} */
  let input;
  try {
    const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    input = JSON.parse(noBom);
  } catch (e) {
    return { notice: `引导检查没查成：钩子输入不是 JSON（${why(e)}）` };
  }
  if (!isObj(input)) return { notice: '引导检查没查成：钩子输入不是一个对象' };
  // Grok 借道读 ~/.claude/settings.json 的钩子（camelCase 输入，没有 transcript）：引导以 queued_command 附进 transcript
  // 是 Claude Code 的做法，这一条只管 Claude Code。
  if ('hookEventName' in input || ('toolName' in input && !('tool_name' in input))) return {};
  if (isSubagentCall(input)) return {};
  if (typeof input.tool_name === 'string' && REPLY_TOOLS.has(input.tool_name)) return {};

  /** @type {string[]} */
  const reasons = [];
  /** @type {string | undefined} */
  let notice;
  let sidechain = false;
  const path = input.transcript_path;
  if (typeof path !== 'string' || path.trim() === '') {
    notice = `引导检查没查成：钩子输入里没有 transcript_path（${JSON.stringify(path) ?? 'undefined'}）`;
  } else {
    const toolUseId =
      typeof input.tool_use_id === 'string' && input.tool_use_id !== '' ? input.tool_use_id : undefined;
    try {
      let tail = lastDirective(path, toolUseId);
      // 这次的工具调用已经落盘还没见到文字：同一条回复里排在前面的文字也早该在了，不用再等
      for (let i = 0; i < SETTLE_TRIES && tail.kind === 'pending' && !tail.seenCall; i++) {
        sleep(settleMs);
        tail = lastDirective(path, toolUseId);
      }
      if (tail.kind === 'pending') reasons.push(replyFirst(tail.text));
      sidechain = tail.kind === 'sidechain';
    } catch (e) {
      notice = `引导检查没查成：读不了 ${path}（${why(e)}）`;
    }
  }
  if (sidechain) return {};

  /** @type {Verdict} */
  const v = {};
  if (reasons.length > 0) v.deny = reasons.join('\n');
  if (notice !== undefined) v.notice = notice;
  return v;
}

/**
 * 钩子写到 stdout 的那一份：拒 → hookSpecificOutput.permissionDecision: deny；要明说 → systemMessage；都没有 → 空串。
 * @param {Verdict} v
 */
export function hookOutput(v) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (v.deny !== undefined) {
    out.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: v.deny,
    };
  }
  if (v.notice !== undefined) out.systemMessage = v.notice;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : '';
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  if (process.env.FLEET_HEADLESS === '1') process.exit(0);
  // 各阶段耗时记进 ~/.fleet-dao/logs/hook-timing.jsonl（hook-timing.mjs），查超时用
  const timer = hookTimer('main-thread.mjs');
  /** @type {Verdict} */
  let v;
  /** @type {unknown} */
  let tool;
  try {
    const raw = readFileSync(0, 'utf8');
    timer.mark('read');
    try {
      tool = prop(JSON.parse(raw), 'tool_name');
    } catch {
      // 认不出由 check 处理
    }
    v = check(raw);
  } catch (e) {
    v = { notice: `引导检查没查成：钩子自己出错了（${why(e)}）` };
  }
  timer.mark('decide');
  const out = hookOutput(v);
  if (out) process.stdout.write(`${out}\n`);
  timer.mark('write');
  timer.done({ tool, code: 0 });
  process.exit(0);
}
