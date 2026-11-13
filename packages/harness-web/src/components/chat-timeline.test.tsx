// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem, ToolStep } from '../lib/transcript';
import { ApprovalRow, ApprovalsNote, ChatTimeline } from './chat-timeline';

afterEach(() => cleanup());

const SAMPLE = [
  '# 标题',
  '',
  '这是 **粗体** 和 *斜体*。',
  '',
  '- 一项',
  '',
  '行内 `code`。',
  '',
  '```ts',
  'const n = 1;',
  '```',
  '',
  '| 列a | 列b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '[文档](https://example.com/docs)',
  '',
  '<script>alert(1)</script>',
  '<img src="x" onerror="alert(1)">',
].join('\n');

function sayItem(text: string): TimelineItem {
  return {
    kind: 'say',
    step: { kind: 'say', id: 8, at: '2026-11-13T00:00:00.000Z', text, chars: text.length, truncated: false },
  };
}

function userItem(text: string): TimelineItem {
  return {
    kind: 'event',
    ev: {
      id: 9,
      seq: 9,
      type: 'session.message',
      createdAt: '2026-11-13T00:00:00.000Z',
      payload: { text },
    },
  };
}

function toolItem(name: string, status: ToolStep['status'], id: number): TimelineItem {
  return {
    kind: 'tool',
    step: {
      kind: 'tool',
      id,
      at: '2026-11-13T00:00:00.000Z',
      toolUseId: `t${id}`,
      name,
      summary: name,
      input: '{}',
      inputTruncated: false,
      status,
    },
  };
}

const pending: TimelineItem = {
  kind: 'approval',
  card: {
    id: 1,
    at: '2026-11-13T00:00:00.000Z',
    approvalId: 'ap1',
    tool: 'Bash',
    category: 'command',
    input: '{"command":"git init","description":"建仓库"}',
    status: 'pending',
  },
};

describe('审批卡', () => {
  it('待审批能点允许和拒绝', () => {
    const allow = vi.fn(async () => undefined);
    render(<ChatTimeline items={[pending]} onDecide={allow} />);
    const card = screen.getByTestId('approval-card');
    expect(card.textContent).toContain('跑命令');
    expect(card.textContent).toContain('Bash');
    expect(card.textContent).toContain('git init');
    expect(card.textContent).toContain('建仓库');
    expect(card.textContent).not.toContain('{"command"');
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(allow).toHaveBeenCalledWith('ap1', 'allow');
    cleanup();
    const deny = vi.fn(async () => undefined);
    render(<ChatTimeline items={[pending]} onDecide={deny} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(deny).toHaveBeenCalledWith('ap1', 'deny');
  });

  it('已经拒绝的不再给按钮，留下谁和结果', () => {
    render(
      <ApprovalRow
        card={{
          id: 2,
          at: '2026-11-13T00:00:00.000Z',
          approvalId: 'ap2',
          tool: 'WebFetch',
          category: 'network',
          input: '{"url":"https://example.com","prompt":"看一眼"}',
          status: 'denied',
          by: '本机',
          decidedAt: '2026-11-13T00:00:02.000Z',
          result: 'denied',
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
    const card = screen.getByTestId('approval-card');
    expect(card.textContent).toContain('本机');
    expect(card.textContent).toContain('已拒绝');
    expect(card.textContent).toContain('联网');
    expect(card.textContent).toContain('https://example.com');
    expect(card.textContent).not.toContain('prompt');
  });

  it('还在跑或等审批时不说已经调了、跑了', () => {
    render(<ChatTimeline items={[toolItem('Skill', 'running', 1), toolItem('Bash', 'running', 2)]} />);
    expect(screen.getByText('要调 1 个工具')).toBeTruthy();
    expect(screen.getByText('要跑 1 条命令')).toBeTruthy();
    expect(screen.queryByText('调了 1 个工具')).toBeNull();
    expect(screen.queryByText('跑了 1 条命令')).toBeNull();
    cleanup();
    render(<ChatTimeline items={[toolItem('Skill', 'ok', 3), toolItem('PowerShell', 'ok', 4)]} />);
    expect(screen.getByText('调了 1 个工具')).toBeTruthy();
    expect(screen.getByText('跑了 1 条命令')).toBeTruthy();
  });

  it('交不出逐条审批的就写明，不留按钮', () => {
    render(<ApprovalsNote mode="none" />);
    expect(screen.getByText('这家不支持逐条审批')).toBeTruthy();
    cleanup();
    render(<ApprovalsNote mode="per-call" />);
    expect(screen.queryByText('这家不支持逐条审批')).toBeNull();
  });
});

describe('助手消息 markdown', () => {
  it('渲染 GFM，不渲染原始 HTML，链接新窗口，表格自己横滚', async () => {
    const { container } = render(<ChatTimeline items={[sayItem(SAMPLE)]} />);
    expect((await screen.findByRole('heading', { name: '标题' })).tagName).toBe('H1');
    expect(container.querySelector('strong')?.textContent).toBe('粗体');
    expect(container.querySelector('em')?.textContent).toBe('斜体');
    expect(container.querySelector('[data-testid="assistant-markdown"] li')?.textContent).toContain('一项');
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelector('table')?.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
    const codes = [...container.querySelectorAll('code')].map((el) => el.textContent);
    expect(codes).toContain('code');
    expect(container.querySelector('pre')?.textContent).toContain('const n = 1;');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('用户消息保持纯文本', () => {
    const { container } = render(<ChatTimeline items={[userItem(SAMPLE)]} />);
    expect(container.querySelector('[data-testid="assistant-markdown"]')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    const bubble = container.querySelector('li div');
    expect(bubble?.textContent).toContain('**粗体**');
    expect(bubble?.textContent).toContain('| --- | --- |');
    expect(bubble?.textContent).toContain('`code`');
  });
});
