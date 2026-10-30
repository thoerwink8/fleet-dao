// 主线读不出必过检查（免费私有仓）时 waitCi / mergePr 的兜底：用仓档案的 mergeSignals；档案也没写就照旧交给下层（会抛）。
import type { GitHub } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { withNoRulesFallback } from '../../src/real/no-rules-fallback.ts';

const repo = { owner: 'acme', name: 'widgets' };
const HEAD = 'a'.repeat(40);

function fake(requiredChecks: string[]) {
  const calls: { fn: string; input: unknown }[] = [];
  const gh = {
    deps: {
      facts: {
        get: async () => ({ defaultBranch: 'main', fullName: 'acme/widgets', private: true }),
        branchRules: async () => ({ requiredChecks, mergeMethods: [] }),
      },
    },
    waitCi: async (input: unknown) => {
      calls.push({ fn: 'waitCi', input });
      return { state: 'green', head: HEAD, checks: [{ name: 'real', state: 'success' }] };
    },
    mergePr: async (input: unknown) => {
      calls.push({ fn: 'mergePr', input });
      return { merged: true };
    },
  } as unknown as GitHub;
  return { gh, calls };
}

const waitInput = { repo, prNumber: 1, head: HEAD, excludeChecks: ['merge-gate'] };
const mergeInput = { repo, prNumber: 1, expectedHead: HEAD };

describe('主线没有必过检查时的兜底', () => {
  it('mergePr：用档案的 mergeSignals 做合并前复核', async () => {
    const { gh, calls } = fake([]);
    await withNoRulesFallback(gh, async () => ['merge-gate', 'cold-verify']).mergePr(mergeInput);
    expect(calls[0]?.input).toMatchObject({ checks: ['merge-gate', 'cold-verify'] });
  });

  it('waitCi：没有东西可等，直接回绿，不调下层', async () => {
    const { gh, calls } = fake([]);
    const r = await withNoRulesFallback(gh, async () => ['merge-gate', 'cold-verify']).waitCi(waitInput);
    expect(r).toMatchObject({ state: 'green', head: HEAD });
    expect(calls).toEqual([]);
  });

  it('档案也没写 mergeSignals：原样交下层（下层零条检查不当绿，会抛）', async () => {
    const { gh, calls } = fake([]);
    const wrapped = withNoRulesFallback(gh, async () => []);
    await wrapped.waitCi(waitInput);
    await wrapped.mergePr(mergeInput);
    expect(calls.map((c) => c.fn)).toEqual(['waitCi', 'mergePr']);
    expect(calls[1]?.input).not.toHaveProperty('checks');
  });

  it('主线有必过检查：一律不走兜底', async () => {
    const { gh, calls } = fake(['check']);
    const wrapped = withNoRulesFallback(gh, async () => ['merge-gate', 'cold-verify']);
    const r = await wrapped.waitCi(waitInput);
    await wrapped.mergePr(mergeInput);
    expect(r).toMatchObject({ checks: [{ name: 'real' }] });
    expect(calls.map((c) => c.fn)).toEqual(['waitCi', 'mergePr']);
    expect(calls[1]?.input).not.toHaveProperty('checks');
  });
});
