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

describe('ProbeCells 渠道状态页用的小变体（#3533）', () => {
  test('id、kind 写进 data-cell、data-kind；label 为空的是补位格，不报给读屏', () => {
    render(
      <ProbeCells
        items={[
          { result: 'none', label: '' },
          { result: 'warn', label: '10:30 额度耗尽', id: 7, kind: 'quota' },
        ]}
      />,
    );
    const real = screen.getByLabelText('10:30 额度耗尽');
    expect(real.getAttribute('data-cell')).toBe('7');
    expect(real.getAttribute('data-kind')).toBe('quota');
    const pad = document.querySelector('[data-result="none"]');
    expect(pad?.getAttribute('aria-hidden')).toBe('true');
    expect(pad?.hasAttribute('data-cell')).toBe(false);
  });

  test('summary：整条是一张图，一句话念完，格子不单独报也不是按钮', () => {
    render(<ProbeCells items={items} summary="近 4 次真探：通过 1" />);
    const strip = screen.getByRole('img', { name: '近 4 次真探：通过 1' });
    expect(strip.hasAttribute('data-strip-display')).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
    expect(strip.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });
});

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
