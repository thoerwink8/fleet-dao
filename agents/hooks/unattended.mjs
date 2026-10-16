// 无人值守：活由 Agent 子代理干、不脱离会话，这个会话等子代理的完成通知、收创始人的引导、汇报。
// 两处用它：命令行（AI 按创始人的话开关）、Stop 钩子（stop.mjs：开着、又什么都没在跑时把「结束这一轮」挡回去）。
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
// - 只有这个会话自己跑了 on 才挡：状态按会话号存（~/.fleet-dao/unattended/<会话号>.json，会话号来自环境变量 CLAUDE_CODE_SESSION_ID，
//   Stop、PreToolUse 的输入里同一个号），别的会话、别的机器、工人和反方（机器派的会话，on 直接拒）都不受影响。
//   起子代理、监视、后台命令不自动开。会话号拿不到，on 明确失败。
// - 放行的几种：off；done / needs-you；开着满 12 小时；还有东西在跑（Stop 输入的 background_tasks 有子代理、后台命令、
//   监视，或 session_crons 有定时唤醒：它们收口时会把会话叫回来，这一轮结束不丢活，挡回去只是多一轮重读上下文）；
//   什么都没在跑、连着挡了 MAX_STREAK 次（放行一次、记一笔，状态仍开着；有通知或创始人说话再接上）；
//   总次数上限；状态读不了 / 写不了（放行是为了不把人困住，但要说清楚是故障，不是正常收尾）。
//   这几个数不要凭感觉改大——改大等于允许多烧额度。
// - 输入里没有 background_tasks（别家、旧版 Claude Code）：判不出有没有在跑，按「什么都没在跑」算，靠 MAX_STREAK 兜住。
// - 中间调没调工具不算数：以前按「挡回去之后调没调工具」判空转，模型 sleep 50 秒、查一次 PR 就算在干活，一个会话被挡了 247 次。
// - 钩子里任何一步出错一律放行（只提示），绝不抛、不拦：这里是兜底，不是新的故障点。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 类型只写在 JSDoc 里（这份文件被同步工具原样装到各台机器、纯 node 直接跑，没有编译步骤）；agents/tsconfig.json 用 checkJs 过严格检查。
/**
 * 一个会话的无人值守状态（~/.fleet-dao/unattended/<会话号>.json）：readState 认过 state、expiresAt、totalBlocks 才当它是状态。
 * streak：什么都没在跑、连着挡了几次；streakReleases：连着挡到上限放行过几次。idle、toolSinceBlock 是旧版留下的字段，不再读。
 * @typedef {{ state: 'on' | 'paused' | 'done', expiresAt: string, totalBlocks: number, streak?: number, streakReleases?: number, lastStreakReleaseAt?: string, idle?: number, toolSinceBlock?: boolean, auto?: boolean, since?: string, note?: string, lastBlockAt?: string }} State
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
/** 什么都没在跑、连着挡了这么多次就放行一次（记一笔）：挡回去它也没起新东西，别空转。 */
export const MAX_STREAK = 3;
/** 一次无人值守最多挡这么多次，防别的原因造成的无限循环。 */
export const MAX_TOTAL_BLOCKS = 200;

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
      'totalBlocks' in s &&
      Number.isInteger(s.totalBlocks);
    if (!good) return { ok: false, why: '状态文件的内容认不出' };
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
      `无人值守开着（到 ${fmt(s.expiresAt)}）：有子代理、后台命令、监视在跑时这一轮可以结束，等它们的完成通知（不脱离会话）；什么都没在跑、队列还有活就派 Agent 子代理，不要空着收尾。有进展就 pnpm progress note 记一句；全做完 node ${SCRIPT} done "做完了什么"，要创始人拍板 needs-you，他说停 off。`,
    ];
  if (s.state === 'paused' && s.note) return [`无人值守暂停着（${s.note}）。这一轮可以结束。`];
  return [];
}

/**
 * 挡回去时给模型看的话：现在什么都没在跑，具体要它干什么（派子代理、起监视、有进展记进度、别空转），以及怎么合法地放行。
 * @param {State} state
 * @param {number} now
 * @param {number} [streak] 这是连着第几次挡
 */
export function blockReason(state, now, streak = 1) {
  const left = Math.max(0, Math.round((Date.parse(state.expiresAt) - now) / 60_000));
  const watching =
    '现在没有在跑的子代理、后台命令、监视（有的话这一轮可以直接结束，它们的完成通知会叫醒你，不用轮询、不用 sleep 等）。队列里还有活就用 Agent 子代理派（三个角色，决定 0087：写代码的 subagent_type: "general-purpose"，能脚本核对的只读活先给 subagent_type: "Explore"，方案和疑难给 subagent_type: "Plan"，不传 model），派出去就可以结束这一轮；要盯法国就起 Monitor 跑 node ~/.claude/skills/commander/scripts/patrol.mjs（只在报 ALERT 且 DELTA 不为 0 时出一行），报了再叫一个短命的 Explore 子代理摘证据；子代理都收口、队列空了才跑 done 收尾。';
  return (
    `无人值守开着（还剩约 ${left} 分钟，什么都没在跑时连着第 ${streak} 次挡，到 ${MAX_STREAK} 次放行）：不要空着结束这一轮。${watching}` +
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
 * pending：Stop 输入里还有什么在跑（pendingOf）；有就放行，它们收口会把会话叫回来。不给按判不出算。
 * 不抛：任何一步出错都放行并写明。
 * @param {{ dir: string, sessionId: unknown, now?: number, pending?: Pending }} opts
 * @returns {{ block: true, reason: string } | { block: false, notice?: string }}
 */
export function decideStop({ dir, sessionId, now = Date.now(), pending = { tasks: null, crons: null } }) {
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
    const streak = Number.isInteger(s.streak) ? Number(s.streak) : 0;
    // 还有东西在跑：它们收口时的完成通知会把会话叫回来，这一轮结束不丢活；挡回去只会让它 sleep、轮询，多一轮重读上下文
    if ((pending.tasks ?? 0) > 0 || (pending.crons ?? 0) > 0) {
      if (streak !== 0) writeState(dir, sessionId, { ...s, streak: 0 });
      return { block: false };
    }
    if (s.totalBlocks >= MAX_TOTAL_BLOCKS) {
      const why = `已经挡了 ${MAX_TOTAL_BLOCKS} 次，到上限`;
      writeState(dir, sessionId, { ...s, state: 'paused', note: why });
      return {
        block: false,
        notice: `无人值守自动暂停：${why}。有话要创始人定就放最后一条；要接着干请重新跑 node ${SCRIPT} on。`,
      };
    }
    // 什么都没在跑，又已经连着挡了 MAX_STREAK 次：挡回去它也没起任何东西，放行一次、记一笔，状态仍开着
    if (streak >= MAX_STREAK) {
      const released = (Number.isInteger(s.streakReleases) ? Number(s.streakReleases) : 0) + 1;
      writeState(dir, sessionId, {
        ...s,
        streak: 0,
        streakReleases: released,
        lastStreakReleaseAt: new Date(now).toISOString(),
      });
      return {
        block: false,
        notice: `无人值守：什么都没在跑、连着挡了 ${MAX_STREAK} 次也没起子代理、后台命令或监视，这一轮放行（第 ${released} 次，记在状态文件）；无人值守仍开着，有通知或创始人说话再接上。`,
      };
    }
    writeState(dir, sessionId, {
      ...s,
      streak: streak + 1,
      totalBlocks: s.totalBlocks + 1,
      lastBlockAt: new Date(now).toISOString(),
    });
    return { block: true, reason: blockReason(s, now, streak + 1) };
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
          `无人值守：${s.state}，到 ${fmt(s.expiresAt)}，已挡 ${s.totalBlocks} 次（眼下连着挡了 ${s.streak ?? 0} 次，连着挡到上限放行过 ${s.streakReleases ?? 0} 次）${s.note ? `，${s.note}` : ''}`,
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
      writeState(dir, id, {
        state: 'on',
        since: new Date(now).toISOString(),
        expiresAt,
        totalBlocks: 0,
        streak: 0,
        note: '',
      });
      io.out(
        `无人值守已开，到 ${fmt(expiresAt)}。活交给 Agent 子代理（写代码的 subagent_type: "general-purpose"，不设固定个数：派新工人前看空闲内存和 CPU（空闲内存 < 4G 或 1 分钟负载 > 核数×0.8 就先等一个收口），同时在跑的工人不改同一批文件（撞了就排队或交给同一个工人连着做），监控不占名额，见决定 0094；三个角色见决定 0087），不脱离会话；有子代理、后台命令、监视在跑时这一轮可以结束，完成通知会叫醒你；什么都没在跑时想结束会被挡回来（连着 ${MAX_STREAK} 次放行）；做完 done、要他拍板 needs-you、他说停就 off。`,
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
