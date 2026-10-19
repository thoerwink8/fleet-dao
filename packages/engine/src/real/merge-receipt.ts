// 已经合了的 PR 记合并回执（幂等账 github.merge_pr）的必经一步：挂自动合并、直接合、等合并（task-activities.ts）
// 和等 CI 时看到已合并（github-ports.ts 的 waitCi，#3018）都走 bookMergedPull，不另起一套记账。
//
// 改这里之前必须知道：
// - mergePr 必须带 onlyBook：在 writer 实际重读处核已合并事实和回执，绝不发合并请求；账上已经有这把键的（正常记的，或每小时对账补的
//   github.merge_pr_backfill）原样留着，不升级、不覆盖来源。
// - 等 CI 看到已合并时先现读 PR 核实：没合、关了没合、合的不是 CI 查过的头，都不记账、不当成合上了；读不到、记账没成
//   照抛（写明 PR 和合并提交），交 waitCi 这次活动重试或失败分流，不把结果未知当成功，也不留给对账去补。

import { errMessage } from '@fleet-dao/shared/util';
import type { CiResult } from '../decisions/types.ts';
import { type PortContext, PortError } from '../ports.ts';
import type { MergedTaskReceipt, ReadMergedTaskInput } from '../task-contract.ts';
import type { EngineGitHub } from './github-ports.ts';
import { mapped } from './mirror.ts';

type MergeRefused = Extract<Awaited<ReturnType<EngineGitHub['mergePr']>>, { merged: false }>;

export type MergeBooking =
  | { booked: true; mergeCommit: string; mergedBy: string | null; mergedByEngine: boolean }
  | { booked: false; reason: MergeRefused['reason']; detail: string };

export type MergeLog = (message: string, fields?: Record<string, unknown>) => void;

interface PullRef {
  repo: { owner: string; name: string };
  prNumber: number;
}

const short = (sha: string) => sha.slice(0, 7);

/** Never arms or merges an open PR. The writer re-reads the actual merge before onlyBook. */
export async function readMergedTask(
  gh: Pick<EngineGitHub, 'mergePr' | 'claims'>,
  input: ReadMergedTaskInput,
  ctx: PortContext,
  verifyIdle?: () => Promise<void>,
): Promise<MergedTaskReceipt | null> {
  const sha = /^[0-9a-f]{40}$/;
  if (
    input.schemaVersion !== 1 ||
    !input.repo?.owner ||
    !input.repo.name ||
    !Number.isSafeInteger(input.prNumber) ||
    input.prNumber <= 0 ||
    !sha.test(input.expectedHead) ||
    (input.expectedMergeCommit !== undefined && !sha.test(input.expectedMergeCommit))
  ) {
    throw new PortError('INVALID_INPUT', '已合任务收尾缺少完整 PR 身份', { retryable: false });
  }
  const pull = await mapped(() =>
    gh.claims.readPull(input.repo, input.prNumber, { requireMergeState: true }),
  );
  if (pull.number !== input.prNumber)
    throw new PortError('MERGE_IDENTITY_MISMATCH', '现读 PR 编号与原任务不一致', { retryable: false });
  // Ordinary open PRs are expected. A merged different head is never fresh authorization.
  // Normal checkpoint reads must not block reconnecting a detached session on an open PR.
  if (!pull.merged) {
    if (input.idle?.includeOpen) {
      if (!verifyIdle)
        throw new PortError('TASK_NOT_CONFIGURED', '未装配关单收尾的在跑会话核验', { retryable: false });
      await verifyIdle();
    }
    return null;
  }
  if (pull.headSha !== input.expectedHead)
    throw new PortError('MERGE_IDENTITY_MISMATCH', '已合 PR 不是原任务头，保留现场', { retryable: false });
  if (input.idle) {
    if (!verifyIdle)
      throw new PortError('TASK_NOT_CONFIGURED', '未装配已合收尾的在跑会话核验', { retryable: false });
    await verifyIdle();
  }
  const booked = await bookMergedPull(gh, input, ctx);
  if (
    !booked.booked ||
    !sha.test(booked.mergeCommit) ||
    (input.expectedMergeCommit !== undefined && input.expectedMergeCommit !== booked.mergeCommit)
  ) {
    throw new PortError('MERGE_IDENTITY_MISMATCH', '真实合并回执与待结清身份不一致', { retryable: false });
  }
  return {
    repo: input.repo,
    prNumber: input.prNumber,
    head: input.expectedHead,
    mergeCommit: booked.mergeCommit,
  };
}

/**
 * 给已经合了的 PR 记合并回执。onlyBook 在 writer 实际重读处拒绝未合并、错号和不完整回执，不能退到主动合并。
 * 合的不是 expectedHead 回 booked: false（merged_other_head），读不到、记不成照抛。
 */
export async function bookMergedPull(
  gh: Pick<EngineGitHub, 'mergePr'>,
  input: PullRef & { expectedHead: string },
  ctx: PortContext,
): Promise<MergeBooking> {
  const { repo, prNumber, expectedHead } = input;
  const r = await mapped(() => gh.mergePr({ repo, prNumber, expectedHead, onlyBook: true }, ctx));
  if (!r.merged) return { booked: false, reason: r.reason, detail: r.detail };
  return {
    booked: true,
    mergeCommit: r.mergeCommit,
    mergedBy: r.mergedBy ?? null,
    mergedByEngine: r.mergedByEngine === true,
  };
}

/**
 * 等 CI 看到 PR 已合并（ciResultOf 回 merged）：现读 PR 核实合的是 CI 查过的头，再走 bookMergedPull 记回执。
 * 回 merged 的 head、mergeCommit 都取现读和回执里的实际值，不拿入参的头顶。
 * 没合（还开着）回 unknown 让工作流重查；关了没合、合的是别的头回「PR 被关了」的 unknown，停下等人。
 */
export async function settleMergedCi(
  gh: Pick<EngineGitHub, 'mergePr' | 'claims'>,
  input: PullRef,
  ci: CiResult & { state: 'merged' },
  ctx: PortContext,
  log: MergeLog,
): Promise<CiResult> {
  const { prNumber } = input;
  const repo = { owner: input.repo.owner, name: input.repo.name };
  const fields = { repo: `${repo.owner}/${repo.name}`, prNumber, head: ci.head, mergeCommit: ci.mergeCommit };
  let pull: Awaited<ReturnType<EngineGitHub['claims']['readPull']>>;
  try {
    pull = await mapped(() => gh.claims.readPull(repo, prNumber));
  } catch (error) {
    log('等 CI 看到 PR 已合并，现读 PR 核实没读成，不记合并、不当成合上了', {
      ...fields,
      error: errMessage(error),
    });
    throw error;
  }
  const unknown = (detail: string): CiResult => {
    log(`等 CI 看到 PR 已合并，现读核实对不上：${detail}`, { ...fields, actualHead: pull.headSha });
    return { state: 'unknown', head: ci.head, failedChecks: [], detail };
  };
  if (!pull.merged) {
    return pull.state === 'open'
      ? unknown(`CI 那边读到 PR #${prNumber} 已合并，现读却还开着、没合`)
      : unknown(`PR 被关了：CI 那边读到 PR #${prNumber} 已合并，现读是关了没合`);
  }
  const otherHead = (detail: string) =>
    unknown(
      `PR 被关了：PR #${prNumber} 已经合并，但合的不是 CI 查过的头 ${short(ci.head)}（${detail}），要人看`,
    );
  if (pull.headSha !== ci.head) return otherHead(`合的头是 ${short(pull.headSha)}`);
  let booked: MergeBooking;
  try {
    booked = await bookMergedPull(gh, { repo, prNumber, expectedHead: pull.headSha }, ctx);
  } catch (error) {
    log('PR 已合并，记合并回执没成：这次等 CI 不算收场，重试再记', { ...fields, error: errMessage(error) });
    throw new PortError(
      'MERGE_RECEIPT_FAILED',
      `PR #${prNumber} 已合并（头 ${short(pull.headSha)}${ci.mergeCommit ? `，合并提交 ${short(ci.mergeCommit)}` : ''}），记合并回执没成：${errMessage(error).slice(0, 300)}`,
      {
        retryable: error instanceof PortError ? error.retryable : true,
        details: {
          prNumber,
          head: pull.headSha,
          ...(error instanceof PortError ? { cause: error.code } : {}),
        },
      },
    );
  }
  if (!booked.booked) {
    return booked.reason === 'merged_other_head'
      ? otherHead(booked.detail)
      : unknown(`记合并回执时 GitHub 不认 PR #${prNumber} 已合并（${booked.reason}）：${booked.detail}`);
  }
  if (ci.mergeCommit && booked.mergeCommit !== ci.mergeCommit) {
    log('等 CI 读到的合并提交和记账时现读的不一样，按现读的', {
      ...fields,
      actualMergeCommit: booked.mergeCommit,
    });
  }
  if (!booked.mergedByEngine) {
    log(
      booked.mergedBy === null
        ? 'PR 已合并、回执已记，但合并人读不到'
        : 'PR 已合并、回执已记，但不是「引擎」机器人合的',
      { ...fields, mergedBy: booked.mergedBy },
    );
  }
  return { state: 'merged', head: pull.headSha, failedChecks: [], mergeCommit: booked.mergeCommit };
}
