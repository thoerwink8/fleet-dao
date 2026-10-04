// 引擎端口 → packages/github：推分支（会话用户打的 bundle）、开 PR（正文给结构，renderPrBody 生成；PR 不抄单子的类别标签、
// 里程碑，#654）、等 CI、并主线（并完把会话的树快进到新头）、关单，以及建树（记下主线的头；树等起会话时由会话
// 自己建，见 sessions.ts）、收树（先存档没提交的改动）。
// GitHubError 一律换成 PortError：码和「能不能重试」原样带过 Temporal 边界，失败分流按码判。

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionUser } from '@fleet-dao/adapters';
import type { GitHub, PrBodyInput } from '@fleet-dao/github';
import type { CiResult } from '../decisions/types.ts';
import {
  type EnginePorts,
  type PortContext,
  PortError,
  type PrBody,
  type WaitCiInput,
  type Worktree,
} from '../ports.ts';
import type { UserExec } from './exec.ts';
import { bundleFromMirror, mapped } from './mirror.ts';
import {
  bundleSince,
  changedFilesAgainst,
  fastForward,
  fetchBundle,
  hasCommit,
  headOf,
  headOfIncoming,
  isAncestor,
  isMergeChainOnto,
  mergeInto,
  pinMainline,
  type UserTree,
  uncommittedPatch,
  uncommittedTracked,
} from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

export { toPortError } from './mirror.ts';

/** 引擎用到的那几样；测试给假的。 */
export type EngineGitHub = Pick<
  GitHub,
  | 'pushBranch'
  | 'openPr'
  | 'waitCi'
  | 'mergePr'
  | 'updateIssueProgress'
  | 'closeIssue'
  | 'commitIdentity'
  | 'syncMainline'
  | 'fetchMainline'
  | 'fetchBranchHead'
  | 'bundleCommits'
  | 'writeSpecDoc'
  | 'readSpecDoc'
  | 'readIssue'
  | 'readIssuePlan'
  | 'readRepoFile'
  | 'pullFiles'
  | 'claims'
>;

export interface GitHubPortsDeps {
  gh: EngineGitHub;
  trees: WorkTrees;
  exec: UserExec;
  /** 引擎自己的临时目录（bundle 落在这里，用完就删）。 */
  tmpDir: string;
  /** 没合并就收的树，没提交的改动存到这里。 */
  archiveDir: string;
  now?: () => Date;
  /** 要心跳的活动（建树）在等 GitHub 时多久报一次活着；默认 HEARTBEAT_EVERY_MS，测试调短。 */
  heartbeatEveryMs?: number;
  /** 会话目录里跑的 git、sh（测试里换成 PATH 上的）。 */
  gitBin?: string;
  shBin?: string;
}

/** 远小于心跳超时（limits.heartbeatSeconds 默认 120 秒）：漏一两次也不判工人丢了。 */
export const HEARTBEAT_EVERY_MS = 15_000;

/** fn 跑着的时候每隔一会儿报一次活着；fn 结束（成功或失败）就停。 */
async function withHeartbeat<T>(ctx: PortContext, everyMs: number, fn: () => Promise<T>): Promise<T> {
  ctx.heartbeat();
  const timer = setInterval(() => ctx.heartbeat(), everyMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

type GitHubPorts = Pick<
  EnginePorts,
  'createWorktree' | 'removeWorktree' | 'pushBranch' | 'openPr' | 'waitCi' | 'syncMainline' | 'closeIssue'
>;

function prBody(body: PrBody): PrBodyInput {
  return {
    ...(body.requirement === undefined ? {} : { requirement: body.requirement }),
    ...(body.subtask === undefined ? {} : { subtask: body.subtask }),
    did: body.did,
    verified: body.verified,
    ...(body.owed ? { owed: body.owed } : {}),
    ...(body.risks ? { risks: body.risks } : {}),
    // 「按推荐先做了」一栏（#259）：漏传了正文里就没有这一栏
    ...(body.assumed ? { assumed: body.assumed } : {}),
  };
}

/**
 * CI 的结论换成引擎的几态：绿、红、和主线冲突、头被改写了、没查成（PR 关了、没跑、超时都是没查成，写明哪一种）。
 * 冲突、头被改写了单独分出来（不折进没查成）：冲突有确定的解法——并主线（core 的 nextFlow 见到 conflict 走
 * sync-mainline，不算「没查成」的次数）；头被改写了（github 包已经先排除了「新头含着老头」的良性情形，见
 * packages/github/src/pulls.ts 的 waitCi）不是重试能解决的，要人看，也不该被当成「没查成」再等三次才停下。
 */
export function ciResultOf(r: Awaited<ReturnType<EngineGitHub['waitCi']>>): CiResult {
  switch (r.state) {
    case 'green':
      return { state: 'green', head: r.head, failedChecks: [] };
    case 'red':
      return {
        state: 'red',
        head: r.head,
        failedChecks: r.failedChecks,
        ...(r.digest ? { digest: r.digest } : {}),
      };
    case 'conflict':
      return {
        state: 'conflict',
        head: r.head,
        failedChecks: [],
        detail: `和主线冲突，CI 没起：${r.detail}`,
      };
    case 'head_moved':
      return {
        state: 'diverged',
        head: r.actualHead,
        failedChecks: [],
        detail: `PR 的头从 ${r.head} 变成了 ${r.actualHead}，且新头不含老头：${r.detail}`,
      };
    case 'closed':
      // merged 结构化地说是不是合并关的（packages/github 的 waitCi 已经从 PR 的 merged 字段读出来，不是猜文案）：
      // 合了就当合上了（mergeCommit 带着合并提交），关了没合才是真的没查成——调用方（waitCiEvent）按它分岔。
      return r.merged && r.mergeCommit
        ? { state: 'merged', head: r.head, failedChecks: [], mergeCommit: r.mergeCommit }
        : { state: 'unknown', head: r.head, failedChecks: [], detail: `PR 被关了：${r.detail}` };
    case 'missing':
      return { state: 'unknown', head: r.head, failedChecks: [], detail: `CI 根本没跑：${r.detail}` };
    case 'timeout':
      return {
        state: 'unknown',
        head: r.head,
        failedChecks: [],
        detail: `CI 没在限时内跑完（还在等：${r.pending.join('、') || '无'}）：${r.detail}`,
      };
    case 'unknown':
      return { state: 'unknown', head: r.head, failedChecks: [], detail: `CI 没查成：${r.detail}` };
  }
}

export function createGitHubPorts(deps: GitHubPortsDeps): GitHubPorts {
  const { gh, trees } = deps;
  const now = deps.now ?? (() => new Date());
  const heartbeatEveryMs = deps.heartbeatEveryMs ?? HEARTBEAT_EVERY_MS;

  const treeAs = (dir: string, user: SessionUser, prefix: string, ctx: PortContext): UserTree => ({
    exec: deps.exec,
    user,
    dir,
    scopePrefix: prefix,
    signal: ctx.signal,
    ...(deps.gitBin ? { git: deps.gitBin } : {}),
    ...(deps.shBin ? { sh: deps.shBin } : {}),
  });

  /** 这棵树现在归谁：不在（从没起过会话、或已经收了）明确报错，不当成「没有改动」。 */
  const ownerOrFail = async (dir: string): Promise<SessionUser> => {
    const user = await trees.ownerOf(dir);
    if (!user) {
      throw new PortError('WORKTREE_MISSING', `工作树 ${dir} 不在：还没起过会话、或已经收了`, {
        retryable: false,
      });
    }
    return user;
  };

  /**
   * waitCi 认了新头（新头含着老头）：把工作树也快进过去。树不在（没建过、已经收了）就跳过——没有工作树可并。
   * 工作树不是「干净、正好在旧头」这个能安全快进的状态（有没提交的改动、或本地头已经不是查 CI 时以为的那个）
   * 就当会话正在用它，跳过、不抛：等下一轮 waitCi 或下一次任务边界再试，不强上。真读不到 GitHub（抓分支、
   * 打包失败）原样抛出去，交 waitCi 这次活动自己的重试/挂起（不是「会话在跑」，是没查成）。
   */
  const adoptCiHead = async (
    input: Pick<WaitCiInput, 'repo' | 'branch' | 'head' | 'worktreePath' | 'subtaskId' | 'taskId'>,
    newHead: string,
    ctx: PortContext,
  ): Promise<void> => {
    const dir = input.worktreePath;
    if (!dir) return;
    const user = await trees.ownerOf(dir);
    if (!user) return;
    const t = treeAs(dir, user, `ci-adopt-${input.subtaskId ?? input.taskId}`, ctx);
    const [dirty, current] = await Promise.all([uncommittedTracked(t), headOf(t)]);
    if (dirty.length > 0 || current !== input.head) return;
    await mapped(() =>
      gh.fetchBranchHead({ repo: input.repo, branch: input.branch, signal: ctx.signal }, ctx),
    );
    const { bytes, ref } = await bundleFromMirror(
      gh,
      deps.tmpDir,
      input.repo,
      newHead,
      [input.head],
      ctx.signal,
    );
    const ff = await fastForward(t, bytes, ref, newHead);
    // ff === 'diverged'：核过之后（上面两行）工作树又变了，极罕见的竞态，一样跳过、不抛，下一轮再试。
    void ff;
  };

  return {
    async createWorktree(input, ctx): Promise<Worktree> {
      // 这里只定位置、记下主线的头：树等起会话时由那个会话用户自己从 bundle 建（sessions.ts）——
      // 建树的时候还不知道会派给哪个账号池、哪个会话用户。同一位置留着上一轮的旧树（同名分支）就先删掉。
      // 这一档要心跳（activity-options 的 setup）：大仓第一次抓进镜像可能要好几分钟，删一棵大的旧树也可能要好一会儿，
      // 这两步都照常报活着。
      const path = trees.treeFor(input.repo, input.branch);
      return withHeartbeat(ctx, heartbeatEveryMs, async () => {
        const main = await mapped(() => gh.fetchMainline({ repo: input.repo, signal: ctx.signal }, ctx));
        if ((await trees.ownerOf(path)) !== null) await trees.remove(path);
        return { path, branch: input.branch, baseSha: main.head };
      });
    },

    async removeWorktree(input, ctx) {
      const user = await trees.ownerOf(input.path);
      if (!user) return { removed: false, gone: true };
      let archivedTo: string | undefined;
      if (input.archive) {
        const t = treeAs(input.path, user, `rm-${input.subtaskId ?? input.taskId}`, ctx);
        const { status, patch } = await uncommittedPatch(t);
        if (status.length > 0 || patch.length > 0) {
          const dir = join(deps.archiveDir, input.taskId);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const stamp = now().toISOString().replace(/[:.]/g, '-');
          const file = join(dir, `${input.subtaskKey ?? 'tree'}-${stamp}.patch`);
          const header = `# git status\n${status.map((s) => `# ${s}`).join('\n')}\n`;
          await writeFile(file, Buffer.concat([Buffer.from(header), patch]), { mode: 0o600 });
          archivedTo = file;
        }
      }
      const { gone } = await trees.remove(input.path);
      return { removed: !gone, gone, ...(archivedTo ? { archivedTo } : {}) };
    },

    async pushBranch(input, ctx) {
      const user = await ownerOrFail(input.worktreePath);
      const t = treeAs(input.worktreePath, user, `push-${input.subtaskId ?? input.taskId}`, ctx);
      let head = await headOf(t);
      // 上一次（或上几次）这一步已经把主线并进来了、只是没推成：头是会话交的头之后只有并提交的一串，接着推它
      if (head !== input.head && !(await isMergeChainOnto(t, head, input.head))) {
        throw new PortError(
          'HEAD_MISMATCH',
          `工作树的头是 ${head.slice(0, 7)}，不是要推的 ${input.head.slice(0, 7)}`,
          { retryable: false },
        );
      }
      const dirty = await uncommittedTracked(t);
      if (dirty.length > 0) {
        throw new PortError(
          'NOT_DELIVERED',
          `工作树里有没提交的已跟踪改动，不推：${dirty.slice(0, 5).join('；')}`,
          { retryable: false },
        );
      }
      // 推的必须含最新主线（github 包核，不含就拒）：主线在会话干活时动过，先把它并进会话的树再推。
      // 并出冲突就撤掉，交失败分流退回会话去解（MC1）；树里已经有新主线的提交，会话照着 git merge 就行。
      // 会话一个新提交都没有就不并（并出来的只有一个并提交，是空交付）。
      const incoming = await headOfIncoming(t);
      if (head === incoming) {
        throw new PortError('EMPTY_DELIVERY', `起会话前的头 ${incoming.slice(0, 7)} 之后没有新提交`, {
          retryable: false,
        });
      }
      const main = await mapped(() => gh.fetchMainline({ repo: input.repo, signal: ctx.signal }, ctx));
      if (!(await hasCommit(t, main.head))) {
        const { bytes, ref } = await bundleFromMirror(
          gh,
          deps.tmpDir,
          input.repo,
          main.head,
          [incoming],
          ctx.signal,
        );
        await fetchBundle(t, bytes, ref);
      }
      // 最新主线已经在树里：先钉上再并（并出冲突退回会话时，会话照着 git merge 它，pnpm test:changed 也和它比）
      await pinMainline(t, input.repo.defaultBranch, main.head);
      if (!(await isAncestor(t, main.head, head))) {
        const merged = await mergeInto(t, main.head);
        if ('conflict' in merged) {
          throw new PortError(
            'MERGE_CONFLICT',
            `推之前把最新主线 ${main.head.slice(0, 7)} 并进来有冲突：${merged.conflict.slice(0, 10).join('、')}。在树里 git merge ${main.head} 解掉冲突、提交后再交`,
            { retryable: false, details: { mainline: main.head, conflictFiles: merged.conflict } },
          );
        }
        head = merged.merged;
      }
      // 包的起点：树最后一次从引擎取的头（建树的主线头、并主线后的新头、或刚取进来的最新主线）——引擎的镜像里一定有它。
      const base = await headOfIncoming(t);
      const doPush = async (pushHead: string): Promise<string> => {
        const bundle = await bundleSince(t, pushHead, base);
        await mkdir(deps.tmpDir, { recursive: true, mode: 0o700 });
        const bundlePath = join(deps.tmpDir, `push-${randomUUID()}.bundle`);
        try {
          await writeFile(bundlePath, bundle, { mode: 0o600 });
          const r = await mapped(() =>
            gh.pushBranch(
              { repo: input.repo, bundlePath, branch: input.branch, head: pushHead, signal: ctx.signal },
              ctx,
            ),
          );
          return r.head;
        } finally {
          await rm(bundlePath, { force: true });
        }
      };

      /**
       * 推被拒（DIVERGED / REMOTE_AHEAD，github 包的 assertFastForward：「不强推，交给引擎处理」）：先认领远端
       * 此刻的头，判断是良性前进还是真被改写（#307/#389 那次真事：帅位手工并了主线又推，工作树没跟上；后来再
       * 推被拒，落进了失败分流的兜底梯）——远端含着 incoming（起会话前的头，工作流上一次确认过的分支头）就是
       * 良性前进，不是改写：把远端的新提交取进树，能快进就快进认领（REMOTE_AHEAD：远端已经含着我们要推的），
       * 不能快进就真并一次（DIVERGED：两边都有新东西），并上了改用新头重推一次；并不上（真冲突，双方改了同一
       * 处）交回去走 MERGE_CONFLICT 现成那条返工路。远端不含 incoming——不是良性前进，是历史被改写过——原样
       * 报出去，交失败分流按 DIVERGED 明确归类（不走「认不出」兜底，见 failure/rules.ts 的 MC3）。
       */
      const recoverDiverged = async (error: PortError): Promise<{ head: string; needsPush: boolean }> => {
        const remoteHead = (error.details as { remoteHead?: unknown } | undefined)?.remoteHead;
        if (typeof remoteHead !== 'string' || !/^[0-9a-f]{40}$/.test(remoteHead)) throw error;
        const branchState = await mapped(() =>
          gh.fetchBranchHead({ repo: input.repo, branch: input.branch, signal: ctx.signal }, ctx),
        );
        if (!branchState.head) {
          throw new PortError('DIVERGED', `推 ${input.branch} 被拒后再看，远端这个分支已经不在了：要人看`, {
            retryable: false,
            details: { head },
          });
        }
        const freshHead = branchState.head;
        const { bytes, ref } = await bundleFromMirror(
          gh,
          deps.tmpDir,
          input.repo,
          freshHead,
          [incoming],
          ctx.signal,
        );
        await fetchBundle(t, bytes, ref);
        if (!(await isAncestor(t, incoming, freshHead))) {
          throw new PortError(
            'DIVERGED',
            `推 ${input.branch} 被拒：远端头 ${freshHead.slice(0, 7)} 不含起会话前的头 ${incoming.slice(0, 7)}（像是被强推改写了历史），不能自动并，要人看`,
            { retryable: false, details: { remoteHead: freshHead, incoming, head } },
          );
        }
        if (await isAncestor(t, freshHead, head)) return { head, needsPush: true };
        if (await isAncestor(t, head, freshHead)) {
          const ff = await fastForward(t, bytes, ref, freshHead);
          if (ff === 'diverged') {
            throw new PortError(
              'DIVERGED',
              `推 ${input.branch} 被拒：认领远端头 ${freshHead.slice(0, 7)} 时工作树状态和刚核过的不一致，要人看`,
              { retryable: true, details: { remoteHead: freshHead, head } },
            );
          }
          return { head: freshHead, needsPush: false };
        }
        const merged = await mergeInto(t, freshHead);
        if ('conflict' in merged) {
          throw new PortError(
            'MERGE_CONFLICT',
            `推 ${input.branch} 时发现远端头 ${freshHead.slice(0, 7)} 和要推的 ${head.slice(0, 7)} 都往前走了、内容上真冲突：${merged.conflict.slice(0, 10).join('、')}。在树里 git merge ${freshHead} 解掉冲突、提交后再交`,
            { retryable: false, details: { remoteHead: freshHead, conflictFiles: merged.conflict } },
          );
        }
        return { head: merged.merged, needsPush: true };
      };

      try {
        const pushed = await doPush(head);
        // 推上去的头相对主线的净改动：工作流开 PR 前验证判界面、给验证方的清单、PR 正文按它，
        // 不按一轮轮会话交的累计（撤回了的、老版算进来的主线改动都还在那里面，#293）
        return { head: pushed, changedFiles: await changedFilesAgainst(t, main.head, pushed) };
      } catch (error) {
        if (!(error instanceof PortError) || (error.code !== 'DIVERGED' && error.code !== 'REMOTE_AHEAD')) {
          throw error;
        }
        const recovered = await recoverDiverged(error);
        head = recovered.head;
        if (!recovered.needsPush) {
          return { head, changedFiles: await changedFilesAgainst(t, main.head, head) };
        }
        const pushed = await doPush(head);
        return { head: pushed, changedFiles: await changedFilesAgainst(t, main.head, pushed) };
      }
    },

    async openPr(input, ctx) {
      const r = await mapped(() =>
        gh.openPr(
          {
            repo: input.repo,
            branch: input.branch,
            head: input.head,
            title: input.title,
            body: prBody(input.body),
          },
          ctx,
        ),
      );
      return { prNumber: r.number, url: r.url };
    },

    async waitCi(input, ctx) {
      const result = ciResultOf(
        await mapped(() => gh.waitCi({ repo: input.repo, prNumber: input.prNumber, head: input.head }, ctx)),
      );
      // CI 认了新头（新头含着老头，github 包的 waitCi 已经用 compare API 核过）：顺手把工作树也快进过去，
      // 别让「CI 查到的头」和「工作树实际的头」分家（#307/#389 那次真事：认了新头查 CI，工作树没跟上，后面
      // 并主线、推分支都从旧头算起，最后推送被拒）。diverged 是新头不含老头的情形，交回去要人看，不在这适用。
      if (input.worktreePath && result.state !== 'diverged' && result.head !== input.head) {
        await adoptCiHead(input, result.head, ctx);
      }
      return result;
    },

    async syncMainline(input, ctx) {
      const r = await mapped(() =>
        gh.syncMainline(
          {
            repo: input.repo,
            prNumber: input.prNumber,
            branch: input.branch,
            head: input.head,
            signal: ctx.signal,
          },
          ctx,
        ),
      );
      if (r.state === 'head_moved') {
        throw new PortError(
          'HEAD_MOVED',
          `分支 ${input.branch} 的头是 ${r.head.slice(0, 7)}，不是以为的 ${r.expectedHead.slice(0, 7)}：有别人推过，要人看`,
          { retryable: false },
        );
      }
      if (r.state === 'conflict') return { state: 'conflict', head: r.head, conflictFiles: r.conflictFiles };
      if (r.merged && input.worktreePath) {
        // 并出来的新头推上去了：会话的树快进过去，接着返工的时候基于新头。
        const user = await ownerOrFail(input.worktreePath);
        const t = treeAs(input.worktreePath, user, `sync-${input.subtaskId ?? input.taskId}`, ctx);
        const { bytes, ref } = await bundleFromMirror(
          gh,
          deps.tmpDir,
          input.repo,
          r.head,
          [r.previousHead],
          ctx.signal,
        );
        const ff = await fastForward(t, bytes, ref, r.head);
        if (ff === 'diverged') {
          throw new PortError(
            'WORKTREE_DIVERGED',
            `工作树在 ${r.previousHead.slice(0, 7)} 之后还有没推的提交，快进不到并好的 ${r.head.slice(0, 7)}：要人看`,
            { retryable: false },
          );
        }
        // 并进来的主线跟着新头进了树：重钉，接着返工时 pnpm test:changed 只算分支自己的改动
        await pinMainline(t, input.repo.defaultBranch, r.mainline);
      }
      return { state: 'clean', head: r.head, conflictFiles: [] };
    },

    async closeIssue(input, ctx) {
      await mapped(() =>
        gh.closeIssue(
          {
            repo: input.repo,
            issueNumber: input.issueNumber,
            reason: input.reason,
            ...(input.comment ? { comment: input.comment } : {}),
          },
          ctx,
        ),
      );
    },
  };
}
