// 会话目录里的 git，一律以会话用户的身份跑（经 exec.ts）：从 bundle 建树、看头和改动、把新提交打成 bundle 交出来、
// 并主线后快进。git 没跑成一律抛 PortError（带白话原因），不拿空字符串、空列表冒充「没有改动」。

import type { SessionUser } from '@fleet-dao/adapters';
import { PortError } from '../ports.ts';
import { describeFailure, type UserCommandResult, type UserExec } from './exec.ts';

export const GIT = '/usr/bin/git';
const SH = '/bin/sh';

/** 在哪个目录、以谁的身份跑。scopePrefix 拼 scope 编号：同一时刻不许重复，所以每条命令再加序号。 */
export interface UserTree {
  exec: UserExec;
  user: SessionUser;
  dir: string;
  scopePrefix: string;
  git?: string;
  sh?: string;
  signal?: AbortSignal;
}

let seq = 0;
function scopeIdFor(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)}-g${seq}`;
}

const GIT_ENV = { LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0' };

async function run(
  t: UserTree,
  argv: string[],
  options: { stdin?: Buffer; timeoutMs?: number } = {},
): Promise<UserCommandResult> {
  return t.exec({
    user: t.user,
    cwd: t.dir,
    argv,
    ...(options.stdin ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(t.signal ? { signal: t.signal } : {}),
    scopeId: scopeIdFor(t.scopePrefix),
    env: GIT_ENV,
  });
}

async function git(
  t: UserTree,
  args: string[],
  what: string,
  options: { stdin?: Buffer; timeoutMs?: number; allow?: number[] } = {},
): Promise<UserCommandResult> {
  const r = await run(t, [t.git ?? GIT, ...args], options);
  if (r.code === 0 || (r.code !== null && options.allow?.includes(r.code))) return r;
  throw new PortError('GIT_FAILED', describeFailure(what, r), {
    retryable: !r.aborted,
    details: { user: t.user, dir: t.dir },
  });
}

const text = (r: UserCommandResult) => r.stdout.toString('utf8');
const lines = (r: UserCommandResult) =>
  text(r)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);

const SHA = /^[0-9a-f]{40}$/;

function assertSha(sha: string, what: string): void {
  if (!SHA.test(sha))
    throw new PortError('BAD_INPUT', `${what} 不是完整的提交号：${sha}`, { retryable: false });
}

/** 目录里有没有 git 仓（.git 在不在）。 */
export async function hasRepo(t: UserTree): Promise<boolean> {
  const r = await run(t, [t.git ?? GIT, 'rev-parse', '--git-dir']);
  if (r.code === 0) return true;
  if (r.code === 128) return false;
  throw new PortError('GIT_FAILED', describeFailure('看目录里有没有仓', r), { retryable: true });
}

export interface Identity {
  name: string;
  email: string;
}

/**
 * 从 bundle 取提交进目录里的仓：没有仓先 init（设好提交身份——会话的提交挂在「干活的」机器人名下）。
 * bundle 经标准输入进来，会话用户在自己的 .git 里落成临时文件再 fetch，fetch 完删掉。取完回 refs/fleet/incoming 的头。
 */
export async function fetchBundle(
  t: UserTree,
  bundle: Buffer,
  ref: string,
  options: { identity?: Identity } = {},
): Promise<string> {
  if (!/^refs\/fleet\/[A-Za-z0-9/_.-]+$/.test(ref)) {
    throw new PortError('BAD_INPUT', `bundle 里的引用名不对：${ref}`, { retryable: false });
  }
  if (!(await hasRepo(t))) {
    await git(t, ['init', '-q'], '建仓');
    if (options.identity) {
      await git(t, ['config', 'user.name', options.identity.name], '设提交身份');
      await git(t, ['config', 'user.email', options.identity.email], '设提交身份');
    }
    await git(t, ['config', 'commit.gpgsign', 'false'], '设提交身份');
  }
  const script =
    'f="$(git rev-parse --git-dir)/fleet-incoming.bundle" && cat > "$f" && ' +
    'git fetch --no-tags -q "$f" "+$1:refs/fleet/incoming"; rc=$?; rm -f "$f"; exit $rc';
  const r = await run(t, [t.sh ?? SH, '-c', script, 'sh', ref], { stdin: bundle, timeoutMs: 300_000 });
  if (r.code !== 0)
    throw new PortError('GIT_FAILED', describeFailure('从 bundle 取提交', r), { retryable: true });
  return headOfRef(t, 'refs/fleet/incoming');
}

async function headOfRef(t: UserTree, ref: string): Promise<string> {
  const r = await git(t, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], `读 ${ref}`);
  const sha = text(r).trim();
  assertSha(sha, ref);
  return sha;
}

/** 仓里有没有这个提交（换检出之前先看：已经有了就不用再从镜像取，取了反而是空包）。 */
export async function hasCommit(t: UserTree, sha: string): Promise<boolean> {
  assertSha(sha, '提交');
  const r = await run(t, [t.git ?? GIT, 'cat-file', '-e', `${sha}^{commit}`]);
  if (r.code === 0) return true;
  if (r.code === 1 || r.code === 128) return false;
  throw new PortError('GIT_FAILED', describeFailure('看仓里有没有这个提交', r), { retryable: true });
}

/** 把分支放到这个提交上并检出（新建的树用）。 */
export async function checkoutBranch(t: UserTree, branch: string, sha: string): Promise<void> {
  assertSha(sha, '检出的提交');
  await git(t, ['checkout', '-q', '-B', branch, sha], `检出 ${branch}`);
}

/** 只读的检出（分诊、写文档、审查用）：分离头、清掉上一轮留下的东西。 */
export async function checkoutDetached(t: UserTree, sha: string): Promise<void> {
  assertSha(sha, '检出的提交');
  await git(t, ['checkout', '-q', '--force', '--detach', sha], '检出');
  await git(t, ['clean', '-q', '-fdx'], '清掉上一轮的文件');
}

export async function headOf(t: UserTree): Promise<string> {
  return headOfRef(t, 'HEAD');
}

/** 树最后一次从引擎取进来的头（refs/fleet/incoming）：建树时的主线头，或并主线后的新头。引擎的镜像里一定有它，交 bundle 拿它当起点。 */
export async function headOfIncoming(t: UserTree): Promise<string> {
  return headOfRef(t, 'refs/fleet/incoming');
}

/** 没提交的已跟踪改动（交付判据：不许有）。 */
export async function uncommittedTracked(t: UserTree): Promise<string[]> {
  return lines(await git(t, ['status', '--porcelain', '--untracked-files=no'], '看有没有没提交的改动'));
}

/** base 之后改了哪些文件。 */
export async function changedFilesSince(t: UserTree, base: string): Promise<string[]> {
  assertSha(base, '起点');
  return lines(await git(t, ['diff', '--name-only', base, 'HEAD'], '列改动的文件'));
}

/** base 之后的提交（老的在前，最多 limit 条）。 */
export async function commitsSince(t: UserTree, base: string, limit = 50): Promise<string[]> {
  assertSha(base, '起点');
  return lines(await git(t, ['log', '--oneline', '--reverse', `-n${limit}`, `${base}..HEAD`], '列已提交的'));
}

export async function diffstatSince(t: UserTree, base: string, maxLines = 12): Promise<string[]> {
  assertSha(base, '起点');
  return lines(await git(t, ['diff', '--stat', base, 'HEAD'], '统计改动')).slice(-maxLines);
}

/** head 在不在 base 之后（base 是 head 的祖先）。 */
export async function isAncestor(t: UserTree, base: string, head: string): Promise<boolean> {
  assertSha(base, '起点');
  assertSha(head, '头');
  const r = await git(t, ['merge-base', '--is-ancestor', base, head], '看提交先后', { allow: [1] });
  return r.code === 0;
}

/**
 * 把 base 之后到 head 的提交打成 bundle 交出来（git bundle create - 写到标准输出）。
 * 没有新提交 git 拒绝打空包：先看，没有就明确报 EMPTY_DELIVERY，不交空包。
 */
export async function bundleSince(t: UserTree, head: string, base: string): Promise<Buffer> {
  assertSha(head, '头');
  assertSha(base, '起点');
  const count = Number(text(await git(t, ['rev-list', '--count', `${base}..${head}`], '数新提交')).trim());
  if (!Number.isInteger(count))
    throw new PortError('GIT_FAILED', '数新提交：输出认不出', { retryable: true });
  if (count === 0) {
    throw new PortError('EMPTY_DELIVERY', `起会话前的头 ${base.slice(0, 7)} 之后没有新提交`, {
      retryable: false,
    });
  }
  // bundle 里只收引用：光给提交号 git 会当成空包拒掉。先把头挂到一个临时引用上，打完删掉。
  await git(t, ['update-ref', OUTGOING_REF, head], '挂临时引用');
  try {
    const r = await git(t, ['bundle', 'create', '-', OUTGOING_REF, `^${base}`], '打 bundle', {
      timeoutMs: 300_000,
    });
    if (r.stdout.length === 0)
      throw new PortError('GIT_FAILED', '打 bundle：输出是空的', { retryable: true });
    return r.stdout;
  } finally {
    await run(t, [t.git ?? GIT, 'update-ref', '-d', OUTGOING_REF]);
  }
}

/** 交出去的 bundle 里头挂的引用名（引擎导入时只认提交号，不认这个名字）。 */
export const OUTGOING_REF = 'refs/fleet/outgoing';

/**
 * 并主线之后把工作树快进到新头：新提交经 bundle 取进来，merge --ff-only。
 * 会话在本地又提交了、快进不了回 diverged（交给调用方判：会话还有没推的活）；已经是新头回 already。
 */
export async function fastForward(
  t: UserTree,
  bundle: Buffer,
  ref: string,
  newHead: string,
): Promise<'fast-forwarded' | 'already' | 'diverged'> {
  assertSha(newHead, '新头');
  const current = await headOf(t);
  if (current === newHead) return 'already';
  const fetched = await fetchBundle(t, bundle, ref);
  if (fetched !== newHead) {
    throw new PortError(
      'GIT_FAILED',
      `bundle 里的头 ${fetched.slice(0, 7)} 不是要快进到的 ${newHead.slice(0, 7)}`,
      {
        retryable: true,
      },
    );
  }
  if (!(await isAncestor(t, current, newHead))) return 'diverged';
  const dirty = await uncommittedTracked(t);
  if (dirty.length > 0) {
    throw new PortError(
      'WORKTREE_DIRTY',
      `工作树里有没提交的改动，快进不了：${dirty.slice(0, 5).join('；')}`,
      {
        retryable: false,
      },
    );
  }
  await git(t, ['merge', '--ff-only', '-q', newHead], '快进到新头');
  return 'fast-forwarded';
}

/** 以会话用户的身份读目录里的一个文件；不在回 null（别的错照抛）。 */
export async function readFileAs(t: UserTree, path: string): Promise<string | null> {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new PortError('BAD_INPUT', `只读目录里的相对路径：${path}`, { retryable: false });
  }
  const r = await run(t, [t.sh ?? SH, '-c', 'if [ -f "$1" ]; then cat -- "$1"; else exit 3; fi', 'sh', path]);
  if (r.code === 0) return text(r);
  if (r.code === 3) return null;
  throw new PortError('READ_FAILED', describeFailure(`读 ${path}`, r), { retryable: true });
}

/** 没合并就收树时存档：没提交的改动（含二进制）和状态，交给引擎写进自己的存档目录。 */
export async function uncommittedPatch(t: UserTree): Promise<{ status: string[]; patch: Buffer }> {
  const status = lines(await git(t, ['status', '--porcelain'], '看工作树状态'));
  const patch = (await git(t, ['diff', 'HEAD', '--binary'], '存档没提交的改动', { timeoutMs: 300_000 }))
    .stdout;
  return { status, patch };
}
