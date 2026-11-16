// 收单式合并的唯一入口（pnpm pr:merge <号>）：从 PR 号解出分支、主检出、工作树和它派活的
// mirasim 会话，交给 close.mjs 一条做完（合并 → 主检出快进 → 拆联接 → 删工作树和分支 → 删会话）。
// 为什么裸 gh pr merge 不行：它只合远端，工作树、本地分支和会话全留成残（fleet-setup、fleet-ade 连漏四次）。
// 删的规则一条不松：工作树有未提交改动不删、没有合并证据不删，close.mjs 里已经是必经步骤，这里不加第二套。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeRun, parseWorktrees, Stop, samePath } from './close.mjs';

export const USAGE = `用法：pnpm pr:merge <PR 号>（= node pr-merge.mjs <PR 号> [--repo <主检出>])
合并唯一入口：解出 PR 的分支、主检出、工作树、派活会话，整条交给 close.mjs。
不要裸 gh pr merge：它只合远端，留下工作树、分支和会话。`;

/** @typedef {{ code: number, stdout: string, stderr: string }} ExecResult */
/** @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }) => ExecResult} Exec */
/** @typedef {(url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<{ status: number, text: () => Promise<string> }>} FetchFn */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 * @returns {ExecResult}
 */
export function realExec(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeout ?? 120_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = /** @type {{ status?: number, stdout?: string, stderr?: string, message?: string }} */ (err);
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(e.message ?? err),
    };
  }
}

/**
 * @param {string[]} argv
 * @returns {{ pr: string, repo: string }}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let pr;
  /** @type {string | undefined} */
  let repo;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--repo') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Stop('参数', `--repo 缺值\n${USAGE}`, 2);
      if (repo !== undefined) throw new Stop('参数', `--repo 写了两次\n${USAGE}`, 2);
      repo = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--')) throw new Stop('参数', `不认识的参数 ${token}\n${USAGE}`, 2);
    if (pr !== undefined) throw new Stop('参数', `PR 号只能给一个\n${USAGE}`, 2);
    pr = token;
  }
  if (pr === undefined || !/^[1-9]\d*$/.test(pr))
    throw new Stop('参数', `PR 号要是正整数，收到的是 ${pr ?? '没有'}\n${USAGE}`, 2);
  return { pr, repo: resolve(repo ?? '.') };
}

/**
 * 把任何一个检出（主检出或链接工作树）解成主检出：git-common-dir 的上一级就是。
 * @param {Exec} exec
 * @param {string} dir
 * @returns {string}
 */
export function resolveMain(exec, dir) {
  const common = exec('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0)
    throw new Stop(
      '核对',
      `在 ${dir} 里认 git 目录没成：${(common.stderr || common.stdout).trim().slice(0, 200)}`,
    );
  const main = dirname(common.stdout.trim());
  const top = exec('git', ['-C', main, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !samePath(resolve(top.stdout.trim()), main))
    throw new Stop('核对', `git-common-dir 的上一级 ${main} 不是主检出，用 --repo 指定`);
  return resolve(main);
}

/**
 * 工作树所在的那棵树上派活的 mirasim 会话：~/.mirasim/sessions/<agent>/<id>/record.json 的
 * workdir 对上就认。多个取 updatedAt 最新的。sessionKey 是 <agent>:<sessionId>。
 * @param {string} sessionsRoot
 * @param {string} worktree
 * @returns {{ sessionKey: string, agent: string, id: string } | null}
 */
export function sessionForWorktree(sessionsRoot, worktree) {
  if (!existsSync(sessionsRoot)) return null;
  /** @type {{ sessionKey: string, agent: string, id: string, updatedAt: string } | null} */
  let best = null;
  for (const agent of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, agent);
    /** @type {string[]} */
    let ids;
    try {
      ids = readdirSync(dir);
    } catch {
      continue;
    }
    for (const id of ids) {
      /** @type {Record<string, unknown>} */
      let rec;
      try {
        rec = JSON.parse(readFileSync(join(dir, id, 'record.json'), 'utf8'));
      } catch {
        continue;
      }
      const workdir = typeof rec.workdir === 'string' ? rec.workdir : '';
      if (!workdir || !samePath(workdir, worktree)) continue;
      const sessionId = typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : id;
      const updatedAt = typeof rec.updatedAt === 'string' ? rec.updatedAt : '';
      if (!best || updatedAt > best.updatedAt)
        best = { sessionKey: `${agent}:${sessionId}`, agent, id, updatedAt };
    }
  }
  return best;
}

/**
 * @param {string} text gh pr view --json headRefName 的 stdout
 * @returns {string}
 */
export function headBranch(text) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Stop('核对', 'gh pr view 的输出不是 JSON');
  }
  const name =
    parsed && typeof parsed === 'object' && typeof parsed.headRefName === 'string' ? parsed.headRefName : '';
  if (!name) throw new Stop('核对', 'gh pr view 里没有 headRefName');
  return name;
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
export async function prMergeRun(argv, io = {}) {
  const exec = io.exec ?? realExec;
  const env = io.env ?? process.env;
  const log = io.log ?? ((line) => console.log(line));
  try {
    const opt = parseArgs(argv);
    const main = resolveMain(exec, opt.repo);
    const view = exec('gh', ['pr', 'view', opt.pr, '--json', 'headRefName,state'], { cwd: main });
    if (view.code !== 0)
      throw new Stop(
        '核对',
        `gh pr view ${opt.pr} 没成：${(view.stderr || view.stdout).trim().slice(0, 300)}`,
      );
    const branch = headBranch(view.stdout);

    const listed = exec('git', ['-C', main, 'worktree', 'list', '--porcelain']);
    if (listed.code !== 0)
      throw new Stop('核对', `列出工作树没成：${(listed.stderr || listed.stdout).trim().slice(0, 200)}`);
    const mine = parseWorktrees(listed.stdout).filter(
      (t) => t.branch === `refs/heads/${branch}` && !samePath(t.path, main),
    );
    const worktree = mine[0]?.path ?? null;

    const sessionsRoot = join(env.USERPROFILE || env.HOME || homedir(), '.mirasim', 'sessions');
    const session = worktree && existsSync(worktree) ? sessionForWorktree(sessionsRoot, worktree) : null;
    if (session) log(`[会话] ${session.sessionKey} 在这棵工作树上派过活，合并后删掉`);
    else log('[会话] 没有对得上工作树的会话；工作树已删但会话还在的，用 pnpm leftovers 查');

    const args = ['--repo', main, '--branch', branch, '--pr', opt.pr];
    if (session) args.push('--session', session.sessionKey);
    return await closeRun(args, {
      exec,
      fetch: io.fetch,
      env,
      log,
      deleteSession: io.deleteSession,
    });
  } catch (err) {
    if (err instanceof Stop) {
      log(`停在：${err.step}`);
      log(`下一步：${err.next}`);
      return err.code;
    }
    throw err;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  process.exitCode = await prMergeRun(process.argv.slice(2));
}
