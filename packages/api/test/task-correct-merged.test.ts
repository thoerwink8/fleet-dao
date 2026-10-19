// fleet-api task correct-merged 回归：把误记 abandoned 的真实已合任务按真实 GitHub 事实改回 done。
// 覆盖：正常纠正、非已合、错仓/错 PR/错 head/错 merge/错 run、读取失败、未授权（非引擎）、活任务、
// 并发变化（CAS 失配）、幂等重复、以及合成的 #3114 反例（真实 squash 的 merge 与 head）。
import { describe, expect, it } from 'vitest';
import {
  type CorrectionRequest,
  type ExecutionFacts,
  type PullFacts,
  type TaskFacts,
  decideCorrection,
} from '../src/task-correct-merged.ts';
import { type CorrectMergedPorts, runCorrectMerged } from '../src/task-correct-merged-run.ts';

// 合成的 #3114 反例：PR 3137，旧头 5b52…，真实 squash bfe1…（均为虚构样例 sha）
const REPO = { owner: 'thoerwink8', name: 'fleet-dao' };
const HEAD = '5b52006a9cdcef60c030c5dbeec645f81a2ad86a';
const MERGE = 'bfe1b1ae69c7ae6404b068eb3ed7bde3082b3e40';
const WF = 'task:thoerwink8/fleet-dao#3114';
const RUN = '01a14fd8-fb57-741a-8c14-42e3fdba87d6';

const req: CorrectionRequest = {
  repo: REPO,
  issueNumber: 3114,
  prNumber: 3137,
  head: HEAD,
  mergeCommit: MERGE,
  workflowId: WF,
  runId: RUN,
};

const goodPr: PullFacts = { repo: REPO, number: 3137, merged: true, head: HEAD, mergeCommit: MERGE };
const goodTask: TaskFacts = {
  id: 'd629758a-570d-405d-be00-417b7ee6c0c7',
  repo: REPO,
  issueNumber: 3114,
  state: 'stopped',
  phase: 'abandoned',
  executor: 'engine',
  updatedAtMs: 1_781_833_926_446,
  openRunCount: 0,
};
const goodExec: ExecutionFacts = { workflowId: WF, runId: RUN, running: false };

function expectRefused(result: ReturnType<typeof decideCorrection>, fragment: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain(fragment);
}

describe('decideCorrection（纯判断）', () => {
  it('合成的 #3114 反例：真实已合、头与 merge 对得上，可纠正为 done/merged', () => {
    const d = decideCorrection(req, goodPr, goodTask, goodExec);
    expect(d).toEqual({
      ok: true,
      before: { state: 'stopped', phase: 'abandoned' },
      after: { state: 'done', phase: 'merged' },
    });
  });

  it('PR 还没合并：拒绝，不用 issue closed 当证明', () => {
    expectRefused(decideCorrection(req, { ...goodPr, merged: false }, goodTask, goodExec), '还没合并');
  });

  it('错仓：拒绝', () => {
    expectRefused(
      decideCorrection(req, { ...goodPr, repo: { owner: 'other', name: 'fleet-dao' } }, goodTask, goodExec),
      '错仓或错 PR',
    );
  });

  it('错 PR 编号：拒绝', () => {
    expectRefused(decideCorrection(req, { ...goodPr, number: 9999 }, goodTask, goodExec), '错仓或错 PR');
  });

  it('错 head（旧头不能冒充已合）：拒绝', () => {
    const oldHead = 'a'.repeat(40);
    expectRefused(decideCorrection(req, { ...goodPr, head: oldHead }, goodTask, goodExec), '错 head');
  });

  it('错 mergeCommit：拒绝', () => {
    expectRefused(
      decideCorrection(req, { ...goodPr, mergeCommit: 'c'.repeat(40) }, goodTask, goodExec),
      '错 merge',
    );
  });

  it('错 run（Temporal 身份不一致）：拒绝', () => {
    expectRefused(
      decideCorrection(req, goodPr, goodTask, { ...goodExec, runId: 'other-run' }),
      '错 run',
    );
  });

  it('读不到 PR：拒绝', () => {
    expectRefused(decideCorrection(req, null, goodTask, goodExec), '读不到 GitHub 上的 PR');
  });

  it('读不到已结束执行身份：拒绝', () => {
    expectRefused(decideCorrection(req, goodPr, goodTask, null), '查不到原任务工作流');
  });

  it('未授权（本机执行、非引擎账）：拒绝', () => {
    expectRefused(decideCorrection(req, goodPr, { ...goodTask, executor: 'local' }, goodExec), '本机执行');
  });

  it('活任务（工作流仍在运行或有开着的会话）：拒绝', () => {
    expectRefused(decideCorrection(req, goodPr, { ...goodTask, openRunCount: 1 }, goodExec), '活跃会话');
    expectRefused(decideCorrection(req, goodPr, goodTask, { ...goodExec, running: true }), '仍在运行');
  });

  it('任务不是误记的 stopped/abandoned：拒绝', () => {
    expectRefused(
      decideCorrection(req, goodPr, { ...goodTask, state: 'done', phase: 'merged' }, goodExec),
      '不是误记',
    );
  });

  it('请求里 head 或 mergeCommit 不是完整 sha：拒绝', () => {
    expectRefused(decideCorrection({ ...req, head: 'abc' }, goodPr, goodTask, goodExec), '完整 sha');
  });
});

function fakePorts(overrides: Partial<CorrectMergedPorts> = {}, log: unknown[] = []): CorrectMergedPorts {
  return {
    readPull: async () => goodPr,
    readTask: async () => goodTask,
    readExecution: async () => goodExec,
    casCorrect: async (input) => {
      log.push(input);
      return 'corrected';
    },
    ...overrides,
  };
}

describe('runCorrectMerged（执行段）', () => {
  it('正常纠正：CAS 写入一次，并带上操作者、原因和证据', async () => {
    const writes: unknown[] = [];
    const out = await runCorrectMerged(req, 'root', '#3114 误记 abandoned', fakePorts({}, writes));
    expect(out.status).toBe('corrected');
    expect(writes).toHaveLength(1);
    const w = writes[0] as { expectedUpdatedAtMs: number; audit: { operator: string; evidence: Record<string, unknown> } };
    expect(w.expectedUpdatedAtMs).toBe(goodTask.updatedAtMs);
    expect(w.audit.operator).toBe('ops:correct-merged:root');
    expect(w.audit.evidence.before).toEqual({ state: 'stopped', phase: 'abandoned' });
    expect(w.audit.evidence.after).toEqual({ state: 'done', phase: 'merged' });
  });

  it('幂等重复：已纠正且身份一致，回 already，不再写', async () => {
    const writes: unknown[] = [];
    const corrected: TaskFacts = { ...goodTask, state: 'done', phase: 'merged' };
    const out = await runCorrectMerged(
      req,
      'root',
      'x',
      fakePorts({ readTask: async () => corrected }, writes),
    );
    expect(out.status).toBe('already');
    expect(writes).toHaveLength(0);
  });

  it('证据变化不能冒充已纠正：已 done 但 PR 头换了，拒绝', async () => {
    const corrected: TaskFacts = { ...goodTask, state: 'done', phase: 'merged' };
    const out = await runCorrectMerged(
      req,
      'root',
      'x',
      fakePorts({ readTask: async () => corrected, readPull: async () => ({ ...goodPr, head: 'd'.repeat(40) }) }),
    );
    expect(out.status).toBe('refused');
  });

  it('读取失败：明确拒绝，不写', async () => {
    const writes: unknown[] = [];
    const out = await runCorrectMerged(
      req,
      'root',
      'x',
      fakePorts({
        readPull: async () => {
          throw new Error('GitHub 超时');
        },
      }, writes),
    );
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.reason).toContain('读取事实没成');
    expect(writes).toHaveLength(0);
  });

  it('并发变化：CAS 失配（任务行已换代），拒绝覆盖', async () => {
    const out = await runCorrectMerged(req, 'root', 'x', fakePorts({ casCorrect: async () => 'stale' }));
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.reason).toContain('变了');
  });

  it('新任务或换代出现：updated_at 变了即 CAS 失配', async () => {
    const out = await runCorrectMerged(
      req,
      'root',
      'x',
      fakePorts({ casCorrect: async (input) => (input.expectedUpdatedAtMs === goodTask.updatedAtMs ? 'stale' : 'corrected') }),
    );
    expect(out.status).toBe('refused');
  });

  it('操作记录写入失败回滚：casCorrect 抛错则整体失败，不假装做成', async () => {
    await expect(
      runCorrectMerged(
        req,
        'root',
        'x',
        fakePorts({
          casCorrect: async () => {
            throw new Error('审计写入失败');
          },
        }),
      ),
    ).rejects.toThrow('审计写入失败');
  });

  it('错 run 的执行段：不写库', async () => {
    const writes: unknown[] = [];
    const out = await runCorrectMerged(req, 'root', 'x', fakePorts({ readExecution: async () => ({ ...goodExec, runId: 'z' }) }, writes));
    expect(out.status).toBe('refused');
    expect(writes).toHaveLength(0);
  });
});
