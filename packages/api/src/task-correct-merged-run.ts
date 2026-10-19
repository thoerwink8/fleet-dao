// fleet-api task correct-merged 的执行段。预检只读一次。执行先再读一遍，两遍不一致就拒绝，然后才 CAS。
// 幂等不在判断之前短路：操作者、交付身份和审计回执都要过。写库失败把拒绝交回去，不另写一条失败审计。

import type { CasCorrectMergedInput } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import {
  CORRECTED_BY_PREFIX,
  type CorrectionDecision,
  type CorrectionRequest,
  type CorrectMergedSnapshot,
  decideCorrection,
  type ExecutionFacts,
  type LedgerTask,
  operatorAllowed,
  workflowBelongs,
} from './task-correct-merged.ts';

export interface CorrectMergedPorts {
  /** 任务栅栏（与受管起代共用）：fn 里做第二次读取、核对、写入。 */
  fence<T>(taskId: string, fn: () => Promise<T>): Promise<T>;
  read(req: CorrectionRequest): Promise<CorrectMergedSnapshot>;
  /** 只读这张单的原工作流各代（Temporal describe/result），给 CAS 前后核对用。 */
  execution(req: CorrectionRequest): Promise<ExecutionFacts>;
  cas(input: Omit<CasCorrectMergedInput, 'now'>): Promise<'corrected' | 'stale'>;
}

export interface CorrectMergedPreview {
  repo: string;
  issue: number;
  task: {
    id: string;
    state: string;
    phase: string | null;
    updatedAtMs: number | null;
    openRunCount: number;
  } | null;
  execution: {
    workflowId: string;
    runId: string;
    status: string;
    outcome: string | null;
    prNumber: number | null;
    head: string | null;
  } | null;
  generations: { workflowId: string; generation: number; runId: string; status: string }[];
  pull: { number: number; merged: boolean; head: string | null; mergeCommit: string | null } | null;
  proposed: { state: 'done'; phase: 'merged' } | null;
}

export interface CorrectMergedReport {
  mode: 'precheck' | 'apply';
  status: 'precheck' | 'corrected' | 'already' | 'refused';
  text: string;
  reason?: string;
  preview: CorrectMergedPreview;
}

const EMPTY_EXECUTION: CorrectMergedSnapshot['execution'] = { generations: [], matched: null };

function emptySnapshot(): CorrectMergedSnapshot {
  return {
    task: null,
    sessions: [],
    mirror: null,
    corrections: [],
    issue: null,
    pull: null,
    execution: EMPTY_EXECUTION,
  };
}

function previewOf(
  req: CorrectionRequest,
  snap: CorrectMergedSnapshot,
  proposed: boolean,
): CorrectMergedPreview {
  const matched = snap.execution.matched;
  return {
    repo: `${req.repo.owner}/${req.repo.name}`,
    issue: req.issueNumber,
    task: snap.task
      ? {
          id: snap.task.id,
          state: snap.task.state,
          phase: snap.task.phase,
          updatedAtMs: snap.task.updatedAtMs,
          openRunCount: snap.task.openRunCount,
        }
      : null,
    execution: matched
      ? {
          workflowId: matched.workflowId,
          runId: matched.runId,
          status: matched.status,
          outcome: matched.result?.outcome ?? null,
          prNumber: matched.result?.prNumber ?? null,
          head: matched.result?.head ?? null,
        }
      : null,
    generations: snap.execution.generations.map((row) => ({
      workflowId: row.workflowId,
      generation: row.generation,
      runId: row.runId,
      status: row.status,
    })),
    pull: snap.pull
      ? {
          number: snap.pull.number,
          merged: snap.pull.merged,
          head: snap.pull.head,
          mergeCommit: snap.pull.mergeCommit,
        }
      : null,
    proposed: proposed ? { state: 'done', phase: 'merged' } : null,
  };
}

function fingerprint(snap: CorrectMergedSnapshot): string {
  return JSON.stringify({
    task: snap.task,
    sessions: snap.sessions,
    mirror: snap.mirror,
    corrections: snap.corrections,
    issue: snap.issue,
    pull: snap.pull,
    execution: snap.execution,
  });
}

function refused(
  mode: CorrectMergedReport['mode'],
  req: CorrectionRequest,
  snap: CorrectMergedSnapshot,
  reason: string,
): CorrectMergedReport {
  return { mode, status: 'refused', text: reason, reason, preview: previewOf(req, snap, false) };
}

function described(
  decision: CorrectionDecision,
  ref: string,
  prNumber: number,
): { status: 'precheck' | 'already'; text: string } {
  if (decision.ok && decision.kind === 'already') {
    return { status: 'already', text: `已纠正（之前已做过）：${ref}` };
  }
  return {
    status: 'precheck',
    text: `可以纠正：${ref}（PR #${prNumber} 真实已合，将改为 done/merged；原 abandoned 结论留在原执行结果）`,
  };
}

export async function runCorrectMerged(
  req: CorrectionRequest,
  operator: string,
  reason: string,
  mode: 'precheck' | 'apply',
  ports: CorrectMergedPorts,
): Promise<CorrectMergedReport> {
  const ref = `${req.repo.owner}/${req.repo.name}#${req.issueNumber}`;
  const blank = emptySnapshot();
  if (!operatorAllowed(operator)) return refused(mode, req, blank, '未授权：没有可用的 ops 操作者，不纠正');
  if (!workflowBelongs(req.workflowId, req.repo, req.issueNumber)) {
    return refused(mode, req, blank, '工作流编号不属于这张单，不能用别的执行来纠正');
  }

  let first: CorrectMergedSnapshot;
  try {
    first = await ports.read(req);
  } catch (err) {
    return refused(mode, req, blank, `读取事实没成（${errMessage(err)}），不纠正`);
  }
  const decision = decideCorrection(operator, req, first);
  if (!decision.ok) return refused(mode, req, first, decision.reason);
  const proposed = previewOf(req, first, true);
  if (mode === 'precheck') {
    const view = described(decision, ref, req.prNumber);
    return { mode, status: view.status, text: view.text, preview: proposed };
  }

  const taskId = first.task?.id;
  if (!taskId) return refused(mode, req, first, '任务行不在库里，不纠正');
  // 栅栏里才第二次读取、核对、写入：受管起代（重做）也抢这把栅栏，所以它要么在这之前起完（这里核对到新代、拒绝），
  // 要么等这里写完（重做重读到已做完、拒绝）。两边不会交错。
  return ports.fence(taskId, () => confirmAndApply(req, operator, reason, mode, first, decision, ports, ref));
}

async function confirmAndApply(
  req: CorrectionRequest,
  operator: string,
  reason: string,
  mode: 'precheck' | 'apply',
  first: CorrectMergedSnapshot,
  decision: Extract<CorrectionDecision, { ok: true }>,
  ports: CorrectMergedPorts,
  ref: string,
): Promise<CorrectMergedReport> {
  let second: CorrectMergedSnapshot;
  try {
    second = await ports.read(req);
  } catch (err) {
    return refused(mode, req, first, `读取事实没成（${errMessage(err)}），不纠正`);
  }
  const again = decideCorrection(operator, req, second);
  if (!again.ok) return refused(mode, req, second, again.reason);
  if (again.kind !== decision.kind || fingerprint(first) !== fingerprint(second)) {
    return refused(mode, req, second, '任务在核对之后变了（并发换代或新运行），拒绝覆盖，请重新预检');
  }
  if (again.kind === 'already') {
    return {
      mode,
      status: 'already',
      text: `已纠正（之前已做过）：${ref}`,
      preview: previewOf(req, second, true),
    };
  }
  return apply(req, operator, reason, again, second, ports);
}

async function apply(
  req: CorrectionRequest,
  operator: string,
  reason: string,
  decision: Extract<CorrectionDecision, { ok: true; kind: 'correct' }>,
  snap: CorrectMergedSnapshot,
  ports: CorrectMergedPorts,
): Promise<CorrectMergedReport> {
  const task = snap.task as LedgerTask;
  const ref = `${req.repo.owner}/${req.repo.name}#${req.issueNumber}`;
  // 代数和结果在 CAS 前后各核一次（CAS 在任务行锁里做）。与核对时冻结的快照不一致、或读不到，就回滚拒绝。
  const frozen = JSON.stringify(snap.execution);
  const verify = async (): Promise<boolean> => JSON.stringify(await ports.execution(req)) === frozen;
  let outcome: 'corrected' | 'stale';
  try {
    outcome = await ports.cas({
      taskId: task.id,
      expectedUpdatedAtMs: task.updatedAtMs ?? Number.NaN,
      workflowId: req.workflowId,
      runId: req.runId,
      prNumber: req.prNumber,
      audit: {
        actorId: `${CORRECTED_BY_PREFIX}:${operator}`,
        reason,
        before: decision.receiptBefore,
        after: decision.receiptAfter,
      },
      verify,
    });
  } catch (err) {
    return refused(
      'apply',
      req,
      snap,
      `操作记录写不进或核对没成（${errMessage(err)}），任务行保持原样，不纠正`,
    );
  }
  if (outcome === 'stale') {
    return refused('apply', req, snap, '任务在核对之后变了（并发换代或新运行），拒绝覆盖，请重新预检');
  }
  return {
    mode: 'apply',
    status: 'corrected',
    text: `已纠正：${ref}（PR #${req.prNumber} 真实已合，改为 done/merged；原 abandoned 结论留在原执行结果）`,
    preview: previewOf(req, snap, true),
  };
}
