// fleet-api task correct-merged 的执行段。预检和 --apply 各自现读一遍全部事实，判过了 --apply 才 CAS。
// 读的先后是钉死的：先读账（任务行更新时间、起代意图），再读 GitHub 和 Temporal。CAS 核的是这次读账的更新时间：
// 受管起代先落意图、改更新时间才去起 Temporal，所以读账之后才开始的起代必然让 CAS 回 stale；读账之前没结的起代在判断里就拒绝。
// 幂等不在判断之前短路：操作者、交付身份和审计回执都要过。写库失败把拒绝交回去，不另写一条失败审计。

import type { CasCorrectMergedInput } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import {
  CORRECTED_BY_PREFIX,
  type CorrectionDecision,
  type CorrectionRequest,
  type CorrectMergedSnapshot,
  decideCorrection,
  type LedgerTask,
  operatorAllowed,
  workflowBelongs,
} from './task-correct-merged.ts';

export interface CorrectMergedPorts {
  /** 先读账，再读 GitHub、Temporal。顺序不能换。 */
  read(req: CorrectionRequest): Promise<CorrectMergedSnapshot>;
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
    startPending: boolean;
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

function emptySnapshot(): CorrectMergedSnapshot {
  return {
    task: null,
    sessions: [],
    mirror: null,
    corrections: [],
    issue: null,
    pull: null,
    execution: { generations: [], matched: null },
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
          startPending: snap.task.startPending,
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

function refused(
  mode: CorrectMergedReport['mode'],
  req: CorrectionRequest,
  snap: CorrectMergedSnapshot,
  reason: string,
): CorrectMergedReport {
  return { mode, status: 'refused', text: reason, reason, preview: previewOf(req, snap, false) };
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

  let snap: CorrectMergedSnapshot;
  try {
    snap = await ports.read(req);
  } catch (err) {
    return refused(mode, req, blank, `读取事实没成（${errMessage(err)}），不纠正`);
  }
  const decision = decideCorrection(operator, req, snap);
  if (!decision.ok) return refused(mode, req, snap, decision.reason);
  if (decision.kind === 'already') {
    return {
      mode,
      status: 'already',
      text: `已纠正（之前已做过）：${ref}`,
      preview: previewOf(req, snap, true),
    };
  }
  if (mode === 'precheck') {
    return {
      mode,
      status: 'precheck',
      text: `可以纠正：${ref}（PR #${req.prNumber} 真实已合，将改为 done/merged；原 abandoned 结论留在原执行结果）`,
      preview: previewOf(req, snap, true),
    };
  }
  return apply(req, operator, reason, decision, snap, ports);
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
    });
  } catch (err) {
    return refused('apply', req, snap, `操作记录写不进（${errMessage(err)}），任务行保持原样，不纠正`);
  }
  if (outcome === 'stale') {
    return refused('apply', req, snap, '任务在核对之后变了（受管起代、换代或新运行），拒绝覆盖，请重新预检');
  }
  return {
    mode: 'apply',
    status: 'corrected',
    text: `已纠正：${ref}（PR #${req.prNumber} 真实已合，改为 done/merged；原 abandoned 结论留在原执行结果）`,
    preview: previewOf(req, snap, true),
  };
}
