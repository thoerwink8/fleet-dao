import { describe, expect, it } from 'vitest';
import type { AdeSession } from './ade';
import { buildRows } from './session-rows';
import type { SessionSummary } from './types';

function ade(id: string, title: string): AdeSession {
  return {
    id,
    workspaceId: 'w1',
    title,
    status: 'idle',
    agent: 'claude',
    model: 'sonnet',
    pinned: false,
    turns: 1,
    updatedAt: '2026-11-13T00:00:00.000Z',
  };
}

function cockpit(id: string, text: string): SessionSummary {
  return {
    id,
    eventCount: 4,
    lastEventId: 1,
    lastAt: '2026-11-13T00:00:00.000Z',
    lastType: 'session.message',
    lastPayload: { text },
  };
}

describe('会话行和内核行', () => {
  it('有会话行的用标题和轮数；筛掉的不画成内核行；真没有会话行的才是内核行', () => {
    const rows = buildRows(
      [ade('keep', '改成这个')],
      [cockpit('keep', '好'), cockpit('gone', '收起来'), cockpit('kernel', '只有事件')],
      [],
      true,
      new Set(['keep', 'gone']),
    );
    expect(rows.map((r) => [r.id, r.title, r.turns])).toEqual([
      ['keep', '改成这个', 1],
      ['kernel', '新会话', null],
    ]);
  });

  it('搜索和已归档不混内核行', () => {
    const rows = buildRows([ade('keep', '改成这个')], [cockpit('kernel', '只有事件')], [], false, new Set());
    expect(rows.map((r) => r.id)).toEqual(['keep']);
  });
});
