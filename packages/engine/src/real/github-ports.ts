// 引擎端口 → packages/github：推分支（会话用户打的 bundle）、开 PR（正文给结构，renderPrBody 生成；照抄需求 issue 的
// 类别标签和里程碑）、等 CI、并主线（并完把会话的树快进到新头）、在新头上跑测试（= 等这个头的 CI）、合并、issue 进度、
// 关单、写需求文档，以及建树（记下主线的头；树等起会话时由会话用户自己建，见 sessions.ts）、收树（先存档没提交的改动）。
// GitHubError 一律换成 PortError：码和「能不能重试」原样带过 Temporal 边界，失败分流按码判。

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionUser } from '@fleet-dao/adapters';
import type { GitHub, PrBodyInput } from '@fleet-dao/github';
import type { CiResult } from '../decisions/verify.ts';
import { type EnginePorts, type PortContext, PortError, type PrBody, type Worktree } from '../ports.ts';
import type { UserExec } from './exec.ts';
import { bundleFromMirror, mapped } from './mirror.ts';
import { PLAN_LINE_HINT, planLineOf, REQUIREMENT_DOC } from './spec-doc.ts';
import {
  bundleSince,
  fastForward,
  fetchBundle,
  hasCommit,
  headOf,
  headOfIncoming,
  isAncestor,
  isMergeChainOnto,
  mergeInto,
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
  | 'bundleCommits'
  | 'writeSpecDoc'
  | 'readSpecDoc'
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
  | 'createWorktree'
  | 'removeWorktree'
  | 'pushBranch'
  | 'openPr'
  | 'waitCi'
  | 'syncMainline'
  | 'runTests'
  | 'mergePr'
  | 'updateIssueProgress'
  | 'closeIssue'
  | 'writeSpecDoc'
>;

const DOC_FILE = { requirement: REQUIREMENT_DOC, plan: '方案.md', result: '结果.md' } as const;

function prBody(body: PrBody, plan: string, specs: string): PrBodyInput {
  return {
    ...(body.requirement === undefined ? {} : { requirement: body.requirement }),
    ...(body.subtask === undefined ? {} : { subtask: body.subtask }),
    did: body.did,
    verified: body.verified,
    ...(body.owed ? { owed: body.owed } : {}),
    ...(body.risks ? { risks: body.risks } : {}),
    plan,
    specs,
    tier: body.tier,
    changedFiles: body.changedFiles,
  };
}

/** CI 的结论换成引擎的三态：绿、红、没查成（冲突、头变了、PR 关了、没跑、超时都是没查成，写明哪一种）。 */
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
      return { state: 'unknown', head: r.head, failedChecks: [], detail: `和主线冲突，CI 没起：${r.detail}` };
    case 'head_moved':
      return {
        state: 'unknown',
        head: r.head,
        failedChecks: [],
        detail: `PR 的头变成了 ${r.actualHead}：${r.detail}`,
      };
    case 'closed':
      return { state: 'unknown', head: r.head, failedChecks: [], detail: `PR 被关了：${r.detail}` };
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
      const bundle = await bundleSince(t, head, base);
      await mkdir(deps.tmpDir, { recursive: true, mode: 0o700 });
      const bundlePath = join(deps.tmpDir, `push-${randomUUID()}.bundle`);
      try {
        await writeFile(bundlePath, bundle, { mode: 0o600 });
        const r = await mapped(() =>
          gh.pushBranch(
            { repo: input.repo, bundlePath, branch: input.branch, head, signal: ctx.signal },
            ctx,
          ),
        );
        return { head: r.head };
      } finally {
        await rm(bundlePath, { force: true });
      }
    },

    async openPr(input, ctx) {
      // 需求 issue 的类别标签和里程碑照抄到 PR 上（design 第七节）；读不到 issue 由 github 包明确报错，不当成「没有标签」。
      // 「对应计划」「specs」两栏必填（#41）：specs 是需求文档的目录，对应计划现读主线上那份需求文档里的那一行。
      const issueNumber = input.body.requirement;
      const specs = `${input.body.specs.trim().replace(/\/+$/, '')}/`;
      if (specs === '/') {
        throw new PortError(
          'SPEC_PLAN_MISSING',
          '开 PR 没给需求文档的目录：「specs」「对应计划」两栏都没法填',
          {
            retryable: false,
          },
        );
      }
      const path = `${specs}${REQUIREMENT_DOC}`;
      const doc = await mapped(() => gh.readSpecDoc({ repo: input.repo, path, signal: ctx.signal }, ctx));
      if (!doc) {
        throw new PortError(
          'SPEC_PLAN_MISSING',
          `主线上没有 ${path}：开 PR 要照它写「对应计划」一栏（需求文档还没进主线？）`,
          { retryable: false },
        );
      }
      const plan = planLineOf(doc.content);
      if ('error' in plan) {
        throw new PortError(
          'SPEC_PLAN_MISSING',
          `${path} 里${plan.error}：开 PR 的「对应计划」一栏照它写，缺了不开。${PLAN_LINE_HINT}`,
          { retryable: false },
        );
      }
      const r = await mapped(() =>
        gh.openPr(
          {
            repo: input.repo,
            branch: input.branch,
            head: input.head,
            title: input.title,
            body: prBody(input.body, plan.ok, specs),
            ...(issueNumber === undefined ? {} : { inheritFrom: { issueNumber } }),
          },
          ctx,
        ),
      );
      return { prNumber: r.number, url: r.url };
    },

    async waitCi(input, ctx) {
      return ciResultOf(
        await mapped(() => gh.waitCi({ repo: input.repo, prNumber: input.prNumber, head: input.head }, ctx)),
      );
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
      }
      return { state: 'clean', head: r.head, conflictFiles: [] };
    },

    async runTests(input, ctx) {
      // 合之前在最新主线上再跑一遍测试 = 等并好的这个头上的 CI（design：正式测试跑在 GitHub 的机器上）。
      const ci = ciResultOf(
        await mapped(() => gh.waitCi({ repo: input.repo, prNumber: input.prNumber, head: input.head }, ctx)),
      );
      if (ci.state === 'unknown') {
        // 没查成不是没过：不退回会话，交给失败分流（重试，再不行挂起）。
        throw new PortError('CI_UNKNOWN', ci.detail ?? 'CI 没查成', { retryable: true });
      }
      const failed = ci.failedChecks.join('、');
      return {
        passed: ci.state === 'green',
        head: ci.head,
        summary:
          ci.state === 'green'
            ? '新头上的 CI 全绿'
            : `新头上的 CI 红了：${failed || '（没列出检查名）'}${ci.digest ? `；${ci.digest}` : ''}`,
      };
    },

    async mergePr(input, ctx) {
      const r = await mapped(() =>
        gh.mergePr({ repo: input.repo, prNumber: input.prNumber, expectedHead: input.expectedHead }, ctx),
      );
      return r.merged
        ? { merged: true, mergeCommit: r.mergeCommit }
        : { merged: false, reason: `${r.reason}: ${r.detail}` };
    },

    async updateIssueProgress(input, ctx) {
      await mapped(() =>
        gh.updateIssueProgress(
          { repo: input.repo, issueNumber: input.issueNumber, progress: input.progress },
          ctx,
        ),
      );
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

    async writeSpecDoc(input, ctx) {
      const path = `${input.specDir.replace(/\/+$/, '')}/${DOC_FILE[input.doc]}`;
      const r = await mapped(() =>
        gh.writeSpecDoc(
          {
            repo: input.repo,
            path,
            content: input.markdown,
            message: `docs(spec): #${input.issueNumber} ${DOC_FILE[input.doc]}`,
            signal: ctx.signal,
          },
          ctx,
        ),
      );
      return { path: r.path, ...(r.commit ? { commit: r.commit } : {}) };
    },
  };
}
