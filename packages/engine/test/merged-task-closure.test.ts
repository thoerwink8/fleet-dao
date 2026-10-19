import { describe, expect, it, vi } from 'vitest';
import {
  type MergedTaskClosureDeps,
  mergedTaskCandidateOf,
  settleMergedTasks,
} from '../src/jobs/merged-task-closure.ts';

const workflowId = 'task:acme/repo#12';
const repo = { owner: 'acme', name: 'repo' };
const token = {
  version: 1 as const,
  runId: '12345678-1234-1234-1234-123456789abc',
  kind: 'parked' as const,
  generation: 2,
  continued: 1,
};
const head = 'a'.repeat(40);
const status = {
  phase: 'parked',
  prNumber: 100,
  mergedTaskClose: { version: 1, token, repo, prNumber: 100, head },
};
const candidate = { workflowId, repo, token, prNumber: 100, head };
const receipt = { repo, prNumber: 100, head, mergeCommit: 'b'.repeat(40) };
describe('每小时已合任务收尾不虚报完成（#3193）', () => {
  it('旧 worker 缺能力或停法身份残缺，明确失败；活活动不给凭据则不动', () => {
    expect(() => mergedTaskCandidateOf({ phase: 'parked', prNumber: 100 }, workflowId)).toThrow('旧 worker');
    expect(() =>
      mergedTaskCandidateOf(
        {
          ...status,
          mergedTaskClose: { ...status.mergedTaskClose, token: { ...token, runId: '-'.repeat(36) } },
        },
        workflowId,
      ),
    ).toThrow();
    expect(() =>
      mergedTaskCandidateOf(
        { ...status, mergedTaskClose: { ...status.mergedTaskClose, repo: { ...repo, name: 'other' } } },
        workflowId,
      ),
    ).toThrow();
    expect(
      mergedTaskCandidateOf(
        { ...status, mergedTaskClose: { ...status.mergedTaskClose, token: null } },
        workflowId,
      ),
    ).toBeNull();
    expect(mergedTaskCandidateOf(status, workflowId)).toEqual(candidate);
  });
  it('受理 Update 不冒充 finish 成功，保留待核实', async () => {
    const settle = vi.fn(async () => 'accepted' as const);
    const deps: MergedTaskClosureDeps = {
      mergedTasks: {
        workflows: async () => [workflowId],
        candidate: async () => candidate,
        readMerged: async () => receipt,
        settle,
      },
    };
    const result = await settleMergedTasks(deps);
    expect(result).toMatchObject({ scanned: 1, found: 0 });
    expect(result.unchecked[0]).toContain('完成回执待核实');
    expect(settle).toHaveBeenCalledWith(candidate, receipt);
  });
  it('普通未合 PR 不提交收尾；读失败保留未知', async () => {
    const settle = vi.fn(async () => 'accepted' as const);
    const port = {
      workflows: async () => [workflowId],
      candidate: async () => candidate,
      readMerged: async () => null,
      settle,
    };
    expect(await settleMergedTasks({ mergedTasks: port })).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(settle).not.toHaveBeenCalled();
    const result = await settleMergedTasks({
      mergedTasks: {
        ...port,
        readMerged: async () => {
          throw new Error('GitHub 502');
        },
      },
    });
    expect(result.unchecked[0]).toContain('GitHub 502');
    expect(settle).not.toHaveBeenCalled();
  });
});
