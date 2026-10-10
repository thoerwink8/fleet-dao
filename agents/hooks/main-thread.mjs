// PreToolUse 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，Claude Code 每次调工具之前都跑：登记时不写 matcher）。
// 只管主对话的几条（决定 0078，创始人 2026-10-10 13:02「都按你的推荐来。」）：
// 1. 引导先回。创始人在一轮中途打的字叫「引导」：transcript 里是一行 attachment（type: queued_command，commandMode: prompt），
//    附在下一次工具结果后面送进主对话。本机 178 条送到的引导里，AI 第一反应直接再调工具 107 条、先写话 45 条、本轮随即结束 26 条，
//    创始人觉得「石沉大海」。所以最后一条引导之后，主对话还没写过一段非空文字，就拒这次工具调用。
// 2. 子代理一律后台跑。主对话前台等子代理（Agent/Task 写了 run_in_background: false）时整段不调工具，引导转不进来，
//    界面也只在派它的那一轮显示每一步。所以主对话里前台派子代理就拒（一轮结束不会杀掉后台子代理，2026-10-11 实测；
//    进程重开——插队、重启——会）。不写 run_in_background 不拦：本机 transcript 里不写的 39 次全是后台起的
//    （结果是「Async agent launched」），不写就是后台。让它后台跑、主对话留在这一轮每次最多等 60 秒，跑完再收尾。
// 3. Mirasim 的引导由钩子取原文转过来（#1743，补决定 0078）。Mirasim 收到引导当场就写进 Claude Code 的 stdin，
//    可 Claude Code 要等后台子代理都跑完才读进来（2026-10-11 实测：Mirasim 03:37:01 写进去，03:39:39 子代理收场后才进会话；
//    叫这一轮结束也没用，照样等子代理）。所以每次调工具前读 ~/.mirasim/diag/ 当前和上一小时的 ev-<UTC 年月日时>.ndjson，
//    找本会话的 turn.steer；会话记录里那之后没收到创始人的话（任务通知、Stop 钩子挡回来开的一轮都不算），就从 Mirasim 取原文
//    （ui-cli raw 订阅这个会话，snapshot.steers；约 0.6 秒，只在 diag 显示有引导在等时才起），拒这次调用、理由带原文：
//    先回一句、接着干、不用结束这一轮。转过的记进 ~/.fleet-dao/steer-shown/<会话号>.json，同一条不再拦；稍后 Claude Code
//    正式送进来时它说一句「这条前面已回」。收尾钩子（stop.mjs）收尾时用同一个 takeSteers 挡回去。
//    取不到原文、diag 读不了：不拦，明说没查成；整个 ~/.mirasim 都不在（没装 Mirasim）：不会有它的引导，不说话。
// 子代理里的调用（输入带 agent_id）几条都不管：子代理不和创始人对话，收不到引导；子代理里再派子代理也不管。
// 读不了 transcript：不拦（拦死所有工具代价太大），但用 systemMessage 明说「引导检查没查成：原因」，不当成没有引导静默过去。
// 借道读 ~/.claude/settings.json 的几家：Grok 的输入是 camelCase、没有 transcript，认出来就不查、不说话；Devin、Cursor 的输入
// 要是不带 transcript_path，每次都会明说没查成（照实说，不装作查过）。
// 引擎起的 Claude 会话带 --setting-sources project、不读用户级设置，这条钩子管不到它们。
// 协议：stdin 一份 JSON；拒 = stdout 一份 hookSpecificOutput.permissionDecision: deny，退出码 0；没意见 = 什么都不写。
// 规矩由 agents/test/rules/main-thread.rules.test.ts、mirasim-steer.rules.test.ts 钉住：改这里的判断就是改规矩，那边会红。
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
/** @typedef {{ text: string, at: number }} SteerText 一条 Mirasim 引导的原文和 Mirasim 记下它的时刻（毫秒） */
/** @typedef {(root: string, sessionId: string) => SteerText[]} FetchSteers 从 Mirasim 取这个会话这一轮的引导原文；读不到就抛 */
/**
 * @typedef {{ settleMs?: number, sleep?: (ms: number) => void, now?: number, mirasim?: string,
 *   fetchSteers?: FetchSteers, shownDir?: string }} Opts 测试换掉等待、时钟、Mirasim 家目录、取原文那一步、记转过的目录
 */
/** @typedef {{ kind: 'none' } | { kind: 'pending', at: number } | { kind: 'unknown', why: string }} Steer Mirasim 里有没有没送进来的引导 */

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
/** @param {unknown} e */
const errCode = (e) => prop(e, 'code');

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
  if (typeof content === 'string') return content.trim() !== '' && !machineTurn(content);
  if (!Array.isArray(content) || content.length === 0) return false;
  if (content.some((b) => prop(b, 'type') === 'tool_result')) return false;
  return !machineTurn(content.map((b) => String(prop(b, 'text') ?? '')).join(''));
}

/**
 * 不是人说的、由 Claude Code 自己开的一轮：后台任务的完成通知把会话叫醒、Stop 钩子把收尾挡回来。
 * 2026-10-11 实测：把它们当成「收到了创始人的话」，Mirasim 的引导还没送到钩子就不转了。
 * @param {string} text
 */
function machineTurn(text) {
  const t = text.trimStart();
  return t.startsWith('<task-notification>') || t.startsWith('Stop hook feedback:');
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

/** 一小时的毫秒数：diag 一小时一个文件 */
const HOUR_MS = 3_600_000;

/**
 * Mirasim 的家目录（~/.mirasim）；测试和别的布局用 FLEET_MIRASIM_DIR 换。
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 */
export function mirasimDir(env = process.env, home = homedir()) {
  const o = env.FLEET_MIRASIM_DIR;
  return typeof o === 'string' && o ? o : join(home, '.mirasim');
}

/**
 * diag 里某一时刻所在那个 UTC 小时的事件文件：<家目录>/diag/ev-<UTC 年月日时>.ndjson。
 * @param {string} root
 * @param {number} ms
 */
export function diagFile(root, ms) {
  const iso = new Date(ms).toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}`;
  return join(root, 'diag', `ev-${stamp}.ndjson`);
}

/**
 * 这个会话在 diag（上一小时和当前这一小时）里最后一次 turn.steer 的时刻（毫秒）；没有是 null。
 * 当前这一小时的文件还没开写（整点刚过）不算错，两份都不在才算。读不了、认不出就抛，由调用方明说没查成。
 * 只看最后一次：它之后收到过创始人的话，更早的也都过去了。
 * @param {string} root
 * @param {string} sessionId
 * @param {number} now
 * @returns {number | null}
 */
export function lastSteerAt(root, sessionId, now) {
  /** @type {number | null} */
  let latest = null;
  let seen = 0;
  for (const file of [diagFile(root, now - HOUR_MS), diagFile(root, now)]) {
    /** @type {string} */
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if (errCode(e) === 'ENOENT') continue;
      throw new Error(`读不了 ${file}（${errCode(e) ?? why(e)}）`);
    }
    seen += 1;
    const lines = text.split('\n');
    /** @type {string | null} */
    let badFormat = null;
    let checkedFirst = false;
    for (let i = 0; i < lines.length && badFormat === null; i++) {
      const line = (lines[i] ?? '').trim();
      if (line === '') continue;
      const last = i === lines.length - 1;
      // 只解析第一行（认格式）和提到 turn.steer、本会话号的行；一小时几十万字节，别的不逐行 JSON.parse
      if (checkedFirst && !(line.includes('turn.steer') && line.includes(sessionId))) continue;
      /** @type {unknown} */
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        if (last) continue; // 还没写完的最后一行
        badFormat = `第 ${i + 1} 行不是 JSON`;
        break;
      }
      if (!checkedFirst) {
        checkedFirst = true;
        if (!isObj(o) || typeof o.ts !== 'string' || typeof o.kind !== 'string') {
          badFormat = '第一行不是带 ts、kind 的事件';
          break;
        }
      }
      if (!isObj(o) || o.name !== 'turn.steer' || o.sessionId !== sessionId) continue;
      const at = typeof o.ts === 'string' ? Date.parse(o.ts) : Number.NaN;
      if (!Number.isFinite(at)) {
        badFormat = `第 ${i + 1} 行 turn.steer 的时刻 ${JSON.stringify(o.ts)} 认不出`;
        break;
      }
      if (latest === null || at > latest) latest = at;
    }
    if (badFormat !== null) throw new Error(`${file} 的格式认不出（${badFormat}）`);
  }
  if (seen === 0) {
    throw new Error(`${join(root, 'diag')} 里当前和上一小时的事件文件都不在`);
  }
  return latest;
}

/**
 * 是不是「收到了创始人的话」：不是任务通知、Stop 钩子反馈的 enqueue（Claude Code 读进引导时就记这一行）、
 * 创始人中途打的字（queued_command）、新一轮的用户消息（任务通知、Stop 钩子开的不算，见 machineTurn）。
 * @param {Record<string, unknown>} o
 */
function founderSpoke(o) {
  if (o.type === 'queue-operation' && o.operation === 'enqueue') {
    const c = o.content;
    return !(typeof c === 'string' && (c.includes('<task-notification>') || machineTurn(c)));
  }
  if (o.type === 'attachment') return isFounderDirective(o.attachment);
  return newTurn(o);
}

/**
 * 会话记录里 since（毫秒）那一刻之后收到过创始人的话没有。从尾部往回读，读到早于 since 的行就停。读不了就抛。
 * @param {string} path
 * @param {number} since
 */
export function receivedSince(path, since) {
  for (const line of linesFromEnd(path)) {
    /** @type {unknown} */
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 还没写完的最后一行
    }
    if (!isObj(o) || o.isSidechain === true) continue;
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : Number.NaN;
    if (!Number.isFinite(ts)) continue;
    if (ts < since) return false;
    if (founderSpoke(o)) return true;
  }
  return false;
}

/**
 * Mirasim 里有没有这个会话还没送进来的引导。不抛：读不了、认不出都是 unknown（调用方明说没查成）；
 * 整个 Mirasim 家目录都不在 = 这台机器没装 Mirasim，不会有它的引导，是 none。
 * @param {{ root: string, sessionId: unknown, transcriptPath: unknown, now: number }} o
 * @returns {Steer}
 */
export function pendingSteer({ root, sessionId, transcriptPath, now }) {
  try {
    statSync(root);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { kind: 'none' };
    return { kind: 'unknown', why: `读不了 ${root}（${errCode(e) ?? why(e)}）` };
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return {
      kind: 'unknown',
      why: `钩子输入里没有 session_id（${JSON.stringify(sessionId) ?? 'undefined'}）`,
    };
  }
  /** @type {number | null} */
  let at;
  try {
    at = lastSteerAt(root, sessionId, now);
  } catch (e) {
    return { kind: 'unknown', why: why(e) };
  }
  if (at === null) return { kind: 'none' };
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') {
    return { kind: 'unknown', why: 'Mirasim 里有引导，但钩子输入里没有 transcript_path，判不了送到没有' };
  }
  try {
    return receivedSince(transcriptPath, at) ? { kind: 'none' } : { kind: 'pending', at };
  } catch (e) {
    return {
      kind: 'unknown',
      why: `Mirasim 里有引导，但读不了 ${transcriptPath}（${why(e)}），判不了送到没有`,
    };
  }
}

/**
 * 北京时间「月-日 时:分」。
 * @param {number} ms
 */
export function beijing(ms) {
  return new Date(ms + 8 * HOUR_MS).toISOString().slice(5, 16).replace('T', ' ');
}

/** 装好的 Mirasim 桌面版的本机口（ui-cli 连它）；MIRASIM_PORT 可换 */
const MIRASIM_PORT = process.env.MIRASIM_PORT || '4970';
/** 取一次引导原文最多等多久：调工具前钩子、收尾钩子都只给 10 秒（packages/agents-sync/src/targets.ts），实测约 0.6 秒 */
const FETCH_MS = 7_000;

/**
 * Mirasim 装好的最新版本里的 server.cjs（<家目录>/app/<版本>/server.cjs，版本按数字比）；一个都没有就抛。
 * @param {string} root
 */
export function mirasimServer(root) {
  const app = join(root, 'app');
  const num = (/** @type {string} */ v) => v.split('.').map(Number);
  const versions = readdirSync(app)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && existsSync(join(app, v, 'server.cjs')))
    .sort((a, b) => {
      const [x, y] = [num(a), num(b)];
      for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      return 0;
    });
  const latest = versions.at(-1);
  if (latest === undefined) throw new Error(`${app} 下没有带 server.cjs 的版本`);
  return join(app, latest, 'server.cjs');
}

/**
 * 这个会话这一轮在 Mirasim 里记下的引导原文：ui-cli raw 订阅 claude:<会话号>，回的 responses[] 里 snapshot 帧的
 * snapshot.steers（ui-cli watch 不带 steers，不能用）。起不来、退出码不是 0、回的认不出都抛。
 * @type {FetchSteers}
 */
export function fetchSteers(root, sessionId) {
  const out = execFileSync(
    process.execPath,
    [
      mirasimServer(root),
      'ui-cli',
      '--port',
      MIRASIM_PORT,
      'raw',
      JSON.stringify({ type: 'subscribe', sessionKey: `claude:${sessionId}` }),
      '--await',
      'snapshot',
      '--seconds',
      '4',
    ],
    { encoding: 'utf8', timeout: FETCH_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  /** @type {unknown} */
  const r = JSON.parse(out);
  const frames = prop(r, 'responses');
  if (!Array.isArray(frames)) throw new Error('ui-cli raw 回的不是 { responses: [] }');
  const snap = frames.find((f) => prop(f, 'type') === 'snapshot');
  if (snap === undefined) throw new Error('订阅这个会话没收到 snapshot 帧');
  const steers = prop(prop(snap, 'snapshot'), 'steers');
  if (steers === undefined || steers === null) return [];
  if (!Array.isArray(steers)) throw new Error('snapshot 里的 steers 不是数组');
  return steers.flatMap((s) => {
    const text = prop(s, 'text');
    const at = prop(s, 'at');
    return typeof text === 'string' && typeof at === 'number' ? [{ text, at }] : [];
  });
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

/** @param {string} file 读不到、认不出当没转过（0）：多转一次也比漏转好 */
function readShown(file) {
  try {
    const at = prop(JSON.parse(readFileSync(file, 'utf8')), 'at');
    return typeof at === 'number' ? at : 0;
  } catch {
    return 0;
  }
}

/** @typedef {{ kind: 'relay', steers: SteerText[] } | { kind: 'none' } | { kind: 'unknown', why: string }} Taken 要转的引导 */

/**
 * 还没转给模型看过的 Mirasim 引导：diag 说有引导在等、且晚于上次转过的，才去 Mirasim 取原文；取到就先记成转过（同一条只转一次）。
 * 调工具前钩子和收尾钩子共用。不抛：取不到原文、记不下都是 unknown（调用方明说没查成，不拦）。
 * @param {{ root: string, sessionId: unknown, transcriptPath: unknown, now: number, fetch?: FetchSteers, shownDir?: string }} o
 * @returns {Taken}
 */
export function takeSteers({
  root,
  sessionId,
  transcriptPath,
  now,
  fetch = fetchSteers,
  shownDir = steerShownDir(),
}) {
  const steer = pendingSteer({ root, sessionId, transcriptPath, now });
  if (steer.kind !== 'pending') return steer;
  if (typeof sessionId !== 'string') return { kind: 'none' }; // pending 时一定是字符串，这句只给类型检查看
  const file = shownFile(shownDir, sessionId);
  const shownAt = readShown(file);
  if (steer.at <= shownAt) return { kind: 'none' };
  const head = `创始人 ${beijing(steer.at)} 在 Mirasim 发了一条引导`;
  /** @type {string} */
  let miss;
  try {
    const fresh = fetch(root, sessionId).filter((s) => s.at > shownAt);
    if (fresh.length > 0) {
      const at = Math.max(steer.at, ...fresh.map((s) => s.at));
      try {
        mkdirSync(shownDir, { recursive: true });
        writeFileSync(file, JSON.stringify({ at }));
      } catch (e) {
        // 记不下就不转：不然同一条每次调工具都拦一遍
        return {
          kind: 'unknown',
          why: `${head}，记不下转过的（${file}：${errCode(e) ?? why(e)}），没转给你`,
        };
      }
      return { kind: 'relay', steers: fresh };
    }
    miss = 'Mirasim 这一轮里没有记着它的原文';
  } catch (e) {
    miss = why(e);
  }
  return {
    kind: 'unknown',
    why: `${head}，读不到原文（${miss}）：Claude Code 要等后台子代理都跑完才会把它送进来`,
  };
}

/**
 * 转给模型的话（调工具前钩子拒调用的理由、收尾钩子挡回去的 reason）：带北京时刻和原文。
 * @param {SteerText[]} steers
 */
export const steerRelay = (steers) => {
  const lines = steers.map(
    (s) => `${beijing(s.at)}『${Array.from(s.text).slice(0, DIRECTIVE_SHOWN_CHARS).join('')}』`,
  );
  return (
    `创始人在 Mirasim 发了引导：${lines.join('；')}。Claude Code 要等后台子代理都跑完才会把它正式送进来，钩子先转给你：` +
    '先用一句话回它（问题就答，指令就说改成什么；涉及在跑的子代理就用 SendMessage 转给它并说已转），再接着干活，不用结束这一轮。' +
    '它稍后还会作为新消息再送进来一次，那时说一句「这条前面已回」就行。'
  );
};

/** @param {string} text */
const replyFirst = (text) => {
  const shown = Array.from(text).slice(0, DIRECTIVE_SHOWN_CHARS).join('');
  return `你刚收到创始人的引导『${shown}』：先用一句话回它（问题就答，指令就说改成什么；涉及在跑的子代理就用 SendMessage 转给它并说已转），再接着调工具。`;
};
const BACKGROUND_ONLY =
  '子代理一律后台跑：去掉 run_in_background: false 再派（不写就是后台）。主对话留在本轮、每次最多等 60 秒，等它跑完再收尾。前台等子代理时主对话不调工具，创始人的引导转不进来，界面也只在派它的那一轮显示每一步；一轮结束不会杀掉后台子代理（2026-10-11 实测），进程重开（插队、重启）会。';

/**
 * 这次工具调用要不要拒。
 * @param {string} raw 钩子的原始输入
 * @param {Opts} [opts]
 * @returns {Verdict}
 */
export function check(
  raw,
  {
    settleMs = SETTLE_MS,
    sleep = sleepSync,
    now = Date.now(),
    mirasim = mirasimDir(),
    fetchSteers: fetch = fetchSteers,
    shownDir = steerShownDir(),
  } = {},
) {
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

  // Mirasim 的引导在等：Claude Code 要等后台子代理跑完才读进来，钩子取原文当场转给模型，不用结束这一轮
  const steer = takeSteers({
    root: mirasim,
    sessionId: input.session_id,
    transcriptPath: path,
    now,
    fetch,
    shownDir,
  });
  if (steer.kind === 'relay') {
    /** @type {Verdict} */
    const held = { deny: steerRelay(steer.steers) };
    if (notice !== undefined) held.notice = notice;
    return held;
  }
  if (steer.kind === 'unknown') {
    const more = `引导检查没查成：${steer.why}`;
    notice = notice === undefined ? more : `${notice}；${more}`;
  }

  const tool = input.tool_name;
  const toolInput = input.tool_input;
  if (
    typeof tool === 'string' &&
    SUBAGENT_TOOLS.has(tool) &&
    prop(toolInput, 'run_in_background') === false
  ) {
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
