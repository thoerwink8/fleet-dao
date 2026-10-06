// 无人值守：活由脱离会话的工人干（决定 0026），这个会话自己「不结束这一轮」、留着盯工人、收创始人的引导、汇报
// （决定 0028，创始人 2026-10-07 约 02:27 推翻 0026 里「起完工人这一轮结束、收尾不拦」：「无人值守模式，会话不应该轮次中断」）。
// 三处用它：命令行（AI 按创始人的话开关）、Stop 钩子（stop.mjs：开着就把「结束这一轮」挡回去）、PreToolUse 钩子
// （pretool.mjs：调了工具就记一笔「在干活」）。开会话钩子也读它，上下文被总结、会话重启之后还知道开着。
//
// 用法（AI 在创始人说「进入无人值守」「过夜」「我在睡觉」时跑 on，说「停」「退出无人值守」时跑 off）：
//   node ~/.fleet-dao/hooks/unattended.mjs on [--hours 12]      开（最长 12 小时，默认 12）；只在这个会话自己跑了 on 才挡
//   node ~/.fleet-dao/hooks/unattended.mjs done "做完了什么"    全做完（工人都收口、队列空了）：放行收尾
//   node ~/.fleet-dao/hooks/unattended.mjs needs-you "要他拍什么"  碰人闸：放行收尾，把问题放最后一条等他
//   node ~/.fleet-dao/hooks/unattended.mjs off                  关
//   node ~/.fleet-dao/hooks/unattended.mjs status
//
// 改这里之前必须知道（规矩由 agents/test/rules/stop.rules.test.ts 钉住）：
// - 只有这个会话自己跑了 on 才挡：状态按会话号存（~/.fleet-dao/unattended/<会话号>.json，会话号来自环境变量 CLAUDE_CODE_SESSION_ID，
//   Stop、PreToolUse 的输入里同一个号），别的会话、别的机器、工人和反方（机器派的会话，on 直接拒）都不受影响。
//   起子代理、监视、后台命令不自动开（决定 0026 第 2 条保留，不要把「起后台活自动开」加回来）。会话号拿不到，on 明确失败。
// - 放行的几种：off；done / needs-you；开着满 12 小时；空转（挡回去之后连着多次一个工具都没调：还有工人在跑给
//   MAX_IDLE_BLOCKS 次，没有在跑的工人给 MAX_IDLE_BLOCKS_NO_WORKER 次，防死循环）；总次数上限；状态读不了 / 写不了
//   （放行是为了不把人困住，但要说清楚是故障，不是正常收尾）。这几个数不要凭感觉改大——改大等于允许多烧额度。
// - 钩子里任何一步出错一律放行（只提示），绝不抛、不拦：这里是兜底，不是新的故障点。
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

export const DEFAULT_HOURS = 12;
/** 开着最长这么久，到点自动放行（创始人 2026-10-07：开着超过 12 小时放行）。 */
export const MAX_HOURS = 12;
/** 还有工人在跑时，被挡回去后连着这么多次没调过工具，才放行（创始人 2026-10-07「比如连续 20 次」）。 */
export const MAX_IDLE_BLOCKS = 20;
/** 一个在跑的工人都没有时，连着这么多次没调过工具就放行：没有什么可盯的了，别空转。 */
export const MAX_IDLE_BLOCKS_NO_WORKER = 3;
/** 一次无人值守最多挡这么多次，防别的原因造成的无限循环。 */
export const MAX_TOTAL_BLOCKS = 200;

const SCRIPT = '~/.fleet-dao/hooks/unattended.mjs';

/**
 * 工人状态目录（相对家目录）。commander 技能的 worker-lib.mjs 另有一份（钩子和技能装在两个目录，互相 import 不了），
 * agents/test/hooks-shared.test.ts 钉着两边相等。
 */
export const WORKERS_REL = join('.fleet-dao', 'workers');

/** 这个 pid 的进程还在不在；判不出来（没权限看）当还在，不把它报成死了。 */
export function pidAlive(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EPERM';
  }
}

/**
 * 本机还在跑的脱离会话的工人有几个（~/.fleet-dao/workers/<名字>/meta.json 的 pid 还活着、没 clean 过）。
 * 记录读不了、起的时候没记上 pid（不知道在不在跑）都当在跑：宁可多给空转次数，也不把还在干活的会话放掉。
 * 工人目录没有 = 没起过工人 = 0。不抛。
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, alive?: (pid: number) => boolean }} [opts]
 * @returns {number}
 */
export function runningWorkers({ env = process.env, home = homedir(), alive = pidAlive } = {}) {
  const o = env.FLEET_WORKERS_DIR;
  const root = typeof o === 'string' && o ? o : join(home, WORKERS_REL);
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    try {
      /** @type {unknown} */
      const m = JSON.parse(readFileSync(join(root, name, 'meta.json'), 'utf8'));
      if (typeof m !== 'object' || m === null) {
        n += 1;
      } else if ('cleanedAt' in m && m.cleanedAt) {
        // clean 过的不算
      } else if (!('pid' in m) || !Number.isInteger(m.pid)) n += 1;
      else if (alive(/** @type {number} */ (m.pid))) n += 1;
    } catch (err) {
      if (errCode(err) !== 'ENOENT') n += 1;
    }
  }
  return n;
}

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
      `无人值守开着（到 ${fmt(s.expiresAt)}）：这一轮不要结束。继续盯工人（worker.mjs watch --wait 55），有进展就 pnpm progress:note 记一句；全做完 node ${SCRIPT} done "做完了什么"，要创始人拍板 needs-you，他说停 off。`,
    ];
  if (s.state === 'paused' && s.note) return [`无人值守暂停着（${s.note}）。这一轮可以结束。`];
  return [];
}

/**
 * 挡回去时给模型看的话：具体要它干什么（继续盯工人、有进展记进度、别空转），以及怎么合法地放行。
 * @param {State} state
 * @param {number} now
 * @param {number | null} running 本机还在跑的工人数；null = 没数成
 */
export function blockReason(state, now, running) {
  const left = Math.max(0, Math.round((Date.parse(state.expiresAt) - now) / 60_000));
  const watching =
    running === 0
      ? '现在没有在跑的工人：队列里还有活就起工人（worker.mjs start --detached），没有了就跑 done 收尾。'
      : '继续盯工人：node ~/.claude/skills/commander/scripts/worker.mjs watch --wait 55（单次前台等待不超过 60 秒；法国那边的活用 france.mjs）。';
  return (
    `无人值守开着（还剩约 ${left} 分钟，在跑的工人 ${running ?? '没数成'} 个）：不要结束这一轮。${watching}` +
    `每次工人有进展（PR 开了、做完、卡住）就 pnpm progress:note 记一句、给创始人一行汇报，再接着盯；没有新结果就不写话、别空转、别重复上一句。` +
    `全做完（工人都收口、队列空了）：node ${SCRIPT} done "做完了什么"；碰到要创始人拍的（对外发布、花钱、删数据、改标准）：` +
    `node ${SCRIPT} needs-you "要他拍什么"，再把问题放在最后一条；创始人说停：node ${SCRIPT} off。`
  );
}

/**
 * Stop 钩子要不要挡。返回 { block: true, reason } 或 { block: false, notice? }（notice 给 systemMessage，只在要说话时有）。
 * 不抛：任何一步出错都放行并写明。running = 本机还在跑的工人数（调用方用 runningWorkers 数好传进来；null = 没数成，按有工人算）。
 * @param {{ dir: string, sessionId: unknown, now?: number, running?: number | null }} opts
 * @returns {{ block: true, reason: string } | { block: false, notice?: string }}
 */
export function decideStop({ dir, sessionId, now = Date.now(), running = null }) {
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
    // auto：旧版「起后台活自动开」留下的状态文件，决定 0026 起不认（只有这个会话自己跑 on 才挡）
    if (s === null || s.state !== 'on' || s.auto === true) return { block: false };
    if (now > Date.parse(s.expiresAt)) {
      removeState(dir, sessionId);
      return {
        block: false,
        notice: `无人值守过期了（到 ${fmt(s.expiresAt)}，最长 ${MAX_HOURS} 小时），已关。`,
      };
    }
    // 上一次挡过之后，到这一次之间没调过任何工具：没干活，只回了文字
    const idle = s.totalBlocks > 0 && !s.toolSinceBlock ? s.idle + 1 : 0;
    const idleCap = running === 0 ? MAX_IDLE_BLOCKS_NO_WORKER : MAX_IDLE_BLOCKS;
    if (idle >= idleCap || s.totalBlocks >= MAX_TOTAL_BLOCKS) {
      const why =
        idle >= idleCap
          ? `被挡回去 ${idleCap} 次都没再干活（没调工具${running === 0 ? '，也没有在跑的工人' : ''}）`
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
    return { block: true, reason: blockReason(s, now, running) };
  } catch (err) {
    return {
      block: false,
      notice: `无人值守的判断自己出错了（${messageOf(err) ?? err}）：这一轮不拦（不能把人困住）。`,
    };
  }
}

/**
 * PreToolUse 调用：开着就记一笔「调了工具」（Stop 钩子靠它判有没有在干活）。只在需要改的时候才写；任何错误都吞掉。
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
        idle: 0,
        totalBlocks: 0,
        toolSinceBlock: true,
        note: '',
      });
      io.out(
        `无人值守已开，到 ${fmt(expiresAt)}。活交给脱离会话的工人（worker.mjs start --detached "创始人说了进入无人值守"），这个会话留着盯：worker.mjs watch --wait 55，这一轮想结束会被挡回来；做完 done、要他拍板 needs-you、他说停就 off。`,
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
