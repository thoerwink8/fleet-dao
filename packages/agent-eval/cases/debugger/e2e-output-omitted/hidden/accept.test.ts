// 藏起来的验收（#1207 合进去的修法补的两条，加一条别放宽了的）：判分时拷到快照根上，用 node --test 跑。
// needs 照 ci.yml 里 toJSON(needs) 的样子造：GitHub 不把值为空串的 job 输出放进 needs.<job>.outputs。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciVerdict, planOutputs } from './packages/conventions/src/ci-plan.ts';

type Plan = Parameters<typeof planOutputs>[0];

const base = {
  full: false,
  biome: false,
  web: false,
  e2e: [] as string[],
  deploy: 'none',
  tests: [],
  tsc: [],
  testUnits: [],
  reasons: [],
};

/** GitHub 交给汇总 job 的 needs：changes 的输出去掉空串那几项，各 job 的结果照给的。 */
function needs(plan: Plan, e2eResult: string, drop: string[] = []): unknown {
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(planOutputs(plan))) if (v !== '' && !drop.includes(k)) outputs[k] = v;
  return {
    changes: { result: 'success', outputs },
    lint: { result: 'success' },
    test: { result: 'skipped' },
    web: { result: 'skipped' },
    e2e: { result: e2eResult },
    deploy: { result: 'skipped' },
  };
}

test('e2e 清单为空：GitHub 不给 outputs.e2e，按空串认，汇总不判红（#1204 那次真事）', () => {
  const v = ciVerdict(needs(base as unknown as Plan, 'skipped'));
  assert.equal(v.ok, true, v.lines.join('\n'));
  // ci.yml 的 e2e job 靠空串跳过（题面说了 ci.yml 不动）：空清单写进输出的只能还是空串
  assert.equal(planOutputs(base as unknown as Plan).e2e, '');
});

test('【故意造出的失败】plan 要跑 e2e，输出却缺了这一项：不能当成空清单放过', () => {
  const plan = { ...base, e2e: 'all' } as unknown as Plan;
  assert.equal(ciVerdict(needs(plan, 'success', ['e2e'])).ok, false);
  const listed = { ...base, e2e: ['packages/web/e2e/specs/01-login.e2e.ts'] } as unknown as Plan;
  assert.equal(ciVerdict(needs(listed, 'success', ['e2e'])).ok, false);
});

test('开关输出和 plan 里的清单不是同一份：照样判红', () => {
  const n = needs(base as unknown as Plan, 'skipped') as { changes: { outputs: Record<string, string> } };
  n.changes.outputs.e2e = 'all';
  const v = ciVerdict(n);
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /outputs\.e2e/);
});
