import type { Model } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { describeTimeline, findBan, jobView, routeLookup, routeProblem } from '../src/views.ts';

const gpt: Model = { id: 'gpt-5.6', family: 'GPT', displayName: 'GPT 5.6' };
const opus: Model = { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' };
const bans = [
  { family: 'gpt', stage: 'ui' as const, reason: 'GPT 不碰 UI' },
  { family: 'fable', reason: '不用 Fable' },
  { stage: 'review' as const, reason: '只写了阶段的禁令不算数' },
];

describe('禁令', () => {
  it('GPT × UI 犯禁（族名不分大小写）；GPT × 审查不犯；只写阶段的禁令不生效', () => {
    expect(findBan(gpt, 'ui', bans)?.reason).toBe('GPT 不碰 UI');
    expect(findBan(gpt, 'review', bans)).toBeUndefined();
    expect(findBan(opus, 'review', bans)).toBeUndefined();
  });

  it('Fable 在哪个阶段都犯禁；已下架的模型也不许挂', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const models: Model[] = [
      { id: 'fable-1', family: 'fable', displayName: 'Fable' },
      { id: 'old', family: 'claude', displayName: '老模型', retiredAt: '2026-09-01T00:00:00Z' },
    ];
    const routes = [
      {
        id: 'r-fable',
        channelId: 'c',
        poolId: 'p',
        modelId: 'fable-1',
        hostId: 'mirasim' as const,
        alive: true,
      },
      {
        id: 'r-old',
        channelId: 'c',
        poolId: 'p',
        modelId: 'old',
        hostId: 'claude-code' as const,
        alive: true,
      },
      {
        id: 'r-ghost',
        channelId: 'c',
        poolId: 'p',
        modelId: 'ghost',
        hostId: 'claude-code' as const,
        alive: true,
      },
    ];
    const ctx = { route: routeLookup(routes, models), bans, now };
    expect(routeProblem('r-fable', 'triage', ctx)).toContain('不用 Fable');
    expect(routeProblem('r-old', 'execute', ctx)).toContain('已下架');
    expect(routeProblem('r-ghost', 'execute', ctx)).toContain('不在模型目录里');
    expect(routeProblem('r-none', 'execute', ctx)).toContain('不存在');
  });
});

describe('时间线白话', () => {
  it('按种类拼一行；载荷认不出也不崩', () => {
    const rec = (kind: string, payload?: unknown) => ({
      id: 'x',
      at: '2026-09-25T08:00:00Z',
      source: 'session' as const,
      kind,
      payload,
    });
    expect(describeTimeline(rec('say', { text: '在写测试' }))).toBe('在写测试');
    expect(
      describeTimeline(
        rec('plan', {
          steps: [
            { title: 'a', state: 'done' },
            { title: '正在写实现', state: 'in_progress' },
            { title: 'c', state: 'pending' },
          ],
        }),
      ),
    ).toBe('步骤清单：完成 1/3，正在写实现');
    expect(describeTimeline(rec('test', { passed: false, command: 'pnpm check' }))).toBe(
      '跑测试（pnpm check）：没过',
    );
    expect(describeTimeline(rec('test', {}))).toBe('跑测试：结果没读到');
    expect(describeTimeline(rec('state', { from: 'running', to: 'merging' }))).toBe(
      '状态：running → merging',
    );
    expect(describeTimeline(rec('stop', { reason: '方向错了' }))).toBe('叫停：方向错了');
    expect(describeTimeline(rec('file', 'not-an-object'))).toBe('改文件：（没带路径）');
    expect(describeTimeline(rec('something-new'))).toBe('something-new');
  });
});

describe('定时任务新鲜度', () => {
  it('错过一次不算超期，超过两个周期才算', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const job = (minutesAgo: number) => ({
      id: 'j',
      name: 'j',
      schedule: '每小时',
      expectEveryMinutes: 60,
      lastSuccessAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    });
    expect(jobView(job(119), now).status).toBe('fresh');
    expect(jobView(job(121), now).status).toBe('overdue');
  });
});
