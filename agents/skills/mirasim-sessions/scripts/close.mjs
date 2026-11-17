// mirasim-sessions 收单：合并 → 主检出快进并推其余远端 → 拆目录联接后再删工作树和分支 → 删会话。
// 为什么先拆联接：Windows 上工作树里的 node_modules 常是指回主检出的目录联接，git worktree remove 会顺着联接
// 把主检出的依赖删空（同一台机器踩过三次，最近 2026-11-12）。这里只 unlink 链接本身，不进链接里面。
// 地址和令牌只从这次要收的仓读（远端 URL、环境变量、仓本地 git config），脚本里不写任何主机名。
// 推其余远端时，推送地址是 DISABLED（只读）或 git remote get-url --push 失败的远端跳过，输出写明跳过了哪个。
// fleet-ade 的 upstream 推送地址故意是 DISABLED，推它会让后面的删除全停（2026-11-16 #155）。不加开关。
// 每一步失败就停、退出码非 0，并写明下一步怎么手工接。已经做成的步骤再跑会跳过（看仓库现状，不另记进度文件）。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostPort } from './dispatch.mjs';

export const USAGE = `用法：node close.mjs --repo <主检出> --branch <分支> [--mr <号>|--pr <号>] [--session <sessionKey>]
按序：合并（GitHub 用 gh，GitLab 用仓远端上的地址和令牌）→ 主检出快进到默认分支并推其余远端 →
拆工作树里的目录联接/目录软链（只拆不跟）→ 核主检出依赖目录项数 → 删工作树和本地、远端分支 → 删会话。
没给 --session 时删会话这一步打印「不适用」。某一步失败退出码 1（参数不对是 2），重跑同一条会跳过已做成的。`;

/** @typedef {{ code: number, stdout: string, stderr: string }} ExecResult */
/** @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }) => ExecResult} Exec */
/** @typedef {{ status: number, text: () => Promise<string> }} FetchResult */
/** @typedef {(url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<FetchResult>} FetchFn */

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

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 * @returns {ExecResult}
 */
export function realExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout ?? 120_000,
  });
  const err = r.error ? r.error.message : '';
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${err}`,
  };
}

/**
 * @param {string} step
 * @param {ExecResult} result
 * @param {string} what
 */
function failExec(step, result, what) {
  const detail = (result.stderr || result.stdout || '没有输出').trim().slice(0, 500);
  throw new Stop(step, `${what} 没成（退出码 ${result.code}）：${detail}`);
}

/**
 * @param {Exec} exec
 * @param {string} repo
 * @param {string[]} args
 */
function git(exec, repo, args) {
  return exec('git', ['-C', repo, ...args]);
}

/**
 * @param {string} a
 * @param {string} b
 */
function samePath(a, b) {
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
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | undefined>} */
  const got = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (!token.startsWith('--')) throw new Stop('参数', `不认识的参数 ${token}\n${USAGE}`, 2);
    const key = token.slice(2);
    if (!['repo', 'branch', 'mr', 'pr', 'session'].includes(key))
      throw new Stop('参数', `不认识的参数 ${token}\n${USAGE}`, 2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Stop('参数', `${token} 缺值\n${USAGE}`, 2);
    if (got[key] !== undefined) throw new Stop('参数', `${token} 写了两次\n${USAGE}`, 2);
    got[key] = value;
    i += 1;
  }
  if (!got.repo || !got.branch) throw new Stop('参数', `要有 --repo 和 --branch\n${USAGE}`, 2);
  if (got.mr && got.pr) throw new Stop('参数', '--mr 和 --pr 只能给一个', 2);
  for (const key of ['mr', 'pr']) {
    if (got[key] !== undefined && !/^[1-9]\d*$/.test(got[key]))
      throw new Stop('参数', `--${key} 要是正整数，收到的是 ${got[key]}`, 2);
  }
  return {
    repo: resolve(got.repo),
    branch: got.branch,
    mr: got.mr,
    pr: got.pr,
    session: got.session,
  };
}

/**
 * @param {string} text porcelain
 * @returns {{ path: string, branch: string | null }[]}
 */
export function parseWorktrees(text) {
  /** @type {{ path: string, branch: string | null }[]} */
  const trees = [];
  /** @type {{ path: string, branch: string | null } | null} */
  let cur = null;
  const push = () => {
    if (cur) trees.push(cur);
    cur = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      push();
      cur = { path: line.slice('worktree '.length).trim(), branch: null };
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim();
    } else if (line === '') push();
  }
  push();
  return trees;
}

/**
 * 目录联接或指向目录的软链。用 lstat / dirent，不把链接当目录走下去。
 * 分类时 stat 一次只为了知道指的是不是目录，不删除目标。断掉的链接也算，留着它 git 仍可能去跟。
 * @param {string} root 工作树根
 * @returns {string[]} 绝对路径
 */
export function directoryLinks(root) {
  /** @type {string[]} */
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const p = join(dir, ent.name);
      let link = ent.isSymbolicLink();
      if (!link) {
        try {
          link = lstatSync(p).isSymbolicLink();
        } catch {
          link = false;
        }
      }
      if (link) {
        let dirLink = true;
        try {
          dirLink = statSync(p).isDirectory();
        } catch {
          dirLink = true;
        }
        if (dirLink) found.push(p);
        continue;
      }
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(root);
  return found;
}

/**
 * 只拆链接本身。
 * @param {string} root
 * @returns {{ removed: string[], left: string[] }}
 */
export function unlinkDirectoryLinks(root) {
  const before = directoryLinks(root);
  for (const p of before) {
    unlinkSync(p);
  }
  return { removed: before, left: directoryLinks(root) };
}

/**
 * @param {string} dir
 * @returns {number | null} 目录不在就是 null
 */
function entryCount(dir) {
  try {
    return readdirSync(dir).length;
  } catch {
    return null;
  }
}

/**
 * 主检出的 node_modules，以及工作树里目录链接指向的目标里、落在主检出且不在这棵工作树里的那些。
 * 工作树建在主检出里面时，指回工作树自己的目录也落在主检出路径下，跟着工作树一起没，不能进这张表。
 * 项数只数这一层。
 * @param {string} main
 * @param {string | null} worktree
 * @returns {Map<string, number>}
 */
export function snapshotDepCounts(main, worktree) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const mainReal = realpathSync(main);
  const worktreeReal = worktree && existsSync(worktree) ? realpathSync(worktree) : '';
  const add = (dir) => {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    const rel = relative(mainReal, real);
    const insideMain = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (!insideMain) return;
    if (worktreeReal) {
      const inWt = relative(worktreeReal, real);
      const insideWt = inWt === '' || (!inWt.startsWith('..') && !isAbsolute(inWt));
      if (insideWt) return;
    }
    if (counts.has(real)) return;
    const n = entryCount(real);
    if (n === null) return;
    counts.set(real, n);
  };
  const nm = join(main, 'node_modules');
  if (existsSync(nm)) add(nm);
  if (worktree && existsSync(worktree)) {
    for (const link of directoryLinks(worktree)) add(link);
  }
  return counts;
}

/**
 * @param {string} url
 * @returns {{ host: string, project: string } | null} 本地路径不是主机
 */
export function remoteHost(url) {
  const scp = /^git@([^:]+):(.+)$/.exec(url.trim());
  if (scp) return { host: scp[1], project: scp[2].replace(/\.git$/, '') };
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'ssh:' && u.protocol !== 'http:') return null;
    const project = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (!u.hostname || !project) return null;
    return { host: u.hostname, project };
  } catch {
    return null;
  }
}

/**
 * @param {Exec} exec
 * @param {string} repo
 * @param {NodeJS.ProcessEnv} env
 */
function gitlabToken(exec, repo, env) {
  for (const key of ['GITLAB_TOKEN', 'GL_TOKEN', 'GITLAB_PRIVATE_TOKEN']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const cfg = git(exec, repo, ['config', '--local', '--get', 'gitlab.token']);
  if (cfg.code === 0 && cfg.stdout.trim()) return cfg.stdout.trim();
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} host 从仓的远端读到的主机名
 */
function gitlabApi(env, host) {
  const fromEnv = env.GITLAB_API_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim().replace(/\/$/, '');
  return `https://${host}/api/v4`;
}

/**
 * 合并一个还开着的 PR/MR。已经合了就跳过。
 * @param {{
 *   exec: Exec,
 *   fetch: FetchFn,
 *   env: NodeJS.ProcessEnv,
 *   repo: string,
 *   pr?: string,
 *   mr?: string,
 *   slug?: string,
 *   host?: string,
 *   project?: string,
 * }} o
 * @returns {Promise<{ skipped: boolean, detail: string }>}
 */
export async function performMerge(o) {
  if (o.pr) {
    if (!o.slug) throw new Stop('合并', '给了 --pr，但 GitHub 远端里读不出 owner/repo');
    const view = o.exec('gh', ['pr', 'view', o.pr, '--repo', o.slug, '--json', 'state']);
    if (view.code !== 0) failExec('合并', view, `gh pr view ${o.pr}`);
    let state = '';
    try {
      const parsed = JSON.parse(view.stdout);
      state = typeof parsed.state === 'string' ? parsed.state : '';
    } catch {
      throw new Stop('合并', `gh pr view ${o.pr} 的输出不是 JSON`);
    }
    if (state === 'MERGED') return { skipped: true, detail: `PR #${o.pr} 已经合并` };
    if (state !== 'OPEN') throw new Stop('合并', `PR #${o.pr} 状态是 ${state || '认不出'}，没有合并`);
    const merged = o.exec('gh', ['pr', 'merge', o.pr, '--repo', o.slug, '--squash']);
    if (merged.code !== 0) failExec('合并', merged, `gh pr merge ${o.pr}`);
    return { skipped: false, detail: `已 squash 合并 PR #${o.pr}` };
  }
  if (!o.mr || !o.host || !o.project)
    throw new Stop('合并', '给了 --mr，但 GitLab 远端的主机或项目路径没读出来');
  const token = gitlabToken(o.exec, o.repo, o.env);
  if (!token) {
    throw new Stop(
      '合并',
      '没读到 GitLab 令牌。把令牌放进环境变量 GITLAB_TOKEN（或 GL_TOKEN），或这个仓的 git config gitlab.token。脚本里不写令牌。',
    );
  }
  const api = gitlabApi(o.env, o.host);
  const base = `${api}/projects/${encodeURIComponent(o.project)}/merge_requests/${o.mr}`;
  const read = async () => {
    const res = await o.fetch(base, {
      method: 'GET',
      headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' },
    });
    const text = await res.text();
    if (res.status === 404) throw new Stop('合并', `MR !${o.mr} 在 ${o.host} 上不存在（HTTP 404）`);
    if (res.status !== 200) throw new Stop('合并', `读 MR !${o.mr} 失败：HTTP ${res.status}`);
    try {
      const parsed = JSON.parse(text);
      return typeof parsed.state === 'string' ? parsed.state : '';
    } catch {
      throw new Stop('合并', `MR !${o.mr} 的响应不是 JSON`);
    }
  };
  const state = await read();
  if (state === 'merged') return { skipped: true, detail: `MR !${o.mr} 已经合并` };
  if (state !== 'opened') throw new Stop('合并', `MR !${o.mr} 状态是 ${state || '认不出'}，没有合并`);
  const res = await o.fetch(`${base}/merge`, {
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': token, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ squash: true, should_remove_source_branch: false }),
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    let again = '';
    try {
      again = await read();
    } catch {
      again = '';
    }
    if (again === 'merged') return { skipped: false, detail: `MR !${o.mr} 已经合并` };
    throw new Stop('合并', `合并 MR !${o.mr} 失败：HTTP ${res.status} ${text.trim().slice(0, 200)}`);
  }
  return { skipped: false, detail: `已 squash 合并 MR !${o.mr}` };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Exec} exec
 * @param {string} sessionKey
 */
async function deleteSessionReal(env, exec, sessionKey) {
  const home = env.USERPROFILE || env.HOME || homedir();
  const statePath = join(home, '.mirasim', 'app', 'state.json');
  let version = '';
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    version = typeof parsed.good === 'string' ? parsed.good : '';
  } catch (err) {
    const code = err && typeof err === 'object' && 'message' in err ? String(err.message) : '读不了';
    throw new Stop('删会话', `读不了 ${statePath}（${code}），不知道调哪一版 mirasim`);
  }
  if (!version) throw new Stop('删会话', `${statePath} 里没有 good 版本`);
  const server = join(home, '.mirasim', 'app', version, 'server.cjs');
  if (!existsSync(server)) throw new Stop('删会话', `没有 ${server}`);
  // 不带端口的 ui-cli 会起一次性私服、删不到正在跑的宿主里的会话（#4075），端口一律经 hostPort 取。
  let port;
  try {
    port = hostPort(env);
  } catch (e) {
    throw new Stop('删会话', e instanceof Error ? e.message : String(e));
  }
  const args = [
    server,
    'ui-cli',
    '--port',
    port,
    'call',
    'deleteSession',
    '--args',
    JSON.stringify({ sessionKey }),
  ];
  const r = exec(process.execPath, args, { env });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) {
    if (/not found|不存在|unknown session|does not exist|no such session/i.test(out))
      return { skipped: true, detail: '会话已经不在' };
    throw new Stop('删会话', `deleteSession 没成（退出码 ${r.code}）：${out.trim().slice(0, 400)}`);
  }
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed && parsed.ok === false) {
      const brief = JSON.stringify(parsed).slice(0, 400);
      if (/not found|不存在|unknown session/i.test(brief)) return { skipped: true, detail: '会话已经不在' };
      throw new Stop('删会话', `deleteSession 返回失败：${brief}`);
    }
  } catch (err) {
    if (err instanceof Stop) throw err;
    throw new Stop('删会话', 'deleteSession 的输出不是 JSON');
  }
  return { skipped: false, detail: `已删会话 ${sessionKey}` };
}

/**
 * @param {string[]} argv
 * @param {{
 *   exec?: Exec,
 *   fetch?: FetchFn,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (line: string) => void,
 *   deleteSession?: (sessionKey: string) => Promise<{ skipped: boolean, detail: string }>,
 * }} [io]
 * @returns {Promise<number>}
 */
export async function closeRun(argv, io = {}) {
  const exec = io.exec ?? realExec;
  const fetchImpl = io.fetch ?? fetch;
  const env = io.env ?? process.env;
  const log = io.log ?? ((line) => console.log(line));
  /** @type {string[]} */
  const said = [];
  const say = (line) => {
    said.push(line);
    log(line);
  };
  const again = () => `node close.mjs ${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  try {
    const opt = parseArgs(argv);
    const top = git(exec, opt.repo, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) failExec('核对', top, '认主检出');
    const main = resolve(top.stdout.trim());
    if (!samePath(main, opt.repo)) {
      throw new Stop('核对', `--repo 要是主检出 ${main}，收到的是 ${opt.repo}`);
    }
    const gitDir = git(exec, main, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const commonDir = git(exec, main, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (gitDir.code !== 0 || commonDir.code !== 0)
      failExec('核对', gitDir.code !== 0 ? gitDir : commonDir, '认 git 目录');
    if (!samePath(resolve(gitDir.stdout.trim()), resolve(commonDir.stdout.trim()))) {
      throw new Stop('核对', '--repo 是一棵链接工作树，不是主检出。主检出才是 --repo。');
    }

    const listed = git(exec, main, ['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) failExec('核对', listed, '列出工作树');
    const wantRef = `refs/heads/${opt.branch}`;
    const trees = parseWorktrees(listed.stdout).filter((t) => !samePath(t.path, main));
    const mine = trees.filter((t) => t.branch === wantRef);
    if (mine.length > 1)
      throw new Stop('核对', `分支 ${opt.branch} 检出了 ${mine.length} 棵工作树，不确定删哪棵`);
    const worktree = mine[0]?.path ?? null;

    const localBranch = git(exec, main, ['show-ref', '--verify', '--quiet', wantRef]);
    const branchExists = localBranch.code === 0;
    if (!worktree && !branchExists && !opt.pr && !opt.mr) {
      say(`[核对] 工作树和本地分支 ${opt.branch} 都已经不在`);
    }

    if (worktree) {
      const dirty = git(exec, worktree, ['status', '--porcelain', '--untracked-files=all']);
      if (dirty.code !== 0) failExec('核对', dirty, '看工作树有没有未提交改动');
      if (dirty.stdout.trim()) {
        throw new Stop(
          '核对',
          `工作树有未提交改动，没有合并也没有删。先在 ${worktree} 提交或丢掉这些改动，再重跑：${again()}`,
        );
      }
      say(`[核对] 工作树没有未提交改动：${worktree}`);
    } else say('[核对] 没有这棵工作树，跳过未提交检查');

    const headRef = git(exec, main, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    let defaultBranch = '';
    if (headRef.code === 0 && headRef.stdout.trim().includes('/')) {
      defaultBranch = headRef.stdout.trim().slice(headRef.stdout.trim().indexOf('/') + 1);
    } else {
      for (const name of ['main', 'master']) {
        const has = git(exec, main, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
        if (has.code === 0) {
          defaultBranch = name;
          break;
        }
      }
    }
    if (!defaultBranch)
      throw new Stop('核对', '认不出默认分支（没有 origin/HEAD，也没有本地 main 或 master）');

    const remoteList = git(exec, main, ['remote']);
    if (remoteList.code !== 0) failExec('核对', remoteList, '列出远端');
    const remoteNames = remoteList.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    /** @type {{ name: string, url: string, host: { host: string, project: string } | null }[]} */
    const remotes = [];
    for (const name of remoteNames) {
      const url = git(exec, main, ['remote', 'get-url', name]);
      if (url.code !== 0) failExec('核对', url, `读远端 ${name}`);
      remotes.push({ name, url: url.stdout.trim(), host: remoteHost(url.stdout) });
    }
    /** @type {{ name: string, url: string, host: { host: string, project: string } | null } | null} */
    let source = null;
    if (opt.pr) {
      source = remotes.find((r) => r.host?.host === 'github.com') ?? null;
      if (!source) throw new Stop('合并', '给了 --pr，但没有主机是 github.com 的远端');
    } else if (opt.mr) {
      source = remotes.find((r) => r.host && r.host.host !== 'github.com') ?? null;
      if (!source) throw new Stop('合并', '给了 --mr，但没有 GitLab 远端。地址要从仓的远端读，脚本里不写。');
    } else source = remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null;

    if (source) {
      const fetched = git(exec, main, ['fetch', source.name, defaultBranch]);
      if (fetched.code !== 0) failExec('合并', fetched, `git fetch ${source.name} ${defaultBranch}`);
    }
    const upstream = source ? `refs/remotes/${source.name}/${defaultBranch}` : `refs/heads/${defaultBranch}`;
    const contained = branchExists
      ? git(exec, main, ['merge-base', '--is-ancestor', opt.branch, upstream])
      : { code: 1, stdout: '', stderr: '' };
    if (branchExists && contained.code !== 0 && contained.code !== 1)
      failExec('合并', contained, '看分支是否已在默认分支里');
    // 有合并证据才许删远端分支：分支已在默认分支里，或这次确认 PR/MR 已合并。
    let mergeProven = branchExists && contained.code === 0;
    if (mergeProven) say(`[合并] 跳过：${opt.branch} 已在默认分支 ${defaultBranch} 里`);
    else if (!branchExists && !opt.pr && !opt.mr) say('[合并] 跳过：本地分支已经不在，也没有 --pr/--mr');
    else if (!opt.pr && !opt.mr) {
      throw new Stop(
        '合并',
        `分支 ${opt.branch} 还不在 ${defaultBranch} 里，也没给 --pr 或 --mr，没有合并。确认已经合过就带上号再重跑：${again()}`,
      );
    } else {
      const result = await performMerge({
        exec,
        fetch: fetchImpl,
        env,
        repo: main,
        pr: opt.pr,
        mr: opt.mr,
        slug: source?.host?.host === 'github.com' ? source.host.project : undefined,
        host: source?.host?.host,
        project: source?.host?.project,
      });
      say(`[合并] ${result.detail}`);
      if (source) {
        const againFetch = git(exec, main, ['fetch', source.name, defaultBranch]);
        if (againFetch.code !== 0) failExec('合并', againFetch, `合并后 git fetch ${source.name}`);
      }
      mergeProven = true;
    }

    if (!source) {
      say('[快进] 没有远端，不快进也不推');
    } else {
      const localTip = git(exec, main, ['rev-parse', `refs/heads/${defaultBranch}`]);
      const remoteTip = git(exec, main, ['rev-parse', upstream]);
      if (localTip.code !== 0) failExec('快进', localTip, `读本地 ${defaultBranch}`);
      if (remoteTip.code !== 0) failExec('快进', remoteTip, `读 ${upstream}`);
      if (localTip.stdout.trim() !== remoteTip.stdout.trim()) {
        const on = git(exec, main, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (on.code !== 0) failExec('快进', on, '看主检出当前分支');
        const mainDirty = git(exec, main, ['status', '--porcelain']);
        if (mainDirty.code !== 0) failExec('快进', mainDirty, '看主检出有没有未提交改动');
        if (mainDirty.stdout.trim()) {
          throw new Stop(
            '快进',
            `主检出有未提交改动，没法快进到 ${defaultBranch}。提交或丢掉之后重跑：${again()}`,
          );
        }
        if (on.stdout.trim() !== defaultBranch) {
          const switched = git(exec, main, ['checkout', defaultBranch]);
          if (switched.code !== 0) failExec('快进', switched, `切到 ${defaultBranch}`);
        }
        const ff = git(exec, main, ['merge', '--ff-only', upstream]);
        if (ff.code !== 0) failExec('快进', ff, `快进 ${defaultBranch}`);
        const now = git(exec, main, ['rev-parse', '--short', 'HEAD']);
        say(`[快进] 主检出已快进到 ${now.stdout.trim() || remoteTip.stdout.trim()}`);
      } else say(`[快进] 主检出的 ${defaultBranch} 已是 ${source.name} 上合并后的提交`);

      const others = remotes.filter((r) => r.name !== source.name);
      if (others.length === 0) say('[快进] 没有其余远端');
      for (const other of others) {
        // 推送地址故意设成 DISABLED（只读）或根本读不出来的远端推不出去。
        // fleet-ade 的 upstream 就是这样：推它会 fatal: 'DISABLED' does not appear to be a git repository，
        // 后面的删工作树、删分支、删会话全停（2026-11-16 #155）。跳过，不加开关。
        const pushUrl = git(exec, main, ['remote', 'get-url', '--push', other.name]);
        const pushTarget = pushUrl.stdout.trim();
        if (pushUrl.code !== 0 || pushTarget === 'DISABLED') {
          const why =
            pushUrl.code !== 0
              ? `读推送地址没成：${(pushUrl.stderr || pushUrl.stdout).trim().slice(0, 200)}`
              : '推送地址是 DISABLED';
          say(`[快进] 跳过 ${other.name}：${why}`);
          continue;
        }
        const pushed = git(exec, main, [
          'push',
          other.name,
          `refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`,
        ]);
        if (pushed.code !== 0) {
          throw new Stop(
            '快进',
            `推 ${other.name} ${defaultBranch} 没成。其余步骤还没做。修好这个远端后重跑（已合并、已快进的会跳过）：${again()}\n${(pushed.stderr || pushed.stdout).trim().slice(0, 400)}`,
          );
        }
        say(`[快进] 已推 ${other.name} ${defaultBranch}`);
      }
    }

    if (!worktree || !existsSync(worktree)) {
      say('[拆联接] 不适用：工作树已经不在');
    } else {
      const before = snapshotDepCounts(main, worktree);
      let removed = [];
      try {
        const unlinked = unlinkDirectoryLinks(worktree);
        removed = unlinked.removed;
        if (unlinked.left.length > 0) {
          throw new Stop(
            '拆联接',
            `拆完还有目录联接，没有删工作树：${unlinked.left.join('、')}。只对这些路径 unlink（不要 rm -rf），确认没有了再重跑：${again()}`,
          );
        }
      } catch (err) {
        if (err instanceof Stop) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new Stop(
          '拆联接',
          `拆目录联接没成：${message}。不要 git worktree remove。修好后重跑：${again()}`,
        );
      }
      say(removed.length === 0 ? '[拆联接] 没有目录联接' : `[拆联接] 已拆 ${removed.length} 个，没有剩余`);
      const gone = git(exec, main, ['worktree', 'remove', worktree]);
      if (gone.code !== 0) {
        throw new Stop(
          '删工作树',
          `目录联接已经拆了，git worktree remove 没成。不要用会跟着联接走的删法。看完原因再重跑：${again()}\n${(gone.stderr || gone.stdout).trim().slice(0, 400)}`,
        );
      }
      say(`[删工作树] 已删 ${worktree}`);
      for (const [dir, n] of before) {
        const after = entryCount(dir);
        if (after !== n) {
          throw new Stop(
            '删工作树',
            `主检出依赖目录项数变了：${dir} 删除前 ${n}，删除后 ${after ?? '目录没了'}。不要继续删别的。先把依赖恢复再重跑。`,
          );
        }
      }
      if (before.size === 0) say('[删工作树] 主检出没有依赖目录可核');
      else say(`[删工作树] 主检出依赖目录项数未变（${[...before.values()].join('、')}）`);
    }

    const localStill = git(exec, main, ['show-ref', '--verify', '--quiet', wantRef]).code === 0;
    if (localStill) {
      if (!mergeProven)
        throw new Stop('删工作树', `没有合并证据，不删本地分支 ${opt.branch}。重跑：${again()}`);
      const stillIn = git(exec, main, ['merge-base', '--is-ancestor', opt.branch, upstream]);
      if (stillIn.code !== 0 && stillIn.code !== 1) failExec('删工作树', stillIn, '删分支前再确认是否已合入');
      const flag = stillIn.code === 0 ? '-d' : '-D';
      const dropped = git(exec, main, ['branch', flag, opt.branch]);
      if (dropped.code !== 0) failExec('删工作树', dropped, `删本地分支 ${opt.branch}`);
      say(`[删工作树] 已删本地分支 ${opt.branch}`);
    } else say(`[删工作树] 本地分支 ${opt.branch} 已经不在`);

    for (const remote of remotes) {
      const ls = git(exec, main, ['ls-remote', '--heads', remote.name, opt.branch]);
      if (ls.code !== 0) {
        throw new Stop(
          '删工作树',
          `列 ${remote.name} 上的 ${opt.branch} 没成。本地该删的已删。修好后重跑：${again()}\n${(ls.stderr || ls.stdout).trim().slice(0, 300)}`,
        );
      }
      if (!ls.stdout.trim()) {
        say(`[删工作树] ${remote.name} 上没有 ${opt.branch}`);
        continue;
      }
      if (!mergeProven) {
        throw new Stop(
          '删工作树',
          `${remote.name} 上还有 ${opt.branch}，但没有合并证据（不在默认分支里，也没有已合并的 --pr/--mr），没有删它。带上号再重跑：${again()}`,
        );
      }
      const del = git(exec, main, ['push', remote.name, '--delete', opt.branch]);
      if (del.code !== 0) {
        throw new Stop(
          '删工作树',
          `删 ${remote.name} 上的 ${opt.branch} 没成。重跑：${again()}\n${(del.stderr || del.stdout).trim().slice(0, 300)}`,
        );
      }
      say(`[删工作树] 已删 ${remote.name} 上的 ${opt.branch}`);
    }

    if (!opt.session) {
      say('[删会话] 不适用');
    } else {
      const drop = io.deleteSession ?? ((key) => deleteSessionReal(env, exec, key));
      const result = await drop(opt.session);
      say(`[删会话] ${result.detail}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof Stop) {
      say(`停在：${err.step}`);
      say(`下一步：${err.next}`);
      return err.code;
    }
    const message = err instanceof Error ? err.message : String(err);
    say('停在：脚本');
    say(`下一步：${message}`);
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
  closeRun(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
