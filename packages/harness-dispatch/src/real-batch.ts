// 真执行冻结前的试算（#3865，#3783 的小补）：读单、判能不能冻、取主线基线。
// planRealBatch 不写库。runRealFreeze 是 freeze 命令：能冻且不是 --dry-run 才写 fleet2.real_batch_items。
// 有一张已关、是 PR 或读不到就整批不冻：清单冻结后不能改，写进去一半就废了。
import { type BatchItem, type Db, freezeRealBatch } from '@fleet-dao/harness-store';

export const REAL_USAGE =
  '用法：real.ts freeze [--dry-run] <批次号> <owner/仓#单号>… | status <owner/仓#单号>… | release <owner/仓#单号> [--pr handoff|close]';

/** 参数写错（缺批次、单号不像 owner/仓#号）。退出码 2，跟读单失败分开。 */
export class FreezeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreezeUsageError';
  }
}

export interface IssueRef {
  repo: string;
  issue: number;
}

/** 冻结前要问的两件事。生产用 githubReader，测试换假的。 */
export interface RealBatchReader {
  issueFacts(repo: string, issue: number): Promise<{ open: boolean; isPr: boolean }>;
  /** 分支现在的提交号。冻结只用主线 `main`。 */
  headSha(repo: string, branch: string): Promise<string>;
}

/** 已关、是 PR、读不到。reason 是给人看的一句。 */
export type RealBatchRejectKind = 'closed' | 'pr' | 'unreadable';

export interface RealBatchRejection {
  repo: string;
  issue: number;
  kind: RealBatchRejectKind;
  reason: string;
}

/** 能冻：带基线的清单。不能冻：只有被拒的那几张，没有可以拿去写库的半份清单。 */
export type RealBatchPlan = { ok: true; items: BatchItem[] } | { ok: false; rejected: RealBatchRejection[] };

const DRY_RUN = '--dry-run';
const BASE_BRANCH = 'main';

export function parseIssueRef(s: string): IssueRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m?.[1] || !m[2]) throw new FreezeUsageError(`单号写法不对（要 owner/仓#号）：${s}`);
  return { repo: m[1], issue: Number(m[2]) };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function reject(ref: IssueRef, kind: RealBatchRejectKind, reason: string): RealBatchRejection {
  return { repo: ref.repo, issue: ref.issue, kind, reason };
}

/**
 * 读每一张，判能不能进这批。同一仓的主线只取一次，这一批共用一个基线提交。
 * 任何一张不行就整批回拒绝（不再取还没取的基线）：调用方不该看到一份可以写一半的清单。
 */
export async function planRealBatch(
  refs: readonly IssueRef[],
  reader: RealBatchReader,
): Promise<RealBatchPlan> {
  const rejected: RealBatchRejection[] = [];
  for (const ref of refs) {
    let facts: { open: boolean; isPr: boolean };
    try {
      facts = await reader.issueFacts(ref.repo, ref.issue);
    } catch (err) {
      rejected.push(reject(ref, 'unreadable', `${ref.repo}#${ref.issue} 读不到：${messageOf(err)}`));
      continue;
    }
    // 关着的 PR 仍然不是单，先报是 PR，不报成已关。
    if (facts.isPr) rejected.push(reject(ref, 'pr', `${ref.repo}#${ref.issue} 是 PR，不是单`));
    else if (!facts.open) rejected.push(reject(ref, 'closed', `${ref.repo}#${ref.issue} 已经关了`));
  }
  if (rejected.length > 0) return { ok: false, rejected };

  const snapshotAt = new Date();
  const heads = new Map<string, Promise<string>>();
  const items: BatchItem[] = [];
  const baselineRejected: RealBatchRejection[] = [];
  for (const ref of refs) {
    let pending = heads.get(ref.repo);
    if (!pending) {
      pending = reader.headSha(ref.repo, BASE_BRANCH);
      heads.set(ref.repo, pending);
    }
    try {
      items.push({ ...ref, baseSha: await pending, snapshotAt });
    } catch (err) {
      baselineRejected.push(reject(ref, 'unreadable', `${ref.repo}#${ref.issue} 读不到：${messageOf(err)}`));
    }
  }
  if (baselineRejected.length > 0) return { ok: false, rejected: baselineRejected };
  return { ok: true, items };
}

export type FreezeCommandResult =
  | {
      exitCode: 0;
      body: { dryRun: true; batchId: string; items: { repo: string; issue: number; baseSha: string }[] };
    }
  | { exitCode: 0; body: { frozen: string; items: { repo: string; issue: number; baseSha: string }[] } }
  | { exitCode: 1; body: { dryRun: boolean; rejected: RealBatchRejection[] } };

/**
 * `real.ts freeze` 的路径。`--dry-run` 放在参数里任何位置都只表示试跑，不当成批次号或单号。
 * 能冻且不是试跑才调用 `freezeRealBatch`；试跑、或有任何一张被拒，都不碰库。
 */
export async function runRealFreeze(
  db: Db,
  args: readonly string[],
  reader: RealBatchReader,
): Promise<FreezeCommandResult> {
  const dryRun = args.includes(DRY_RUN);
  const rest = args.filter((a) => a !== DRY_RUN);
  const [batchId, ...refArgs] = rest;
  if (!batchId || refArgs.length === 0) throw new FreezeUsageError(REAL_USAGE);
  const refs = refArgs.map(parseIssueRef);
  const plan = await planRealBatch(refs, reader);
  if (!plan.ok) return { exitCode: 1, body: { dryRun, rejected: plan.rejected } };
  const items = plan.items.map(({ repo, issue, baseSha }) => ({ repo, issue, baseSha }));
  if (dryRun) return { exitCode: 0, body: { dryRun: true, batchId, items } };
  await freezeRealBatch(db, batchId, plan.items);
  return { exitCode: 0, body: { frozen: batchId, items } };
}
