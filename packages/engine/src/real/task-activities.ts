// 任务工作流（workflows/task.ts，#632 S2-4）要的活动里不碰会话的那五个的真实现：读交代、读交付、查改标准的路径、
// 挂自动合并、等合并。会话（runSegment）和冷验收（coldVerify）各自在 task-segment.ts、task-verify.ts。
//
// 改这里之前必须知道：
// - 读不到、认不出一律抛错，不拿空冒充没事：清单读不出（不是「文件不在」）、PR 文件列表翻不完、工作树不在、git 没跑成，都抛。
//   只有「这个仓根本没声明改标准清单」（文件不在）才当没有。
// - 合并这一步 GitHub 说了算：自动合并只由 armAutoMerge 在验收通过之后挂（每小时对账的兜底不碰任务分支，jobs/auto-merge-check.ts）。
//   挂的时候 GitHub 说「已经是 clean」（所有条件都满足了，没什么可等的）就直接合（github 包的 mergePr：核头、核不落后主线、
//   核 CI 绿）。直接合因这个头上还有检查在跑被拒：现读检查，只有 queued / in_progress 才交 checksPending，工作流有界等待后
//   再走这一入口。真红交 checksRed。必过名单里有一条没出现，哪怕旁边还有在跑的，也不交 checksPending。读不成、没出现、对不上，
//   why 里写明没查成并点名没出现的检查，不靠「ci_not_green / 没跑完」这句原文当还在跑。
//   只是检查没跑完（合并闸在同一个头上重跑，ciPendingOnly）先在这一步里隔一会儿再合，等满 MERGE_PENDING_RETRIES 次
//   还没跑完再交回有界等待。别的拒绝原样说明原因交工作流停下报人。
// - 挂合并的写请求（enableAutoMerge、因 clean 才走的直接合、以及落后主线后的同步主线）在真正发出之前同时看取消信号和
//   这次活动的截止（PortContext 上的 attemptDeadlineMs / scheduleDeadlineMs）。信号已经取消（前面的读 PR、读评审、读检查
//   被挂住后再放行）就不再向 GitHub 发起新的写，哪怕数值截止还在将来。比较判出落后是在截止前开始的慢读，同步写要带上同一
//   截止，到了 GitHub 客户端的写边界再看一次。git 档不心跳，服务端判了超时之后进程里的代码还会往下走，取消信号不会响，
//   所以超时仍靠数值截止拦。截止已过同样不再开新的写；已经发出、结果未知的，下一次先 readPull：已经挂上或头已经换了就照实
//   回报，不盲重试。本地超时或取消撤不回 GitHub 已经接受的请求。没填截止、信号也没取消（活动测试不经 Temporal）时照旧写。
// - 合并记录：这个仓的对账（github 包 auditMergedPrs）要求引擎开的 PR 账上有合并记录。自动合并是 GitHub 自己合的，没有记录，
//   所以等到合并之后再调一次 mergePr——它对「已经合了」的 PR 只补记录、删分支，不再合一次。补不成只记日志，不拦任务往下走。
// - 等合并是长轮询（心跳不断）：叫停时休眠被打断，活动抛取消，不吞。
// - CI 红返工现读正式评审（readCiReviews）：读失败、身份不符、分页不全、读期间换头一律抛错或回未交付，不回空数组，不用旧快照。

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
  ReadCiReviewsInput,
  ReadCiReviewsResult,
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
/**
 * 挂自动合并时 GitHub 说已经 clean、直接合却因检查没跑完被拒：隔 MERGE_POLL_EVERY_MS 再合，最多再试这么多次（#3165）。
 * 10 × 20 秒，加上每次合并前的核对，留在 git 档 5 分钟的活动时限之内。
 */
export const MERGE_PENDING_RETRIES = 10;

/** 等合并这一下读到的必过检查。红了才带 failed。pending 名字只含还在跑的，没出现的不放；不给就是没分开报。 */
export interface MergeWaitChecks {
  overall: 'green' | 'red' | 'pending' | 'none';
  failed: { name: string; detail?: string }[];
  /** 还在跑（queued / in_progress）。有 missing 或 unsettled 时不带。老调用方不读。 */
  pending?: { name: string }[];
  /** 记成没出结论、却不是在跑的（stale、认不出的结论）：有就不当成可等，显式报没查成。老调用方不读。 */
  unsettled?: { name: string; conclusion: string }[];
  /**
   * 必过名单里这次没出现的。有就不当成可等：哪怕 pending 里还有名字，也不进有界等待，why 里点名没出现的。
   * 老调用方不读。
   */
  missing?: { name: string }[];
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
    | 'readTaskBrief'
    | 'readDelivery'
    | 'checkGuarded'
    | 'armAutoMerge'
    | 'waitMerged'
    | 'mergeNow'
    | 'readCiReviews'
  >
>;

const refOf = (repo: { owner: string; name: string }): RepoRef => ({ owner: repo.owner, name: repo.name });
const short = (sha: string) => sha.slice(0, 7);

/** 必过检查红了：检查名和原因交给工作流。没写名字就标明，不回空的。 */
function checksRedWait(checks: MergeWaitChecks): Extract<MergeWait, { state: 'checks_red' }> {
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

/**
 * 不要再向 GitHub 发起新的挂合并或直接合。
 * 先看取消信号：读 PR、读评审、读检查被挂住期间信号已经取消，放行之后数值截止往往还在将来，不能靠截止兜住。
 * 抛的是信号上的原因（Temporal 叫停是 CancelledFailure），好让这一次活动按取消收场，而不是当成挂合并失败去重试。
 * 不心跳时服务端超时不会把信号取消，进程里的代码还会往下走，所以接着看数值截止。两个截止都没填、信号也没取消
 * （不经 Temporal 的测试）就当还来得及。已经发出去的请求这里撤不回来。
 */
function refuseLateArmWrite(ctx: PortContext): void {
  ctx.signal.throwIfAborted();
  const marks = [ctx.attemptDeadlineMs, ctx.scheduleDeadlineMs].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n),
  );
  if (marks.length === 0) return;
  if (Date.now() < Math.min(...marks)) return;
  throw new PortError('ARM_DEADLINE_PASSED', '挂合并的期限已到，不再向 GitHub 发起新的挂合并或直接合', {
    retryable: false,
  });
}

/** 离绝对截止还剩多少毫秒。没填截止返回 null，调用方就按原来的间隔等。 */
function writeBudgetMs(ctx: PortContext): number | null {
  const marks = [ctx.attemptDeadlineMs, ctx.scheduleDeadlineMs].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n),
  );
  if (marks.length === 0) return null;
  return Math.min(...marks) - Date.now();
}

/** 直接合被拒时交回工作流的那句。reason 用机器认的枚举，不从 detail 里再猜。 */
function directRefusal(reason: string, detail: string): string {
  return `GitHub 说 PR 已经满足合并条件，直接合被拒（${reason}）：${detail}`;
}

/** 必过名单里这次没出现的检查名。空名字不算；有名字就不进有界等待。 */
function absentNames(checks: MergeWaitChecks): string[] {
  const names: string[] = [];
  for (const item of checks.missing ?? []) {
    const name = item.name.trim();
    if (name.length === 0 || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * 没出现，或跑完了却不是在跑：等合并不能当成还在排队。空名单返回 null。
 * 点名检查，并写明没查成。
 */
function unreadableChecksDetail(checks: MergeWaitChecks, prNumber: number, head: string): string | null {
  const missing = absentNames(checks);
  const unsettled = (checks.unsettled ?? []).filter((item) => item.name.trim().length > 0);
  if (missing.length === 0 && unsettled.length === 0) return null;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`${missing.join('、')} 没出现`);
  if (unsettled.length > 0) {
    const which = unsettled.map((item) => `${item.name}（${item.conclusion}）`).join('、');
    parts.push(`${which} 没出结论、也不是在跑`);
  }
  return `PR #${prNumber} 头 ${head} 的必过检查没查成：${parts.join('；')}`;
}

/** 还在跑的检查名。没给 pending、名字是空的，都不算。 */
function inProgressNames(checks: MergeWaitChecks): string[] {
  const names: string[] = [];
  for (const item of checks.pending ?? []) {
    const name = item.name.trim();
    if (name.length === 0 || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/** CI 返工读评审时看到的 PR 身份。owner/name 由调用方填上它实际读的那个仓。 */
export interface CiReviewPull {
  owner: string;
  name: string;
  number: number;
  headSha: string;
  headRef: string;
}

const REVIEW_SHA = /^[0-9a-f]{40}$/;

function sameRepoName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** 读失败一律带上「未交付」。已经是带这句的 PortError 就原样抛，保留错误码和能不能重试。 */
function undelivered(error: unknown, prNumber: number): PortError {
  if (error instanceof PortError && error.message.includes('未交付')) return error;
  const message = errMessage(error);
  const text = message.includes('未交付')
    ? message
    : `读 PR #${prNumber} 的正式评审没读成，未核实、未交付：${message}`;
  if (error instanceof PortError) {
    return new PortError(error.code, text, { retryable: error.retryable, details: error.details });
  }
  if (/403|permission|权限/i.test(message)) {
    return new PortError('PERMISSION_DENIED', text, { retryable: false });
  }
  return new PortError('REVIEW_READ_FAILED', text, { retryable: true });
}

function pullIdentity(pull: CiReviewPull, prNumber: number): CiReviewPull {
  if (
    pull === null ||
    pull === undefined ||
    typeof pull.owner !== 'string' ||
    pull.owner.length === 0 ||
    typeof pull.name !== 'string' ||
    pull.name.length === 0 ||
    typeof pull.headRef !== 'string' ||
    pull.headRef.length === 0 ||
    typeof pull.headSha !== 'string' ||
    !Number.isInteger(pull.number)
  ) {
    throw new PortError('CI_REVIEW_INCOMPLETE', `读 PR #${prNumber} 的身份不完整，未核实、未交付`, {
      retryable: true,
    });
  }
  return pull;
}

/** 行内意见必须钉在这一仓这一张 PR 上。解析失败、带查询串或指向别的仓，都不算读全。 */
function inlineBelongs(url: string, repo: { owner: string; name: string }, prNumber: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
  const expected = `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`;
  return parsed.pathname.toLowerCase() === expected.toLowerCase();
}

function pullMismatch(input: ReadCiReviewsInput, pull: CiReviewPull): PortError | null {
  if (!sameRepoName(pull.owner, input.repo.owner) || !sameRepoName(pull.name, input.repo.name)) {
    return new PortError(
      'CI_REVIEW_REPO_MISMATCH',
      `读到的 PR 属于 ${pull.owner}/${pull.name}，不是 ${input.repo.owner}/${input.repo.name}，未核实、未交付`,
      { retryable: false },
    );
  }
  if (pull.number !== input.prNumber || pull.headRef !== input.branch) {
    return new PortError(
      'CI_REVIEW_PR_MISMATCH',
      `读到的是 ${pull.headRef} #${pull.number}，不是 ${input.branch} #${input.prNumber}，未核实、未交付`,
      { retryable: false },
    );
  }
  return null;
}

/**
 * CI 红返工要用的正式评审快照。和冷验收、合并入口共用 reviewChanges（白名单、原作者、分页行内）。
 * 读之前和读完各对一次 PR 身份；头变了丢弃已读内容。任何失败都不回空数组。
 */
export async function readCiReviewSnapshot(
  deps: {
    reviewChanges?: (repo: RepoRef, prNumber: number) => Promise<ReviewChange[]>;
    readPull: (repo: RepoRef, prNumber: number) => Promise<CiReviewPull>;
  },
  input: ReadCiReviewsInput,
): Promise<ReadCiReviewsResult> {
  if (
    input?.schemaVersion !== 1 ||
    typeof input.taskId !== 'string' ||
    input.taskId.length === 0 ||
    !input.repo?.owner ||
    !input.repo?.name ||
    typeof input.branch !== 'string' ||
    input.branch.length === 0 ||
    !Number.isInteger(input.prNumber) ||
    input.prNumber <= 0 ||
    !REVIEW_SHA.test(input.expectedHead)
  ) {
    throw new PortError('INVALID_INPUT', '读 CI 返工时的正式评审：仓、PR、分支、头不齐，未核实、未交付', {
      retryable: false,
    });
  }
  if (deps.reviewChanges === undefined) {
    throw new PortError('REVIEW_READ_UNWIRED', '正式评审读取未装配，未核实、未交付，不能当作没有评审', {
      retryable: false,
    });
  }
  const repo = { owner: input.repo.owner, name: input.repo.name };
  const loadPull = async (): Promise<CiReviewPull> => {
    try {
      return pullIdentity(await deps.readPull(repo, input.prNumber), input.prNumber);
    } catch (error) {
      throw undelivered(error, input.prNumber);
    }
  };
  const before = await loadPull();
  const beforeMismatch = pullMismatch(input, before);
  if (beforeMismatch) throw beforeMismatch;
  if (before.headSha !== input.expectedHead) {
    return {
      delivered: false,
      reason: `读正式评审前 PR #${input.prNumber} 的头已是 ${before.headSha}，不是 CI 红的 ${input.expectedHead}，未核实、未交付`,
      headMoved: before.headSha,
    };
  }
  let reviews: ReviewChange[];
  try {
    reviews = await deps.reviewChanges(repo, input.prNumber);
  } catch (error) {
    throw undelivered(error, input.prNumber);
  }
  if (!Array.isArray(reviews)) {
    throw new PortError(
      'CI_REVIEW_INCOMPLETE',
      `读 PR #${input.prNumber} 的正式评审不是完整名单，未核实、未交付`,
      { retryable: true },
    );
  }
  for (const review of reviews) {
    if (!Array.isArray(review.inlineComments)) {
      throw new PortError(
        'CI_REVIEW_INCOMPLETE',
        `review ${review.reviewId} 的行内原文未读全，未核实、未交付，不能当作没有行内意见`,
        { retryable: true },
      );
    }
    for (const comment of review.inlineComments) {
      if (!inlineBelongs(comment.pullRequestUrl, repo, input.prNumber)) {
        throw new PortError(
          'CI_REVIEW_REPO_MISMATCH',
          `review ${review.reviewId} comment ${comment.id} 的行内地址不属于 ${repo.owner}/${repo.name}#${input.prNumber}，未核实、未交付`,
          { retryable: false },
        );
      }
    }
  }
  const after = await loadPull();
  const afterMismatch = pullMismatch(input, after);
  if (afterMismatch) throw afterMismatch;
  if (after.headSha !== input.expectedHead) {
    return {
      delivered: false,
      reason: `读正式评审期间 PR #${input.prNumber} 的头换成了 ${after.headSha}，这次读到的内容作废，未核实、未交付`,
      headMoved: after.headSha,
    };
  }
  return { delivered: true, head: input.expectedHead, reviews };
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
   * ctx 原样交给 updateBranch：比较可能已经跨过截止，同步写在客户端真正发出前再看一次截止和取消。
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
        mainSyncBudgetExhausted: { prNumber, headSha: expectedHead, used: syncedBefore },
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

      // clean 之后的直接合。recheckCi 只在「现读已经是绿」时再走一次同一个 mergePr，避免检查刚转绿就停。
      const acceptDirectMerge = async (
        result: Awaited<ReturnType<TaskActivitiesDeps['gh']['mergePr']>>,
        recheckCi: boolean,
      ): Promise<ArmAutoMergeResult> => {
        if (result.merged) {
          await auditLateReview(repo, prNumber, ctx);
          return { armed: false, merged: true, mergeCommit: result.mergeCommit };
        }
        if (result.reason === 'behind_main') {
          return syncBehindMain(repo, prNumber, expectedHead, input.syncedBehind ?? 0, result.detail, ctx);
        }
        if (result.reason === 'ci_not_green') return classifyCiNotGreen(result.detail, recheckCi);
        return { armed: false, merged: false, why: directRefusal(result.reason, result.detail) };
      };

      // 不看拒绝原文里的「没跑完 / 红了」。还在跑只认 readChecks 交回的 pending 名字，并且绑这个 expectedHead。
      // 必过检查没出现（missing）或没出结论（unsettled）时，旁边的 pending 名字也不算可等。
      const classifyCiNotGreen = async (detail: string, recheckCi: boolean): Promise<ArmAutoMergeResult> => {
        const why = directRefusal('ci_not_green', detail);
        const readChecks = deps.readChecks;
        if (!readChecks) {
          return { armed: false, merged: false, why: `${why}；必过检查没查成：等合并没接上读检查` };
        }
        let checks: MergeWaitChecks;
        try {
          checks = await mapped(() => readChecks(repo, expectedHead, ctx.signal));
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          return { armed: false, merged: false, why: `${why}；必过检查没查成：${errMessage(error)}` };
        }
        const failed = checks.failed.filter((item) => item.name.trim().length > 0);
        if (checks.overall === 'red' || failed.length > 0) {
          const red = checksRedWait({ ...checks, failed });
          return {
            armed: false,
            merged: false,
            why,
            checksRed: { failedChecks: red.failedChecks, detail: red.detail, head: expectedHead },
          };
        }
        // 没出现、或跑完了却是 stale / 认不出：都不是还在跑。旁边的 pending 名字也不进有界等待。
        const missing = absentNames(checks);
        const unsettled = checks.unsettled ?? [];
        if (missing.length > 0 || unsettled.length > 0) {
          const parts: string[] = [];
          if (missing.length > 0) parts.push(`${missing.join('、')} 没出现`);
          if (unsettled.length > 0) {
            const which = unsettled.map((item) => `${item.name}（${item.conclusion}）`).join('、');
            parts.push(`${which} 没出结论、也不是在跑`);
          }
          return {
            armed: false,
            merged: false,
            why: `${why}；必过检查没查成：${parts.join('；')}`,
          };
        }
        const names = inProgressNames(checks);
        // overall 是 pending 但名字空着（全是没出现、或没分开报）不当成可等。没出现的名字在上面已经单独报过。
        if (checks.overall === 'pending' && names.length > 0) {
          return {
            armed: false,
            merged: false,
            why,
            checksPending: { names, head: expectedHead, detail: why },
          };
        }
        if (checks.overall === 'green' && recheckCi) {
          refuseLateArmWrite(ctx);
          const again = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead }, ctx));
          return acceptDirectMerge(again, false);
        }
        if (checks.overall === 'green') {
          return { armed: false, merged: false, why: `${why}；必过检查读着是绿，直接合仍被拒` };
        }
        return {
          armed: false,
          merged: false,
          why: `${why}；必过检查没查成：读到 ${checks.overall}，没有还在跑的检查名`,
        };
      };

      try {
        // 读过 PR、读过评审了：已经挂上的在上面返回，不会走到这里。已取消或期限已过就不再开新的写。
        refuseLateArmWrite(ctx);
        await mapped(() => gh.claims.enableAutoMerge(repo, pull, ctx));
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
        // 这一下若已取消，或挂的时候把期限用完，不再另开直接合。已经发出去的挂合并请求撤不回来。
        refuseLateArmWrite(ctx);
        let merged = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead }, ctx));
        // 只是检查没跑完（没有红的、没出现的）：多半是验收结果刚写、合并闸在同一个头上重跑（#3165）。
        // 在这一步里隔一会儿再合。每一轮再看取消和绝对截止，过了就不再发新的合并写。
        // 等满、或仍不是「只是没跑完」，交给后面的分类：还在跑交有界等待，落后主线才同步。
        for (
          let i = 0;
          !merged.merged && merged.ciPendingOnly === true && i < MERGE_PENDING_RETRIES;
          i += 1
        ) {
          const left = writeBudgetMs(ctx);
          if (left !== null && left < 1) break;
          await sleep(left === null ? pollEveryMs : Math.min(pollEveryMs, left), ctx.signal);
          refuseLateArmWrite(ctx);
          merged = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead }, ctx));
        }
        return acceptDirectMerge(merged, true);
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
        return {
          merged: false,
          reason: 'behind_main',
          detail: synced.why ?? merged.detail,
          ...(synced.mainSyncBudgetExhausted
            ? { mainSyncBudgetExhausted: synced.mainSyncBudgetExhausted }
            : {}),
        };
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
        // 没出现、没出结论都不是还在跑。旁边就算还有 pending 名字，也不接着轮询装成能等。
        const unread = unreadableChecksDetail(checks, prNumber, pull.headSha);
        if (unread) return { state: 'checks_unreadable', detail: unread };
        if (now().getTime() >= deadline) {
          return { state: 'waiting', detail: '自动合并挂着，GitHub 还没合（等必过检查和合并闸）' };
        }
        await sleep(pollEveryMs, ctx.signal);
      }
    },

    async readCiReviews(input: ReadCiReviewsInput, ctx: PortContext): Promise<ReadCiReviewsResult> {
      ctx.heartbeat();
      const reviewChanges = deps.reviewChanges;
      return readCiReviewSnapshot(
        {
          ...(reviewChanges === undefined ? {} : { reviewChanges }),
          readPull: async (repo, prNumber) => {
            const pull = await mapped(() => gh.claims.readPull(repo, prNumber));
            return {
              owner: repo.owner,
              name: repo.name,
              number: pull.number,
              headSha: pull.headSha,
              headRef: pull.headRef,
            };
          },
        },
        input,
      );
    },
  };
}
