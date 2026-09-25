import { hardBanFor, type Model, type Route } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { describeTimeline, findBan, jobView, routeLookup, routeProblem } from '../src/views.ts';

const gpt: Model = { id: 'gpt-5.6', family: 'GPT', displayName: 'GPT 5.6' };
const opus: Model = { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' };
/** Fable 算在 claude 族里。 */
const fable: Model = { id: 'claude-fable-5-1', family: 'claude', displayName: 'Fable 5.1' };

const route = (id: string, modelId: string): Route => ({
  id,
  channelId: 'c',
  poolId: 'p',
  modelId,
  hostId: 'claude-code',
  alive: true,
});

describe('硬禁令（写死在 shared/bans.ts）', () => {
  it('GPT 按族认、不做 UI（族名不分大小写）', () => {
    expect(hardBanFor(gpt, 'ui')?.id).toBe('gpt-no-ui');
    expect(hardBanFor({ ...gpt, family: ' gpt ' }, 'ui')?.id).toBe('gpt-no-ui');
    expect(hardBanFor(opus, 'ui')).toBeUndefined();
  });

  it('Fable 按模型认（它属 claude 族），哪个阶段都不用', () => {
    for (const stage of ['triage', 'execute', 'ui', 'review', undefined] as const) {
      expect(hardBanFor(fable, stage)?.id).toBe('no-fable');
    }
    expect(hardBanFor({ ...opus, id: 'x-FABLE' }, 'execute')?.id).toBe('no-fable');
    expect(hardBanFor(opus, 'execute')).toBeUndefined();
  });

  it('库里的 bans 表是空的，路由检查照样被硬禁令拦下', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const ctx = {
      route: routeLookup([route('r-gpt', gpt.id), route('r-fable', fable.id)], [gpt, fable]),
      bans: [],
      now,
    };
    expect(routeProblem('r-gpt', 'ui', ctx)).toContain('GPT 不做 UI');
    expect(routeProblem('r-fable', 'execute', ctx)).toContain('不用 Fable');
  });
});

describe('库里配的禁令', () => {
  const bans = [
    { family: 'kimi', stage: 'ui' as const, reason: '库里配的：Kimi 不进 UI' },
    { stage: 'review' as const, reason: '只写了阶段的禁令不算数' },
  ];
  const kimi: Model = { id: 'kimi-k3', family: 'Kimi', displayName: 'Kimi k3' };

  it('和硬禁令一起生效；只写阶段、没写族或模型的不生效', () => {
    expect(findBan(kimi, 'ui', bans)?.reason).toBe('库里配的：Kimi 不进 UI');
    expect(findBan(opus, 'review', bans)).toBeUndefined();
    const now = new Date('2026-09-25T08:00:00Z');
    const ctx = { route: routeLookup([route('r-kimi', kimi.id)], [kimi]), bans, now };
    expect(routeProblem('r-kimi', 'ui', ctx)).toContain('Kimi 不进 UI');
  });

  it('已下架的模型、目录里没有的模型、不存在的路由都不许挂', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const old: Model = {
      id: 'old',
      family: 'claude',
      displayName: '老模型',
      retiredAt: '2026-09-01T00:00:00Z',
    };
    const ctx = {
      route: routeLookup([route('r-old', 'old'), route('r-ghost', 'ghost')], [old]),
      bans,
      now,
    };
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
    expect(describeTimeline(rec('state', { entity: 'task', from: 'running', to: 'merging' }))).toBe(
      '需求状态：running → merging',
    );
    expect(describeTimeline(rec('state', { entity: 'subtask', to: 'pending' }))).toBe('子任务建立：pending');
    expect(describeTimeline(rec('run_queued', { stage: 'execute', whyRoute: '排第一' }))).toBe(
      '写码排进队列（排第一）',
    );
    expect(describeTimeline(rec('run_started', { queueMs: 120_000 }))).toBe('开工（排队 2 分钟）');
    expect(describeTimeline(rec('run_ended', { outcome: 'stopped' }))).toBe('会话被叫停');
    expect(describeTimeline(rec('notification', { title: '卡住了' }))).toBe('通知：卡住了');
    expect(describeTimeline(rec('stop', { reason: '方向错了' }))).toBe('叫停：方向错了');
    expect(describeTimeline(rec('file', 'not-an-object'))).toBe('改文件：（没带路径）');
    expect(describeTimeline(rec('something-new'))).toBe('something-new');
    expect(describeTimeline(rec('pause', { ok: false, error: 'workflow_gone' }))).toBe(
      '暂停没做成：workflow_gone',
    );
    expect(describeTimeline(rec('done_rejected', { code: 'done_rejected', reasons: ['a', 'b'] }))).toBe(
      '交活被退回：a；b',
    );
    expect(describeTimeline(rec('done_rejected', { code: 'not_verifiable_yet', reasons: ['x'] }))).toBe(
      '交活暂时核实不了：x',
    );
  });
});

describe('定时任务新鲜度', () => {
  it('上次跑成超过 expectEveryMinutes 就算过期（这个数登记时已含余量，不再加倍）；从没跑成是 never', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const job = (minutesAgo: number) => ({
      id: 'j',
      name: 'j',
      schedule: '每小时',
      expectEveryMinutes: 75,
      lastSuccessAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    });
    expect(jobView(job(74), now).status).toBe('fresh');
    expect(jobView(job(76), now).status).toBe('overdue');
    expect(jobView({ id: 'j', name: 'j', schedule: '每小时', expectEveryMinutes: 75 }, now).status).toBe(
      'never',
    );
  });

  it('四种结局原样给前端（partial 也是跑成，算新鲜）', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const view = jobView(
      {
        id: 'j',
        name: 'j',
        schedule: '每小时',
        expectEveryMinutes: 75,
        lastRun: {
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          outcome: 'partial',
          scanned: 4,
          why: '一个仓没查成',
        },
        lastSuccessAt: now.toISOString(),
      },
      now,
    );
    expect(view).toMatchObject({ status: 'fresh', lastRun: { outcome: 'partial', scanned: 4 } });
  });
});
