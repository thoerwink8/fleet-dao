// 扫尾：非 running 的会话按工作树和 PR 判类。默认只列。
// 同时列 --repo（默认当前目录所在仓）里没有会话认领的工作树，判类同一套，不另写一条命令。
// --apply 才收「可收」和「孤儿」。收的动作是 close.mjs（closeRun / deleteSession），这里不另写删工作树。
// 会话工作目录是 record.json 的 workdir。会话目录里的 workspace 只是会话自己的文件夹，不算工作树还在。
// 工作目录存在、但 git 说不是仓库（家目录、Documents、工具自己的运行目录）不是工作树残留，close 也收不了，跳过。
// 不按 --repo 把别的仓的链接工作树滤掉。git 因权限等原因失败仍是要人看。
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  closeRun,
  deleteSession,
  gitlabApi,
  gitlabToken,
  parseWorktrees,
  realExec,
  remoteHost,
} from './close.mjs';

export const USAGE = `用法：node sweep.mjs [--root <会话根目录>] [--repo <主检出>] [--apply]
列出 ~/.mirasim/sessions 下各 agent 里 runState 不是 running 的会话，
再列 --repo（默认当前目录所在仓）里没有会话认领的工作树。
可收：链接工作树干净、提交已推、PR/MR 已合并或已关闭。
要人看：没有 PR/MR、有未推提交、有真实未提交改动、读不了，或认不出分支（写明是哪一种）。
孤儿：workdir 指向的工作树和会话工作目录都已不在。
默认只列。--apply 才收可收和孤儿：可收走 close.mjs（没人认的工作树不带会话），孤儿只走它的删会话。`;

/**
 * @param {string} state
 */
function normState(state) {
  const s = String(state).toUpperCase();
  if (s === 'OPENED') return 'OPEN';
  return s;
}

/**
 * @param {string} a
 * @param {string} b
 */
function samePath(a, b) {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * 工作树路径和会话 workdir 可能一个是盘符一个是真实路径。对不上就会把同一棵树列两次。
 * @param {string} a
 * @param {string} b
 */
function sameRealPath(a, b) {
  const norm = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const ra = norm(a);
  const rb = norm(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * @param {import('./close.mjs').Exec} exec
 * @param {string} repo
 * @param {string[]} args
 */
function git(exec, repo, args) {
  return exec('git', ['-C', repo, ...args]);
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ root: string, repo: string, apply: boolean }} */
  const opt = { root: '', repo: '', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--apply') {
      if (opt.apply) throw new Error(`--apply 写了两次\n${USAGE}`);
      opt.apply = true;
      continue;
    }
    if (token === '--root' || token === '--repo') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 缺值\n${USAGE}`);
      if (token === '--root' ? opt.root : opt.repo) throw new Error(`${token} 写了两次\n${USAGE}`);
      if (token === '--root') opt.root = value;
      else opt.repo = value;
      i += 1;
      continue;
    }
    throw new Error(`不认识的参数 ${token}\n${USAGE}`);
  }
  return opt;
}

/**
 * @param {import('./close.mjs').Exec} exec
 * @param {typeof fetch} fetchImpl
 * @param {NodeJS.ProcessEnv} env
 * @param {string} workdir
 * @param {string} branch
 * @returns {Promise<{ prs: { number: string, state: string }[] | null, request: 'pr' | 'mr' }>}
 */
export async function listRequests(exec, fetchImpl, env, workdir, branch) {
  const url = git(exec, workdir, ['remote', 'get-url', 'origin']);
  if (url.code !== 0) return { prs: [], request: 'pr' };
  const host = remoteHost(url.stdout);
  if (!host) return { prs: [], request: 'pr' };
  if (host.host === 'github.com') {
    const listed = exec('gh', [
      'pr',
      'list',
      '--repo',
      host.project,
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,state',
    ]);
    if (listed.code !== 0) return { prs: null, request: 'pr' };
    try {
      const parsed = JSON.parse(listed.stdout);
      if (!Array.isArray(parsed)) return { prs: null, request: 'pr' };
      return {
        request: 'pr',
        prs: parsed.map((item) => ({
          number: String(item.number),
          state: normState(item.state),
        })),
      };
    } catch {
      return { prs: null, request: 'pr' };
    }
  }
  const token = gitlabToken(exec, workdir, env);
  if (!token) return { prs: null, request: 'mr' };
  const api = gitlabApi(env, host.host);
  const endpoint = `${api}/projects/${encodeURIComponent(host.project)}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all`;
  const res = await fetchImpl(endpoint, { headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' } });
  const text = await res.text();
  if (res.status !== 200) return { prs: null, request: 'mr' };
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { prs: null, request: 'mr' };
    return {
      request: 'mr',
      prs: parsed.map((item) => ({
        number: String(item.iid),
        state: normState(item.state),
      })),
    };
  } catch {
    return { prs: null, request: 'mr' };
  }
}

/**
 * @param {{
 *   runState: string,
 *   workdirExists: boolean,
 *   linked: boolean,
 *   dirty: boolean,
 *   unpushed: boolean,
 *   prs: { number: string, state: string }[] | null,
 * }} facts
 * @returns {{ kind: '跳过' | '可收' | '要人看' | '孤儿' | '还开着', reason: string, pr: string | null }}
 */
export function classify(facts) {
  if (facts.runState === 'running') return { kind: '跳过', reason: '在跑', pr: null };
  if (!facts.workdirExists) return { kind: '孤儿', reason: '工作树和会话工作目录都已不在', pr: null };
  if (!facts.linked) return { kind: '跳过', reason: '在主检出', pr: null };
  if (facts.dirty) return { kind: '要人看', reason: '有真实未提交改动', pr: null };
  if (facts.unpushed) return { kind: '要人看', reason: '有未推提交', pr: null };
  if (facts.prs === null) return { kind: '要人看', reason: '查 PR 没成', pr: null };
  const open = facts.prs.find((p) => p.state === 'OPEN');
  if (open) return { kind: '还开着', reason: 'PR 还开着', pr: open.number };
  const merged = facts.prs.find((p) => p.state === 'MERGED');
  if (merged) return { kind: '可收', reason: '已合并', pr: merged.number };
  const closed = facts.prs.find((p) => p.state === 'CLOSED');
  if (closed) return { kind: '可收', reason: '已关闭', pr: closed.number };
  return { kind: '要人看', reason: '没有 PR', pr: null };
}

/**
 * @param {string} root 会话根，下面是 agent 目录
 * @param {{
 *   exec?: import('./close.mjs').Exec,
 *   env?: NodeJS.ProcessEnv,
 *   fetch?: typeof fetch,
 *   listPrs?: (ctx: { workdir: string, branch: string }) => Promise<{ number: string, state: string }[] | null>,
 * }} io
 */
export async function scanSessions(root, io = {}) {
  const exec = io.exec ?? realExec;
  const env = io.env ?? process.env;
  const fetchImpl = io.fetch ?? fetch;
  if (!existsSync(root)) return [];
  /** @type {Awaited<ReturnType<typeof inspectSession>>[]} */
  const rows = [];
  for (const agentDir of readdirSync(root, { withFileTypes: true })) {
    if (!agentDir.isDirectory()) continue;
    const agentRoot = resolve(root, agentDir.name);
    for (const sessionDir of readdirSync(agentRoot, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue;
      const recordPath = resolve(agentRoot, sessionDir.name, 'record.json');
      if (!existsSync(recordPath)) continue;
      let rec;
      try {
        rec = JSON.parse(readFileSync(recordPath, 'utf8'));
      } catch {
        continue;
      }
      rows.push(await inspectSession(agentDir.name, sessionDir.name, rec, exec, env, fetchImpl, io.listPrs));
    }
  }
  return rows;
}

/**
 * @param {string} agentDir
 * @param {string} dirName
 * @param {Record<string, unknown>} rec
 * @param {import('./close.mjs').Exec} exec
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fetch} fetchImpl
 * @param {((ctx: { workdir: string, branch: string }) => Promise<{ number: string, state: string }[] | null>) | undefined} listPrs
 */
async function inspectSession(agentDir, dirName, rec, exec, env, fetchImpl, listPrs) {
  const agent = typeof rec.agent === 'string' && rec.agent ? rec.agent : agentDir;
  const sessionId = typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : dirName;
  const runState = typeof rec.runState === 'string' ? rec.runState : '';
  const workdir = typeof rec.workdir === 'string' ? rec.workdir : '';
  /** @type {{ agent: string, sessionId: string, runState: string, workdir: string, branch: string, kind: string, reason: string, pr: string | null, request: 'pr' | 'mr' }} */
  const row = {
    agent,
    sessionId,
    runState,
    workdir,
    branch: '',
    kind: '跳过',
    reason: '',
    pr: null,
    request: 'pr',
  };
  if (runState === 'running') {
    row.reason = '在跑';
    return row;
  }
  if (!workdir || !existsSync(workdir)) {
    const judged = classify({
      runState,
      workdirExists: false,
      linked: false,
      dirty: false,
      unpushed: false,
      prs: [],
    });
    row.kind = judged.kind;
    row.reason = judged.reason;
    return row;
  }
  const gitDir = git(exec, workdir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = git(exec, workdir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (gitDir.code !== 0 || common.code !== 0) {
    const detail = `${gitDir.stderr}\n${gitDir.stdout}\n${common.stderr}\n${common.stdout}`;
    if (/not a git repository/i.test(detail)) {
      row.kind = '跳过';
      row.reason = '不是 git 工作树';
      return row;
    }
    row.kind = '要人看';
    row.reason = '工作目录不是 git 工作树';
    return row;
  }
  const linked = !samePath(gitDir.stdout.trim(), common.stdout.trim());
  if (!linked) {
    row.kind = '跳过';
    row.reason = '在主检出';
    return row;
  }
  const branchR = git(exec, workdir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchR.stdout.trim();
  if (branchR.code !== 0 || !branch || branch === 'HEAD') {
    row.kind = '要人看';
    row.reason = '认不出分支';
    return row;
  }
  row.branch = branch;
  const judged = await judgeTree(workdir, branch, runState, exec, env, fetchImpl, listPrs);
  row.kind = judged.kind;
  row.reason = judged.reason;
  row.pr = judged.pr;
  row.request = judged.request;
  return row;
}

/**
 * @param {string} workdir
 * @param {string} branch
 * @param {string} runState
 * @param {import('./close.mjs').Exec} exec
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fetch} fetchImpl
 * @param {((ctx: { workdir: string, branch: string }) => Promise<{ number: string, state: string }[] | null>) | undefined} listPrs
 * @returns {Promise<{ kind: string, reason: string, pr: string | null, request: 'pr' | 'mr' }>}
 */
async function judgeTree(workdir, branch, runState, exec, env, fetchImpl, listPrs) {
  const dirty = git(exec, workdir, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty.code !== 0) return { kind: '要人看', reason: '读不了工作树', pr: null, request: 'pr' };
  const unpushed = git(exec, workdir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
  if (unpushed.code !== 0) return { kind: '要人看', reason: '有未推提交', pr: null, request: 'pr' };
  /** @type {{ number: string, state: string }[] | null} */
  let prs = null;
  /** @type {'pr' | 'mr'} */
  let request = 'pr';
  if (listPrs) {
    prs = await listPrs({ workdir, branch });
    if (prs) prs = prs.map((item) => ({ number: String(item.number), state: normState(item.state) }));
  } else {
    const listed = await listRequests(exec, fetchImpl, env, workdir, branch);
    prs = listed.prs;
    request = listed.request;
  }
  const judged = classify({
    runState,
    workdirExists: true,
    linked: true,
    dirty: dirty.stdout.trim() !== '',
    unpushed: Number(unpushed.stdout.trim()) > 0,
    prs,
  });
  return { kind: judged.kind, reason: judged.reason, pr: judged.pr, request };
}

/**
 * 没有会话认领的链接工作树。主检出本身不算残留。判类走 classify，不另写结论。
 * @param {string} repo
 * @param {{ workdir: string }[]} owned
 * @param {import('./close.mjs').Exec} exec
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fetch} fetchImpl
 * @param {((ctx: { workdir: string, branch: string }) => Promise<{ number: string, state: string }[] | null>) | undefined} listPrs
 */
async function scanUnownedWorktrees(repo, owned, exec, env, fetchImpl, listPrs) {
  const listed = git(exec, repo, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) {
    return {
      error: (listed.stderr || listed.stdout).trim().slice(0, 200) || 'git worktree list 失败',
      rows: [],
    };
  }
  const main = mainCheckout(repo, exec);
  if (!main) return { error: '认不出主检出', rows: [] };
  /** @type {Awaited<ReturnType<typeof inspectSession>>[]} */
  const rows = [];
  for (const tree of parseWorktrees(listed.stdout)) {
    if (sameRealPath(tree.path, main)) continue;
    if (owned.some((row) => row.workdir && sameRealPath(row.workdir, tree.path))) continue;
    const branch = tree.branch ? tree.branch.replace(/^refs\/heads\//, '') : '';
    /** @type {Awaited<ReturnType<typeof inspectSession>>} */
    const row = {
      agent: '',
      sessionId: '',
      runState: '',
      workdir: tree.path,
      branch,
      kind: '要人看',
      reason: '认不出分支',
      pr: null,
      request: 'pr',
    };
    if (!branch) {
      rows.push(row);
      continue;
    }
    const judged = await judgeTree(tree.path, branch, 'completed', exec, env, fetchImpl, listPrs);
    row.kind = judged.kind;
    row.reason = judged.reason;
    row.pr = judged.pr;
    row.request = judged.request;
    rows.push(row);
  }
  return { error: '', rows };
}

/** @param {{ kind: string, agent: string, sessionId: string, branch: string, reason: string, pr: string | null, workdir?: string }} row */
export function formatRow(row) {
  if (!row.sessionId) {
    const where = row.workdir ?? '';
    if (row.kind === '可收') return `可收 工作树 ${row.branch} PR #${row.pr} ${row.reason} ${where}`;
    if (row.kind === '要人看') return `要人看 工作树 ${row.branch || '(游离)'} ${row.reason} ${where}`;
    if (row.kind === '还开着') return `还开着 工作树 ${row.branch} PR #${row.pr} ${where}`;
    return '';
  }
  const id = `${row.agent}:${row.sessionId.slice(0, 8)}`;
  if (row.kind === '可收') return `可收 ${id} ${row.branch} PR #${row.pr} ${row.reason}`;
  if (row.kind === '要人看') return `要人看 ${id} ${row.branch} ${row.reason}`;
  if (row.kind === '孤儿') return `孤儿 ${id} ${row.reason}`;
  if (row.kind === '还开着') return `还开着 ${id} ${row.branch} PR #${row.pr}`;
  return '';
}

const ORDER = ['可收', '要人看', '孤儿', '还开着'];

/**
 * @param {string} workdir
 * @param {import('./close.mjs').Exec} exec
 */
function mainCheckout(workdir, exec) {
  const common = git(exec, workdir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0) return null;
  const dir = resolve(common.stdout.trim());
  if (!dir.endsWith('.git')) return null;
  return dirname(dir);
}

/**
 * @param {string[]} argv
 * @param {{
 *   exec?: import('./close.mjs').Exec,
 *   env?: NodeJS.ProcessEnv,
 *   fetch?: typeof fetch,
 *   log?: (line: string) => void,
 *   listPrs?: (ctx: { workdir: string, branch: string }) => Promise<{ number: string, state: string }[] | null>,
 *   closeRun?: typeof closeRun,
 *   deleteSession?: (sessionKey: string) => Promise<{ skipped: boolean, detail: string }>,
 * }} [io]
 */
export async function sweepRun(argv, io = {}) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (io.log ?? console.log)(message);
    return 2;
  }
  const log = io.log ?? ((line) => console.log(line));
  const exec = io.exec ?? realExec;
  const env = io.env ?? process.env;
  const root = opt.root ? resolve(opt.root) : resolve(homedir(), '.mirasim', 'sessions');
  const repo = opt.repo ? resolve(opt.repo) : resolve('.');
  const rows = await scanSessions(root, { exec, env, fetch: io.fetch, listPrs: io.listPrs });
  const extra = await scanUnownedWorktrees(repo, rows, exec, env, io.fetch ?? fetch, io.listPrs);
  if (extra.error) log(`列工作树没成：${extra.error}`);
  const listed = [...rows, ...extra.rows]
    .filter((row) => ORDER.includes(row.kind))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  for (const row of listed) log(formatRow(row));
  if (!listed.length) log('没有可收、要人看、孤儿，也没有没人认的工作树');
  if (!opt.apply) return 0;
  let failed = 0;
  for (const row of listed) {
    if (row.kind === '可收') {
      const main = mainCheckout(row.workdir, exec);
      const label = row.sessionId ? `${row.agent}:${row.sessionId.slice(0, 8)}` : row.branch || row.workdir;
      if (!main || !row.branch) {
        log(`停在：收 ${label} 认不出主检出`);
        failed += 1;
        continue;
      }
      const args = ['--repo', main, '--branch', row.branch];
      if (row.sessionId) args.push('--session', `${row.agent}:${row.sessionId}`);
      if (row.pr) args.push(row.request === 'mr' ? '--mr' : '--pr', row.pr);
      const run = io.closeRun ?? closeRun;
      const code = await run(args, { exec, env, log, fetch: io.fetch, deleteSession: io.deleteSession });
      if (code !== 0) failed += 1;
    } else if (row.kind === '孤儿') {
      const key = `${row.agent}:${row.sessionId}`;
      try {
        const drop = io.deleteSession ?? ((sessionKey) => deleteSession(env, exec, sessionKey));
        const result = await drop(key);
        log(`[删会话] ${result.detail}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`停在：删会话 ${key} ${message}`);
        failed += 1;
      }
    }
  }
  return failed === 0 ? 0 : 1;
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
  sweepRun(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
