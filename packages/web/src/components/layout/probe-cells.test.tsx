// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProbeCells } from './probe-cells';

afterEach(cleanup);

const items = [
  { result: 'ok', label: '10:00 通过' },
  { result: 'none', label: '10:15 没探' },
  { result: 'warn', label: '10:30 疑似换模型' },
  { result: 'fail', label: '10:45 不通' },
] as const;

describe('ProbeCells', () => {
  test('每格有 aria-label、悬停字和 data-result；颜色不是唯一的信息', () => {
    render(<ProbeCells items={items} />);
    for (const it of items) {
      const cell = screen.getByLabelText(it.label);
      expect(cell.dataset.result).toBe(it.result);
      expect(cell.getAttribute('title')).toBe(it.label);
    }
  });

  test('四种结果四种底：通＝灰、没探＝空心、警告＝橙、失败＝红', () => {
    render(<ProbeCells items={items} />);
    expect(screen.getByLabelText('10:00 通过').className).toContain('bg-line-2');
    expect(screen.getByLabelText('10:15 没探').className).toContain('ring-line-2');
    expect(screen.getByLabelText('10:30 疑似换模型').className).toContain('bg-warn');
    expect(screen.getByLabelText('10:45 不通').className).toContain('bg-fail');
  });

  test('没传 onSelect 不是按钮；传了就能点，selected 的那格有外框', () => {
    const { rerender } = render(<ProbeCells items={items} selected={2} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    const onSelect = vi.fn();
    rerender(<ProbeCells items={items} selected={2} onSelect={onSelect} />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
    fireEvent.click(screen.getByLabelText('10:45 不通'));
    expect(onSelect).toHaveBeenCalledWith(3);
    expect(screen.getByLabelText('10:30 疑似换模型').className).toContain('outline-ink');
    expect(screen.getByLabelText('10:30 疑似换模型').getAttribute('aria-pressed')).toBe('true');
  });
});
