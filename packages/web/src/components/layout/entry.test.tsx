// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Clock } from 'lucide-react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Entry, EntryGrid } from './entry';

afterEach(cleanup);

describe('Entry', () => {
  test('给 href 是站内链接：标题、灰字、标签都在', () => {
    render(
      <MemoryRouter>
        <EntryGrid>
          <Entry
            icon={Clock}
            title="定时任务"
            meta="共 8 项"
            tag="失败 1"
            tagTone="error"
            href="/schedules"
          />
        </EntryGrid>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /定时任务/ });
    expect(link.getAttribute('href')).toBe('/schedules');
    expect(link.textContent).toContain('共 8 项');
    expect(link.textContent).toContain('失败 1');
    expect(link.querySelector('[data-look="error"]')).not.toBeNull();
  });

  test('给 onClick 是按钮：aria-expanded 跟着 expanded，点一下调 onClick', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Entry icon={Clock} title="命令行工具" onClick={onClick} expanded={false} />);
    const button = screen.getByRole('button', { name: /命令行工具/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Entry icon={Clock} title="命令行工具" onClick={onClick} expanded />);
    expect(screen.getByRole('button', { name: /命令行工具/ }).getAttribute('aria-expanded')).toBe('true');
  });
});
