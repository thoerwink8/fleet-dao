// 需求开出的单子到哪一步（#2060）：在做 / 已合并 / 已上线 / 关掉，和对话里进度卡的正文。
import { describe, expect, it } from 'vitest';
import type { TaskState } from '../src/domain.ts';
import { deriveIssueProgress, isProgressCardOf, progressCardBody } from '../src/request-progress.ts';

const open = { state: 'open', stateReason: null } as const;
const closed = { state: 'closed', stateReason: 'completed' } as const;
const t = (
  state: TaskState,
  extra: { merged?: number; total?: number; updatedAt?: string; why?: string } = {},
) => ({
  state,
  subtasks: { total: extra.total ?? 0, merged: extra.merged ?? 0 },
  updatedAt: extra.updatedAt ?? '2026-10-14T01:00:00.000Z',
  ...(extra.why ? { why: extra.why } : {}),
});

describe('deriveIssueProgress', () => {
  it('引擎还没接：开着，写「引擎还没接」', () => {
    expect(deriveIssueProgress({ github: open, task: null })).toEqual({
      state: 'open',
      words: '已开单，引擎还没接',
    });
  });

  it('动手中：带已合并几个子任务', () => {
    expect(deriveIssueProgress({ github: open, task: t('running', { merged: 3, total: 6 }) })).toEqual({
      state: 'open',
      words: '动手中 · 已合并 3/6 个子任务',
    });
  });

  it('停下等人：把引擎写的原因带上', () => {
    const p = deriveIssueProgress({ github: open, task: t('stalled', { why: '检查红了：lint' }) });
    expect(p.words).toBe('停下等人：检查红了：lint');
  });

  it('任务做完、单子被引擎关了：是已合并，不是「关掉」', () => {
    expect(deriveIssueProgress({ github: closed, task: t('done') })).toEqual({
      state: 'merged',
      words: '已合并，等上线',
    });
  });

  it('任务做完且在用的那版是做完之后才切上去的：已上线；刚好同一刻也算', () => {
    const at = '2026-10-14T01:00:00.000Z';
    expect(
      deriveIssueProgress({ github: closed, task: t('done', { updatedAt: at }), deployedAt: at }).state,
    ).toBe('deployed');
    expect(
      deriveIssueProgress({
        github: closed,
        task: t('done', { updatedAt: at }),
        deployedAt: '2026-10-14T05:00:00.000Z',
      }).state,
    ).toBe('deployed');
  });

  it('【故意造出的失败】在用的那版比做完的早：还是已合并，不冒充上线', () => {
    const p = deriveIssueProgress({
      github: closed,
      task: t('done', { updatedAt: '2026-10-14T01:00:00.000Z' }),
      deployedAt: '2026-10-13T23:00:00.000Z',
    });
    expect(p.state).toBe('merged');
  });

  it('【故意造出的失败】读不到上线时刻（undefined / null / 认不出）：不猜，停在已合并', () => {
    for (const deployedAt of [undefined, null, 'not-a-date']) {
      expect(deriveIssueProgress({ github: closed, task: t('done'), deployedAt }).state).toBe('merged');
    }
  });

  it('单子被关成不做：一律是关掉，哪怕任务表说 done', () => {
    const notPlanned = { state: 'closed', stateReason: 'not_planned' } as const;
    expect(deriveIssueProgress({ github: notPlanned, task: t('done') }).state).toBe('closed');
  });

  it('单子关了、任务没做完（人手关的）：关掉', () => {
    expect(deriveIssueProgress({ github: closed, task: t('running') })).toEqual({
      state: 'closed',
      words: '单子关掉了',
    });
  });
});

describe('进度卡正文', () => {
  it('「#12 动手中 · …」，按单号认得出是哪张单的卡', () => {
    const body = progressCardBody(12, { state: 'open', words: '动手中' });
    expect(body).toBe('#12 动手中');
    expect(isProgressCardOf(12, body)).toBe(true);
    expect(isProgressCardOf(1, body)).toBe(false);
    expect(isProgressCardOf(12, '#123 动手中')).toBe(false);
  });
});
