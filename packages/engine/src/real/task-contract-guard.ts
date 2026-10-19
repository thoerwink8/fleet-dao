// 正式需求的读口与阻合只放在活动侧；工作流只消费留在历史中的结果。

import { COLD_VERIFY_CONTEXT } from '@fleet-dao/conventions';
import type { RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { type PortContext, PortError } from '../ports.ts';
import {
  type RequirementContract,
  readTaskBrief,
  sameRequirementContract,
  type TaskBriefResult,
  validRequirementContract,
} from '../runner/task-brief.ts';
import type { EngineGitHub } from './github-ports.ts';

type ContractGitHub = Pick<EngineGitHub, 'claims'> & Partial<Pick<EngineGitHub, 'readIssue' | 'readSpecDoc'>>;

/** 先撤自动合并，再写明确失败。任一步未证实都抛错，不能报告已经阻合。 */
export async function holdRequirementContract(
  gh: ContractGitHub,
  repo: RepoRef,
  prNumber: number,
): Promise<void> {
  const pull = await gh.claims.readPull(repo, prNumber);
  if (pull.merged || pull.state !== 'open') return;
  if (pull.autoMerge) await gh.claims.disableAutoMerge(repo, pull);
  await gh.claims.setStatus(repo, pull.headSha, {
    context: COLD_VERIFY_CONTEXT,
    state: 'failure',
    description: '正式需求合同已变更或未核实，旧验收不能放行',
  });
}

export async function readRequirementContract(
  gh: ContractGitHub,
  repo: RepoRef,
  issueNumber: number,
  moduleRoots?: readonly string[],
  signal?: AbortSignal,
): Promise<TaskBriefResult> {
  const readIssue = gh.readIssue;
  const readSpecDoc = gh.readSpecDoc;
  if (!readIssue || !readSpecDoc)
    throw new PortError('TASK_CONTRACT_UNREADABLE', '正式合同读口未装配', { retryable: false });
  return readTaskBrief(
    {
      readIssue: (input) => readIssue.call(gh, { ...input, ...(signal ? { signal } : {}) }),
      readSpecDoc: (input) => readSpecDoc.call(gh, { ...input, ...(signal ? { signal } : {}) }),
    },
    { repo, issueNumber, ...(moduleRoots ? { moduleRoots } : {}) },
  );
}

/** 每次实际发起合并写/发布终态前读取；读取时刻之外的 GitHub 编辑无法跨 API 原子化。 */
export async function guardRequirementContract(
  gh: ContractGitHub,
  repo: RepoRef,
  prNumber: number,
  issueNumber: number,
  expected: RequirementContract,
  ctx?: PortContext,
): Promise<boolean> {
  try {
    if (!validRequirementContract(expected)) throw new Error('正式合同规范版本或摘要无效');
    ctx?.signal.throwIfAborted();
    const got = await readRequirementContract(gh, repo, issueNumber, undefined, ctx?.signal);
    ctx?.signal.throwIfAborted();
    if (!got.ok) throw new Error(got.problems.map((p) => `${p.field}：${p.why}`).join('；'));
    if (sameRequirementContract(expected, got.brief.contract)) return true;
  } catch (error) {
    await holdRequirementContract(gh, repo, prNumber);
    throw new PortError('TASK_CONTRACT_UNREADABLE', `正式合同未核实：${errMessage(error)}`, {
      retryable: false,
    });
  }
  await holdRequirementContract(gh, repo, prNumber);
  return false;
}
