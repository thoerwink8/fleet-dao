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
import {
  type ChangedFile,
  parseStandardPaths,
  STANDARD_PATHS_FILE,
  standardFiles,
} from '@fleet-dao/conventions';
import type { RepoRef } from '@fleet-dao/github';
import { abortableSleep, errMessage } from '@fleet-dao/shared/util';
import type { EngineTasks } from '../activities.ts';
import { type PortContext, PortError } from '../ports.ts';
import { readTaskBrief } from '../runner/task-brief.ts';
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
  WaitMergedInput,
} from '../task-contract.ts';
import { MAX_MAIN_SYNCS } from '../task-contract.ts';
import type { UserExec } from './exec.ts';
import type { EngineGitHub } from './github-ports.ts';
import { mapped } from './mirror.ts';
import {
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

export interface TaskActivitiesDeps {
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

  const treeAs = (dir: string, user: SessionUser, prefix: string, ctx: PortContext): UserTree => ({
    exec: deps.exec,
    user,
    dir,
    scopePrefix: prefix,
    signal: ctx.signal,
    ...(deps.gitBin ? { git: deps.gitBin } : {}),
    ...(deps.shBin ? { sh: deps.shBin } : {}),
  });

  /** 仓里声明的清单文件：文件不在＝这个仓没声明，回 null；在却读不出内容、读失败都抛。 */
  const readList = async (repo: RepoRef, path: string, ctx: PortContext): Promise<string | null> => {
    const read = await mapped(() => gh.readRepoFile({ repo, path, signal: ctx.signal }));
    if (read.file.kind === 'text') return read.file.text;
    if (read.file.kind === 'missing') return null;
    throw new PortError('GUARD_LIST_UNREADABLE', `主线上的 ${path} 读不了内容（${read.file.why}）`, {
      retryable: false,
    });
  };

  /** 已经合了的 PR：补合并记录、删分支（mergePr 对已合并的只做这两件）。补不成只记日志，合并这件事本身是确定的。 */
  const bookMerge = async (
    repo: RepoRef,
    prNumber: number,
    expectedHead: string,
    ctx: PortContext,
  ): Promise<{ mergeCommit?: string; otherHead?: string }> => {
    try {
      const r = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead }, ctx));
      if (r.merged) return { mergeCommit: r.mergeCommit };
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
      return readTaskBrief(
        {
          readIssue: ({ repo, issueNumber }) =>
            mapped(() => gh.readIssue({ repo, issueNumber, signal: ctx.signal })),
          readSpecDoc: async ({ repo, path }) => {
            const doc = await mapped(() => gh.readSpecDoc({ repo, path, signal: ctx.signal }, ctx));
            return doc ? { content: doc.content } : null;
          },
        },
        { repo: refOf(input.repo), issueNumber: input.issueNumber },
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
      return { head, commits: commits.length, changedFiles, leftover, conflicts };
    },

    async checkGuarded(input: CheckGuardedInput, ctx: PortContext): Promise<GuardedPaths> {
      const repo = refOf(input.repo);
      const files: ChangedFile[] = await mapped(() =>
        gh.pullFiles({ repo, prNumber: input.prNumber, signal: ctx.signal }),
      );
      const standardText = await readList(repo, STANDARD_PATHS_FILE, ctx);
      let standards: string[] = [];
      if (standardText !== null) {
        const list = parseStandardPaths(standardText);
        if (typeof list === 'string') {
          throw new PortError('GUARD_LIST_INVALID', `${STANDARD_PATHS_FILE} 认不出：${list}`, {
            retryable: false,
          });
        }
        standards = standardFiles(files, list).map(
          (h) => `${h.file}（${h.rule}${h.section ? `，只有「${h.section}」这一段算标准` : ''}）`,
        );
      }
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
      if (pull.autoMerge) return { armed: true, merged: false };
      try {
        await mapped(() => gh.claims.enableAutoMerge(repo, pull));
        return { armed: true, merged: false };
      } catch (error) {
        if (!isCleanStatus(error)) throw error;
        // 所有条件都已满足：自动合并没有可等的东西，GitHub 不让挂。直接合（核头、核不落后主线、核 CI 绿）。
        const merged = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead }, ctx));
        if (merged.merged) return { armed: false, merged: true, mergeCommit: merged.mergeCommit };
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
      // 不核 CI。头、冲突、落后主线、还开着，mergePr 仍核。分支保护拒绝会抛，不装成合过了。
      const merged = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead, requireCi: false }, ctx));
      if (merged.merged) return { merged: true, mergeCommit: merged.mergeCommit };
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
          return {
            state: 'merged',
            ...(booked.mergeCommit === undefined ? {} : { mergeCommit: booked.mergeCommit }),
          };
        }
        if (pull.state !== 'open') return { state: 'closed' };
        if (pull.headSha !== expectedHead) return { state: 'head_moved', head: pull.headSha };
        if (!pull.autoMerge) return { state: 'unarmed' };
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
