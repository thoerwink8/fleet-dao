// 任务工作流（workflows/task.ts，#632 S2-4）要的活动里不碰会话的那五个的真实现：读交代、读交付、查改标准和先审后合的路径、
// 挂自动合并、等合并。会话（runSegment）和冷验收（coldVerify）各自在 task-segment.ts、task-verify.ts。
//
// 改这里之前必须知道：
// - 读不到、认不出一律抛错，不拿空冒充没事：清单读不出（不是「文件不在」）、PR 文件列表翻不完、工作树不在、git 没跑成，都抛。
//   只有「这个仓根本没声明改标准 / 先审后合清单」（文件不在）才当没有。
// - 合并这一步 GitHub 说了算：自动合并只由 armAutoMerge 在验收通过之后挂（每小时对账的兜底不碰任务分支，jobs/auto-merge-check.ts）。
//   挂的时候 GitHub 说「已经是 clean」（所有条件都满足了，没什么可等的）就直接合（github 包的 mergePr：核头、核不落后主线、
//   核 CI 绿），合不了的原样说明原因交工作流停下报人。
// - 合并记录：这个仓的对账（github 包 auditMergedPrs）要求引擎开的 PR 账上有合并记录。自动合并是 GitHub 自己合的，没有记录，
//   所以等到合并之后再调一次 mergePr——它对「已经合了」的 PR 只补记录、删分支，不再合一次。补不成只记日志，不拦任务往下走。
// - 等合并是长轮询（心跳不断）：叫停时休眠被打断，活动抛取消，不吞。

import type { SessionUser } from '@fleet-dao/adapters';
import {
  type ChangedFile,
  parseRiskPaths,
  parseStandardPaths,
  RISK_PATHS_FILE,
  riskyFiles,
  STANDARD_PATHS_FILE,
  standardFiles,
} from '@fleet-dao/conventions';
import type { RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import type { EngineTasks } from '../activities.ts';
import { type PortContext, PortError } from '../ports.ts';
import { readTaskBrief } from '../runner/task-brief.ts';
import type {
  ArmAutoMergeInput,
  ArmAutoMergeResult,
  CheckGuardedInput,
  DeliveryRead,
  GuardedPaths,
  MergeWait,
  ReadDeliveryInput,
  ReadTaskBriefInput,
  WaitMergedInput,
} from '../task-contract.ts';
import type { UserExec } from './exec.ts';
import type { EngineGitHub } from './github-ports.ts';
import { mapped } from './mirror.ts';
import {
  changedFilesSince,
  commitsSince,
  headOf,
  ownSpan,
  type UserTree,
  worktreeChanges,
} from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

/** 等合并时多久看一次 PR（毫秒）。 */
export const MERGE_POLL_EVERY_MS = 20_000;

export interface TaskActivitiesDeps {
  gh: Pick<EngineGitHub, 'readIssue' | 'readSpecDoc' | 'readRepoFile' | 'pullFiles' | 'mergePr' | 'claims'>;
  trees: Pick<WorkTrees, 'ownerOf'>;
  exec: UserExec;
  now?: () => Date;
  /** 看 PR 的间隔；默认 MERGE_POLL_EVERY_MS，测试调短。 */
  pollEveryMs?: number;
  /** 休眠，叫停（signal 触发）时要抛出来；测试里换成立刻返回的。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** 会话目录里跑的 git、sh（测试里换成 PATH 上的）。 */
  gitBin?: string;
  shBin?: string;
}

type TaskActivities = Required<
  Pick<EngineTasks, 'readTaskBrief' | 'readDelivery' | 'checkGuarded' | 'armAutoMerge' | 'waitMerged'>
>;

const refOf = (repo: { owner: string; name: string }): RepoRef => ({ owner: repo.owner, name: repo.name });
const short = (sha: string) => sha.slice(0, 7);

/** 可以被叫停打断的休眠。 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('被叫停了');
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
      const leftover = await worktreeChanges(t);
      return { head, commits: commits.length, changedFiles, leftover };
    },

    async checkGuarded(input: CheckGuardedInput, ctx: PortContext): Promise<GuardedPaths> {
      const repo = refOf(input.repo);
      const files: ChangedFile[] = await mapped(() =>
        gh.pullFiles({ repo, prNumber: input.prNumber, signal: ctx.signal }),
      );
      const standardText = await readList(repo, STANDARD_PATHS_FILE, ctx);
      const riskText = await readList(repo, RISK_PATHS_FILE, ctx);
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
      let highRisk: string[] = [];
      if (riskText !== null) {
        const list = parseRiskPaths(riskText);
        if (typeof list === 'string') {
          throw new PortError('GUARD_LIST_INVALID', `${RISK_PATHS_FILE} 认不出：${list}`, {
            retryable: false,
          });
        }
        highRisk = riskyFiles(files, list).map(
          (h) => `${h.file}（${h.kind}：${h.rule}${h.note ? `，${h.note}` : ''}）`,
        );
      }
      // 人批过的（原样条目对得上）不再拦；没批过的、批了之后才多出来的照拦。
      const approvedStandards = new Set(input.approved?.standards ?? []);
      const approvedRisk = new Set(input.approved?.highRisk ?? []);
      return {
        standards: standards.filter((s) => !approvedStandards.has(s)),
        highRisk: highRisk.filter((s) => !approvedRisk.has(s)),
      };
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
        return {
          armed: false,
          merged: false,
          why: `GitHub 说 PR 已经满足合并条件，直接合被拒（${merged.reason}）：${merged.detail}`,
        };
      }
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
        if (now().getTime() >= deadline) {
          return { state: 'waiting', detail: '自动合并挂着，GitHub 还没合（等必过检查和合并闸）' };
        }
        await sleep(pollEveryMs, ctx.signal);
      }
    },
  };
}
