import type { SessionUser } from '@fleet-dao/adapters';
import { runProgressFacts, type SessionRunState, type TaskContext } from '@fleet-dao/db';
import { type LaunchSessionInput, PortError } from '../ports.ts';
import type { ContinueMode } from './hosts.ts';
import { bundleFromMirror, mapped } from './mirror.ts';
import { isLeadKind, OUT_DIR, type OutputKind, type RelayFacts } from './prompts.ts';
import type { createTree } from './session-tree.ts';
import type { SessionShared } from './session-types.ts';
import { SHA } from './session-util.ts';
import {
  checkoutBranch,
  checkoutDetached,
  commitsSince,
  diffstatSince,
  excludeLocally,
  fetchBundle,
  hasCheckout,
  hasCommit,
  hasMainline,
  hasRepo,
  headOfIncoming,
  ownSpan,
  pinMainline,
  type UserTree,
} from './user-git.ts';

export function createPrepare(
  shared: SessionShared,
  parts: Pick<ReturnType<typeof createTree>, 'treeAs' | 'identityOf'>,
) {
  const { deps, db, trees, gh } = shared;
  const { treeAs, identityOf } = parts;

  async function prepareTree(
    input: LaunchSessionInput,
    task: TaskContext,
    kind: OutputKind,
    dir: string,
    user: SessionUser,
    mode: ContinueMode,
    signal: AbortSignal,
  ): Promise<void> {
    const owner = await trees.ownerOf(dir);
    const fresh = owner === null;
    if (owner !== user) await trees.adopt(dir, user);
    const t = treeAs(dir, user, `prep-${input.runId}`, signal);
    const identity = await identityOf(task.repo);
    const repoRef = { owner: task.repo.owner, name: task.repo.name };
    if (kind === 'delivery' || isLeadKind(kind)) {
      // 续上一轮的树：检出过的原样接着用。只看 .git 在不在不够——建树时 init 之后取包失败、同一个 runId 重试，
      // 留下的是个空仓；那样的照常取包、检出，不在空树里起会话。Fusion 的 Lead 第一步（写方案）就在新树上起。
      if (fresh || !(await hasCheckout(t))) {
        const base = input.baseHead;
        const branch = input.brief.branch;
        if (!base || !SHA.test(base) || !branch) {
          throw new PortError(
            'BAD_INPUT',
            `${isLeadKind(kind) ? 'Lead 的会话' : '写码会话'}要给起会话前的头（baseHead）和分支（brief.branch）`,
            { retryable: false },
          );
        }
        const { bytes, ref } = await bundleFromMirror(gh, deps.tmpDir, repoRef, base, [], signal);
        await fetchBundle(t, bytes, ref, { identity });
        await checkoutBranch(t, branch, base);
        // 第一轮的 base 就是建树时记下的主线头（createWorktree 的 baseSha）。树丢了、从返工时的分支头重建的，钉的是分支头：
        // test:changed 只算这一轮的改动——前几轮的在那几轮的会话里测过，CI 还会全测。
        await pinMainline(t, task.repo.defaultBranch, base);
      } else if (!(await hasMainline(t, task.repo.defaultBranch))) {
        // 钉主线之前（#218）建的老树接着用：照「从分支头重建的树」的规矩钉到起会话前的头。交活核对要扣掉并进来的主线，
        // 树里没钉就判不了（ownSpan 明确报 MAINLINE_MISSING）；这样钉，这一步的改动从起会话前的头比，和钉主线之前一样
        const base = input.baseHead;
        if (base && SHA.test(base)) await pinMainline(t, task.repo.defaultBranch, base);
      }
      // Lead 的结论文件写在工作树的 .fleet-out/ 里：记进这棵树自己的忽略清单，git add 不会把它提交进分支
      await excludeLocally(t, `${OUT_DIR}/`);
      return;
    }
    // 分诊、需求文档、方案、审查、开 PR 前验证：检出副本。续同一个会话（resume / fork）不动它；开新会话从干净的检出起。
    if (!fresh && (mode === 'resume' || mode === 'fork')) return;
    let sha: string;
    const checksHead = kind === 'review' || kind === 'verify';
    if (checksHead) {
      sha = input.brief.head ?? '';
      if (!SHA.test(sha)) {
        const who = kind === 'review' ? '审查会话要给 PR 的头' : '验证会话要给送检的头';
        throw new PortError('BAD_INPUT', `${who}（完整提交号）：${sha || '没给'}`, {
          retryable: false,
        });
      }
    } else {
      sha = (await mapped(() => gh.fetchMainline({ repo: repoRef, signal }))).head;
    }
    const exclude: string[] = [];
    const known = await hasRepo(t);
    // 仓里已经有这个提交（主线没动过）：直接换检出。要是照样去镜像取，包里一个新提交都没有，git 拒绝打空包。
    if (!known || !(await hasCommit(t, sha))) {
      if (known) {
        const last = await headOfIncoming(t).catch(() => undefined);
        if (last) exclude.push(last);
      }
      const { bytes, ref } = await bundleFromMirror(gh, deps.tmpDir, repoRef, sha, exclude, signal);
      await fetchBundle(t, bytes, ref, { identity });
    }
    await checkoutDetached(t, sha);
    // 分诊、文档、方案检出的就是主线头；审查、验证检出的是送检的头，主线另取进来再钉（提示词让它 git diff origin/<主线>...HEAD）。
    let mainline = sha;
    if (checksHead) {
      mainline = (await mapped(() => gh.fetchMainline({ repo: repoRef, signal }))).head;
      if (!(await hasCommit(t, mainline))) {
        const { bytes, ref } = await bundleFromMirror(gh, deps.tmpDir, repoRef, mainline, [sha], signal);
        await fetchBundle(t, bytes, ref);
      }
    }
    await pinMainline(t, task.repo.defaultBranch, mainline);
  }

  async function relayFacts(
    prior: SessionRunState | null,
    t: UserTree,
    kind: OutputKind,
    base: string | undefined,
    defaultBranch: string,
    why: string,
  ): Promise<RelayFacts> {
    const progress = prior ? await runProgressFacts(db, prior.id, { saysLimit: 8 }) : null;
    const delivery = (kind === 'delivery' || isLeadKind(kind)) && base !== undefined && SHA.test(base);
    // 已提交了什么：并进来的主线不算（接力的会话照它接着干，主线上别人的提交不是这一步做的）
    const span = delivery ? await ownSpan(t, base, defaultBranch) : null;
    return {
      steps: progress?.lastPlan?.steps ?? [],
      says: (progress?.says ?? []).map((s) => s.text).filter(Boolean),
      commits: span ? await commitsSince(t, span, 30) : [],
      diffstat: span ? await diffstatSince(t, span) : [],
      why,
    };
  }

  return { prepareTree, relayFacts };
}
