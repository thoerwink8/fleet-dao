import { describe, expect, it } from 'vitest';
import { approvalInputView, isMainChat, splitConversation, summarizeDiff, toolPhrase } from './chat-view';
import { categoryOf } from './describe';
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
    expect(toolPhrase([{ name: 'Bash', status: 'running' }])).toBe('要跑 1 条命令');
    expect(toolPhrase([{ name: 'Bash', status: 'ok' }])).toBe('跑了 1 条命令');
    expect(approvalInputView('command', '{"command":"git init","description":"建仓库"}')).toEqual({
      command: 'git init',
      description: '建仓库',
    });
    expect(approvalInputView('network', '{"url":"https://example.com"}')).toEqual({
      url: 'https://example.com',
    });
    expect(approvalInputView('other', '{"todos":[]}')).toEqual({ json: '{"todos":[]}' });
  });

  it('审批卡进主视图，类别算会话轮次', () => {
    const card: TimelineItem = {
      kind: 'approval',
      card: {
        id: 3,
        at: '2026-11-13T00:00:00.000Z',
        approvalId: 'ap1',
        tool: 'Bash',
        category: 'command',
        input: 'git init',
        status: 'pending',
      },
    };
    expect(isMainChat(card)).toBe(true);
    expect(splitConversation([card]).main).toHaveLength(1);
    expect(categoryOf('session.approval')).toBe('turn');
  });
});
