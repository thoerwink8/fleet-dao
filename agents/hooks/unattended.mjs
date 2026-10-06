// 无人值守不再靠「挡住收尾」续命（决定 0026，创始人 2026-10-06 17:25「按照你推荐」）。
// 2026-10-03「选 a」是让这一轮一直不结束。实测挡回去会把「先别结束这一轮」塞进对话，普通会话被按住几小时；
// 引导（Mirasim 的 steer）要等下一次调模型才塞进来，这一轮不结束，下一轮开头的对账补投也不发生。
// 一直干改走脱离会话的工人（worker.mjs --detached）。收尾钩子只提醒仓根临时文件，decision 一律不写。
//
// 用法：
//   node ~/.fleet-dao/hooks/unattended.mjs on
//     不再写状态、不再挡收尾。打印一句：要一直干就起工人。
//   node ~/.fleet-dao/hooks/unattended.mjs off|status|done|needs-you
//     还认旧的状态文件（清掉、查看）。done / needs-you 不再是「放行收尾」的开关。
//
// 决定 0027：空壳函数和欠账账本删了。旧的状态文件留着也不拦收尾。钩子里任何一步出错一律放行，绝不抛、不拦。
// 规矩由 agents/test/rules/stop.rules.test.ts 钉住。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if (s === null || now > Date.parse(s.expiresAt)) return [];
  if (s.state === 'paused' && s.note) return [`无人值守暂停过（${s.note}）。这一轮可以结束。`];
  return [];
}

const USAGE = `用法：node ${SCRIPT} on | done "做完了什么" | needs-you "要他拍什么" | off | status`;

/**
 * 命令行；返回退出码。io = { out, err, env, now }。
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {number}
 */
export function main(argv, io) {
  const env = io.env ?? process.env;
  const dir = stateDir(env);
  const [cmd, ...rest] = argv;
  const id = cleanId(env.CLAUDE_CODE_SESSION_ID);
  if (!['on', 'done', 'needs-you', 'off', 'status'].includes(cmd ?? '')) {
    io.err(`没做成：${cmd ? `不认识的命令 ${cmd}` : '没给命令'}。${USAGE}`);
    return 2;
  }
  if (cmd === 'on') {
    io.out(
      '不再挡住这一轮（决定 0026）。要一直干，起脱离会话的工人：worker.mjs start --detached "创始人说了进入无人值守"。这一轮可以结束。',
    );
    return 0;
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
    // done / needs-you：旧状态文件还在时可以改成收尾或暂停。必须写一句话。
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
