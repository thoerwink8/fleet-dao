// 等合并时怎么读必过检查（#1983）：红了带检查名和原因；还在跑、闸还没出现不当红；主线没有必过检查也不挡。
// 请求在本文件里垫，不引用别的包的测试夹具（引擎的 tsc 工程收不进那些文件）。
import { COLD_VERIFY_CONTEXT, GATE_CONTEXT } from '@fleet-dao/conventions';
import type { GhRequest, GhResponse, GitHub } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { readMergeWaitChecks } from '../../src/real/merge-wait-checks.ts';

const repo = { owner: 'acme', name: 'widgets' };
const A = 'a'.repeat(40);
/** fleet-dao 回填的那两样。别的仓的档案里没有就不传。 */
const fleetSignals = [GATE_CONTEXT, COLD_VERIFY_CONTEXT];

interface Run {
  name: string;
  conclusion: string | null;
  title?: string;
  /** 不给：没结论是 in_progress，有结论是 completed。 */
  status?: string;
}

interface Status {
  context: string;
  state: string;
  description?: string;
}

function gh(required: string[], runs: Run[], statuses: Status[]): Pick<GitHub, 'deps'> {
  const checkRuns = runs.map((run, i) => ({
    id: i + 1,
    name: run.name,
    head_sha: A,
    status: run.status ?? (run.conclusion === null ? 'in_progress' : 'completed'),
    conclusion: run.conclusion,
    started_at: '2026-09-25T12:00:00Z',
    completed_at: run.conclusion === null ? null : '2026-09-25T12:00:00Z',
    output: { title: run.title ?? null, summary: null },
  }));
  const commitStatuses = statuses.map((status) => ({
    context: status.context,
    state: status.state,
    updated_at: '2026-09-25T12:00:00Z',
    ...(status.description !== undefined ? { description: status.description } : {}),
  }));
  const deps = {
    facts: {
      async get() {
        return { defaultBranch: 'main', fullName: 'acme/widgets', private: false };
      },
      async branchRules() {
        return { requiredChecks: required, mergeMethods: [] };
      },
    },
    client: {
      async all(_req: GhRequest, itemsOf: (data: unknown) => unknown) {
        const items = itemsOf({ check_runs: checkRuns });
        if (!Array.isArray(items)) throw new Error('检查列表不是数组');
        return items;
      },
      async request(req: GhRequest): Promise<GhResponse> {
        if (req.path.endsWith('/status')) {
          return { status: 200, data: { statuses: commitStatuses }, headers: new Headers() };
        }
        if (req.path.endsWith('/actions/runs')) {
          return { status: 200, data: { total_count: 0 }, headers: new Headers() };
        }
        throw new Error(`没准备 ${req.method} ${req.path}`);
      },
    },
  };
  return { deps: deps as unknown as GitHub['deps'] };
}

describe('等合并时读必过检查', () => {
  it('必过检查红了：overall 是 red，带检查名和原因', async () => {
    const got = await readMergeWaitChecks(
      gh(['check'], [{ name: 'check', conclusion: 'failure', title: '2 个测试没过' }], []),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({ overall: 'red', failed: [{ name: 'check', detail: '2 个测试没过' }] });
  });

  it('主线没有必过检查、合并闸红：不抛 NO_REQUIRED_CHECKS，判红并带上原因', async () => {
    const got = await readMergeWaitChecks(
      gh([], [], [{ context: GATE_CONTEXT, state: 'failure', description: 'cold-verify 没过' }]),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({ overall: 'red', failed: [{ name: GATE_CONTEXT, detail: 'cold-verify 没过' }] });
  });

  const signalsGreen: Status[] = [
    { context: GATE_CONTEXT, state: 'success' },
    { context: COLD_VERIFY_CONTEXT, state: 'success' },
  ];

  it('检查还在跑：pending，不是红', async () => {
    const got = await readMergeWaitChecks(
      gh(['check'], [{ name: 'check', conclusion: null }], signalsGreen),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({ overall: 'pending', failed: [], pending: [{ name: 'check' }] });
  });

  it('检查在排队（queued）：pending，名字算在跑', async () => {
    const got = await readMergeWaitChecks(
      gh(['check'], [{ name: 'check', conclusion: null, status: 'queued' }], signalsGreen),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({ overall: 'pending', failed: [], pending: [{ name: 'check' }] });
  });

  it('【故意造出的失败】检查跑完了结论却是 stale：不算在跑，交 unsettled 带原词，不带 pending', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'stale' }],
        [
          { context: GATE_CONTEXT, state: 'pending', description: '排队' },
          { context: COLD_VERIFY_CONTEXT, state: 'success' },
        ],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got.overall).toBe('pending');
    expect(got.pending).toBeUndefined();
    expect(got.missing).toBeUndefined();
    expect(got.unsettled).toEqual([{ name: 'check', conclusion: 'stale' }]);
  });

  it('【故意造出的失败】检查跑完了结论认不出：交 unsettled，不当成在跑', async () => {
    const got = await readMergeWaitChecks(
      gh(['check'], [{ name: 'check', conclusion: 'weird_new_value' }], []),
      repo,
      A,
      [],
    );
    expect(got).toEqual({
      overall: 'pending',
      failed: [],
      unsettled: [{ name: 'check', conclusion: 'weird_new_value' }],
    });
  });

  it('【故意造出的失败】检查在等部署审批（waiting）：不是 queued / in_progress，交 unsettled', async () => {
    const got = await readMergeWaitChecks(
      gh(['check'], [{ name: 'check', conclusion: null, status: 'waiting' }], []),
      repo,
      A,
      [],
    );
    expect(got.pending).toBeUndefined();
    expect(got.unsettled).toEqual([{ name: 'check', conclusion: 'waiting' }]);
  });

  it('档案没列 cold-verify、闸却写着等验收：pending，不当成红', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [
          {
            context: GATE_CONTEXT,
            state: 'failure',
            description: '等验收：当前头 7790b55 上的 cold-verify 还在跑',
          },
        ],
      ),
      repo,
      A,
      [GATE_CONTEXT],
    );
    expect(got).toEqual({ overall: 'pending', failed: [], pending: [{ name: GATE_CONTEXT }] });
  });

  it('cold-verify 列了但这次没读到、闸写着等验收：不当成红，点名没出现的', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [{ context: GATE_CONTEXT, state: 'failure', description: '等验收：cold-verify 还在跑' }],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({
      overall: 'pending',
      failed: [],
      missing: [{ name: COLD_VERIFY_CONTEXT }],
    });
    expect(got.pending).toBeUndefined();
  });

  it('等验收的同时别的必过检查红了：只把别的交回返工', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'failure', title: '测试没过' }],
        [{ context: GATE_CONTEXT, state: 'failure', description: '等验收：cold-verify 还在跑' }],
      ),
      repo,
      A,
      [GATE_CONTEXT],
    );
    expect(got).toEqual({ overall: 'red', failed: [{ name: 'check', detail: '测试没过' }] });
  });

  it('cold-verify 还在跑时，merge-gate 的「等验收」也算 pending，不当成红', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [
          { context: GATE_CONTEXT, state: 'failure', description: '等验收：cold-verify 还在跑' },
          { context: COLD_VERIFY_CONTEXT, state: 'pending', description: '第 1 轮冷调用跑着' },
        ],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({
      overall: 'pending',
      failed: [],
      pending: [{ name: GATE_CONTEXT }, { name: COLD_VERIFY_CONTEXT }],
    });
  });

  it('冷验收已经通过、闸还写着等验收：接着等闸重算，不当成红（#3316）', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [
          {
            context: GATE_CONTEXT,
            state: 'failure',
            description:
              '等验收：当前头 10eb6fb 上的 cold-verify 还在跑（pending：第 1 轮冷调用跑着），这是引擎任务工作流开的 PR',
          },
          { context: COLD_VERIFY_CONTEXT, state: 'success', description: '过了' },
        ],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({ overall: 'pending', failed: [], pending: [{ name: GATE_CONTEXT }] });
  });

  it('等验收里还写着另有别的理由：仍是红，不装成在等', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [
          {
            context: GATE_CONTEXT,
            state: 'failure',
            description: '等验收：cold-verify 还在跑（另有 1 条，点详情看）',
          },
          { context: COLD_VERIFY_CONTEXT, state: 'pending', description: '跑着' },
        ],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got.overall).toBe('red');
    expect(got.failed.map((item) => item.name)).toEqual([GATE_CONTEXT]);
  });

  it('等验收的同时 cold-verify 自己已经失败：只把验收交回返工', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [
          { context: GATE_CONTEXT, state: 'failure', description: '等验收：cold-verify 还在跑' },
          { context: COLD_VERIFY_CONTEXT, state: 'failure', description: '验收没过' },
        ],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({
      overall: 'red',
      failed: [{ name: COLD_VERIFY_CONTEXT, detail: '验收没过' }],
    });
  });

  it('必过绿、合并闸和 cold-verify 还没出现：pending，不当红', async () => {
    const got = await readMergeWaitChecks(
      gh(['check'], [{ name: 'check', conclusion: 'success' }], []),
      repo,
      A,
      fleetSignals,
    );
    expect(got.overall).toBe('pending');
    expect(got.failed).toEqual([]);
    // 还没出现不是还在跑：没有 pending 名字，挂合并不能据此有界等待，并点名没出现的。
    expect(got.pending).toBeUndefined();
    expect(got.missing).toEqual([{ name: GATE_CONTEXT }, { name: COLD_VERIFY_CONTEXT }]);
  });

  it('必过已绿、merge-gate 还在队列、cold-verify 也已绿：pending，名字只有 merge-gate', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [
          { context: GATE_CONTEXT, state: 'pending', description: '排队' },
          { context: COLD_VERIFY_CONTEXT, state: 'success' },
        ],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({ overall: 'pending', failed: [], pending: [{ name: GATE_CONTEXT }] });
    expect(got.missing).toBeUndefined();
  });

  it('【故意造出的失败】一个检查 in_progress、另一个必过检查没出现：不交可等的 pending，点名没出现的', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check', 'lint'],
        [{ name: 'check', conclusion: null, status: 'in_progress' }],
        [
          { context: GATE_CONTEXT, state: 'success' },
          { context: COLD_VERIFY_CONTEXT, state: 'success' },
        ],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got.overall).toBe('pending');
    expect(got.pending).toBeUndefined();
    expect(got.unsettled).toBeUndefined();
    expect(got.missing).toEqual([{ name: 'lint' }]);
    expect(got.failed).toEqual([]);
  });

  it('【故意造出的失败】merge-gate 在队列里、cold-verify 没出现：不把没出现当成可等', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [{ context: GATE_CONTEXT, state: 'pending', description: '排队' }],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got.pending).toBeUndefined();
    expect(got.missing).toEqual([{ name: COLD_VERIFY_CONTEXT }]);
    expect(got.overall).toBe('pending');
  });

  it('必过检查一个都没出现：none，并点名没出现的，不带 pending', async () => {
    const got = await readMergeWaitChecks(gh(['check', 'lint'], [], []), repo, A, []);
    expect(got.overall).toBe('none');
    expect(got.pending).toBeUndefined();
    expect(got.missing).toEqual([{ name: 'check' }, { name: 'lint' }]);
  });

  it('必过、合并闸、cold-verify 都绿：green', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [
          { context: GATE_CONTEXT, state: 'success' },
          { context: COLD_VERIFY_CONTEXT, state: 'success' },
        ],
      ),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({ overall: 'green', failed: [] });
  });

  it('档案的 mergeSignals 没有 merge-gate：不等它，闸红也不挡', async () => {
    const got = await readMergeWaitChecks(
      gh(
        ['check'],
        [{ name: 'check', conclusion: 'success' }],
        [{ context: GATE_CONTEXT, state: 'failure', description: 'cold-verify 没过' }],
      ),
      repo,
      A,
      [],
    );
    expect(got).toEqual({ overall: 'green', failed: [] });
  });
});
