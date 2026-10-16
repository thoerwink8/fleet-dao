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
    status: run.conclusion === null ? 'in_progress' : 'completed',
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

  it('检查还在跑：pending，不是红', async () => {
    const got = await readMergeWaitChecks(
      gh(['check'], [{ name: 'check', conclusion: null }], []),
      repo,
      A,
      fleetSignals,
    );
    expect(got).toEqual({ overall: 'pending', failed: [] });
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
    expect(got).toEqual({ overall: 'pending', failed: [] });
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
