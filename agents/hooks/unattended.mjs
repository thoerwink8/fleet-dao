// 无人值守「不中断这一轮」（创始人 2026-10-03「无人值守是让这一轮一直不结束……」「选 a」）。
// 三处用它：命令行（AI 按创始人的话开关）、Stop 钩子（stop.mjs：开着就把「结束这一轮」挡回去）、PreToolUse 钩子
// （pretool.mjs：调了工具就记一笔「这一轮在干活」）。开会话钩子也读它，上下文被总结、会话重启之后还知道开着。
//
// 用法（AI 在创始人说「进入无人值守」时跑 on，说「停」时跑 off）：
//   node ~/.fleet-dao/hooks/unattended.mjs on [--hours 8]      开（最长 24 小时，默认 8）
//   node ~/.fleet-dao/hooks/unattended.mjs done "做完了什么"    全做完了：放行收尾
//   node ~/.fleet-dao/hooks/unattended.mjs needs-you "要他拍什么"  碰人闸：放行收尾，把问题放最后一条等他
//   node ~/.fleet-dao/hooks/unattended.mjs off                  关
//   node ~/.fleet-dao/hooks/unattended.mjs status
//
// 改这里之前必须知道（规矩由 agents/test/rules/stop.rules.test.ts 钉住）：
// - 状态按会话号存（~/.fleet-dao/unattended/<会话号>.json，会话号来自环境变量 CLAUDE_CODE_SESSION_ID，Stop、PreToolUse 的输入里
//   同一个号）：同时开着的几个会话、几个仓互不串。会话号拿不到，on 明确失败，不装作开成了。
// - 只有两种放行带着「没查成」的话：状态读不了 / 写不了（放行是为了不把人困住，但要说清楚是故障，不是正常收尾）。
// - 防空转：被挡回去之后，两次挡之间一个工具都没调（PreToolUse 没记到）算「没干活」；连着 3 次就放行并转成 paused，
//   另有总次数上限；过期时间到了自动关。这几个数不要凭感觉改大——改大等于允许多烧额度。
// - 钩子里任何一步出错一律放行（只提示），绝不抛、不拦：这里是兜底，不是新的故障点。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 类型只写在 JSDoc 里（这份文件被同步工具原样装到各台机器、纯 node 直接跑，没有编译步骤）；agents/tsconfig.json 用 checkJs 过严格检查。
/**
 * 一个会话的无人值守状态（~/.fleet-dao/unattended/<会话号>.json）：readState 认过这几项才当它是状态。
 * @typedef {{ state: 'on' | 'paused' | 'done', expiresAt: string, idle: number, totalBlocks: number, toolSinceBlock?: boolean, auto?: boolean, since?: string, note?: string, lastBlockAt?: string }} State
 */
/** @typedef {{ out: (line: string) => void, err: (line: string) => void, env?: NodeJS.ProcessEnv, now?: number }} CliIo */

/**
 * 抛出来的东西上的 code（ENOENT 这类）；不是对象就是 undefined。
 * @param {unknown} e
 */
const errCode = (e) => (typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined);
/**
 * 抛出来的东西上的 message；不是对象就是 undefined。
 * @param {unknown} e
 */
const messageOf = (e) => (typeof e === 'object' && e !== null && 'message' in e ? e.message : undefined);

export const DEFAULT_HOURS = 8;
export const MAX_HOURS = 24;
/** 被挡回去后连着这么多次没调过工具，就放行。 */
export const MAX_IDLE_BLOCKS = 3;
/** 一次无人值守最多挡这么多次，防别的原因造成的无限循环。 */
export const MAX_TOTAL_BLOCKS = 80;

const SCRIPT = '~/.fleet-dao/hooks/unattended.mjs';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 */
export function stateDir(env = process.env, home = homedir()) {
  const o = env.FLEET_UNATTENDED_DIR;
  return typeof o === 'string' && o ? o : join(home, '.fleet-dao', 'unattended');
}

/**
 * 会话号只许字母数字和 - _：它要拼进文件名，别的字符一律当没有。
 * @param {unknown} id
 * @returns {string | null}
 */
export function cleanId(id) {
  return typeof id === 'string' && /^[\w-]{4,128}$/.test(id) ? id : null;
}

/**
 * @param {string} dir
 * @param {unknown} id
 */
function fileFor(dir, id) {
  return join(dir, `${cleanId(id)}.json`);
}

/**
 * { ok: true, state: 对象 | null（没开） } 或 { ok: false, why }；读不了、认不出都是 ok:false，不当成没开。
 * @param {string} dir
 * @param {unknown} id
 * @returns {{ ok: true, state: State | null } | { ok: false, why: string }}
 */
export function readState(dir, id) {
  if (!cleanId(id)) return { ok: true, state: null };
  /** @type {string} */
  let text;
  try {
    text = readFileSync(fileFor(dir, id), 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { ok: true, state: null };
    return { ok: false, why: `读不了状态文件（${errCode(err) ?? err}）` };
  }
  try {
    /** @type {unknown} */
    const s = JSON.parse(text);
    const good =
      typeof s === 'object' &&
      s !== null &&
      'state' in s &&
      typeof s.state === 'string' &&
      ['on', 'paused', 'done'].includes(s.state) &&
      'expiresAt' in s &&
      Number.isFinite(Date.parse(String(s.expiresAt))) &&
      'idle' in s &&
      Number.isInteger(s.idle) &&
      'totalBlocks' in s &&
      Number.isInteger(s.totalBlocks);
    if (!good) return { ok: false, why: '状态文件的内容认不出' };
    // 上面逐项核过 state、expiresAt、idle、totalBlocks 才走到这里
    return { ok: true, state: /** @type {State} */ (s) };
  } catch {
    return { ok: false, why: '状态文件不是合法的 JSON' };
  }
}

/**
 * @param {string} dir
 * @param {unknown} id
 * @param {object} state
 */
function writeState(dir, id, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(dir, id), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * @param {string} dir
 * @param {unknown} id
 */
function removeState(dir, id) {
  rmSync(fileFor(dir, id), { force: true });
}

/** @param {string} iso */
const fmt = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16);

/**
 * @param {State} state
 * @param {number} now
 */
export function blockReason(state, now) {
  const left = Math.max(0, Math.round((Date.parse(state.expiresAt) - now) / 60_000));
  if (state.auto === true) {
    return (
      `你起了后台活（子代理、监视、后台命令），这一轮结束它们会跟着会话进程一起被杀、没有谁会被完成通知叫醒，所以先别结束这一轮（自动挡 ${left} 分钟）。` +
      `继续等它们的结果、接着干；全收口了：node ${SCRIPT} done "做完了什么"；碰到要创始人拍的：node ${SCRIPT} needs-you "要他拍什么"。`
    );
  }
  return (
    `无人值守开着（还剩约 ${left} 分钟）：不要结束这一轮。还有没做完的事就接着干——先短报一行进度，然后继续调工具；` +
    `全做完了：node ${SCRIPT} done "做完了什么"；碰到要创始人拍的（对外发布、花钱、删数据、改标准）：` +
    `node ${SCRIPT} needs-you "要他拍什么"，再把问题放在最后一条。`
  );
}

/**
 * Stop 钩子要不要挡。返回 { block: true, reason } 或 { block: false, notice? }（notice 给 systemMessage，只在要说话时有）。
 * 不抛：任何一步出错都放行并写明。
 * @param {{ dir: string, sessionId: unknown, now?: number }} opts
 * @returns {{ block: true, reason: string } | { block: false, notice?: string }}
 */
export function decideStop({ dir, sessionId, now = Date.now() }) {
  try {
    if (!cleanId(sessionId)) return { block: false };
    const r = readState(dir, sessionId);
    if (!r.ok) {
      return {
        block: false,
        notice: `无人值守状态${r.why}：这一轮不拦（不能把人困住）；开着的话要重新跑 node ${SCRIPT} on。`,
      };
    }
    const s = r.state;
    if (s === null || s.state !== 'on') return { block: false };
    if (now > Date.parse(s.expiresAt)) {
      removeState(dir, sessionId);
      return { block: false, notice: `无人值守过期了（到 ${fmt(s.expiresAt)}），已关。` };
    }
    // 上一次挡过之后，到这一次之间没调过任何工具：没干活，只回了文字
    const idle = s.totalBlocks > 0 && !s.toolSinceBlock ? s.idle + 1 : 0;
    if (idle >= MAX_IDLE_BLOCKS || s.totalBlocks >= MAX_TOTAL_BLOCKS) {
      const why =
        idle >= MAX_IDLE_BLOCKS
          ? `被挡回去 ${MAX_IDLE_BLOCKS} 次都没再干活（没调工具）`
          : `已经挡了 ${MAX_TOTAL_BLOCKS} 次，到上限`;
      writeState(dir, sessionId, { ...s, state: 'paused', note: why, idle });
      return {
        block: false,
        notice: `无人值守自动暂停：${why}。有话要创始人定就放最后一条；要接着干请重新跑 node ${SCRIPT} on。`,
      };
    }
    writeState(dir, sessionId, {
      ...s,
      idle,
      totalBlocks: s.totalBlocks + 1,
      toolSinceBlock: false,
      lastBlockAt: new Date(now).toISOString(),
    });
    return { block: true, reason: blockReason(s, now) };
  } catch (err) {
    return {
      block: false,
      notice: `无人值守的判断自己出错了（${messageOf(err) ?? err}）：这一轮不拦（不能把人困住）。`,
    };
  }
}

/**
 * PreToolUse 调用：开着就记一笔「调了工具」。只在需要改的时候才写；任何错误都吞掉。
 * @param {{ dir: string, sessionId: unknown }} opts
 */
export function touchTool({ dir, sessionId }) {
  try {
    const r = readState(dir, sessionId);
    if (!r.ok || r.state === null || r.state.state !== 'on' || r.state.toolSinceBlock === true) return;
    writeState(dir, sessionId, { ...r.state, toolSinceBlock: true });
  } catch {
    // 记不上最多让这一轮早点被放行，不影响调用
  }
}

/** 起了后台活自动开的无人值守开多久（创始人 2026-10-04「选 1」）；再起一个后台活就续到再过这么久。 */
export const AUTO_ARM_MINUTES = 30;

/**
 * 这次工具调用是不是起了一件在后台跑的活。后台活是挂在这个会话进程上的：一轮结束、进程一重开它就被杀，
 * 也就没有谁会被它的完成通知叫醒（2026-10-04 上午、下午各丢过一回：#754 的测试和三个监视任务跟着一轮结束一起没了）。
 * Agent（子代理）默认在后台，只有显式 run_in_background:false 才是前台；Monitor、Workflow 本来就是后台；Bash、PowerShell 要显式 true。
 * @param {unknown} toolName
 * @param {unknown} toolInput
 * @returns {boolean}
 */
export function startsBackground(toolName, toolInput) {
  const bg =
    typeof toolInput === 'object' && toolInput !== null && 'run_in_background' in toolInput
      ? toolInput.run_in_background
      : undefined;
  if (toolName === 'Monitor' || toolName === 'Workflow') return true;
  if (toolName === 'Agent' || toolName === 'Task') return bg !== false;
  if (toolName === 'Bash' || toolName === 'PowerShell') return bg === true;
  return false;
}

/**
 * 起了后台活：没开无人值守（或已收尾、暂停、过期）就自动开一个 AUTO_ARM_MINUTES 分钟的，这一轮结束会被挡回来；
 * 已经开着的：自动开的续期，创始人手动开的（通常更长）一个字不动。状态读不了就不写（不覆盖认不出的东西），返回为什么。
 * 活全收口了跑 done 放行；忘了跑也不会困住人：到期自动关、连着 3 次挡回去没调工具就暂停（decideStop）。
 * 返回 { armed, kept?, why? }；不抛。
 * @param {{ dir: string, sessionId: unknown, now?: number, minutes?: number }} opts
 * @returns {{ armed: boolean, kept?: boolean, why?: string }}
 */
export function armForBackground({ dir, sessionId, now = Date.now(), minutes = AUTO_ARM_MINUTES }) {
  try {
    if (!cleanId(sessionId)) return { armed: false, why: '拿不到会话号' };
    const r = readState(dir, sessionId);
    if (!r.ok) return { armed: false, why: r.why };
    const s = r.state;
    const until = new Date(now + minutes * 60_000).toISOString();
    if (s !== null && s.state === 'on' && now <= Date.parse(s.expiresAt)) {
      if (s.auto === true && Date.parse(s.expiresAt) < Date.parse(until)) {
        writeState(dir, sessionId, { ...s, expiresAt: until });
        return { armed: false, kept: true };
      }
      return { armed: false, kept: true };
    }
    writeState(dir, sessionId, {
      state: 'on',
      auto: true,
      since: new Date(now).toISOString(),
      expiresAt: until,
      idle: 0,
      totalBlocks: 0,
      toolSinceBlock: true,
      note: '起了后台活，自动开的',
    });
    return { armed: true };
  } catch (err) {
    return { armed: false, why: String(messageOf(err) ?? err) };
  }
}

// ── 创始人的话到了、还没有东西送到他手上（创始人 2026-10-05「全都按照你推荐的改」，对「干活中间问话，一次答完并送到手上」那条）──
// 起因：无人值守或后台活开着时这一轮结束不了，「答案放最后一条」落不了地。2026-10-05 一场会话里他问了一句，答案 11 分钟就齐了，
// 之后 2 小时只是在每一步开头重说，一次也没单独发给他。
// 记在 <会话号>.owed.json，和无人值守的状态分开存：他说话的时候可能还没开（后台活晚一步才起）。
// 三处动它：消息提交钩子（prompt-log.mjs）记；调工具前钩子（pretool.mjs）见到送达类工具就清、过了 OWED_NAG_MINUTES 还欠着就拦一次；
// 收尾钩子（stop.mjs）放行时清（这一轮结束了，最后一条就是答复）、挡回时在话里点名。

/** 他的话到了之后过这么久还没送达，就在下一次调工具时拦一次。 */
export const OWED_NAG_MINUTES = 10;
/** 调了这几个工具算「送到他手上了」。登记在同步工具的 PreToolUse matcher 里（targets.ts），两边要一起改。 */
export const DELIVERY_TOOLS = new Set(['mcp__mirasim__deliver_artifact', 'PushNotification']);

/** @typedef {{ at: string, preview: string, nagged: boolean }} Owed */

/**
 * @param {string} dir
 * @param {unknown} id
 */
function owedFile(dir, id) {
  return join(dir, `${cleanId(id)}.owed.json`);
}

/**
 * 是不是他本人说的、要有个回音的话：系统替后台活报的完成通知、上下文总结的开场白不算；「继续」这种几个字的也不算。
 * @param {unknown} prompt
 * @returns {prompt is string}
 */
export function isFounderPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const t = prompt.trim();
  if (t.length < 6) return false;
  return (
    !/^(<task-notification|<agent-message|\[SYSTEM NOTIFICATION|This session is being continued)/.test(t) &&
    !isMachineOpening(t)
  );
}

/**
 * 机器自己起的会话的第一条提示：反方（「你是「反方」」，discuss 技能起的）。
 * 它也走 UserPromptSubmit，不是创始人说的话（2026-10-05 开会话钩子列「创始人最近的话」，真话被这类提示挤出最后 5 条）。
 * @param {unknown} prompt
 */
export function isMachineOpening(prompt) {
  return typeof prompt === 'string' && /^\s*你是「反方」/.test(prompt);
}

/** 工人（commander 的 worker.mjs 起的）的工作树：`.claude/worktrees/w-<名字>` */
const MACHINE_TREE = /[\\/]\.claude[\\/]worktrees[\\/]w-[^\\/]+(?:[\\/]|$)/;

/**
 * 这个会话是不是机器派的（工人、反方），不是创始人坐在前面的：环境变量 FLEET_WORKER=1（worker-lib.mjs 起工人时设，
 * 反方的 reclaude 会话也设）或会话目录在上面那种工作树里。会话开场、落盘都靠它认。
 * @param {{ env?: Record<string, string | undefined>, cwd?: unknown }} [opts]
 */
export function isMachineSession({ env = process.env, cwd } = {}) {
  if (env.FLEET_WORKER === '1') return true;
  return typeof cwd === 'string' && MACHINE_TREE.test(cwd);
}

/**
 * 消息提交那一刻记一笔。不抛、不出声（调用方是「绝不插话」的 prompt-log.mjs）。
 * @param {{ dir: string, sessionId: unknown, prompt: unknown, now?: number }} opts
 */
export function noteFounderPrompt({ dir, sessionId, prompt, now = Date.now() }) {
  try {
    if (!cleanId(sessionId) || !isFounderPrompt(prompt)) return;
    mkdirSync(dir, { recursive: true });
    /** @type {Owed} */
    const owed = {
      at: new Date(now).toISOString(),
      preview: prompt.trim().replace(/\s+/g, ' ').slice(0, 40),
      nagged: false,
    };
    writeFileSync(owedFile(dir, sessionId), `${JSON.stringify(owed)}\n`);
  } catch {
    // 记不上只是少一次提醒
  }
}

/**
 * 欠账文件：没有（或会话号认不出、没地方找）是 { ok: true, owed: null }；读不了、不是 JSON、缺 at/preview、时间认不出是
 * { ok: false, why }——那是坏了，不是「没欠」，调用方要明说（原来一律回 null，「话还没送到」这条提醒悄悄失效，全仓审查第 4 路 S8）。
 * @param {{ dir: string, sessionId: unknown }} opts
 * @returns {{ ok: true, owed: Owed | null } | { ok: false, why: string }}
 */
export function readOwed({ dir, sessionId }) {
  if (!cleanId(sessionId)) return { ok: true, owed: null };
  let text;
  try {
    text = readFileSync(owedFile(dir, sessionId), 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { ok: true, owed: null };
    return { ok: false, why: `读不了（${errCode(err) ?? messageOf(err) ?? err}）` };
  }
  /** @type {unknown} */
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return { ok: false, why: '不是 JSON' };
  }
  if (typeof o !== 'object' || o === null || !('at' in o) || !('preview' in o))
    return { ok: false, why: '缺 at 或 preview' };
  if (!Number.isFinite(Date.parse(String(o.at)))) return { ok: false, why: `时间认不出（${String(o.at)}）` };
  return {
    ok: true,
    owed: { at: String(o.at), preview: String(o.preview), nagged: 'nagged' in o && o.nagged === true },
  };
}

/**
 * 欠账文件坏了：挪到旁边的 .bad（留着查原因，下次不再报同一份），返回一句不拦的提示。挪不动也照样提示。
 * @param {{ dir: string, sessionId: unknown, why: string }} opts
 */
function setAsideOwed({ dir, sessionId, why }) {
  const file = owedFile(dir, sessionId);
  let moved = '';
  try {
    renameSync(file, `${file}.bad`);
    moved = `，已挪到 ${file}.bad`;
  } catch (err) {
    moved = `，挪不走（${errCode(err) ?? messageOf(err) ?? err}）`;
  }
  return (
    `欠账文件 ${file} 坏了（${why}）${moved}：创始人的话有没有送到他手上核不了。` +
    '他最近说过话、还没送过东西，就先用 deliver_artifact（没有就 PushNotification）送一句。'
  );
}

/** @param {{ dir: string, sessionId: unknown }} opts */
export function clearOwed({ dir, sessionId }) {
  try {
    if (cleanId(sessionId)) rmSync(owedFile(dir, sessionId), { force: true });
  } catch {
    // 清不掉最多多提醒一次
  }
}

/**
 * @param {Owed} owed
 * @param {number} now
 */
export function owedLine(owed, now) {
  const mins = Math.max(0, Math.round((now - Date.parse(owed.at)) / 60_000));
  return (
    `创始人 ${mins} 分钟前说的话（「${owed.preview}…」）还没有东西送到他手上——这一轮结束不了，他等不到「最后一条」。` +
    '现在就送：是问话，把完整答案一次写清，用 deliver_artifact 发给他（没有就 PushNotification）；是交代，发一行「收到、在做什么」。' +
    '送过之后接着干，不要在后面每一步开头再重说。'
  );
}

/**
 * 收尾钩子用：挡回去时把欠着的话点名加在前面（欠账文件坏了就把「坏了」那句加在前面）；放行时清掉（这一轮结束了，最后一条就是答复）。
 * @param {{ block: true, reason: string } | { block: false, notice?: string }} verdict
 * @param {{ dir: string, sessionId: unknown, now?: number }} opts
 */
export function withOwed(verdict, { dir, sessionId, now = Date.now() }) {
  if (!verdict.block) {
    clearOwed({ dir, sessionId });
    return verdict;
  }
  const r = readOwed({ dir, sessionId });
  if (!r.ok)
    return { block: true, reason: `${setAsideOwed({ dir, sessionId, why: r.why })}\n${verdict.reason}` };
  const owed = r.owed;
  if (!owed) return verdict;
  // 同一条欠账只在「第一次挡住收尾」时塞进 reason 顶部；之后每次再把这条放最前，模型就只看见它、看不见别的
  // （Mirasim 会把每条挡回都重现，于是用户以为模型重说同一句话、忽略了新输入）。第一次过后照旧拦，但用一句短的「账还欠着」带过。
  if (owed.nagged) return { block: true, reason: verdict.reason };
  markNagged({ dir, sessionId, owed });
  return { block: true, reason: `${owedLine(owed, now)}\n${verdict.reason}` };
}

/**
 * 给欠账文件打上 nagged：下次挡住收尾时不再把这句放最前。写坏了最多多提醒一次，不抛。
 * @param {{ dir: string, sessionId: unknown, owed: Owed }} opts
 */
function markNagged({ dir, sessionId, owed }) {
  try {
    writeFileSync(owedFile(dir, sessionId), `${JSON.stringify({ ...owed, nagged: true })}\n`);
  } catch {
    // 只是下次多提醒一次
  }
}

/**
 * 调工具前钩子用：这次调的是送达类工具就清账；这一轮结束不了（无人值守开着）、话欠了超过 OWED_NAG_MINUTES 又没拦过，
 * 就返回 { block: true, message } 让调用方把这一次工具调用拦下（只拦一次，不困住人）。
 * 欠账文件坏了、这一步自己出了错：返回 { block: false, message }，调用方写进 stderr、不拦（不再悄悄回 null，全仓审查第 4 路 S8）。不抛。
 * @param {{ dir: string, sessionId: unknown, tool: unknown, now?: number }} opts
 * @returns {{ block: boolean, message: string } | null}
 */
export function nagIfOwed({ dir, sessionId, tool, now = Date.now() }) {
  try {
    if (typeof tool === 'string' && DELIVERY_TOOLS.has(tool)) {
      clearOwed({ dir, sessionId });
      return null;
    }
    const read = readOwed({ dir, sessionId });
    if (!read.ok) return { block: false, message: setAsideOwed({ dir, sessionId, why: read.why }) };
    const owed = read.owed;
    if (!owed || owed.nagged || now - Date.parse(owed.at) < OWED_NAG_MINUTES * 60_000) return null;
    const r = readState(dir, sessionId);
    if (!r.ok || r.state === null || r.state.state !== 'on' || now > Date.parse(r.state.expiresAt))
      return null;
    writeFileSync(
      owedFile(dir, sessionId),
      `${JSON.stringify({ ...owed, nagged: true })}
`,
    );
    return {
      block: true,
      message: `${owedLine(owed, now)}（这次工具调用先拦下，只拦这一次；送完重发这条命令。）`,
    };
  } catch (err) {
    return {
      block: false,
      message: `「创始人的话还没送到」这条提醒自己出错了（${errCode(err) ?? messageOf(err) ?? err}），这次没核成。`,
    };
  }
}

/**
 * 开会话钩子读的那一句：这个会话的无人值守开着（上下文被总结、重启之后还知道）；没开、读不了都是空数组。
 * @param {{ dir: string, sessionId: unknown, now?: number }} opts
 * @returns {string[]}
 */
export function sessionLines({ dir, sessionId, now = Date.now() }) {
  const r = readState(dir, sessionId);
  if (!r.ok) return [`无人值守状态${r.why}：开着的话要重新跑 node ${SCRIPT} on。`];
  const s = r.state;
  if (s === null || now > Date.parse(s.expiresAt)) return [];
  if (s.state === 'on') {
    return [
      `无人值守开着（到 ${fmt(s.expiresAt)}）：这一轮不要结束，接着干；全做完 node ${SCRIPT} done "…"，要创始人拍板 node ${SCRIPT} needs-you "…"。`,
    ];
  }
  if (s.state === 'paused') {
    return [`无人值守暂停着（${s.note || '没写原因'}）：创始人要接着干就重新跑 node ${SCRIPT} on。`];
  }
  return [];
}

const USAGE = `用法：node ${SCRIPT} on [--hours N] | done "做完了什么" | needs-you "要他拍什么" | off | status`;

/**
 * 命令行；返回退出码。io = { out, err, env, now }。
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {number}
 */
export function main(argv, io) {
  const env = io.env ?? process.env;
  const now = io.now ?? Date.now();
  const dir = stateDir(env);
  const [cmd, ...rest] = argv;
  const id = cleanId(env.CLAUDE_CODE_SESSION_ID);
  if (!['on', 'done', 'needs-you', 'off', 'status'].includes(cmd ?? '')) {
    io.err(`没做成：${cmd ? `不认识的命令 ${cmd}` : '没给命令'}。${USAGE}`);
    return 2;
  }
  if (!id) {
    io.err(
      '没做成：拿不到会话号（环境变量 CLAUDE_CODE_SESSION_ID 没有或不合法），不知道这个状态该记在哪个会话上。',
    );
    return 2;
  }
  try {
    if (cmd === 'status') {
      const r = readState(dir, id);
      if (!r.ok) {
        io.err(`没查成：无人值守状态${r.why}`);
        return 1;
      }
      if (r.state === null) io.out('无人值守：没开');
      else {
        const s = r.state;
        io.out(
          `无人值守：${s.state}，到 ${fmt(s.expiresAt)}，已挡 ${s.totalBlocks} 次（连着没干活 ${s.idle} 次）${s.note ? `，${s.note}` : ''}`,
        );
      }
      return 0;
    }
    if (cmd === 'off') {
      removeState(dir, id);
      io.out('无人值守已关。');
      return 0;
    }
    if (cmd === 'on') {
      let hours = DEFAULT_HOURS;
      const i = rest.indexOf('--hours');
      if (i >= 0) hours = Number(rest[i + 1]);
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
        io.err(`没做成：--hours 要是 0 到 ${MAX_HOURS} 之间的数，给的是「${rest[i + 1] ?? ''}」。`);
        return 2;
      }
      const expiresAt = new Date(now + hours * 3_600_000).toISOString();
      writeState(dir, id, {
        state: 'on',
        since: new Date(now).toISOString(),
        expiresAt,
        idle: 0,
        totalBlocks: 0,
        toolSinceBlock: true,
        note: '',
      });
      io.out(
        `无人值守已开，到 ${fmt(expiresAt)}。这一轮想结束会被挡回来；做完 done、要他拍板 needs-you、他说停就 off。`,
      );
      return 0;
    }
    // done / needs-you：必须写一句话，逼着说清楚为什么放行
    const note = rest.join(' ').trim();
    if (!note) {
      io.err(`没做成：${cmd} 要写一句话（${cmd === 'done' ? '做完了什么' : '要他拍什么'}）。`);
      return 2;
    }
    const r = readState(dir, id);
    if (!r.ok || r.state === null) {
      io.err(r.ok ? '没做成：这个会话没开无人值守，没有要改的。' : `没做成：无人值守状态${r.why}。`);
      return 1;
    }
    writeState(dir, id, { ...r.state, state: cmd === 'done' ? 'done' : 'paused', note });
    io.out(`无人值守${cmd === 'done' ? '收尾' : '暂停'}：${note}。这一轮现在可以结束了。`);
    return 0;
  } catch (err) {
    io.err(`没做成：${messageOf(err) ?? err}`);
    return 1;
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  process.exit(
    main(process.argv.slice(2), {
      out: (/** @type {string} */ s) => process.stdout.write(`${s}\n`),
      err: (/** @type {string} */ s) => process.stderr.write(`${s}\n`),
    }),
  );
}
