// fleet-api task correct-merged（#3114 的受管纠正）：已经结束、却被旧引擎误记成 abandoned 的真实已合任务，
// 按真实 GitHub 交付事实改回 done（outcome=merged）。只认「原任务已结束、无活跃会话、真实 PR 已合且头与合并提交全部对得上」。
// 纯判断放在这里：输入是已经现读回来的事实，输出是拒绝原因或拟修正结果。读失败、事实不一致一律拒绝，
// 不用 issue closed 作为 done 的证明，不伪造旧 head 已合，不改 Temporal 历史，不重开 issue。

export const CORRECTED_BY_PREFIX = 'ops:correct-merged';

/** 从 GitHub 现读回来的 PR 事实（读不到的字段由调用方传 null，判断里一律当不一致）。 */
export interface PullFacts {
  repo: { owner: string; name: string };
  number: number;
  merged: boolean;
  /** PR 最终头（头 sha），不是分支名。 */
  head: string | null;
  /** 真实合并提交（squash 之后的 sha）。 */
  mergeCommit: string | null;
}

/** 库里现读回来的任务行（只取判断需要的字段）。 */
export interface TaskFacts {
  id: string;
  repo: { owner: string; name: string };
  issueNumber: number;
  state: string;
  phase: string | null;
  executor: string;
  /** 原 abandoned 结论那一刻的 updated_at（CAS 基准，毫秒）。 */
  updatedAtMs: number;
  /** 当前还挂着的会话数（运行中的 run）。 */
  openRunCount: number;
}

/** Temporal 现读回来的已结束执行身份。 */
export interface ExecutionFacts {
  workflowId: string;
  runId: string;
  running: boolean;
}

/** 操作者要求的精确身份（任何一项对不上都拒绝）。 */
export interface CorrectionRequest {
  repo: { owner: string; name: string };
  issueNumber: number;
  prNumber: number;
  head: string;
  mergeCommit: string;
  workflowId: string;
  runId: string;
}

export type CorrectionDecision =
  | { ok: true; before: { state: string; phase: string | null }; after: { state: 'done'; phase: 'merged' } }
  | { ok: false; reason: string };

const SHA = /^[a-f\d]{40}$/i;

function sameRepo(a: { owner: string; name: string }, b: { owner: string; name: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

/**
 * 判断能不能纠正。只读；所有前置一条不成立就拒绝并写明原因。
 * 调用方在真正写库时仍须用 updatedAtMs 做 CAS（防并发换代），这里只管事实。
 */
export function decideCorrection(
  req: CorrectionRequest,
  pr: PullFacts | null,
  task: TaskFacts | null,
  execution: ExecutionFacts | null,
): CorrectionDecision {
  if (!SHA.test(req.head) || !SHA.test(req.mergeCommit)) return refuse('请求里的 head 或 mergeCommit 不是完整 sha');
  if (!task) return refuse('库里没有这张单的任务，无法核对');
  if (!sameRepo(task.repo, req.repo) || task.issueNumber !== req.issueNumber) {
    return refuse('任务行的仓或单号与请求不一致（错仓或错单）');
  }
  if (task.executor !== 'engine') return refuse('这张单当前由本机执行，不是引擎账，不能由本命令纠正');
  if (task.state !== 'stopped' || task.phase !== 'abandoned') {
    return refuse(`这张单现在是 ${task.state}/${task.phase ?? '空'}，不是误记的 stopped/abandoned，不能纠正`);
  }
  if (task.openRunCount > 0) return refuse('原任务还有活跃会话，拒绝纠正，等它结束');
  if (!execution) return refuse('查不到原任务工作流的已结束身份，无法核对 workflow/run');
  if (execution.running) return refuse('原任务工作流仍在运行，不是已结束的执行，拒绝纠正');
  if (execution.workflowId !== req.workflowId || execution.runId !== req.runId) {
    return refuse('原任务的 workflow 或 run 身份与请求不一致（错 run）');
  }
  if (!pr) return refuse('读不到 GitHub 上的 PR，不能证明已合并');
  if (!sameRepo(pr.repo, req.repo) || pr.number !== req.prNumber) {
    return refuse('GitHub 上的 PR 仓或编号与请求不一致（错仓或错 PR）');
  }
  if (!pr.merged) return refuse('GitHub 上这个 PR 还没合并，不是真实已合交付');
  if (pr.head === null || pr.head.toLowerCase() !== req.head.toLowerCase()) {
    return refuse('PR 最终头与请求的 head 不一致（错 head，或旧头不能冒充已合）');
  }
  if (pr.mergeCommit === null || pr.mergeCommit.toLowerCase() !== req.mergeCommit.toLowerCase()) {
    return refuse('PR 真实合并提交与请求的 mergeCommit 不一致（错 merge）');
  }
  return {
    ok: true,
    before: { state: task.state, phase: task.phase },
    after: { state: 'done', phase: 'merged' },
  };
}

function refuse(reason: string): CorrectionDecision {
  return { ok: false, reason };
}

/** 重复同一请求的幂等判断：已经是纠正后的状态且身份一致，回「已纠正」，不再写。 */
export function alreadyCorrected(task: { state: string; phase: string | null } | null): boolean {
  return task !== null && task.state === 'done' && task.phase === 'merged';
}
