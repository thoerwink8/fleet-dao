// 会话页的 git 面板（#3926）。暂存、提交、拉取是本机 git。
// 推、开 PR、合并只新增 change.* 行，不另写一条绕过 outbox 的推送。
// GitLab 领到就停。删工作树要人确认，running 或有没提交的改动就不删。
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Forge, type OutboxKind, opKey } from '@fleet-dao/harness-contract';
import { makeRedactor } from '@fleet-dao/harness-runner';
import {
  type AdeSessionRow,
  type Db,
  enqueueOp,
  getAdeWorkspace,
  getOp,
  listAdeSessions,
  listOpsForTask,
} from '@fleet-dao/harness-store';
import { runCommand } from '../command.ts';
import { localOutboxDeps, processOutbox } from '../publish.ts';
import {
  branchInfo,
  type ChangeKind,
  commitStaged,
  defaultBase,
  fileDiffs,
  type GhPr,
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

async function describeWorktrees(ctx: GitCtx, repo: string, primaryPath: string): Promise<WorktreeInfo[]> {
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
      const merged = base ? await isAncestorOf(wt.path, base).catch(() => false) : false;
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
    : { branch: '', upstream: null, ahead: null, behind: null };
  let files: GitSnapshot['files'] = [];
  if (diff.git) {
    try {
      files = parsePorcelain(await statusZ(session.cwd));
    } catch {
      files = [];
    }
  }
  const worktrees = ws.isGit ? await describeWorktrees(ctx, ws.path, ws.path) : [];
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
    upstream: info.upstream,
    ahead: info.ahead,
    behind: info.behind,
    files,
    worktrees,
    forge: ws.forge,
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
  const forge = asForge(ws.forge);
  try {
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
    if (op === 'checks') return readChecks(session.cwd);
    if (op === 'worktree-remove') return removeSome(ctx, session, ws.path, body);
    if (forge === 'gitlab') throw new GitPanelError('gitlab 还没实现', 501);
    const info = await branchInfo(session.cwd);
    rejectBranch(info.branch);
    if (op === 'push') {
      const diff = await worktreeDiff(session.cwd);
      const pushed = await enqueueChange(ctx, session, forge, 'change.push', {
        patch: diff.diff,
        branch: info.branch,
        ...(forge === 'local' ? { adeCwd: session.cwd } : {}),
      });
      const notice = pushed.state === 'done' ? '已推送' : '已排进 outbox';
      return { ...(await gitSnapshot(ctx, session)), notice };
    }
    if (op === 'pr') {
      const title = (typeof body.title === 'string' ? body.title.trim() : '') || session.title || info.branch;
      const opened = await enqueueChange(ctx, session, forge, 'change.pr.open', {
        branch: info.branch,
        title,
      });
      const notice = opened.state === 'done' ? '已记下开 PR' : '开 PR 已排进 outbox';
      return { ...(await gitSnapshot(ctx, session)), notice };
    }
    const merged = await enqueueChange(ctx, session, forge, 'change.merge', { branch: info.branch });
    const notice = merged.state === 'done' ? '已记下合并，没有在本地合并' : '合并已排进 outbox';
    return { ...(await gitSnapshot(ctx, session)), notice };
  } catch (err) {
    lift(err);
  }
}

async function readChecks(cwd: string): Promise<{ pr: GhPr | null; reason: string }> {
  const r = await runCommand({
    command: ['gh', 'pr', 'view', '--json', 'number,url,state,statusCheckRollup'],
    cwd,
    timeoutMs: 20_000,
    redact: makeRedactor([]),
  });
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
