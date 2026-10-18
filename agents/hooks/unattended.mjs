// 无人值守：活由 Agent 子代理干、不脱离会话，这个会话等子代理的完成通知、收创始人的引导、汇报。
// 命令行记录本会话开关；同步 Stop 把未完成工作交给下一轮；成功 PostToolUse 登记新进展。
// 开会话钩子也读它，上下文被总结、会话重启之后还知道开着。
//
// 用法（创始人说「进入无人值守」「过夜」「我在睡觉」时跑 on，说「停」「退出无人值守」时跑 off）：
//   node ~/.fleet-dao/hooks/unattended.mjs on [--hours 12]      开（最长 12 小时，默认 12）；只在这个会话自己跑了 on 才挡
//   node ~/.fleet-dao/hooks/unattended.mjs done "做完了什么"    全做完（子代理都收口、队列空了）：放行收尾
//   node ~/.fleet-dao/hooks/unattended.mjs needs-you "要他拍什么"  碰人闸：放行收尾，把问题放最后一条等他
//   node ~/.fleet-dao/hooks/unattended.mjs off                  关
//   node ~/.fleet-dao/hooks/unattended.mjs status
//
// 改这里之前必须知道（规矩由 agents/test/rules/stop.rules.test.ts 钉住）：
// - 只有这个会话自己跑了 on 才挡：状态按会话号存（~/.fleet-dao/unattended/<会话号>.json）；命令和钩子统一识别真实会话号：
//   CLAUDE_CODE_SESSION_ID、CODEX_THREAD_ID、CODEX_SESSION_ID 依次优先；钩子以这次事件的 session_id 为准，缺失才读环境。
//   非法来源不借别的会话号兜底。别的会话、别的机器、工人和反方（机器派的会话，on 直接拒）都不受影响。
//   起子代理、监视、后台命令不自动开。会话号拿不到，on 明确失败。
// - 放行：off、done / needs-you、12 小时到期；无进展/总次数到上限明确 paused 故障，不再仍标 on 却结束。
// - background_tasks/session_crons 只说明登记存在，不证明完成通知会送达；开着时先同步续轮，显式等待并消费结果。
// - 只有成功 PostToolUse 的新写入、验证、提交、收工才重置连续无进展计数；重复动作、sleep 和查询状态不算。
// - 数值上限不扩大；故障暂停保留未完成状态，避免无限循环烧额度。
// - 钩子里任何一步出错一律放行（只提示），绝不抛、不拦：这里是兜底，不是新的故障点。
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 类型只写在 JSDoc 里（这份文件被同步工具原样装到各台机器、纯 node 直接跑，没有编译步骤）；agents/tsconfig.json 用 checkJs 过严格检查。
/**
 * 一个会话的无人值守状态（~/.fleet-dao/unattended/<会话号>.json）：readState 认过 state、expiresAt、totalBlocks 才当它是状态。
 * streak：开启或实质进展重置后的接续次数，首次接续也计 1，并非精确的无进展轮数；
 * streakReleases：到上限暂停过几次（兼容旧字段名）。idle、toolSinceBlock 不再读。
 * @typedef {{ state: 'on' | 'paused' | 'done', expiresAt: string, totalBlocks: number, streak?: number, streakReleases?: number, lastStreakReleaseAt?: string, idle?: number, toolSinceBlock?: boolean, auto?: boolean, since?: string, note?: string, lastBlockAt?: string, consumedProgress?: number, deliveredResults?: string[] }} State
 */
/**
 * Stop 输入里还有什么在跑：tasks 是 background_tasks 的条数，crons 是 session_crons 的条数；输入里没有这一项是 null（判不出）。
 * @typedef {{ tasks: number | null, crons: number | null }} Pending
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

export const DEFAULT_HOURS = 12;
/** 开着最长这么久，到点自动放行。 */
export const MAX_HOURS = 12;
/** 连续接续这么多次却没有实质进展，就明确故障暂停。 */
export const MAX_STREAK = 3;
/** 一次无人值守最多挡这么多次，防别的原因造成的无限循环。 */
export const MAX_TOTAL_BLOCKS = 200;

/**
 * 只记已成功完成的写入、验证、提交、派工/收工；重复命令、sleep、状态轮询不续命。
 * PostToolUse 才调用，PreToolUse 不能把「打算做」当进展。
 * @param {{ dir: string, sessionId: unknown, input: unknown }} opts
 */
export function recordProgress({ dir, sessionId, input }) {
  const r = readState(dir, sessionId);
  if (!r.ok || !r.state || r.state.state !== 'on') return;
  const get = (/** @type {string} */ key) =>
    typeof input === 'object' && input !== null ? Reflect.get(input, key) : undefined;
  const name = get('tool_name');
  const args = get('tool_input');
  const response = get('tool_response');
  if (args && typeof args === 'object' && Reflect.get(args, 'run_in_background') === true) return;
  if (
    response &&
    typeof response === 'object' &&
    (Reflect.get(response, 'is_error') === true ||
      Reflect.get(response, 'success') === false ||
      Reflect.get(response, 'interrupted') === true ||
      typeof Reflect.get(response, 'session_id') === 'number' ||
      Reflect.get(response, 'shell_id') !== undefined ||
      ['running', 'in_progress'].includes(Reflect.get(response, 'status')) ||
      (typeof Reflect.get(response, 'exit_code') === 'number' && Reflect.get(response, 'exit_code') !== 0))
  )
    return;
  const command =
    typeof args === 'object' && args !== null
      ? (Reflect.get(args, 'command') ?? Reflect.get(args, 'cmd'))
      : '';
  const writing = typeof name === 'string' && /^(Write|Edit|MultiEdit|apply_patch)$/.test(name);
  const validating =
    typeof command === 'string' &&
    !/\b(sleep|Start-Sleep)\b/i.test(command) &&
    /\b(pnpm\s+([^\r\n]*\s)?(check|test|typecheck|hygiene|vitest|biome|build)|git\s+(commit|push)|gh\s+(pr\s+create|issue\s+create))\b/.test(
      command,
    );
  const finished =
    typeof name === 'string' &&
    /^(Agent|Task|TaskOutput|SubagentHandback)$/.test(name) &&
    response !== undefined &&
    !/"(status|state)"\s*:\s*"(running|in_progress)"/.test(JSON.stringify(response));
  const waited =
    typeof name === 'string' &&
    /^(wait|wait_agent|write_stdin)$/.test(name) &&
    response &&
    typeof response === 'object' &&
    Reflect.get(response, 'timed_out') !== true &&
    (Reflect.get(response, 'exit_code') === 0 || /"completed"\s*:/.test(JSON.stringify(response)));
  if (!writing && !validating && !finished && !waited) return;
  const hash = createHash('sha256')
    .update(JSON.stringify([name, args]))
    .digest('hex');
  // 并行完成的工具各写独立凭据，不读改写同一状态，避免覆盖掉另一个工具的进展。
  const receipts = join(dir, `${cleanId(sessionId)}.progress`);
  mkdirSync(receipts, { recursive: true });
  try {
    writeFileSync(join(receipts, hash), '', { flag: 'wx' });
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw err;
  }
}

/** @param {string} dir @param {unknown} sessionId */
function countProgress(dir, sessionId) {
  try {
    return readdirSync(join(dir, `${cleanId(sessionId)}.progress`)).filter((n) => /^[a-f0-9]{64}$/.test(n))
      .length;
  } catch (err) {
    if (errCode(err) === 'ENOENT') return 0;
    throw err;
  }
}

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
 * 命令与状态消费者只在这里选号；已给出的高优先级来源非法时不能落到别的会话。
 * 钩子事件号优先于可能继承自父会话的环境号；无事件号时与命令走同一环境选择。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {unknown} [hookId]
 * @returns {{ ok: true, id: string } | { ok: false, missing: boolean, why: string }}
 */
export function selectSessionId(env = process.env, hookId = null) {
  if (hookId !== null && hookId !== undefined && hookId !== '') {
    const id = cleanId(hookId);
    return id ? { ok: true, id } : { ok: false, missing: false, why: '钩子输入 session_id 不合法' };
  }
  for (const source of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) {
    const value = env[source];
    if (value === undefined || value === '') continue;
    const id = cleanId(value);
    return id ? { ok: true, id } : { ok: false, missing: false, why: `环境变量 ${source} 的会话号不合法` };
  }
  return {
    ok: false,
    missing: true,
    why: '拿不到会话号（CLAUDE_CODE_SESSION_ID、CODEX_THREAD_ID、CODEX_SESSION_ID 都没有，钩子也没给 session_id）',
  };
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
      'totalBlocks' in s &&
      Number.isInteger(s.totalBlocks);
    if (
      !good ||
      ('deliveredResults' in s &&
        (!Array.isArray(s.deliveredResults) || !s.deliveredResults.every((v) => typeof v === 'string'))) ||
      ('consumedProgress' in s && (!Number.isInteger(s.consumedProgress) || Number(s.consumedProgress) < 0))
    )
      return { ok: false, why: '状态文件的内容认不出' };
    // 上面逐项核过 state、expiresAt、totalBlocks 才走到这里
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
  const target = fileFor(dir, id);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, target);
}

/**
 * @param {string} dir
 * @param {unknown} id
 */
function removeState(dir, id) {
  rmSync(fileFor(dir, id), { force: true });
  rmSync(join(dir, `${cleanId(id)}.progress`), { recursive: true, force: true });
}

/** 显式 off 是会话级停止指令，优先于尚未开 on 时也会运行的队列对账。 */
/** @param {string} dir @param {unknown} id */
export function explicitlyOff(dir, id) {
  if (!cleanId(id)) return false;
  try {
    const value = readFileSync(join(dir, `${cleanId(id)}.off`), 'utf8');
    if (value !== 'off\n') throw new Error('会话停止记录内容认不出');
    return true;
  } catch (err) {
    if (errCode(err) === 'ENOENT') return false;
    throw err;
  }
}

/** @param {string} iso */
const fmt = (iso) => {
  const date = new Date(iso);
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  // 日期和偏移都取截止时刻的本地时区，跨日和夏令时也不能把 UTC 冒充本地时间。
  const offset = -date.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} UTC${zone}`;
};

/**
 * 机器自己起的会话的第一条提示：反方（「你是「反方」」，discuss 技能起的）。
 * 它也走 UserPromptSubmit，不是创始人说的话。
 * @param {unknown} prompt
 */
export function isMachineOpening(prompt) {
  return typeof prompt === 'string' && /^\s*你是「反方」/.test(prompt);
}

/** 工人的工作树：`.claude/worktrees/w-<名字>` */
const MACHINE_TREE = /[\\/]\.claude[\\/]worktrees[\\/]w-[^\\/]+(?:[\\/]|$)/;

/**
 * 这个会话是不是机器派的（工人、反方），不是创始人坐在前面的：环境变量 FLEET_WORKER=1（机器派的会话都设：
 * 反方的 reclaude 会话等，discuss 的 so-sessions.mjs 在用）或会话目录在上面那种工作树里。会话开场、落盘都靠它认。
 * @param {{ env?: Record<string, string | undefined>, cwd?: unknown }} [opts]
 */
export function isMachineSession({ env = process.env, cwd } = {}) {
  if (env.FLEET_WORKER === '1') return true;
  return typeof cwd === 'string' && MACHINE_TREE.test(cwd);
}

/**
 * 开会话钩子读的那一句：这个会话的无人值守开着（上下文被总结、重启之后还知道）；没开、读不了都是空数组。
 * @param {{ dir: string, sessionId: unknown, now?: number }} opts
 * @returns {string[]}
 */
export function sessionLines({ dir, sessionId, now = Date.now() }) {
  const r = readState(dir, sessionId);
  if (!r.ok) return [`无人值守状态${r.why}：收尾不再被挡住，这句只是没查成。`];
  const s = r.state;
  if (s === null || s.auto === true || now > Date.parse(s.expiresAt)) return [];
  if (s.state === 'on')
    return [
      `无人值守开着（到 ${fmt(s.expiresAt)}）：未完成工作必须接到下一轮；有后台任务先用本 CLI 的阻塞等待工具收结果，不能只凭任务存在就结束。有实质进展才重置防空转计数；连续无进展会明确故障暂停。有进展就 pnpm progress note 记一句；全做完 node ${SCRIPT} done "做完了什么"，要创始人拍板 needs-you，他说停 off。`,
    ];
  if (s.state === 'paused' && s.note) return [`无人值守暂停着（${s.note}）。这一轮可以结束。`];
  return [];
}

/**
 * 续轮提示：继续尚未完成的工作、显式等待并消费结果，以及正常结束与故障暂停的边界。
 * @param {State} state
 * @param {number} now
 * @param {number} [streak] 开启或实质进展重置后的接续序号
 */
export function blockReason(state, now, streak = 1) {
  const left = Math.max(0, Math.round((Date.parse(state.expiresAt) - now) / 60_000));
  const watching =
    '接着做尚未完成的工作。后台任务存在不等于已经送达完成通知；用当前 CLI 的阻塞等待工具收结果（Claude TaskOutput、Codex wait_agent/等待后台命令），不要 sleep 或循环查状态。结果回来后实际消费、验收、再接下一件。需要派工就用本 CLI 支持的子代理；不支持等待或唤醒时明确报接续故障，不能声称持续运行。子代理都收口、队列空了才跑 done 收尾。';
  return (
    `无人值守开着（还剩约 ${left} 分钟，重置后第 ${streak} 次接续；连续 ${MAX_STREAK} 轮无实质进展会故障暂停）：不要空着结束这一轮。${watching}` +
    `每次子代理有进展（PR 开了、做完、卡住）就 pnpm progress note 记一句、给创始人一行汇报，再接着盯；没有新结果就不写话、别空转、别重复上一句。` +
    `全做完（工人都收口、队列空了）：node ${SCRIPT} done "做完了什么"；碰到要创始人拍的（掏新钱、删了找不回又没备份的）：` +
    `node ${SCRIPT} needs-you "要他拍什么"，再把问题放在最后一条；创始人说停：node ${SCRIPT} off。`
  );
}

/**
 * Stop 输入里还有什么在跑：background_tasks、session_crons 两个数组（code.claude.com/docs/en/hooks「Stop input」，
 * 本机 Claude Code 2.1.296 实测带）。不是数组的那一项记 null（判不出），不当成 0。
 * @param {unknown} input
 * @returns {Pending}
 */
export function pendingOf(input) {
  /** @param {string} k */
  const count = (k) => {
    const v = typeof input === 'object' && input !== null && k in input ? Reflect.get(input, k) : undefined;
    return Array.isArray(v) ? v.length : null;
  };
  return { tasks: count('background_tasks'), crons: count('session_crons') };
}

/**
 * Stop 钩子要不要挡。返回 { block: true, reason } 或 { block: false, notice? }（notice 给 systemMessage，只在要说话时有）。
 * pending 只用于提示，不凭任务条数放行；completions 是可消费的本会话工人终态。
 * 不抛：任何一步出错都放行并写明。
 * @param {{ dir: string, sessionId: unknown, now?: number, pending?: Pending, completions?: { key: string, text: string }[] }} opts
 * @returns {{ block: true, reason: string } | { block: false, notice?: string }}
 */
export function decideStop({
  dir,
  sessionId,
  now = Date.now(),
  pending = { tasks: null, crons: null },
  completions = [],
}) {
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
    // auto：旧版「起后台活自动开」留下的状态文件，现在不认（只有这个会话自己跑 on 才挡）
    if (s === null || s.state !== 'on' || s.auto === true) return { block: false };
    if (now > Date.parse(s.expiresAt)) {
      removeState(dir, sessionId);
      return {
        block: false,
        notice: `无人值守过期了（到 ${fmt(s.expiresAt)}，最长 ${MAX_HOURS} 小时），已关。`,
      };
    }
    const fresh = completions.filter((c) => !(s.deliveredResults ?? []).includes(c.key));
    const progressCount = countProgress(dir, sessionId);
    const advanced = progressCount > (s.consumedProgress ?? 0) || fresh.length > 0;
    const streak = advanced ? 0 : Number.isInteger(s.streak) ? Number(s.streak) : 0;
    if (s.totalBlocks >= MAX_TOTAL_BLOCKS) {
      const why = `已经挡了 ${MAX_TOTAL_BLOCKS} 次，到上限`;
      writeState(dir, sessionId, { ...s, state: 'paused', note: why });
      return {
        block: false,
        notice: `无人值守自动暂停：${why}。有话要创始人定就放最后一条；要接着干请重新跑 node ${SCRIPT} on。`,
      };
    }
    // 三次接续都无实质进展：明确停成故障，不能仍标 on 却悄悄收尾。
    if (streak >= MAX_STREAK) {
      const released = (Number.isInteger(s.streakReleases) ? Number(s.streakReleases) : 0) + 1;
      writeState(dir, sessionId, {
        ...s,
        state: 'paused',
        note: `接续故障：连续 ${MAX_STREAK} 次没有实质进展`,
        streakReleases: released,
        lastStreakReleaseAt: new Date(now).toISOString(),
      });
      return {
        block: false,
        notice: `无人值守接续失败：连着挡了 ${MAX_STREAK} 次没有实质进展，已暂停并保留未完成状态（第 ${released} 次）。这不是做完；检查接续链路后重新 on，不能用 sleep 或状态轮询续命。`,
      };
    }
    writeState(dir, sessionId, {
      ...s,
      streak: streak + 1,
      totalBlocks: s.totalBlocks + 1,
      lastBlockAt: new Date(now).toISOString(),
      consumedProgress: progressCount,
      deliveredResults: [...(s.deliveredResults ?? []), ...fresh.map((c) => c.key)],
    });
    const waiting = (pending.tasks ?? 0) + (pending.crons ?? 0);
    return {
      block: true,
      reason: [
        blockReason(s, now, streak + 1),
        ...(waiting > 0 ? [`后台任务/唤醒登记共 ${waiting} 项，先收结果，不能仅凭条数放行。`] : []),
        ...fresh.map((c) => `后台完成结果（必须消费）：${c.text}`),
      ].join('\n'),
    };
  } catch (err) {
    return {
      block: false,
      notice: `无人值守的判断自己出错了（${messageOf(err) ?? err}）：这一轮不拦（不能把人困住）。`,
    };
  }
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
  const session = selectSessionId(env);
  if (!['on', 'done', 'needs-you', 'off', 'status'].includes(cmd ?? '')) {
    io.err(`没做成：${cmd ? `不认识的命令 ${cmd}` : '没给命令'}。${USAGE}`);
    return 2;
  }
  if (!session.ok) {
    io.err(`没做成：${session.why}，不知道这个状态该记在哪个会话上。`);
    return 2;
  }
  const id = session.id;
  try {
    if (cmd === 'status') {
      if (explicitlyOff(dir, id)) {
        io.out('无人值守：off（本会话已明确停止，队列不会再拉起；重新 on 才恢复）。');
        return 0;
      }
      const r = readState(dir, id);
      if (!r.ok) {
        io.err(`没查成：无人值守状态${r.why}`);
        return 1;
      }
      if (r.state === null) io.out('无人值守：没开');
      else {
        const s = r.state;
        io.out(
          `无人值守：${s.state}，到 ${fmt(s.expiresAt)}，已挡 ${s.totalBlocks} 次（连续无进展 ${s.streak ?? 0} 次，接续故障暂停过 ${s.streakReleases ?? 0} 次）${s.note ? `，${s.note}` : ''}`,
        );
      }
      return 0;
    }
    if (cmd === 'off') {
      removeState(dir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.off`), 'off\n');
      rmSync(join(dir, `${id}.queue.json`), { force: true });
      io.out('无人值守已关。');
      return 0;
    }
    if (cmd === 'on') {
      // 工人和反方是机器派的会话，没有创始人在前面；让它们把自己按住没有意义，还会困住机器
      if (isMachineSession({ env })) {
        io.err('没做成：工人、反方这类机器派的会话不开无人值守（不挡它们的收尾）。');
        return 2;
      }
      let hours = DEFAULT_HOURS;
      const i = rest.indexOf('--hours');
      if (i >= 0) hours = Number(rest[i + 1]);
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
        io.err(`没做成：--hours 要是 0 到 ${MAX_HOURS} 之间的数，给的是「${rest[i + 1] ?? ''}」。`);
        return 2;
      }
      const expiresAt = new Date(now + hours * 3_600_000).toISOString();
      const previous = readState(dir, id);
      rmSync(join(dir, `${id}.off`), { force: true });
      rmSync(join(dir, `${id}.progress`), { recursive: true, force: true });
      writeState(dir, id, {
        state: 'on',
        since: new Date(now).toISOString(),
        expiresAt,
        totalBlocks: 0,
        streak: 0,
        note: '',
        deliveredResults: previous.ok ? (previous.state?.deliveredResults ?? []) : [],
      });
      io.out(
        `无人值守状态已记 on，到 ${fmt(expiresAt)}；这只记录意图，不代表 Stop 已登记、信任或执行验证。Claude/Codex 未完成工作经同步 Stop 进入下一轮，后台任务先显式等待并消费结果，不能凭条数结束。成功的新工作重置计数，连续 ${MAX_STREAK} 次无实质进展明确故障暂停。其他 CLI 尚未接通时不得声称接续成功。做完 done、要他拍板 needs-you、他说停 off。`,
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
