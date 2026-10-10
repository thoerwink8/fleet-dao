// PreToolUse 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，Claude Code 每次调工具之前都跑：登记时不写 matcher）。
// 只管主对话的两条（决定 0077，创始人 2026-10-10 13:02「都按你的推荐来。」）：
// 1. 引导先回。创始人在一轮中途打的字叫「引导」：transcript 里是一行 attachment（type: queued_command，commandMode: prompt），
//    附在下一次工具结果后面送进主对话。本机 178 条送到的引导里，AI 第一反应直接再调工具 107 条、先写话 45 条、本轮随即结束 26 条，
//    创始人觉得「石沉大海」。所以最后一条引导之后，主对话还没写过一段非空文字，就拒这次工具调用。
// 2. 子代理一律后台跑。主对话前台等子代理（Agent/Task 不带 run_in_background: true）时整段卡住，引导送不进来；
//    Mirasim 一轮结束会杀掉还在跑的后台子代理，界面也只在派它的那一轮显示每一步。所以主对话里前台派子代理就拒，
//    让它后台跑、主对话留在这一轮每次最多等 60 秒，跑完再收尾。
// 子代理里的调用（输入带 agent_id）两条都不管：子代理不和创始人对话，收不到引导；子代理里再派子代理也不管。
// 读不了 transcript：不拦（拦死所有工具代价太大），但用 systemMessage 明说「引导检查没查成：原因」，不当成没有引导静默过去。
// 借道读 ~/.claude/settings.json 的几家：Grok 的输入是 camelCase、没有 transcript，认出来就不查、不说话；Devin、Cursor 的输入
// 要是不带 transcript_path，每次都会明说没查成（照实说，不装作查过）。
// 引擎起的 Claude 会话带 --setting-sources project、不读用户级设置，这条钩子管不到它们。
// 协议：stdin 一份 JSON；拒 = stdout 一份 hookSpecificOutput.permissionDecision: deny，退出码 0；没意见 = 什么都不写。
// 规矩由 agents/test/rules/main-thread.rules.test.ts 钉住：改这里的判断就是改规矩，那边会红。
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 拒的理由里最多带引导的前多少个字 */
export const DIRECTIVE_SHOWN_CHARS = 200;
/** 从尾部往回读，一块多大 */
const CHUNK_BYTES = 256 * 1024;
/** 最多往回读多少：再往前还认不出回话、引导、这一轮的开头，就算没查成（不读整份大文件） */
const MAX_BACK_BYTES = 64 * 1024 * 1024;
/** 见到没回的引导先等这么久再读一遍：同一条回复里先写的文字，万一还没落盘，别把「已经回了话」误拦 */
const SETTLE_MS = 300;
/** 派子代理的工具名 */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/** @typedef {{ deny?: string, notice?: string }} Verdict 拒（理由给模型看）、或要明说的话（systemMessage，给创始人看）；空对象是没意见 */
/** @typedef {{ kind: 'pending', text: string } | { kind: 'clear' } | { kind: 'sidechain' }} Tail 最后一条引导回了没有 */
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
    let pos = fstatSync(fd).size;
    let back = 0;
    let rest = Buffer.alloc(0);
    while (pos > 0) {
      if (back >= MAX_BACK_BYTES) {
        throw new Error(`往回读了 ${MAX_BACK_BYTES / 1024 / 1024} MB，还没认出回话、引导或这一轮的开头`);
      }
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

/**
 * 创始人开了新的一轮（真的用户消息，不是工具结果、不是系统塞的 isMeta）：在它之前的引导已经过去了。
 * @param {Record<string, unknown>} o
 */
function newTurn(o) {
  if (o.type !== 'user' || o.isMeta === true) return false;
  const content = prop(o.message, 'content');
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content) || content.length === 0) return false;
  return !content.some((b) => prop(b, 'type') === 'tool_result');
}

/**
 * 从尾部往回看：先碰到主对话写的话 → 回了（或者后来没有新引导）；先碰到创始人的引导 → 没回；先碰到新一轮的开头 → 没有待回的引导。
 * 最后一行是子代理的（isSidechain: true）→ 这份是子代理的 transcript，不查。读不了就抛，由调用方明说没查成。
 * @param {string} path
 * @returns {Tail}
 */
export function lastDirective(path) {
  let first = true;
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
    if (o.type === 'attachment' && isFounderDirective(o.attachment)) {
      return { kind: 'pending', text: directiveText(prop(o.attachment, 'prompt')) };
    }
    if (newTurn(o)) return { kind: 'clear' };
  }
  return { kind: 'clear' };
}

/**
 * 子代理发的调用：Claude Code 只在子代理里的钩子调用带 agent_id（和 pretool.mjs 的 isSubagentCall 同一个判法）。
 * 空的、不是字符串的不算，宁可按主对话多拦一次。
 * @param {unknown} input
 */
function isSubagentCall(input) {
  const id = prop(input, 'agent_id');
  return typeof id === 'string' && id.trim() !== '';
}

/** @param {string} text */
const replyFirst = (text) => {
  const shown = Array.from(text).slice(0, DIRECTIVE_SHOWN_CHARS).join('');
  return `你刚收到创始人的引导『${shown}』：先用一句话回它（问题就答，指令就说改成什么；涉及在跑的子代理就用 SendMessage 转给它并说已转），再接着调工具。`;
};
const BACKGROUND_ONLY =
  '子代理一律后台跑：Agent 工具带上 run_in_background: true 再派。主对话留在本轮、每次最多等 60 秒，等它跑完再收尾（Mirasim 一轮结束会杀掉后台子代理，界面也只在派它的那一轮显示每一步；前台等子代理时创始人的引导送不进来）。';

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
  // 是 Claude Code 的做法，这两条只管 Claude Code。
  if ('hookEventName' in input || ('toolName' in input && !('tool_name' in input))) return {};
  if (isSubagentCall(input)) return {};

  /** @type {string[]} */
  const reasons = [];
  /** @type {string | undefined} */
  let notice;
  let sidechain = false;
  const path = input.transcript_path;
  if (typeof path !== 'string' || path.trim() === '') {
    notice = `引导检查没查成：钩子输入里没有 transcript_path（${JSON.stringify(path) ?? 'undefined'}）`;
  } else {
    try {
      let tail = lastDirective(path);
      if (tail.kind === 'pending') {
        sleep(settleMs);
        tail = lastDirective(path);
      }
      if (tail.kind === 'pending') reasons.push(replyFirst(tail.text));
      sidechain = tail.kind === 'sidechain';
    } catch (e) {
      notice = `引导检查没查成：读不了 ${path}（${why(e)}）`;
    }
  }
  if (sidechain) return {};

  const tool = input.tool_name;
  const toolInput = input.tool_input;
  if (typeof tool === 'string' && SUBAGENT_TOOLS.has(tool) && prop(toolInput, 'run_in_background') !== true) {
    reasons.push(BACKGROUND_ONLY);
  }
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
  /** @type {Verdict} */
  let v;
  try {
    v = check(readFileSync(0, 'utf8'));
  } catch (e) {
    v = { notice: `引导检查没查成：钩子自己出错了（${why(e)}）` };
  }
  const out = hookOutput(v);
  if (out) process.stdout.write(`${out}\n`);
  process.exit(0);
}
