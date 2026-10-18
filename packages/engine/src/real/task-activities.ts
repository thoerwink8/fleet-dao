// 任务工作流（workflows/task.ts，#632 S2-4）要的活动里不碰会话的那五个的真实现：读交代、读交付、查改标准的路径、
// 挂自动合并、等合并。会话（runSegment）和冷验收（coldVerify）各自在 task-segment.ts、task-verify.ts。
//
// 改这里之前必须知道：
// - 读不到、认不出一律抛错，不拿空冒充没事：清单读不出（不是「文件不在」）、PR 文件列表翻不完、工作树不在、git 没跑成，都抛。
//   只有「这个仓根本没声明改标准清单」（文件不在）才当没有。
// - 合并这一步 GitHub 说了算：自动合并只由 armAutoMerge 在验收通过之后挂（每小时对账的兜底不碰任务分支，jobs/auto-merge-check.ts）。
//   挂的时候 GitHub 说「已经是 clean」（所有条件都满足了，没什么可等的）就直接合（github 包的 mergePr：核头、核不落后主线、
//   核 CI 绿），合不了的原样说明原因交工作流停下报人。
// - 合并记录：这个仓的对账（github 包 auditMergedPrs）要求引擎开的 PR 账上有合并记录。自动合并是 GitHub 自己合的，没有记录，
//   所以等到合并之后再调一次 mergePr——它对「已经合了」的 PR 只补记录、删分支，不再合一次。补不成只记日志，不拦任务往下走。
// - 等合并是长轮询（心跳不断）：叫停时休眠被打断，活动抛取消，不吞。

import type { SessionUser } from '@fleet-dao/adapters';
import { type ChangedFile, STANDARD_PATHS_FILE, standardFiles } from '@fleet-dao/conventions';
import type { RepoRef } from '@fleet-dao/github';
import { parseRepoProfile, type RepoProfile } from '@fleet-dao/shared';
import { abortableSleep, errMessage } from '@fleet-dao/shared/util';
import type { EngineTasks } from '../activities.ts';
import { type PortContext, PortError } from '../ports.ts';
import { readTaskBrief } from '../runner/task-brief.ts';
import { standardPathsList } from '../standard-paths-list.ts';
import type {
  ArmAutoMergeInput,
  ArmAutoMergeResult,
  CheckGuardedInput,
  DeliveryRead,
  GuardedPaths,
  MergeNowInput,
  MergeNowResult,
  MergeWait,
  ReadDeliveryInput,
  ReadTaskBriefInput,
  ReviewChange,
  WaitMergedInput,
} from '../task-contract.ts';
import { MAX_MAIN_SYNCS } from '../task-contract.ts';
import type { UserExec } from './exec.ts';
import type { EngineGitHub } from './github-ports.ts';
import { bookMergedPull } from './merge-receipt.ts';
import { mapped } from './mirror.ts';
import { createReviewAudit, type ReviewAuditDeps } from './review-audit.ts';
import {
  addedLinesAgainst,
  changedFilesSince,
  commitsSince,
  deliveryLeftover,
  headOf,
  ownSpan,
  type UserTree,
  unresolvedConflicts,
} from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

/** 等合并时多久看一次 PR（毫秒）。 */
export const MERGE_POLL_EVERY_MS = 20_000;

/** 等合并这一下读到的必过检查。红了才带 failed；pending / none / green 不带。 */
export interface MergeWaitChecks {
  overall: 'green' | 'red' | 'pending' | 'none';
  failed: { name: string; detail?: string }[];
}

export interface TaskActivitiesDeps extends ReviewAuditDeps {
  gh: Pick<
    EngineGitHub,
    'readIssue' | 'readSpecDoc' | 'readRepoFile' | 'pullFiles' | 'mergePr' | 'updateBranch' | 'claims'
  >;
  trees: Pick<WorkTrees, 'ownerOf'>;
  exec: UserExec;
  now?: () => Date;
  /** 看 PR 的间隔；默认 MERGE_POLL_EVERY_MS，测试调短。 */
  pollEveryMs?: number;
  /** 休眠，叫停（signal 触发）时要抛出来；测试里换成立刻返回的。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * 等合并时读这个头上的必过检查（含合并闸、cold-verify）。
   * 不给、又会接着等：waitMerged 抛错，不把红了装成还在等。
   */
  readChecks?: ((repo: RepoRef, sha: string, signal: AbortSignal) => Promise<MergeWaitChecks>) | undefined;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** 这个仓的档案（库里的原文，补默认值）。不给就按 fleet-dao 的清单路径和 packages/* 分档（旧测试）。真装配必给。 */
  profileOf?: (repo: RepoRef) => Promise<unknown>;
  /** 会话目录里跑的 git、sh（测试里换成 PATH 上的）。 */
  gitBin?: string;
  shBin?: string;
}

type TaskActivities = Required<
  Pick<
    EngineTasks,
    'readTaskBrief' | 'readDelivery' | 'checkGuarded' | 'armAutoMerge' | 'waitMerged' | 'mergeNow'
  >
>;

const refOf = (repo: { owner: string; name: string }): RepoRef => ({ owner: repo.owner, name: repo.name });
const short = (sha: string) => sha.slice(0, 7);

/** 必过检查红了：检查名和原因交给工作流。没写名字就标明，不回空的。 */
function checksRedWait(checks: MergeWaitChecks): MergeWait {
  const failed = checks.failed.filter((item) => item.name.trim().length > 0);
  const failedChecks = failed.length > 0 ? failed.map((item) => item.name) : ['（没写是哪项）'];
  const detail =
    failed
      .map((item) =>
        item.detail && item.detail.trim().length > 0 ? `${item.name}：${item.detail}` : item.name,
      )
      .join('；') || '必过检查红了';
  return { state: 'checks_red', failedChecks, detail };
}

/** GitHub 拒绝挂自动合并、因为 PR 已经满足全部合并条件（没什么可等的）。 */
function isCleanStatus(error: unknown): boolean {
  return /clean status/i.test(errMessage(error));
}

export function createTaskActivities(deps: TaskActivitiesDeps): TaskActivities {
  const { gh, trees } = deps;
  const now = deps.now ?? (() => new Date());
  const pollEveryMs = deps.pollEveryMs ?? MERGE_POLL_EVERY_MS;
  const sleep = deps.sleep ?? abortableSleep;
  const log = deps.log ?? (() => undefined);

  /**
   * 合之前现读还挂着的正式「要求改」（#2991）：没接上读评审回空（老测试）；读到了先把已挂的自动合并撤掉，
   * 撤不成抛错（不让 GitHub 在这时把它合了还装成拦下了）。
   */
  const reviewHold = async (
    repo: RepoRef,
    pull: { number: number; nodeId: string; autoMerge: boolean },
  ): Promise<ReviewChange[]> => {
    if (deps.reviewChanges === undefined) return [];
    let changes: ReviewChange[];
    try {
      changes = await deps.reviewChanges(repo, pull.number);
    } catch (readError) {
      if (pull.autoMerge) {
        try {
          await mapped(() => gh.claims.disableAutoMerge(repo, pull));
          log('正式评审未读全，已撤自动合并，意见仍未送达', {
            prNumber: pull.number,
            error: errMessage(readError),
          });
        } catch (disableError) {
          throw new PortError(
            'REVIEW_READ_AND_HOLD_FAILED',
            `正式评审未读全、未送达：${errMessage(readError)}；自动合并未确认撤掉：${errMessage(disableError)}`,
            { retryable: true },
          );
        }
      }
      throw readError;
    }
    if (changes.length > 0 && pull.autoMerge) {
      await mapped(() => gh.claims.disableAutoMerge(repo, pull));
      log('PR 上还挂着正式「要求改」，撤掉了自动合并', {
        prNumber: pull.number,
        reviews: changes.map((r) => r.reviewId),
      });
    }
    return changes;
  };

  // waitCi与三个合并入口共用同一补读和未送达留账判据；重试已合分支仍必经。
  const auditLateReview = createReviewAudit(deps, log);

  const treeAs = (dir: string, user: SessionUser, prefix: string, ctx: PortContext): UserTree => ({
    exec: deps.exec,
    user,
    dir,
    scopePrefix: prefix,
    signal: ctx.signal,
    ...(deps.gitBin ? { git: deps.gitBin } : {}),
    ...(deps.shBin ? { sh: deps.shBin } : {}),
  });

  const profileOf = async (repo: RepoRef): Promise<RepoProfile | undefined> => {
    if (!deps.profileOf) return undefined;
    return parseRepoProfile(await deps.profileOf(repo));
  };

  /** 仓里声明的清单文件：文件不在＝这个仓没声明，回 null；在却读不出内容、读失败都抛。 */
  const readList = async (repo: RepoRef, path: string, ctx: PortContext): Promise<string | null> => {
    const read = await mapped(() => gh.readRepoFile({ repo, path, signal: ctx.signal }));
    if (read.file.kind === 'text') return read.file.text;
    if (read.file.kind === 'missing') return null;
    throw new PortError('GUARD_LIST_UNREADABLE', `主线上的 ${path} 读不了内容（${read.file.why}）`, {
      retryable: false,
    });
  };

  /**
   * 已经合了的 PR：补合并记录、删分支（bookMergedPull，和等 CI 看到已合并同一步）。补不成只记日志，合并这件事本身是确定的
   * （这几步前面已经现读过 PR 是合了的；等 CI 那一处更严，记不成照抛，见 merge-receipt.ts）。
   */
  const bookMerge = async (
    repo: RepoRef,
    prNumber: number,
    expectedHead: string,
    ctx: PortContext,
  ): Promise<{ mergeCommit?: string; otherHead?: string }> => {
    try {
      const r = await bookMergedPull(gh, { repo, prNumber, expectedHead }, ctx);
      if (r.booked) return { mergeCommit: r.mergeCommit };
      if (r.reason === 'merged_other_head') return { otherHead: r.detail };
      return {};
    } catch (error) {
      log('PR 合并了，但补合并记录 / 删分支没成（每小时对账会补记录）', {
        repo: `${repo.owner}/${repo.name}`,
        prNumber,
        error: errMessage(error),
      });
      return {};
    }
  };

  /**
   * 直接合被拒、因为落后主线（引擎同时跑多张单，主线在 CI 跑的这段时间里又进了新提交）：把 PR 同步到最新主线，
   * 新头当 headMoved 交回去，工作流对新头重跑 CI 和验收（直接合那一道的「落后主线不许合」不放宽）。
   * 同一张 PR 最多自动同步 MAX_MAIN_SYNCS 次，之后原样停下报人；同步时冲突也停下报人。
   */
  const syncBehindMain = async (
    repo: RepoRef,
    prNumber: number,
    expectedHead: string,
    syncedBefore: number,
    behindDetail: string,
    ctx: PortContext,
  ): Promise<ArmAutoMergeResult> => {
    if (syncedBefore >= MAX_MAIN_SYNCS) {
      return {
        armed: false,
        merged: false,
        why: `连着 ${MAX_MAIN_SYNCS} 次同步主线后仍落后（主线一直在动）：${behindDetail}`,
      };
    }
    const synced = await mapped(() => gh.updateBranch({ repo, prNumber, expectedHead }, ctx));
    if (synced.updated) {
      return {
        armed: false,
        merged: false,
        why: `落后主线，已把 PR #${prNumber} 同步到最新主线（第 ${syncedBefore + 1} 次，新头 ${short(synced.head)}）`,
        headMoved: synced.head,
        syncedMain: true,
      };
    }
    if (synced.reason === 'head_moved' && synced.head !== undefined) {
      return {
        armed: false,
        merged: false,
        why: `落后主线，同步前 PR 的头先变了：${synced.detail}`,
        headMoved: synced.head,
      };
    }
    return {
      armed: false,
      merged: false,
      why: `落后主线，同步主线没成（${synced.reason}）：${synced.detail}`,
    };
  };

  return {
    async readTaskBrief(input: ReadTaskBriefInput, ctx: PortContext) {
      const repo = refOf(input.repo);
      const profile = await profileOf(repo);
      return readTaskBrief(
        {
          readIssue: ({ repo: issueRepo, issueNumber }) =>
            mapped(() => gh.readIssue({ repo: issueRepo, issueNumber, signal: ctx.signal })),
          readSpecDoc: async ({ repo: docRepo, path }) => {
            const doc = await mapped(() => gh.readSpecDoc({ repo: docRepo, path, signal: ctx.signal }, ctx));
            return doc ? { content: doc.content } : null;
          },
        },
        {
          repo,
          issueNumber: input.issueNumber,
          ...(profile ? { moduleRoots: profile.moduleRoots } : {}),
        },
      );
    },

    async readDelivery(input: ReadDeliveryInput, ctx: PortContext): Promise<DeliveryRead> {
      const user = await trees.ownerOf(input.worktreePath);
      if (!user) {
        throw new PortError(
          'WORKTREE_MISSING',
          `工作树 ${input.worktreePath} 不在：会话没建起来、或已经收了`,
          {
            retryable: false,
          },
        );
      }
      const t = treeAs(input.worktreePath, user, `delivery-${input.taskId}`, ctx);
      const span = await ownSpan(t, input.baseSha, input.repo.defaultBranch);
      const head = await headOf(t);
      const changedFiles = await changedFilesSince(t, span);
      const commits = await commitsSince(t, span);
      // 环境文件（钩子改的项目设置这些）先还原、再剔除，不算没提交的改动（#2721）
      const leftover = await deliveryLeftover(t);
      // since 是起会话前的头：提交进 HEAD 的冲突标记要和它比。和主线一个字节都不差的文件在 unresolvedConflicts 里剔除。
      const conflicts = await unresolvedConflicts(t, { since: input.baseSha, mainline: span.mainline });
      // 相对钉住的主线新增了多少行（#2755 体量预算）：只给预算判用，没数成不带、不挡交活核对
      let addedLines: number | undefined;
      if (span.mainline) {
        try {
          addedLines = await addedLinesAgainst(t, span.mainline, head);
        } catch (error) {
          if (ctx.signal.aborted) throw error;
        }
      }
      return {
        head,
        commits: commits.length,
        changedFiles,
        leftover,
        conflicts,
        ...(addedLines === undefined ? {} : { addedLines }),
      };
    },

    async checkGuarded(input: CheckGuardedInput, ctx: PortContext): Promise<GuardedPaths> {
      const repo = refOf(input.repo);
      const files: ChangedFile[] = await mapped(() =>
        gh.pullFiles({ repo, prNumber: input.prNumber, signal: ctx.signal }),
      );
      const profile = await profileOf(repo);
      const listFile = profile?.standardPathsFile ?? STANDARD_PATHS_FILE;
      const standardText = await readList(repo, listFile, ctx);
      let list: ReturnType<typeof standardPathsList>;
      try {
        list = standardPathsList(standardText);
      } catch (error) {
        throw new PortError('GUARD_LIST_INVALID', `${listFile} 认不出：${errMessage(error)}`, {
          retryable: false,
        });
      }
      const standards = standardFiles(files, list).map(
        (h) => `${h.file}（${h.rule}${h.section ? `，只有「${h.section}」这一段算标准` : ''}）`,
      );
      // 人批过的（原样条目对得上）不再拦；没批过的、批了之后才多出来的照拦。
      const approvedStandards = new Set(input.approved?.standards ?? []);
      return { standards: standards.filter((s) => !approvedStandards.has(s)) };
    },

    async armAutoMerge(input: ArmAutoMergeInput, ctx: PortContext): Promise<ArmAutoMergeResult> {
      const repo = refOf(input.repo);
      const { prNumber, expectedHead } = input;
      const pull = await mapped(() => gh.claims.readPull(repo, prNumber));
      if (pull.merged) {
        const booked = await bookMerge(repo, prNumber, expectedHead, ctx);
        if (booked.otherHead !== undefined) {
          return { armed: false, merged: false, why: booked.otherHead };
        }
        await auditLateReview(repo, prNumber, ctx);
        return {
          armed: false,
          merged: true,
          ...(booked.mergeCommit === undefined ? {} : { mergeCommit: booked.mergeCommit }),
        };
      }
      if (pull.state !== 'open') {
        return { armed: false, merged: false, why: `PR #${prNumber} 已经关了` };
      }
      if (pull.headSha !== expectedHead) {
        return {
          armed: false,
          merged: false,
          why: `PR #${prNumber} 的头是 ${short(pull.headSha)}，不是引擎验过、推上去的 ${short(expectedHead)}（有人改过）`,
          headMoved: pull.headSha,
        };
      }
      const held = await reviewHold(repo, pull);
      if (held.length > 0) {
        return {
          armed: false,
          merged: false,
          why: `PR #${prNumber} 上还挂着 ${held.length} 条正式「要求改」的评审，不挂自动合并`,
          reviewChanges: held,
        };
      }
      if (pull.autoMerge) return { armed: true, merged: false };
      try {
        await mapped(() => gh.claims.enableAutoMerge(repo, pull));
        // 先挂、再读（#2991）：挂之前读到之后才交的评审，事件那头看到的是没挂（不撤）；挂上之后再读一遍，
        // 这一次之后交的评审，事件那头读到的就是已挂着（会撤）。两头合起来不留「检查完才到」的窗口。
        const after = await reviewHold(repo, { ...pull, autoMerge: true });
        if (after.length > 0) {
          return {
            armed: false,
            merged: false,
            why: `PR #${prNumber} 挂上自动合并后读到 ${after.length} 条正式「要求改」的评审，已撤掉`,
            reviewChanges: after,
          };
        }
        return { armed: true, merged: false };
      } catch (error) {
        if (!isCleanStatus(error)) throw error;
        // 所有条件都已满足：自动合并没有可等的东西，GitHub 不让挂。直接合（核头、核不落后主线、核 CI 绿）。
        const merged = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead }, ctx));
        if (merged.merged) {
          await auditLateReview(repo, prNumber, ctx);
          return { armed: false, merged: true, mergeCommit: merged.mergeCommit };
        }
        if (merged.reason === 'behind_main') {
          return syncBehindMain(repo, prNumber, expectedHead, input.syncedBehind ?? 0, merged.detail, ctx);
        }
        return {
          armed: false,
          merged: false,
          why: `GitHub 说 PR 已经满足合并条件，直接合被拒（${merged.reason}）：${merged.detail}`,
        };
      }
    },

    async mergeNow(input: MergeNowInput, ctx: PortContext): Promise<MergeNowResult> {
      const repo = refOf(input.repo);
      const { prNumber, expectedHead } = input;
      const pull = await mapped(() => gh.claims.readPull(repo, prNumber));
      if (pull.merged) {
        const booked = await bookMerge(repo, prNumber, expectedHead, ctx);
        if (booked.otherHead !== undefined)
          return { merged: false, reason: 'other', detail: booked.otherHead };
        await auditLateReview(repo, prNumber, ctx);
        return {
          merged: true,
          ...(booked.mergeCommit === undefined ? {} : { mergeCommit: booked.mergeCommit }),
        };
      }
      if (pull.state !== 'open') {
        return { merged: false, reason: 'closed', detail: `PR #${prNumber} 已经关了` };
      }
      if (pull.headSha !== expectedHead) {
        return {
          merged: false,
          reason: 'head_moved',
          detail: `PR #${prNumber} 的头是 ${short(pull.headSha)}，不是引擎推上去的 ${short(expectedHead)}`,
          headMoved: pull.headSha,
        };
      }
      const held = await reviewHold(repo, pull);
      if (held.length > 0) {
        return {
          merged: false,
          reason: 'review_changes',
          detail: `PR #${prNumber} 上还挂着 ${held.length} 条正式「要求改」的评审，不合`,
          reviewChanges: held,
        };
      }
      // 不核 CI。头、冲突、落后主线、还开着，mergePr 仍核。分支保护拒绝会抛，不装成合过了。
      const merged = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead, requireCi: false }, ctx));
      if (merged.merged) {
        await auditLateReview(repo, prNumber, ctx);
        return { merged: true, mergeCommit: merged.mergeCommit };
      }
      if (merged.reason === 'behind_main') {
        const synced = await syncBehindMain(
          repo,
          prNumber,
          expectedHead,
          input.syncedBehind ?? 0,
          merged.detail,
          ctx,
        );
        if (synced.headMoved !== undefined) {
          return {
            merged: false,
            reason: 'head_moved',
            detail: synced.why ?? merged.detail,
            headMoved: synced.headMoved,
            ...(synced.syncedMain === true ? { syncedMain: true } : {}),
          };
        }
        return { merged: false, reason: 'behind_main', detail: synced.why ?? merged.detail };
      }
      if (merged.reason === 'conflict') return { merged: false, reason: 'conflict', detail: merged.detail };
      if (merged.reason === 'not_open') return { merged: false, reason: 'closed', detail: merged.detail };
      if (merged.reason === 'head_moved')
        return { merged: false, reason: 'head_moved', detail: merged.detail };
      return { merged: false, reason: 'other', detail: `${merged.reason}：${merged.detail}` };
    },

    async waitMerged(input: WaitMergedInput, ctx: PortContext): Promise<MergeWait> {
      const repo = refOf(input.repo);
      const { prNumber, expectedHead } = input;
      const deadline = now().getTime() + input.minutes * 60_000;
      for (;;) {
        ctx.heartbeat();
        const pull = await mapped(() => gh.claims.readPull(repo, prNumber));
        if (pull.merged) {
          if (pull.headSha !== expectedHead) return { state: 'head_moved', head: pull.headSha };
          const booked = await bookMerge(repo, prNumber, expectedHead, ctx);
          await auditLateReview(repo, prNumber, ctx);
          return {
            state: 'merged',
            ...(booked.mergeCommit === undefined ? {} : { mergeCommit: booked.mergeCommit }),
          };
        }
        if (pull.state !== 'open') return { state: 'closed' };
        if (pull.headSha !== expectedHead) return { state: 'head_moved', head: pull.headSha };
        if (!pull.autoMerge) return { state: 'unarmed' };
        // 等合并时交的正式「要求改」（#2991）：每一圈现读，读到了先撤自动合并再交回工作流，不等 GitHub 把它合了
        const held = await reviewHold(repo, pull);
        if (held.length > 0) return { state: 'review_changes', reviewChanges: held };
        // 和主线冲突（#1838）：自动合并永远等不到（GitHub 不给冲突的 PR 起 CI、也不会合它，等下去只有超时）。
        // 当场回 conflict 交工作流去并主线，不在这儿干等。老历史里没有这个状态（那时候只回 waiting）。
        if (pull.mergeable === false || pull.mergeableState === 'dirty') {
          return { state: 'conflict', detail: `PR #${prNumber} 和主线冲突，自动合并等不到：要并主线` };
        }
        // 必过检查红了和还在跑都是 blocked（#1983）。红了当场交回去；没接上读检查就抛，不装成还在等。
        const readChecks = deps.readChecks;
        if (!readChecks) {
          throw new PortError('MERGE_CHECKS_UNWIRED', '等合并没接上读检查：红了和还在跑分不清，不接着等', {
            retryable: false,
          });
        }
        const checks = await mapped(() => readChecks(repo, pull.headSha, ctx.signal));
        if (checks.overall === 'red') return checksRedWait(checks);
        if (now().getTime() >= deadline) {
          return { state: 'waiting', detail: '自动合并挂着，GitHub 还没合（等必过检查和合并闸）' };
        }
        await sleep(pollEveryMs, ctx.signal);
      }
    },
  };
}
