import { describe, expect, it } from 'vitest';
import { isMainChat, splitConversation, summarizeDiff, toolPhrase } from './chat-view';
import type { TimelineItem } from './transcript';
import type { FeedEvent } from './types';

const ev = (type: string, payload: Record<string, unknown>): TimelineItem => ({
  kind: 'event',
  ev: { id: 1, type, createdAt: '2026-11-12T00:00:00Z', payload } as FeedEvent,
});

describe('对话主视图', () => {
  it('人的话和工具进主视图，会话建立和轮次开始进调试', () => {
    const items: TimelineItem[] = [
      ev('session.created', { agent: 'claude' }),
      ev('session.turn.started', {}),
      ev('session.message', { text: '修一下' }),
    ];
    const { main, debug } = splitConversation(items);
    expect(main).toHaveLength(1);
    expect(isMainChat(main[0] as TimelineItem)).toBe(true);
    expect(debug.map((i) => (i.kind === 'event' ? i.ev.type : i.kind))).toEqual([
      'session.created',
      'session.turn.started',
    ]);
  });

  it('diff 摘要和工具行的说法', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '+one', '+two', '-old'].join('\n');
    expect(summarizeDiff(diff)).toMatchObject({ files: 1, add: 2, del: 1 });
    expect(toolPhrase([{ name: 'Read' }, { name: 'Read' }])).toBe('读了 2 个文件');
    expect(toolPhrase([{ name: 'Edit' }])).toBe('改了 1 个文件');
    expect(toolPhrase([{ name: 'read_file' }])).toBe('读了 1 个文件');
    expect(toolPhrase([{ name: 'search_replace' }])).toBe('改了 1 个文件');
  });
});
