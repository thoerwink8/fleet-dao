// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '../lib/transcript';
import { ApprovalRow, ApprovalsNote, ChatTimeline } from './chat-timeline';

afterEach(() => cleanup());

const pending: TimelineItem = {
  kind: 'approval',
  card: {
    id: 1,
    at: '2026-11-13T00:00:00.000Z',
    approvalId: 'ap1',
    tool: 'Bash',
    category: 'command',
    input: '{"command":"git init"}',
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
          input: 'https://example.com',
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
  });

  it('交不出逐条审批的就写明，不留按钮', () => {
    render(<ApprovalsNote mode="none" />);
    expect(screen.getByText('这家不支持逐条审批')).toBeTruthy();
    cleanup();
    render(<ApprovalsNote mode="per-call" />);
    expect(screen.queryByText('这家不支持逐条审批')).toBeNull();
  });
});
