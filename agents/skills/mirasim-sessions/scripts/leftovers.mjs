// 残留盘点（pnpm leftovers）：只列不删。列两样——
//   工作树：分支、对应 PR 是否已合并、有没有未提交改动；
//   mirasim 会话：回报发没发（turns.jsonl 里的「ok 已发给」）、还在不在跑、workdir 在不在。
// 删除只走收单入口 pnpm pr:merge / close.mjs，那里先核「已合并、无未提交」才删；这条命令永不删。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SENT_MARK } from './check-reports.mjs';
import { parseWorktrees, remoteHost, samePath } from './close.mjs';
import { realExec, resolveMain } from './pr-merge.mjs';

export const USAGE = `用法：pnpm leftovers（= node leftovers.mjs [--repo <主检出>] [--sessions <会话目录>])
只读：列出工作树和 mirasim 会话的残留。删用 pnpm pr:merge <PR 号>。`;

/** @typedef {{ code: number, stdout: string, stderr: string }} ExecResult */
/** @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }) => ExecResult} Exec */

/**
 * @param {string[]} argv
 * @returns {{ repo: string, sessions: string | null }}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let repo;
  /** @type {string | undefined} */
  let sessions;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--repo' || token === '--sessions') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 缺值\n${USAGE}`);
      if (token === '--repo' ? repo !== undefined : sessions !== undefined)
        throw new Error(`${token} 写了两次\n${USAGE}`);
      if (token === '--repo') repo = value;
      else sessions = value;
      i += 1;
      continue;
    }
    throw new Error(`不认识的参数 ${token}\n${USAGE}`);
  }
  return { repo: resolve(repo ?? '.'), sessions: sessions ?? null };
}

/**
 * 一棵工作树的残留状态。branch 为 null 的是游离 HEAD。
 * @param {Exec} exec
 * @param {string} main
 * @param {{ path: string, branch: string | null }} tree
 * @param {boolean} github 有没有 github.com 远端
 * @returns {{ path: string, branch: string, pr: string, dirty: string, verdict: string }}
 */
export function worktreeRow(exec, main, tree, github) {
  const branch = tree.branch ? tree.branch.replace(/^refs\/heads\//, '') : '(游离)';
  let dirty = '?';
  const st = exec('git', ['-C', tree.path, 'status', '--porcelain', '--untracked-files=all']);
  if (st.code === 0) dirty = st.stdout.trim() ? '有未提交' : '干净';
  let pr = '-';
  let verdict = '';
  if (tree.branch && github) {
    const list = exec(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '5', '--json', 'number,state'],
      { cwd: main },
    );
    if (list.code === 0) {
      /** @type {{ number: number, state: string }[]} */
      let prs = [];
      try {
        const parsed = JSON.parse(list.stdout);
        if (Array.isArray(parsed)) prs = parsed;
      } catch {
        prs = [];
      }
      const merged = prs.find((p) => p.state === 'MERGED');
      const open = prs.find((p) => p.state === 'OPEN');
      if (merged) pr = `#${merged.number} 已合并`;
      else if (open) pr = `#${open.number} 开着`;
      else if (prs.length) pr = `#${prs[0].number} ${prs[0].state}`;
    } else pr = '读不了';
  }
  if (dirty === '?') verdict = '状态读不了';
  else if (dirty === '有未提交') verdict = '留着：有未提交改动';
  else if (pr.endsWith('已合并')) verdict = '残留：已合并，收它用 pnpm pr:merge ' + pr.match(/\d+/)?.[0];
  else if (pr === '-') verdict = '没对到 PR，不删';
  else verdict = '留着：PR 没合并';
  return { path: tree.path, branch, pr, dirty, verdict };
}

/**
 * 一个会话目录的残留状态。
 * @param {string} dir <agent>/<id>
 * @returns {{ key: string, runState: string, reported: boolean, workdir: string, workdirGone: boolean, title: string } | null}
 */
export function sessionRow(dir) {
  /** @type {Record<string, unknown>} */
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  } catch {
    return null;
  }
  let turns = '';
  try {
    turns = readFileSync(join(dir, 'turns.jsonl'), 'utf8');
  } catch {
    // 没有轮记录：没跑起来
  }
  const workdir = typeof rec.workdir === 'string' ? rec.workdir : '';
  return {
    key: typeof rec.sessionId === 'string' ? rec.sessionId : '',
    runState: typeof rec.runState === 'string' ? rec.runState : '?',
    reported: turns.includes(SENT_MARK),
    workdir,
    workdirGone: Boolean(workdir) && !existsSync(workdir),
    title: typeof rec.title === 'string' ? rec.title.slice(0, 60) : '',
  };
}

/**
 * @param {string[]} argv
 * @param {{ exec?: Exec, env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [io]
 * @returns {number} 永远是 0：这是只读盘点，列出来不是失败。
 */
export function leftoversRun(argv, io = {}) {
  const exec = io.exec ?? realExec;
  const env = io.env ?? process.env;
  const log = io.log ?? ((line) => console.log(line));
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 2;
  }
  let main;
  try {
    main = resolveMain(exec, opt.repo);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const listed = exec('git', ['-C', main, 'worktree', 'list', '--porcelain']);
  if (listed.code !== 0) {
    log(`列工作树没成：${(listed.stderr || listed.stdout).trim().slice(0, 200)}`);
    return 2;
  }
  const remoteUrl = exec('git', ['-C', main, 'remote', 'get-url', 'origin']);
  const github = remoteUrl.code === 0 && remoteHost(remoteUrl.stdout)?.host === 'github.com';
  const trees = parseWorktrees(listed.stdout).filter((t) => !samePath(t.path, main));

  log('== 工作树 ==');
  if (!trees.length) log('（主检出以外没有工作树）');
  for (const tree of trees) {
    const row = worktreeRow(exec, main, tree, github);
    log(`${row.branch}\tPR:${row.pr}\t${row.dirty}\t${row.verdict}\t${row.path}`);
  }

  const sessionsRoot = opt.sessions ?? join(env.USERPROFILE || env.HOME || homedir(), '.mirasim', 'sessions');
  log('== mirasim 会话 ==');
  let found = 0;
  if (existsSync(sessionsRoot)) {
    for (const agent of readdirSync(sessionsRoot)) {
      const agentDir = join(sessionsRoot, agent);
      let ids;
      try {
        ids = readdirSync(agentDir);
      } catch {
        continue;
      }
      for (const id of ids) {
        const row = sessionRow(join(agentDir, id));
        if (!row) continue;
        found += 1;
        const key = `${agent}:${row.key || id}`;
        let verdict;
        if (row.runState === 'running') verdict = '在跑';
        else if (!row.reported) verdict = '收轮了没发回报（巡检 ALERT 的那类）';
        else verdict = '发过回报：残留，处理完报回时收单删掉';
        if (row.workdirGone) verdict += '；workdir 已不在';
        log(
          `${key}\t${row.runState}\t${row.reported ? '已回报' : '未回报'}\t${verdict}\t${row.workdir || row.title}`,
        );
      }
    }
  }
  if (!found) log('（没有会话目录）');
  return 0;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = leftoversRun(process.argv.slice(2));
}
