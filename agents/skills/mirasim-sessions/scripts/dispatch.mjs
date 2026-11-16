// mirasim-sessions 派活：只调一次 prompt，拿到会话号就立刻改名。
// 拿不到会话号就退出码 1、不再调 prompt（重调会再派一个会话）。参数不对是退出码 2。
// 版本读 ~/.mirasim/app/state.json 里 good 的那一版，不写死版本号；用户目录用 USERPROFILE / HOME / os.homedir()。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const USAGE = `用法：node dispatch.mjs --title <侧栏名> --workdir <目录> --prompt <交代> [--agent <名>] [--model <名>] [--effort <档>] [--route local|cloud] [--port <端口>] [--report-to <会话key>]
派活并立刻改名，只调一次 prompt。交代末尾自动加上回报去向。找不到指挥会话退出码 2、一次都不派；拿不到会话号退出码 1、不重派；参数不对退出码 2。
没给 --port 时用环境变量 MIRASIM_HOST_PORT；两个都没有就不带端口（会话里 mirasim 自己认宿主）。
没给 --report-to 时，在本机 claude 会话目录里找正在跑、工作目录以 fleet-dao 结尾、标题不是无人值守心跳的会话，用最近更新的那一个。`;

/** 和本脚本放在一起的回报脚本，换机器不写死盘符。 */
export const REPORT_SCRIPT = fileURLToPath(new URL('./report.mjs', import.meta.url));

export const REQUIRED = ['title', 'workdir', 'prompt'];

export class Stop extends Error {
  /**
   * @param {string} step
   * @param {string} next
   * @param {number} [code]
   */
  constructor(step, next, code = 1) {
    super(next);
    this.name = 'Stop';
    this.step = step;
    this.next = next;
    this.code = code;
  }
}

/** @typedef {{ code: number, stdout: string, stderr: string }} ExecResult */
/** @typedef {(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv, timeout?: number }) => ExecResult} Exec */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 * @returns {ExecResult}
 */
export function realExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    env: opts.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const err = r.error ? r.error.message : '';
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${err}`,
  };
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const got = {};
  const known = ['title', 'workdir', 'prompt', 'agent', 'model', 'effort', 'route', 'port', 'report-to'];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (!token.startsWith('--')) throw new Stop('参数', `不认识的参数 ${token}\n${USAGE}`, 2);
    const key = token.slice(2);
    if (!known.includes(key)) throw new Stop('参数', `不认识的参数 ${token}\n${USAGE}`, 2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Stop('参数', `${token} 缺值\n${USAGE}`, 2);
    if (got[key] !== undefined) throw new Stop('参数', `${token} 写了两次\n${USAGE}`, 2);
    got[key] = value;
    i += 1;
  }
  for (const key of REQUIRED) {
    if (!got[key]) throw new Stop('参数', `缺 --${key}\n${USAGE}`, 2);
  }
  if (got.route !== undefined && got.route !== 'local' && got.route !== 'cloud') {
    throw new Stop('参数', `--route 只认 local 或 cloud\n${USAGE}`, 2);
  }
  return got;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} server.cjs 的绝对路径
 */
export function mirasimServer(env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  const statePath = join(home, '.mirasim', 'app', 'state.json');
  let version = '';
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    version = typeof parsed.good === 'string' ? parsed.good : '';
  } catch (err) {
    const code = err && typeof err === 'object' && 'message' in err ? String(err.message) : '读不了';
    throw new Stop('派活', `读不了 ${statePath}（${code}），不知道调哪一版 mirasim`);
  }
  if (!version) throw new Stop('派活', `${statePath} 里没有 good 版本`);
  const server = join(home, '.mirasim', 'app', version, 'server.cjs');
  if (!existsSync(server)) throw new Stop('派活', `没有 ${server}`);
  return server;
}

/**
 * @param {unknown} parsed
 * @returns {Array<Record<string, unknown>>}
 */
export function framesOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const record = /** @type {Record<string, unknown>} */ (parsed);
  if (Array.isArray(record.frames)) return record.frames.filter((f) => f && typeof f === 'object');
  return [record];
}

/**
 * @param {Array<Record<string, unknown>>} frames
 * @returns {Array<Record<string, unknown>>}
 */
export function sessionsIn(frames) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const frame of frames) {
    const list = frame.sessions;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === 'object') out.push(/** @type {Record<string, unknown>} */ (item));
    }
  }
  return out;
}

/**
 * prompt 回来的帧里找刚开的那一个：同 agent、同 workdir，createdAt 最新。找不到回 null，不猜。
 * @param {unknown} parsed
 * @param {{ agent: string, workdir: string }} want
 * @returns {string | null}
 */
export function pickSessionKey(parsed, want) {
  const accepted = acceptedKey(parsed);
  if (accepted) return accepted;
  const matched = sessionsIn(framesOf(parsed)).filter((item) => {
    return item.agent === want.agent && item.workdir === want.workdir && typeof item.sessionKey === 'string';
  });
  matched.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  const key = matched[0]?.sessionKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * 接受帧上的会话号优先：prompt 当场认下的就是刚开的那一个。
 * @param {unknown} parsed
 * @returns {string | null}
 */
export function acceptedKey(parsed) {
  for (const frame of framesOf(parsed)) {
    if (frame.type === 'accepted' && typeof frame.sessionKey === 'string' && frame.sessionKey.length > 0) {
      return frame.sessionKey;
    }
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is { runState?: unknown, title?: unknown, workdir?: unknown, sessionId?: unknown, updatedAt?: unknown }}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object';
}

/**
 * 指挥会话：正在跑、工作目录以 fleet-dao 结尾、标题不是无人值守心跳。多个时取 updatedAt 最大的。
 * @param {unknown[]} records
 * @returns {string | null}
 */
export function findCommander(records) {
  const matched = records.filter(isRecord).filter((item) => {
    const title = typeof item.title === 'string' ? item.title : '';
    const workdir = typeof item.workdir === 'string' ? item.workdir.replace(/[\\/]+$/, '') : '';
    return (
      item.runState === 'running' &&
      !title.startsWith('无人值守心跳') &&
      /fleet-dao$/i.test(workdir) &&
      typeof item.sessionId === 'string' &&
      item.sessionId.length > 0
    );
  });
  matched.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const id = matched[0]?.sessionId;
  return typeof id === 'string' ? `claude:${id}` : null;
}

/**
 * 读本机 claude 会话目录。目录不在就当没有。
 * @param {NodeJS.ProcessEnv} env
 * @returns {unknown[]}
 */
export function readCommanderRecords(env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  const root = join(home, '.mirasim', 'sessions', 'claude');
  let names = [];
  try {
    names = readdirSync(root);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return [];
    throw new Stop('派活', `读不了 ${root}，加 --report-to 再派`);
  }
  /** @type {unknown[]} */
  const out = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(readFileSync(join(root, name, 'record.json'), 'utf8')));
    } catch {
      // 单个会话读不了就跳过
    }
  }
  return out;
}

/**
 * @param {string} reportTo
 * @param {string} [reportScript]
 * @returns {string}
 */
export function reportFooter(reportTo, reportScript = REPORT_SCRIPT) {
  return (
    `\n\n【回报，必做】做完、或卡在只有人能拍的事上，在同一轮里发回报，发完才算做完：` +
    `把回报正文写进一个文件，再运行 node ${reportScript} --to ${reportTo} --title "<活名>" --file <正文文件>，` +
    `看到输出 ok 才行，失败就重试并把失败原因写进最后一条消息。` +
    `正文写：做到哪、PR 号、头提交、git ls-remote 和 gh pr view 的输出、验证命令和真实结果、没做的和原因、要人拍的。` +
    `不许写「CI 绿了再回报」然后收轮；命令超过约 60 秒会被钩子自动转后台：测试按单个文件分开跑，每条命令尽量 60 秒内；同一条查看命令（比如反复 tail 同一个日志）最多连发 2 次，之后必须换做法，连续 8 次相同调用会被系统停掉整轮，停了就既不提交也不回报；不许丢到后台再收轮。`
  );
}

/**
 * @param {Exec} exec
 * @param {string} nodePath
 * @param {string} server
 * @param {string | undefined} port
 * @param {string} atom
 * @param {Record<string, unknown>} args
 * @param {NodeJS.ProcessEnv} env
 */
export function callAtom(exec, nodePath, server, port, atom, args, env) {
  /** @type {string[]} */
  const argv = [server, 'ui-cli'];
  if (port) argv.push('--port', port);
  argv.push('call', atom, '--args', JSON.stringify(args));
  const result = exec(nodePath, argv, { env, timeout: 120_000 });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '没有输出').trim().slice(0, 400);
    throw new Stop('派活', `${atom} 没成（退出码 ${result.code}）：${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Stop('派活', `${atom} 的输出不是 JSON`);
  }
}

/**
 * @param {string[]} argv
 * @param {{
 *   exec?: Exec,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (line: string) => void,
 *   server?: string,
 *   nodePath?: string,
 *   now?: number,
 *   records?: unknown[],
 * }} [io]
 * @returns {number}
 */
export function dispatchRun(argv, io = {}) {
  const exec = io.exec ?? realExec;
  const env = io.env ?? process.env;
  const log = io.log ?? ((line) => console.log(line));
  const err = (line) => console.error(line);
  try {
    const opt = parseArgs(argv);
    // 干活的会话一律是 omp：mirasim 里的 agent 名是 kimi（启动方式经 ACP 到 omp）。
    // 原版 pi 的配置和技能目录不归我们的规范管，不用它干活。
    const agent = opt.agent || 'kimi';
    if (agent === 'pi') {
      throw new Stop('参数', '干活的会话必须用 omp（--agent kimi，默认值），不用原版 pi', 2);
    }
    // omp 的模型由它自己的配置（~/.omp/agent/config.yml 的角色）定，不经 ACP 的 set_model：
    // 给 kimi 传 model 会报 Unknown ACP ext method: session/set_model（2026-11-16 实测），所以不传。
    const reportTo = opt['report-to'] || findCommander(io.records ?? readCommanderRecords(env));
    if (!reportTo) {
      throw new Stop('派活', '找不到指挥会话，加 --report-to <会话key>；这次不派，免得做完没处回报', 2);
    }
    const server = io.server ?? mirasimServer(env);
    const nodePath = io.nodePath ?? process.execPath;
    const port = opt.port || (env.MIRASIM_HOST_PORT ? String(env.MIRASIM_HOST_PORT) : '');
    /** @type {Record<string, unknown>} */
    const promptArgs = {
      clientRef: `d-${io.now ?? Date.now()}`,
      agent,
      workdir: opt.workdir,
      prompt: `${opt.prompt}${reportFooter(reportTo)}`,
    };
    if (opt.model) promptArgs.model = opt.model;
    if (opt.effort) promptArgs.effort = opt.effort;
    if (opt.route) promptArgs.route = opt.route;
    const created = callAtom(exec, nodePath, server, port, 'prompt', promptArgs, env);
    const sessionKey = pickSessionKey(created, { agent, workdir: opt.workdir });
    if (!sessionKey) {
      const brief = JSON.stringify(created).slice(0, 400);
      throw new Stop('派活', `没拿到会话号，不要重派，先查 prompt 的返回：${brief}`);
    }
    callAtom(exec, nodePath, server, port, 'renameSession', { sessionKey, title: opt.title }, env);
    log(`已派并改名：${sessionKey} ${opt.title}`);
    return 0;
  } catch (error) {
    if (error instanceof Stop) {
      err(`停在：${error.step}`);
      err(`下一步：${error.next}`);
      return error.code;
    }
    err(`停在：脚本`);
    err(`下一步：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exit(dispatchRun(process.argv.slice(2)));
}
