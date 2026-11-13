// 会话页的 git 面板（#3926、#3948、#3944）。暂存、提交、拉取是本机 git。
// 推、开 PR、合并先入 change.* outbox，不另写一条绕过 outbox 的推送。
// forge=github 由这次点击领走并做完（gh）。forge=gitlab 走同一套 change.*，用 GitLab 接口开 MR、读流水线、按看到的 head 合并。
// 合并要带上看到的 head。删工作树要人确认。分支有已合并的 PR 就算已合并；没有 PR 再看是不是祖先，或改动已经在 main 上。
// running 或有没提交的改动就不删。内核自动发布领到的 GitLab 仍不做。
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Forge, type OutboxKind, opKey } from '@fleet-dao/harness-contract';
import { makeRedactor } from '@fleet-dao/harness-runner';
import {
  type AdeSessionRow,
  claimOpByKey,
  completeOp,
  type Db,
  enqueueOp,
  failOp,
  getAdeWorkspace,
  getOp,
  listAdeSessions,
  listOpsForTask,
} from '@fleet-dao/harness-store';
import { localOutboxDeps, processOutbox } from '../publish.ts';
import {
  branchInfo,
  type ChangeKind,
  changesLanded,
  commitStaged,
  defaultBase,
  fileDiffs,
  type GhPr,
  inspectRepo,
  isAncestorOf,
  isClean,
  listWorktrees,
  parseGhPr,
  parsePorcelain,
  pullFf,
  removeWorktree,
  stagePaths,
  statusZ,
  unstagePaths,
  worktreeDiff,
} from './git.ts';
import {
  type CmdRun,
  defaultGithubRun,
  mergePullRequest,
  openPullRequest,
  pushCurrentBranch,
} from './github-ops.ts';
import { gitlabTokenPath, loadGitlabHosts, readGitlabToken } from './gitlab-hosts.ts';
import {
  defaultGitlabFetch,
  defaultGitlabRun,
  type GitlabFetch,
  gitlabMergeBody,
  mergeGitlabMr,
  openGitlabMr,
  parseGitlabRemote,
  pushGitlabBranch,
  readGitlabMr,
} from './gitlab-ops.ts';

export class GitPanelError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitPanelError';
    this.status = status;
  }
}

export interface GitCtx {
  db: Db;
  dataDir: string;
  /** 测试注入。不给就走 runCommand。 */
  run?: CmdRun;
  /** 测试注入的 GitLab 响应。不给就走 fetch。 */
  gitlab?: GitlabFetch;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  primary: boolean;
  clean: boolean;
  merged: boolean;
  idle: boolean;
  removable: boolean;
  reason: string;
}

export interface GitSnapshot {
  git: boolean;
  status: string;
  diff: string;
  branch: string;
  head: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: { path: string; origPath?: string; staged: ChangeKind | null; unstaged: ChangeKind | null }[];
  worktrees: WorktreeInfo[];
  forge: string;
  ops: { key: string; kind: string; state: string }[];
  notice?: string;
}

const OPS = new Set([
  'stage',
  'unstage',
  'commit',
  'pull',
  'push',
  'pr',
  'merge',
  'diff',
  'checks',
  'worktree-remove',
]);

function lift(err: unknown): never {
  if (err instanceof GitPanelError) throw err;
  throw new GitPanelError(err instanceof Error ? err.message : '没做成', 400);
}

function asForge(v: string): Forge {
  if (v === 'github' || v === 'gitlab' || v === 'local') return v;
  return 'local';
}

async function canon(p: string): Promise<string> {
  try {
    const r = await realpath(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch {
    const r = resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  }
}

function pathsOf(body: Record<string, unknown>): string[] {
  const v = body.paths;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
    throw new GitPanelError('paths 要是字符串数组', 400);
  if (v.length === 0) throw new GitPanelError('没指定文件', 400);
  if (v.length > 200) throw new GitPanelError('一次最多 200 个文件', 400);
  return v as string[];
}

/** main / master 不推。别的只允许字母、数字和 . _ / -。 */
export function rejectBranch(name: string): void {
  if (
    name === '' ||
    name === 'HEAD' ||
    name === 'main' ||
    name === 'master' ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(name)
  ) {
    throw new GitPanelError(name === 'main' || name === 'master' ? '不动 main' : '这个分支不能推', 400);
  }
}

async function workspaceOf(ctx: GitCtx, session: AdeSessionRow) {
  const ws = await getAdeWorkspace(ctx.db, session.workspaceId);
  if (!ws) throw new GitPanelError('工作区没了', 404);
  return ws;
}

async function pullRequestState(run: CmdRun, cwd: string): Promise<string | null> {
  const r = await run(cwd, ['gh', 'pr', 'view', '--json', 'state']);
  if (!r.ran || r.exitCode !== 0) return null;
  const line = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{'))
    .at(-1);
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || !('state' in value)) return null;
    const state = value.state;
    return typeof state === 'string' && state ? state : null;
  } catch {
    return null;
  }
}

/** 有对应 PR 且已合并就算已合并。没有 PR 时再看祖先，以及改动是不是已经在 base 上。 */
async function worktreeMerged(
  path: string,
  branch: string,
  base: string | null,
  forge: string,
  run: CmdRun,
): Promise<boolean> {
  if (forge === 'github' && branch && branch !== 'main' && branch !== 'master') {
    const state = await pullRequestState(run, path);
    if (state) return state === 'MERGED';
  }
  if (!base) return false;
  if (await isAncestorOf(path, base).catch(() => false)) return true;
  return changesLanded(path, base).catch(() => false);
}

async function describeWorktrees(
  ctx: GitCtx,
  repo: string,
  primaryPath: string,
  forge: string,
): Promise<WorktreeInfo[]> {
  const [listed, base, sessions] = await Promise.all([
    listWorktrees(repo),
    defaultBase(repo),
    listAdeSessions(ctx.db),
  ]);
  const primaryKey = await canon(primaryPath);
  const byCwd = new Map<string, AdeSessionRow[]>();
  for (const s of sessions) {
    const key = await canon(s.cwd);
    const list = byCwd.get(key) ?? [];
    list.push(s);
    byCwd.set(key, list);
  }
  const rows = await Promise.all(
    listed.slice(0, 50).map(async (wt) => {
      const key = await canon(wt.path);
      const here = byCwd.get(key) ?? [];
      const running = here.find((s) => s.status === 'running');
      const primary = key === primaryKey;
      const clean = await isClean(wt.path).catch(() => false);
      const merged = await worktreeMerged(wt.path, wt.branch, base, forge, ctx.run ?? defaultGithubRun);
      const idle = !running;
      const bits: string[] = [];
      if (primary) bits.push('主检出');
      if (!merged) bits.push('还没合并');
      if (!clean) bits.push('有没提交的改动');
      if (running) bits.push(`会话 ${running.id} 还在跑`);
      if (bits.length === 0) bits.push('已合并、干净、闲置');
      return {
        path: wt.path,
        branch: wt.branch,
        primary,
        clean,
        merged,
        idle,
        removable: !primary && clean && merged && idle,
        reason: bits.join('，'),
      };
    }),
  );
  return rows;
}

export async function gitSnapshot(ctx: GitCtx, session: AdeSessionRow): Promise<GitSnapshot> {
  const ws = await workspaceOf(ctx, session);
  const diff = await worktreeDiff(session.cwd);
  const info = diff.git
    ? await branchInfo(session.cwd)
    : { branch: '', upstream: null, ahead: null, behind: null, head: '' };
  let files: GitSnapshot['files'] = [];
  if (diff.git) {
    try {
      files = parsePorcelain(await statusZ(session.cwd));
    } catch {
      files = [];
    }
  }
  const seen = await seenForge(ctx, session.cwd, ws.forge);
  const worktrees = ws.isGit ? await describeWorktrees(ctx, ws.path, ws.path, seen.forge) : [];
  const issue = session.taskId && session.taskId > 0 ? session.taskId : 1;
  let ops: GitSnapshot['ops'] = [];
  try {
    const all = await listOpsForTask(ctx.db, { repo: `local/${ws.id}`, issue }, 30);
    ops = all
      .filter((o) => o.payload.sessionId === session.id)
      .slice(-8)
      .map((o) => ({ key: o.opKey, kind: o.kind, state: o.state }));
  } catch {
    ops = [];
  }
  return {
    git: diff.git,
    status: diff.status,
    diff: diff.diff,
    branch: info.branch,
    head: info.head,
    upstream: info.upstream,
    ahead: info.ahead,
    behind: info.behind,
    files,
    worktrees,
    forge: seen.forge,
    ops,
  };
}

async function enqueueChange(
  ctx: GitCtx,
  session: AdeSessionRow,
  forge: Forge,
  kind: OutboxKind,
  extra: Record<string, unknown>,
): Promise<{ opKey: string; state: string }> {
  if (forge === 'gitlab') throw new GitPanelError('gitlab 还没实现', 501);
  const ws = await workspaceOf(ctx, session);
  const issue = session.taskId && session.taskId > 0 ? session.taskId : 1;
  const ref = { repo: `local/${ws.id}`, issue };
  const key = opKey(kind, ref, 0, `${session.id}-${randomBytes(4).toString('hex')}`);
  await enqueueOp(ctx.db, {
    opKey: key,
    kind,
    ref,
    fencing: 0,
    payload: { forge, sessionId: session.id, ...extra },
  });
  if (forge !== 'local') {
    const op = await getOp(ctx.db, key);
    return { opKey: key, state: op?.state ?? 'pending' };
  }
  const deps = localOutboxDeps(ctx.db, join(ctx.dataDir, 'outbox'), makeRedactor([]));
  deps.batch = 50;
  let why = '';
  deps.onError = (err) => {
    why = err instanceof Error ? err.message : String(err);
  };
  await processOutbox(deps);
  const op = await getOp(ctx.db, key);
  if (op?.state !== 'done') throw new GitPanelError(why || '外送没做成', 400);
  return { opKey: key, state: 'done' };
}

/** 这一下：先入 outbox，只领这一条，做成再标完成。对不上 head 就 409，行进 dead。 */
async function runTracked(
  ctx: GitCtx,
  session: AdeSessionRow,
  forge: Forge,
  kind: OutboxKind,
  extra: Record<string, unknown>,
  fallback: CmdRun,
  exec: (run: CmdRun) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const ws = await workspaceOf(ctx, session);
  const issue = session.taskId && session.taskId > 0 ? session.taskId : 1;
  const ref = { repo: `local/${ws.id}`, issue };
  const key = opKey(kind, ref, 0, `${session.id}-${randomBytes(4).toString('hex')}`);
  await enqueueOp(ctx.db, {
    opKey: key,
    kind,
    ref,
    fencing: 0,
    payload: { forge, sessionId: session.id, adeCwd: session.cwd, ...extra },
  });
  const claimed = await claimOpByKey(ctx.db, key, 60_000);
  if (!claimed) throw new GitPanelError('外送没领到', 500);
  try {
    const result = await exec(ctx.run ?? fallback);
    await completeOp(ctx.db, claimed, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : '没做成';
    try {
      await failOp(ctx.db, claimed, msg.slice(0, 1000), 0, 0);
    } catch {
      // 租约已经没了，不再改这条
    }
    throw new GitPanelError(msg, msg.includes('新提交') ? 409 : 400);
  }
}

async function seenForge(
  ctx: GitCtx,
  cwd: string,
  stored: string,
): Promise<{ forge: Forge; remote: string | null; hosts: string[] }> {
  const hosts = await loadGitlabHosts(ctx.dataDir);
  const looked = await inspectRepo(cwd, hosts);
  return { forge: looked.isGit ? looked.forge : asForge(stored), remote: looked.remote, hosts };
}

async function gitlabCred(
  ctx: GitCtx,
  remote: string | null,
): Promise<{ token: string; tokenFile: string } | null> {
  if (!remote) throw new GitPanelError('没有 origin', 400);
  const { host } = parseGitlabRemote(remote);
  const token = await readGitlabToken(ctx.dataDir, host);
  if (!token) return null;
  return { token, tokenFile: gitlabTokenPath(ctx.dataDir, host) };
}

export async function gitAct(
  ctx: GitCtx,
  session: AdeSessionRow,
  body: Record<string, unknown>,
): Promise<
  | GitSnapshot
  | { path: string; staged: string; unstaged: string; untracked: string }
  | { pr: GhPr | null; reason: string }
> {
  const op = body.op;
  if (typeof op !== 'string' || !OPS.has(op)) throw new GitPanelError('不认识的操作', 400);
  const ws = await workspaceOf(ctx, session);
  try {
    const seen = await seenForge(ctx, session.cwd, ws.forge);
    const forge = seen.forge;
    if (op === 'stage') {
      await stagePaths(session.cwd, pathsOf(body));
      return { ...(await gitSnapshot(ctx, session)), notice: '已暂存' };
    }
    if (op === 'unstage') {
      await unstagePaths(session.cwd, pathsOf(body));
      return { ...(await gitSnapshot(ctx, session)), notice: '已取消暂存' };
    }
    if (op === 'commit') {
      const message = typeof body.message === 'string' ? body.message : '';
      await commitStaged(session.cwd, message);
      return { ...(await gitSnapshot(ctx, session)), notice: '已提交' };
    }
    if (op === 'pull') {
      await pullFf(session.cwd);
      return { ...(await gitSnapshot(ctx, session)), notice: '已拉取' };
    }
    if (op === 'diff') {
      const path = typeof body.path === 'string' ? body.path : '';
      return await fileDiffs(session.cwd, path);
    }
    if (op === 'checks') return readChecks(ctx, session.cwd, forge, seen.remote, seen.hosts);
    if (op === 'worktree-remove') return removeSome(ctx, session, ws.path, body);
    const info = await branchInfo(session.cwd);
    rejectBranch(info.branch);
    if (op === 'push') {
      const diff = await worktreeDiff(session.cwd);
      if (forge === 'github') {
        await runTracked(
          ctx,
          session,
          'github',
          'change.push',
          { patch: diff.diff, branch: info.branch },
          defaultGithubRun,
          (run) => pushCurrentBranch(run, session.cwd, info.branch),
        );
      } else if (forge === 'gitlab') {
        const cred = await gitlabCred(ctx, seen.remote);
        await runTracked(
          ctx,
          session,
          'gitlab',
          'change.push',
          { patch: diff.diff, branch: info.branch },
          defaultGitlabRun(cred?.tokenFile ?? null, cred?.token ?? null),
          (run) =>
            pushGitlabBranch(run, session.cwd, info.branch, {
              tokenFile: cred?.tokenFile ?? null,
              hosts: seen.hosts,
            }),
        );
      } else {
        await enqueueChange(ctx, session, forge, 'change.push', {
          patch: diff.diff,
          branch: info.branch,
          adeCwd: session.cwd,
        });
      }
      return { ...(await gitSnapshot(ctx, session)), notice: '已推送' };
    }
    if (op === 'pr') {
      const title = (typeof body.title === 'string' ? body.title.trim() : '') || session.title || info.branch;
      if (forge === 'github') {
        const opened = await runTracked(
          ctx,
          session,
          'github',
          'change.pr.open',
          { branch: info.branch, title },
          defaultGithubRun,
          (run) => openPullRequest(run, session.cwd, info.branch, title),
        );
        const notice =
          opened.opened === false ? `这个分支已经有 PR #${opened.number}` : `已开 PR #${opened.number}`;
        return { ...(await gitSnapshot(ctx, session)), notice };
      }
      if (forge === 'gitlab') {
        const cred = await gitlabCred(ctx, seen.remote);
        if (!cred || !seen.remote) throw new GitPanelError('缺 GitLab 令牌', 400);
        const opened = await runTracked(
          ctx,
          session,
          'gitlab',
          'change.pr.open',
          { branch: info.branch, title },
          defaultGitlabRun(cred.tokenFile, cred.token),
          () =>
            openGitlabMr(
              ctx.gitlab ?? defaultGitlabFetch,
              cred.token,
              seen.remote ?? '',
              info.branch,
              title,
              seen.hosts,
            ),
        );
        const notice =
          opened.opened === false ? `这个分支已经有 MR #${opened.number}` : `已开 MR #${opened.number}`;
        return { ...(await gitSnapshot(ctx, session)), notice };
      }
      await enqueueChange(ctx, session, forge, 'change.pr.open', { branch: info.branch, title });
      return { ...(await gitSnapshot(ctx, session)), notice: '已记下开 PR' };
    }
    if (op !== 'merge') throw new GitPanelError('不认识的操作', 400);
    if (forge === 'github') {
      if (body.confirm !== true) return { ...(await gitSnapshot(ctx, session)), notice: '还没合并，先确认' };
      const head = typeof body.head === 'string' ? body.head.trim() : '';
      if (!/^[0-9a-f]{40}$/.test(head)) throw new GitPanelError('要带上看到的 head', 400);
      const merged = await runTracked(
        ctx,
        session,
        'github',
        'change.merge',
        { branch: info.branch, expectedHead: head },
        defaultGithubRun,
        (run) => mergePullRequest(run, session.cwd, head),
      );
      return { ...(await gitSnapshot(ctx, session)), notice: `已合并 PR #${merged.number}` };
    }
    if (forge === 'gitlab') {
      if (body.confirm !== true) return { ...(await gitSnapshot(ctx, session)), notice: '还没合并，先确认' };
      const head = typeof body.head === 'string' ? body.head.trim() : '';
      const method = typeof body.method === 'string' && body.method.trim() ? body.method.trim() : 'merge';
      try {
        gitlabMergeBody(method, head);
      } catch (err) {
        throw new GitPanelError(err instanceof Error ? err.message : '这个合并方式不行', 400);
      }
      const cred = await gitlabCred(ctx, seen.remote);
      if (!cred) throw new GitPanelError('缺 GitLab 令牌', 400);
      const merged = await runTracked(
        ctx,
        session,
        'gitlab',
        'change.merge',
        { branch: info.branch, expectedHead: head, method },
        defaultGitlabRun(cred.tokenFile, cred.token),
        (run) =>
          mergeGitlabMr(
            run,
            ctx.gitlab ?? defaultGitlabFetch,
            cred.token,
            session.cwd,
            head,
            method,
            seen.hosts,
          ),
      );
      return { ...(await gitSnapshot(ctx, session)), notice: `已合并 MR #${merged.number}` };
    }
    await enqueueChange(ctx, session, forge, 'change.merge', { branch: info.branch });
    return { ...(await gitSnapshot(ctx, session)), notice: '已记下合并，没有在本地合并' };
  } catch (err) {
    lift(err);
  }
}

async function readChecks(
  ctx: GitCtx,
  cwd: string,
  forge: Forge,
  remote: string | null,
  hosts: readonly string[],
): Promise<{ pr: GhPr | null; reason: string }> {
  if (forge === 'gitlab') {
    if (!remote) return { pr: null, reason: '没有 origin' };
    const cred = await gitlabCred(ctx, remote);
    if (!cred) return { pr: null, reason: '缺 GitLab 令牌' };
    const info = await branchInfo(cwd);
    try {
      const mr = await readGitlabMr(ctx.gitlab ?? defaultGitlabFetch, cred.token, remote, info.branch, hosts);
      if (!mr) return { pr: null, reason: '没有 MR' };
      return { pr: { number: mr.number, url: mr.url, state: mr.state, checks: mr.checks }, reason: '' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '读 CI 没成';
      return { pr: null, reason: msg.slice(0, 200) };
    }
  }
  const run = ctx.run;
  const r = await (run ?? defaultGithubRun)(cwd, [
    'gh',
    'pr',
    'view',
    '--json',
    'number,url,state,statusCheckRollup',
  ]);
  if (!r.ran || r.exitCode !== 0) {
    const why = (r.stderrTail || r.stdout || r.spawnError || '没有 PR').trim().slice(-200);
    return { pr: null, reason: why || '没有 PR' };
  }
  try {
    const pr = parseGhPr(JSON.parse(r.stdout));
    return pr ? { pr, reason: '' } : { pr: null, reason: 'CI 认不出' };
  } catch {
    return { pr: null, reason: 'CI 读到的不是 JSON' };
  }
}

async function removeSome(
  ctx: GitCtx,
  session: AdeSessionRow,
  repo: string,
  body: Record<string, unknown>,
): Promise<GitSnapshot> {
  const snap = await gitSnapshot(ctx, session);
  if (body.confirm !== true) return { ...snap, notice: '还没删，先看预览' };
  const want = pathsOf(body);
  const wanted = new Set(await Promise.all(want.map((p) => canon(p))));
  const targets = [];
  for (const row of snap.worktrees) {
    if (wanted.has(await canon(row.path))) targets.push(row);
  }
  if (targets.length !== want.length) throw new GitPanelError('名单里有不认识的工作树', 400);
  const blocked = targets.find((row) => !row.removable);
  if (blocked) {
    const running = blocked.reason.includes('还在跑');
    throw new GitPanelError(blocked.reason, running ? 409 : 400);
  }
  for (const row of targets) {
    try {
      await removeWorktree(repo, row.path);
    } catch (err) {
      lift(err);
    }
  }
  return { ...(await gitSnapshot(ctx, session)), notice: `删了 ${targets.length} 棵工作树` };
}
