// 动手会话的工作树（#632 S2-4b-2）：会话起之前，树要在、归会话用户、在任务的分支上、钉好主线。
// 和老链路 sessions.ts 的 prepareTree（写码那一支）是同一套做法，只是这里没有 Fusion 的续会话、Lead 那些分支：
// 第一轮树还不存在（createWorktree 只定位置、记下主线的头）→ 会话用户自己从镜像的 bundle 建；后几轮树在，原样接着用。
//
// 改这里之前必须知道：
// - 树在不在不能只看 .git：建树时 init 之后取包失败、同一个任务重来，留下的是个空仓——hasCheckout 才说明真检出过。
// - 钉主线（pinMainline）：交活核对（readDelivery 的 ownSpan）要扣掉并进来的主线，树里没钉就明确报 MAINLINE_MISSING。
//   第一轮钉建树时的主线头；树丢了从上一轮推上去的头重建的，钉的是那个头（只算这一轮的改动）。
// - 老树没钉主线的补钉，用 baseSha；baseSha 不是完整提交号当场报错，不猜。

import type { SessionUser } from '@fleet-dao/adapters';
import type { Repo } from '@fleet-dao/shared';
import { type PortContext, PortError } from '../ports.ts';
import type { UserExec } from './exec.ts';
import { bundleFromMirror, type MirrorGitHub, mapped } from './mirror.ts';
import {
  checkoutBranch,
  fetchBundle,
  hasCheckout,
  hasMainline,
  type Identity,
  pinMainline,
  type UserTree,
} from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

const SHA = /^[0-9a-f]{40}$/;

export interface SegmentTreeDeps {
  gh: MirrorGitHub & { commitIdentity(repo: { owner: string; name: string }): Promise<Identity> };
  trees: Pick<WorkTrees, 'ownerOf' | 'adopt'>;
  exec: UserExec;
  /** 引擎自己的临时目录（bundle 落在这里，用完就删）。 */
  tmpDir: string;
  gitBin?: string;
  shBin?: string;
}

export interface SegmentTreeInput {
  repo: Pick<Repo, 'owner' | 'name' | 'defaultBranch'>;
  worktreePath: string;
  branch: string;
  /** 起会话前的头：第一轮是建树时的主线头，后几轮是上一轮推上去的头。 */
  baseSha: string;
  user: SessionUser;
  /** 这一次执行的编号（scope 编号前缀用，同一时刻不重复）。 */
  runId: string;
}

/** 备好树；已经备好的原样不动。树归了别的会话用户的，交给这一个。 */
export async function prepareSegmentTree(
  deps: SegmentTreeDeps,
  input: SegmentTreeInput,
  ctx: Pick<PortContext, 'signal'>,
): Promise<void> {
  const { repo, worktreePath: dir, branch, baseSha, user } = input;
  if (!SHA.test(baseSha)) {
    throw new PortError('BAD_INPUT', `起会话前的头要是完整提交号：${baseSha || '没给'}`, {
      retryable: false,
    });
  }
  if (!branch) throw new PortError('BAD_INPUT', '动手会话要给分支名', { retryable: false });
  const owner = await deps.trees.ownerOf(dir);
  const fresh = owner === null;
  if (owner !== user) await deps.trees.adopt(dir, user);
  const t: UserTree = {
    exec: deps.exec,
    user,
    dir,
    scopePrefix: `prep-${input.runId}`,
    signal: ctx.signal,
    ...(deps.gitBin ? { git: deps.gitBin } : {}),
    ...(deps.shBin ? { sh: deps.shBin } : {}),
  };
  if (fresh || !(await hasCheckout(t))) {
    const repoRef = { owner: repo.owner, name: repo.name };
    const identity = await mapped(() => deps.gh.commitIdentity(repoRef));
    const { bytes, ref } = await bundleFromMirror(deps.gh, deps.tmpDir, repoRef, baseSha, [], ctx.signal);
    await fetchBundle(t, bytes, ref, { identity });
    await checkoutBranch(t, branch, baseSha);
    await pinMainline(t, repo.defaultBranch, baseSha);
  } else if (!(await hasMainline(t, repo.defaultBranch))) {
    await pinMainline(t, repo.defaultBranch, baseSha);
  }
}
