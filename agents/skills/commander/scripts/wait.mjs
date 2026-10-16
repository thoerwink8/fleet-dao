// 指挥官等一件事到终态（单 #2730）：node wait.mjs pr <号> | main-ci | issue <号> [--interval <秒>] [-R <owner/repo>]
// 主线程不再手写「循环 + sleep」盯梢（旧会话 709bd85a：46 个手写轮询，44 个带 2>/dev/null，最后一个 jq 写错、错误进了
// /dev/null，空跑 90 分钟）。这里只认 gh 的 --json 输出、自己 JSON.parse，不经 jq、不吞 stderr：
// gh 起不来、退出码非 0、输出不是认得出的 JSON，当场以退出码 2 退出，stderr 写明哪条命令、为什么。
// 到终态才往 stdout 写一行并退出：绿（合并、CI 成功、单关了）退出码 0；红（PR 有检查失败或被关掉没合、CI 不是成功）退出码 1。
// 用法错了退出码 2。中途什么都不打，挂成后台命令只在结束时叫醒一次。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 主线 CI 的工作流文件名（.github/workflows/ci.yml，push 到 main 时跑） */
export const MAIN_CI_WORKFLOW = 'ci.yml';
/** 默认多久问一次 gh（秒）：远端接口不宜更勤 */
export const DEFAULT_INTERVAL_S = 60;

export const USAGE = `用法：node wait.mjs pr <号> [--interval <秒>] [-R <owner/repo>]   等 PR 合并（0）、被关或有检查红（1）
      node wait.mjs main-ci [--interval <秒>] [-R <owner/repo>]     等现在 main 头上那个提交的 ${MAIN_CI_WORKFLOW} 跑完：成功 0、别的 1
      node wait.mjs issue <号> [--interval <秒>] [-R <owner/repo>]  等单关掉（0）
到终态才写一行并退出；gh 出错、输出认不出当场退出码 2，不重试、不吞错。默认每 ${DEFAULT_INTERVAL_S} 秒问一次。`;

/** @typedef {(args: string[]) => string} Gh 跑一条 gh，返回 stdout；出错就抛（带上原因） */
/** @typedef {{ done: false } | { done: true, ok: boolean, line: string }} Step 问一次的结论：还没到终态，或到了（绿/红 + 那一行） */
/** @typedef {{ gh: Gh, sleep: (ms: number) => Promise<void>, out: (line: string) => void, err: (line: string) => void }} Io */

/** 一条 gh 命令出错：命令行写进消息里，方便一眼看出是哪条 */
export class WaitError extends Error {}

/**
 * 真的 gh：退出码非 0、起不来都抛，stderr 原样带上。
 * @type {Gh}
 */
export function realGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const cmd = `gh ${args.join(' ')}`;
  if (r.error) throw new WaitError(`${cmd} 没跑起来：${r.error.message}`);
  if (r.status !== 0) {
    throw new WaitError(
      `${cmd} 退出码 ${r.status ?? `信号 ${r.signal}`}：${(r.stderr || r.stdout || '').trim() || '（没有输出）'}`,
    );
  }
  return r.stdout;
}

/**
 * gh 的输出按 JSON 读；读不成就抛，不当成空。
 * @param {string} text
 * @param {string} what
 * @returns {unknown}
 */
function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new WaitError(
      `${what} 的输出不是 JSON（${e instanceof Error ? e.message : String(e)}）：${text.slice(0, 200)}`,
    );
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 取字符串字段，没有或不是字符串就抛（认不出的输出不猜）。
 * @param {Record<string, unknown>} o
 * @param {string} k
 * @param {string} what
 */
function str(o, k, what) {
  const v = o[k];
  if (typeof v !== 'string') throw new WaitError(`${what} 的输出里 ${k} 不是字符串（${JSON.stringify(v)}）`);
  return v;
}

/** CheckRun 的这几种结论算红 */
const RED_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
/** StatusContext 的这几种状态算红 */
const RED_STATES = new Set(['FAILURE', 'ERROR']);

/**
 * PR 问一次：合并了 → 绿；关了没合 → 红；有检查红 → 红；别的接着等。
 * @param {Gh} gh
 * @param {number} n
 * @param {string[]} repo
 * @returns {Step}
 */
export function stepPr(gh, n, repo) {
  const what = `gh pr view ${n}`;
  const o = parseJson(gh(['pr', 'view', String(n), ...repo, '--json', 'state,url,statusCheckRollup']), what);
  if (!isObj(o)) throw new WaitError(`${what} 的输出不是一个对象`);
  const state = str(o, 'state', what);
  const url = str(o, 'url', what);
  if (state === 'MERGED') return { done: true, ok: true, line: `PR #${n} 合并了 ${url}` };
  if (state === 'CLOSED') return { done: true, ok: false, line: `PR #${n} 被关掉、没合并 ${url}` };
  if (state !== 'OPEN') throw new WaitError(`${what} 的 state 认不出：${state}`);
  const checks = o.statusCheckRollup ?? [];
  if (!Array.isArray(checks)) throw new WaitError(`${what} 的 statusCheckRollup 不是数组`);
  /** @type {string[]} */
  const red = [];
  for (const c of checks) {
    if (!isObj(c)) throw new WaitError(`${what} 的 statusCheckRollup 里有一项不是对象`);
    const conclusion = typeof c.conclusion === 'string' ? c.conclusion.toUpperCase() : '';
    const st = typeof c.state === 'string' ? c.state.toUpperCase() : '';
    if (RED_CONCLUSIONS.has(conclusion) || RED_STATES.has(st)) {
      red.push(String(c.name ?? c.context ?? '（没名字的检查）'));
    }
  }
  if (red.length > 0) return { done: true, ok: false, line: `PR #${n} 检查红了：${red.join('、')} ${url}` };
  return { done: false };
}

/**
 * 主线 CI 问一次：sha 是开始时 main 头上的提交，等它的 ci.yml 跑完。还没起跑接着等。
 * @param {Gh} gh
 * @param {string} sha
 * @param {string[]} repo
 * @returns {Step}
 */
export function stepMainCi(gh, sha, repo) {
  const what = `gh run list --commit ${sha.slice(0, 7)}`;
  const runs = parseJson(
    gh([
      'run',
      'list',
      ...repo,
      '--workflow',
      MAIN_CI_WORKFLOW,
      '--branch',
      'main',
      '--commit',
      sha,
      '--limit',
      '1',
      '--json',
      'databaseId,status,conclusion,url',
    ]),
    what,
  );
  if (!Array.isArray(runs)) throw new WaitError(`${what} 的输出不是数组`);
  const run = runs[0];
  if (run === undefined) return { done: false };
  if (!isObj(run)) throw new WaitError(`${what} 的输出里有一项不是对象`);
  const status = str(run, 'status', what);
  if (status !== 'completed') return { done: false };
  const conclusion = str(run, 'conclusion', what);
  const url = str(run, 'url', what);
  const ok = conclusion === 'success';
  return {
    done: true,
    ok,
    line: `main ${sha.slice(0, 7)} 的 CI ${ok ? '绿了' : `没过（${conclusion}）`} ${url}`,
  };
}

/**
 * main 现在头上的提交。
 * @param {Gh} gh
 * @param {string[]} repo
 */
export function mainHead(gh, repo) {
  const path = repo.length > 0 ? `repos/${repo[1]}/commits/main` : 'repos/{owner}/{repo}/commits/main';
  const o = parseJson(gh(['api', path]), `gh api ${path}`);
  if (!isObj(o)) throw new WaitError(`gh api ${path} 的输出不是一个对象`);
  const sha = str(o, 'sha', `gh api ${path}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new WaitError(`gh api ${path} 的 sha 认不出：${sha}`);
  return sha;
}

/**
 * 单问一次：关了 → 绿（附上 stateReason）；开着接着等。
 * @param {Gh} gh
 * @param {number} n
 * @param {string[]} repo
 * @returns {Step}
 */
export function stepIssue(gh, n, repo) {
  const what = `gh issue view ${n}`;
  const o = parseJson(gh(['issue', 'view', String(n), ...repo, '--json', 'state,stateReason,url']), what);
  if (!isObj(o)) throw new WaitError(`${what} 的输出不是一个对象`);
  const state = str(o, 'state', what);
  if (state === 'OPEN') return { done: false };
  if (state !== 'CLOSED') throw new WaitError(`${what} 的 state 认不出：${state}`);
  const reason = typeof o.stateReason === 'string' && o.stateReason !== '' ? `（${o.stateReason}）` : '';
  return { done: true, ok: true, line: `单 #${n} 关了${reason} ${str(o, 'url', what)}` };
}

/**
 * 读命令行；用法错就返回一句原因。
 * @param {string[]} argv
 * @returns {{ kind: 'pr' | 'issue', n: number, intervalMs: number, repo: string[] } | { kind: 'main-ci', intervalMs: number, repo: string[] } | { usage: string }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const pos = [];
  let interval = DEFAULT_INTERVAL_S;
  /** @type {string[]} */
  let repo = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--interval') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { usage: '--interval 后面要跟一个正数（秒）' };
      interval = v;
    } else if (a === '-R' || a === '--repo') {
      const v = argv[++i];
      if (!v || !/^[\w.-]+\/[\w.-]+$/.test(v)) return { usage: `${a} 后面要跟 owner/repo` };
      repo = ['-R', v];
    } else if (a.startsWith('-')) {
      return { usage: `认不出的参数 ${a}` };
    } else {
      pos.push(a);
    }
  }
  const intervalMs = interval * 1000;
  const [kind, num, ...extra] = pos;
  if (extra.length > 0) return { usage: `多出来的参数：${extra.join(' ')}` };
  if (kind === 'main-ci') {
    if (num !== undefined) return { usage: 'main-ci 后面不跟号' };
    return { kind, intervalMs, repo };
  }
  if (kind === 'pr' || kind === 'issue') {
    const n = Number(num);
    if (!num || !Number.isInteger(n) || n <= 0) return { usage: `${kind} 后面要跟号` };
    return { kind, n, intervalMs, repo };
  }
  return { usage: kind === undefined ? '要说等什么' : `认不出的种类 ${kind}` };
}

/**
 * 等到终态。返回退出码：0 绿、1 红、2 用法错或 gh 出错。
 * @param {string[]} argv
 * @param {Io} io
 * @returns {Promise<number>}
 */
export async function run(argv, io) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  const p = parseArgs(argv);
  if ('usage' in p) {
    io.err(`wait.mjs：${p.usage}\n${USAGE}`);
    return 2;
  }
  try {
    /** @type {() => Step} */
    let step;
    if (p.kind === 'main-ci') {
      const sha = mainHead(io.gh, p.repo);
      step = () => stepMainCi(io.gh, sha, p.repo);
    } else if (p.kind === 'pr') {
      step = () => stepPr(io.gh, p.n, p.repo);
    } else {
      step = () => stepIssue(io.gh, p.n, p.repo);
    }
    for (;;) {
      const s = step();
      if (s.done) {
        io.out(s.line);
        return s.ok ? 0 : 1;
      }
      await io.sleep(p.intervalMs);
    }
  } catch (e) {
    io.err(`wait.mjs 出错，当场退出：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  // 用 exitCode 不用 process.exit：输出接到管道上时，exit 可能把没写完的截掉
  process.exitCode = await run(process.argv.slice(2), {
    gh: realGh,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
