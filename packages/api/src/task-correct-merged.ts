// fleet-api task correct-merged：已经结束、却被误记成 abandoned 的真实已合任务。
// 纯判断。事实由调用方现读。任何一项对不上、读不到、或对不上同一次纠正回执，都拒绝。
// issue 关没关不看。不改 Temporal 历史，不重开 issue，不把旧 head 说成已合。

import {
  type CorrectMergedAuditReceipt,
  type CorrectMergedMirror,
  type CorrectMergedSessionLink,
  sessionLinkRefusal,
} from '@fleet-dao/db';
import { parseTaskWorkflowId } from '@fleet-dao/shared';
import { generationLife } from '@fleet-dao/shared/task-redo';

export const CORRECTED_BY_PREFIX = 'ops:correct-merged';

const SHA = /^[a-f\d]{40}$/i;

export interface PullFacts {
  repo: { owner: string; name: string };
  number: number;
  merged: boolean;
  head: string | null;
  mergeCommit: string | null;
}

/** 只证明这个编号在这个仓里、而且不是 PR。不读、不返回 state，关闭不是做完。 */
export interface IssueFacts {
  number: number;
  repo: { owner: string; name: string };
  isPullRequest: boolean;
}

export interface LedgerTask {
  id: string;
  repo: { owner: string; name: string };
  issueNumber: number;
  state: string;
  phase: string | null;
  executor: string;
  /** null = 库里没有更新时间，不能做 CAS。 */
  updatedAtMs: number | null;
  openRunCount: number;
  /** 有一次受管起代已经发出、结果没明确。 */
  startPending: boolean;
}

export interface GenerationFact {
  workflowId: string;
  generation: number;
  runId: string;
  status: string;
}

export interface ExecutionResult {
  outcome: string;
  prNumber: number;
  head: string;
}

/** 这一仓这一单的各代。读失败由读取方抛错，这里不会把失败变成空列表。 */
export interface ExecutionFacts {
  generations: GenerationFact[];
  matched: {
    workflowId: string;
    runId: string;
    status: string;
    /** 只有已完成且 run 对得上才填。形状不对是 null，不当成 abandoned。 */
    result: ExecutionResult | null;
  } | null;
}

export interface CorrectionRequest {
  repo: { owner: string; name: string };
  issueNumber: number;
  prNumber: number;
  head: string;
  mergeCommit: string;
  workflowId: string;
  runId: string;
}

export interface CorrectionIdentity {
  repo: string;
  issue: number;
  taskId: string;
  pr: number;
  head: string;
  mergeCommit: string;
  workflowId: string;
  runId: string;
}

export interface CorrectMergedSnapshot {
  task: LedgerTask | null;
  sessions: readonly CorrectMergedSessionLink[];
  mirror: CorrectMergedMirror | null;
  corrections: readonly CorrectMergedAuditReceipt[];
  issue: IssueFacts | null;
  pull: PullFacts | null;
  execution: ExecutionFacts;
}

export type CorrectionDecision =
  | {
      ok: true;
      kind: 'correct';
      before: { state: 'stopped'; phase: 'abandoned' };
      after: { state: 'done'; phase: 'merged' };
      receiptBefore: { state: 'stopped'; phase: 'abandoned' };
      receiptAfter: { state: 'done'; phase: 'merged' } & CorrectionIdentity;
    }
  | { ok: true; kind: 'already' }
  | { ok: false; reason: string };

const RECEIPT_BEFORE = { state: 'stopped', phase: 'abandoned' } as const;

export function operatorAllowed(operator: string): boolean {
  return (
    operator === operator.trim() && operator.length > 0 && operator.length <= 64 && !/[\r\n]/.test(operator)
  );
}

export function sameRepo(a: { owner: string; name: string }, b: { owner: string; name: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

/** 请求里的工作流编号必须就是这张单的任务工作流。别的已结束执行不能拿来授权。 */
export function workflowBelongs(
  workflowId: string,
  repo: { owner: string; name: string },
  issueNumber: number,
): boolean {
  const parsed = parseTaskWorkflowId(workflowId);
  return parsed !== null && sameRepo(parsed.repo, repo) && parsed.issueNumber === issueNumber;
}

export function correctionIdentity(req: CorrectionRequest, taskId: string): CorrectionIdentity {
  return {
    repo: `${req.repo.owner}/${req.repo.name}`.toLowerCase(),
    issue: req.issueNumber,
    taskId,
    pr: req.prNumber,
    head: req.head.toLowerCase(),
    mergeCommit: req.mergeCommit.toLowerCase(),
    workflowId: req.workflowId,
    runId: req.runId,
  };
}

function exactRecord(value: unknown, expected: Record<string, unknown>): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const got = value as Record<string, unknown>;
  const keys = Object.keys(got).sort();
  const want = Object.keys(expected).sort();
  if (keys.length !== want.length || keys.some((key, i) => key !== want[i])) return false;
  return want.every((key) => got[key] === expected[key]);
}

/** 幂等只认同一次纠正的完整身份。原因文字不在里面。多一条、少一条、多一个键都不算。 */
export function sameReceipt(row: CorrectMergedAuditReceipt, identity: CorrectionIdentity): boolean {
  return (
    exactRecord(row.before, RECEIPT_BEFORE) &&
    exactRecord(row.after, { state: 'done', phase: 'merged', ...identity })
  );
}

function idle(count: number): 'idle' | 'busy' | 'unknown' {
  if (!Number.isSafeInteger(count) || count < 0) return 'unknown';
  return count === 0 ? 'idle' : 'busy';
}

function refuse(reason: string): CorrectionDecision {
  return { ok: false, reason };
}

/**
 * 能不能纠正，或是不是同一次已经纠正过。
 * 重复调用走同一套前置：操作者、仓、单、PR、头、合并提交、工作流、run、没有活会话。
 * 已纠正只在任务行已经是 done/merged，并且有且只有一条对得上的成功回执时成立。
 */
export function decideCorrection(
  operator: string,
  req: CorrectionRequest,
  facts: CorrectMergedSnapshot,
): CorrectionDecision {
  if (!operatorAllowed(operator)) return refuse('未授权：没有可用的 ops 操作者，不纠正');
  if (!SHA.test(req.head) || !SHA.test(req.mergeCommit))
    return refuse('请求里的 head 或 mergeCommit 不是完整 sha');
  if (!workflowBelongs(req.workflowId, req.repo, req.issueNumber)) {
    return refuse('工作流编号不属于这张单，不能用别的执行来纠正');
  }
  const task = facts.task;
  if (!task) return refuse('库里没有这张单的任务，无法核对');
  if (!sameRepo(task.repo, req.repo) || task.issueNumber !== req.issueNumber) {
    return refuse('任务行的仓或单号与请求不一致（错仓或错单）');
  }
  if (task.executor !== 'engine') return refuse('这张单当前由本机执行，不是引擎账，不能由本命令纠正');
  const sessions = idle(task.openRunCount);
  if (sessions === 'unknown') return refuse('活跃会话数未知，不把未知当成没有会话');
  if (sessions === 'busy') return refuse('原任务还有活跃会话，拒绝纠正，等它结束');
  if (task.startPending) {
    return refuse('这张单有一次受管起代（重做或接手）已经发出、结果未知，可能正在起新一代，拒绝纠正');
  }

  const execution = facts.execution;
  if (execution.generations.some((row) => generationLife(row.status) === 'running')) {
    return refuse('原任务工作流仍在运行或状态看不清，拒绝纠正');
  }
  const highest = execution.generations.at(-1);
  if (!highest || highest.workflowId !== req.workflowId) {
    if (execution.generations.some((row) => row.workflowId === req.workflowId)) {
      return refuse('这张单已经有新的一代，拒绝用旧执行覆盖');
    }
    return refuse('查不到原任务工作流的已结束身份，无法核对 workflow/run');
  }
  const matched = execution.matched;
  if (!matched || matched.workflowId !== req.workflowId) {
    return refuse('查不到原任务工作流的已结束身份，无法核对 workflow/run');
  }
  if (matched.status !== 'COMPLETED') return refuse('原任务工作流不是已完成，拒绝纠正');
  if (matched.runId !== req.runId) return refuse('原任务的 run 身份与请求不一致（错 run）');
  const result = matched.result;
  if (!result) return refuse('原执行结果读不到，不能证明当时记的是 abandoned');
  if (result.outcome !== 'abandoned') return refuse('原执行结果不是 abandoned，不是这次要纠正的误记');
  if (result.prNumber !== req.prNumber || result.head.toLowerCase() !== req.head.toLowerCase()) {
    return refuse('原执行的 PR 或 head 与请求不一致，不能用别的交付来纠正');
  }
  const sessionGap = sessionLinkRefusal(facts.sessions, req.workflowId, req.prNumber, req.runId);
  if (sessionGap) return refuse(sessionGap);
  if (!facts.issue) return refuse('读不到这张 issue，不能确认编号属于这个仓');
  if (!sameRepo(facts.issue.repo, req.repo) || facts.issue.number !== req.issueNumber) {
    return refuse('GitHub 上的 issue 仓或编号与请求不一致（错仓或错单）');
  }
  if (facts.issue.isPullRequest) return refuse('这是 PR 不是 issue，拒绝纠正');
  if (!facts.pull) return refuse('读不到 GitHub 上的 PR，不能证明已合并');
  if (!sameRepo(facts.pull.repo, req.repo)) return refuse('GitHub 上的 PR 仓与请求不一致（错仓）');
  if (facts.pull.number !== req.prNumber) return refuse('GitHub 上的 PR 编号与请求不一致（错 PR）');
  if (!facts.pull.merged) return refuse('GitHub 上这个 PR 还没合并，不是真实已合交付');
  if (facts.pull.head === null || facts.pull.head.toLowerCase() !== req.head.toLowerCase()) {
    return refuse('PR 最终头与请求的 head 不一致（错 head，或旧头不能冒充已合）');
  }
  if (
    facts.pull.mergeCommit === null ||
    facts.pull.mergeCommit.toLowerCase() !== req.mergeCommit.toLowerCase()
  ) {
    return refuse('PR 真实合并提交与请求的 mergeCommit 不一致（错 merge）');
  }
  const mirror = mirrorProblem(facts.mirror, req);
  if (mirror) return refuse(mirror);

  const identity = correctionIdentity(req, task.id);
  const matchedReceipts = facts.corrections.filter((row) => sameReceipt(row, identity));
  if (task.state === 'done' && task.phase === 'merged') {
    if (facts.corrections.length === 1 && matchedReceipts.length === 1) return { ok: true, kind: 'already' };
    return refuse('没有同一次受管纠正的审计回执，不能把现在的 done/merged 当成已经纠正');
  }
  if (task.state === 'stopped' && task.phase === 'abandoned') {
    if (facts.corrections.length > 0) return refuse('审计和任务状态对不上：还有 abandoned，却已有纠正回执');
    if (task.updatedAtMs === null || !Number.isSafeInteger(task.updatedAtMs)) {
      return refuse('任务行没有可用的更新时间，不能做比对');
    }
    const receiptAfter = { state: 'done' as const, phase: 'merged' as const, ...identity };
    return {
      ok: true,
      kind: 'correct',
      before: { state: 'stopped', phase: 'abandoned' },
      after: { state: 'done', phase: 'merged' },
      receiptBefore: { state: 'stopped', phase: 'abandoned' },
      receiptAfter,
    };
  }
  return refuse(`这张单现在是 ${task.state}/${task.phase ?? '空'}，不是误记的 stopped/abandoned，不能纠正`);
}

/** 镜像可以没有。有了就不得和这次交付冲突。issueRefs 空着是没读到，不是没挂这张单。 */
function mirrorProblem(mirror: CorrectMergedMirror | null, req: CorrectionRequest): string | null {
  if (!mirror) return null;
  if (mirror.number !== req.prNumber) return '库里的 PR 镜像和这次交付不一致';
  if (mirror.headSha.toLowerCase() !== req.head.toLowerCase()) {
    return 'PR 镜像的头和请求不一致（错 head）';
  }
  if (mirror.mergeSha !== null && mirror.mergeSha.toLowerCase() !== req.mergeCommit.toLowerCase()) {
    return 'PR 镜像的合并提交和请求不一致（错 merge）';
  }
  if (mirror.issueRefs.length > 0 && !mirror.issueRefs.includes(req.issueNumber)) {
    return '库里的 PR 镜像没有挂这张单';
  }
  return null;
}
