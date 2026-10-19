// Existing hourly reconciliation, not a new worker or a second state store.
import type { RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { parseTaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { ClosedIssueHoldToken, MergedTaskReceipt } from '../task-contract.ts';
import type { SweepPart } from './reconcile-common.ts';

export interface MergedTaskCandidate {
  workflowId: string;
  repo: RepoRef;
  prNumber: number;
  head: string;
  token: ClosedIssueHoldToken;
}

export interface MergedTaskClosureDeps {
  mergedTasks?: {
    workflows(): Promise<string[]>;
    candidate(workflowId: string): Promise<MergedTaskCandidate | null>;
    readMerged(candidate: MergedTaskCandidate): Promise<MergedTaskReceipt | null>;
    settle(
      candidate: MergedTaskCandidate,
      receipt: MergedTaskReceipt,
    ): Promise<'accepted' | 'stale' | 'busy' | 'gone'>;
  };
}

/** Capability and identity are read together; a path/name or PR number alone cannot authorize settlement. */
export function mergedTaskCandidateOf(raw: unknown, workflowId: string): MergedTaskCandidate | null {
  const ref = parseTaskWorkflowId(workflowId);
  if (!ref || !raw || typeof raw !== 'object') throw new Error('已合任务身份没读成');
  const status = raw as Record<string, unknown>;
  if (status.phase !== 'parked' && status.phase !== 'paused') return null;
  if (status.prNumber === null) return null;
  const cap = status.mergedTaskClose as
    | {
        version?: unknown;
        token?: ClosedIssueHoldToken | null;
        repo?: RepoRef;
        prNumber?: unknown;
        head?: unknown;
      }
    | undefined;
  if (cap?.version !== 1) throw new Error('旧 worker 没有已合 PR 收尾能力，不发继续或放弃');
  if (cap.token === null) return null;
  const token = cap.token;
  if (
    token?.version !== 1 ||
    typeof token.runId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token.runId) ||
    token.kind !== status.phase ||
    !Number.isSafeInteger(token.generation) ||
    token.generation < 1 ||
    !Number.isSafeInteger(token.continued) ||
    token.continued < 0 ||
    cap.repo?.owner !== ref.repo.owner ||
    cap.repo.name !== ref.repo.name ||
    cap.prNumber !== status.prNumber ||
    !Number.isSafeInteger(cap.prNumber) ||
    (cap.prNumber as number) <= 0 ||
    typeof cap.head !== 'string' ||
    !/^[0-9a-f]{40}$/.test(cap.head)
  ) {
    throw new Error('已合任务停法/仓/PR/头身份不完整');
  }
  return { workflowId, repo: ref.repo, prNumber: cap.prNumber as number, head: cap.head, token };
}

export async function settleMergedTasks(deps: MergedTaskClosureDeps): Promise<SweepPart> {
  const part: SweepPart = { scanned: 0, found: 0, unchecked: [] };
  const port = deps.mergedTasks;
  if (!port) return part;
  let ids: string[];
  try {
    ids = await port.workflows();
  } catch (error) {
    return { ...part, failed: `已合任务工作流没列成：${errMessage(error)}` };
  }
  for (const workflowId of ids) {
    part.scanned += 1;
    try {
      const candidate = await port.candidate(workflowId);
      if (!candidate) continue;
      const receipt = await port.readMerged(candidate);
      if (!receipt) continue;
      const result = await port.settle(candidate, receipt);
      // accepted acknowledges the CAS request, not completion of finish/cleanup.
      // The original task mirror and alert reconciliation remain authoritative.
      if (result === 'accepted')
        part.unchecked.push(`${workflowId} 已受理精确合并身份收尾，原任务完成回执待核实`);
    } catch (error) {
      part.unchecked.push(`${workflowId} 已合任务收尾未核实：${errMessage(error)}`);
    }
  }
  return part;
}
