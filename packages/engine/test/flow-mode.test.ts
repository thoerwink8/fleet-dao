// 全程模式第一期（#2826）：一张单走三段还是全程的分组边界，和定模式那个活动（读标签、开关、仓档案，写一次分组记录）。
import { FULL_FLOW_LABEL, THREE_FLOW_LABEL } from '@fleet-dao/conventions';
import { type FlowAssignment, FlowAssignmentExistsError, type NewFlowAssignment } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  chooseFlowMode,
  createDecideFlowMode,
  type FlowFacts,
  flowBucket,
  isClaude55,
} from '../src/flow-mode.ts';
import type { PortContext } from '../src/ports.ts';
import type { DecideFlowModeInput } from '../src/task-contract.ts';

const base: FlowFacts = {
  labels: [],
  setting: { kind: 'full' },
  repoEligible: true,
  modelId: 'claude-opus-5-5',
  touches: ['`packages/web/src/pages/`：驾驶舱页面'],
  stratum: 'standard',
  issueKey: 'acme/widgets#12',
};

describe('分组边界（chooseFlowMode）', () => {
  it('开关 full、仓开了、Claude 5.5、模块不敏感：走全程（按开关）', () => {
    expect(chooseFlowMode(base)).toEqual({ mode: 'full', source: 'hash', reason: null });
  });

  it('开关是 three、没贴标签：一律三段，原因写明是开关', () => {
    const got = chooseFlowMode({ ...base, setting: { kind: 'three' } });
    expect(got.mode).toBe('three');
    expect(got.source).toBe('ineligible');
    expect(got.reason).toContain('engine.flowMode');
  });

  it('仓档案没开 flowEligible：三段，原因写明', () => {
    const got = chooseFlowMode({ ...base, repoEligible: false });
    expect(got).toMatchObject({ mode: 'three', source: 'ineligible' });
    expect(got.reason).toContain('flowEligible');
  });

  it('只有 Claude 5.5（Sonnet、Opus）才进全程：别的模型三段并写明模型', () => {
    expect(isClaude55('claude-opus-5-5')).toBe(true);
    expect(isClaude55('claude-sonnet-5-5')).toBe(true);
    expect(isClaude55('claude-sonnet-5-5[1m]')).toBe(true);
    expect(isClaude55('claude-haiku-5-5')).toBe(false);
    expect(isClaude55('claude-opus-5-55')).toBe(false);
    expect(isClaude55('claude-opus-4-7')).toBe(false);
    expect(isClaude55('gpt-5.5')).toBe(false);
    const got = chooseFlowMode({ ...base, modelId: 'gpt-5.5' });
    expect(got).toMatchObject({ mode: 'three', source: 'ineligible' });
    expect(got.reason).toContain('gpt-5.5');
  });

  it.each([
    ['迁移', '`packages/db/migrations/0042_x.sql`'],
    ['合并闸', '`.github/workflows/merge-gate.yml`'],
    ['凭据', '`packages/api/src/credentials.ts`：凭据'],
    ['权限', '`deploy/sudoers.d/fleet`：权限'],
    ['任务工作流', '`packages/engine/src/workflows/task.ts`'],
    ['发布脚本', '`deploy/release.sh`'],
  ])('已知的模块碰到%s：一律三段，原因点名', (what, touch) => {
    const got = chooseFlowMode({ ...base, touches: ['`packages/web/src/a.ts`', touch] });
    expect(got).toMatchObject({ mode: 'three', source: 'ineligible' });
    expect(got.reason).toContain(what);
  });

  it('贴了「三段」：照标签三段，开关是 full 也一样', () => {
    expect(chooseFlowMode({ ...base, labels: [THREE_FLOW_LABEL] })).toEqual({
      mode: 'three',
      source: 'label',
      reason: null,
    });
  });

  it('贴了「全程」：开关是 three、仓没开也走全程；两个都贴按三段', () => {
    expect(
      chooseFlowMode({ ...base, labels: [FULL_FLOW_LABEL], setting: { kind: 'three' }, repoEligible: false }),
    ).toEqual({ mode: 'full', source: 'label', reason: null });
    const both = chooseFlowMode({ ...base, labels: [FULL_FLOW_LABEL, THREE_FLOW_LABEL] });
    expect(both).toMatchObject({ mode: 'three', source: 'label' });
    expect(both.reason).toContain('两个标签');
  });

  it('贴了「全程」也过模型和模块那两道：不是 Claude 5.5、碰到迁移都退回三段', () => {
    expect(chooseFlowMode({ ...base, labels: [FULL_FLOW_LABEL], modelId: 'grok-5' })).toMatchObject({
      mode: 'three',
      source: 'ineligible',
    });
    expect(
      chooseFlowMode({ ...base, labels: [FULL_FLOW_LABEL], touches: ['packages/db/migrations/'] }),
    ).toMatchObject({ mode: 'three', source: 'ineligible' });
  });

  it('split：同一档位里按单号哈希，桶号小于百分比走全程；0 全三段、100 全全程', () => {
    const key = 'acme/widgets#12';
    const bucket = flowBucket(`standard:${key}`);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    const at = (percent: number) =>
      chooseFlowMode({ ...base, setting: { kind: 'split', percent }, issueKey: key }).mode;
    expect(at(bucket)).toBe('three');
    expect(at(bucket + 1)).toBe('full');
    expect(at(0)).toBe('three');
    expect(at(100)).toBe('full');
  });

  it('split：同一张单哈希稳定；换档位分层后桶号跟着变（分层分组）', () => {
    expect(flowBucket('standard:acme/widgets#12')).toBe(flowBucket('standard:acme/widgets#12'));
    const buckets = new Set(
      Array.from({ length: 200 }, (_, i) => flowBucket(`standard:acme/widgets#${i}`) < 50),
    );
    expect(buckets).toEqual(new Set([true, false]));
    const half = Array.from({ length: 1000 }, (_, i) => flowBucket(`light:acme/w#${i}`) < 50).filter(
      Boolean,
    ).length;
    expect(half).toBeGreaterThan(400);
    expect(half).toBeLessThan(600);
  });
});

const ctx = { signal: new AbortController().signal } as unknown as PortContext;
const input: DecideFlowModeInput = {
  schemaVersion: 1,
  taskId: '00000000-0000-4000-8000-000000000012',
  repo: { id: 'r1', owner: 'acme', name: 'widgets', defaultBranch: 'main', testCommand: 'pnpm check' },
  issueNumber: 12,
  modelId: 'claude-sonnet-5-5',
  touches: ['`packages/web/src/pages/`'],
  stratum: 'standard',
};

function world(over: { labels?: string[]; setting?: unknown; profile?: unknown; prior?: FlowAssignment }) {
  const written: NewFlowAssignment[] = [];
  let prior = over.prior ?? null;
  const decide = createDecideFlowMode({
    readLabels: async () => over.labels ?? [],
    readSetting: async () => over.setting,
    readProfile: async () => over.profile ?? { flowEligible: true },
    record: async (a) => {
      if (prior) throw new FlowAssignmentExistsError(a.taskId);
      written.push(a);
      prior = { ...a, reason: a.reason ?? null, assignedAt: '2026-10-16T00:00:00.000Z' };
      return prior;
    },
    existing: async () => prior,
  });
  return { decide, written };
}

describe('定模式的活动（createDecideFlowMode）', () => {
  it('开关 full、仓开了：回全程，写一次分组记录（分层是档位）', async () => {
    const { decide, written } = world({ setting: 'full' });
    expect(await decide(input, ctx)).toEqual({ mode: 'full', source: 'hash', reason: null });
    expect(written).toEqual([
      { taskId: input.taskId, mode: 'full', source: 'hash', stratum: 'standard', reason: null },
    ]);
  });

  it('没设过开关：按 three，照样写一行（原因写明开关）', async () => {
    const { decide, written } = world({});
    const got = await decide(input, ctx);
    expect(got.mode).toBe('three');
    expect(written[0]?.reason).toContain('engine.flowMode');
  });

  it('开关的值认不出：按 three，原因带上认不出的原话', async () => {
    const { decide } = world({ setting: 'half' });
    const got = await decide(input, ctx);
    expect(got.mode).toBe('three');
    expect(got.reason).toContain('half');
  });

  it('仓档案没写 flowEligible：默认关，三段', async () => {
    const { decide } = world({ setting: 'full', profile: {} });
    expect((await decide(input, ctx)).mode).toBe('three');
  });

  it('这张单早分过组（重做的下一代）：照原来那一组，不再写', async () => {
    const prior: FlowAssignment = {
      taskId: input.taskId,
      mode: 'full',
      source: 'label',
      stratum: 'standard',
      reason: null,
      assignedAt: '2026-10-15T00:00:00.000Z',
    };
    const { decide, written } = world({ setting: 'three', prior });
    expect(await decide(input, ctx)).toEqual({ mode: 'full', source: 'label', reason: null });
    expect(written).toEqual([]);
  });

  it('标签读不到：抛错（不当成没贴）', async () => {
    const decide = createDecideFlowMode({
      readLabels: async () => {
        throw new Error('GitHub 504');
      },
      readSetting: async () => 'full',
      readProfile: async () => ({ flowEligible: true }),
      record: async () => {
        throw new Error('不该写');
      },
      existing: async () => null,
    });
    await expect(decide(input, ctx)).rejects.toThrow('504');
  });
});
