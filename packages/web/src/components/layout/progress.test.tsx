// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Progress } from './progress';

afterEach(cleanup);

const fill = (c: HTMLElement) => c.querySelector('[data-progress-fill]') as HTMLElement;

describe('Progress', () => {
  test('蓝条：宽度＝百分比，读屏有 aria-valuenow，右边写百分比', () => {
    const { container } = render(<Progress percent={42} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(fill(container).style.width).toBe('42%');
    expect(fill(container).className).toContain('bg-brand');
    expect(screen.getByText('42%')).toBeTruthy();
  });

  test('默认 75 变橙、90 变红；没有绿色', () => {
    const { container, rerender } = render(<Progress percent={74} />);
    expect(fill(container).className).toContain('bg-brand');
    rerender(<Progress percent={75} />);
    expect(fill(container).className).toContain('bg-warn');
    rerender(<Progress percent={90} />);
    expect(fill(container).className).toContain('bg-fail');
    expect(fill(container).className).not.toContain('bg-success');
  });

  test('thresholds 可改；传 {} 不变色', () => {
    const { container, rerender } = render(<Progress percent={50} thresholds={{ warn: 40, fail: 60 }} />);
    expect(fill(container).className).toContain('bg-warn');
    rerender(<Progress percent={99} thresholds={{}} />);
    expect(fill(container).className).toContain('bg-brand');
  });

  test('超出范围夹到 0–100；宽度过渡 300', () => {
    const { container, rerender } = render(<Progress percent={140} />);
    expect(fill(container).style.width).toBe('100%');
    rerender(<Progress percent={-5} />);
    expect(fill(container).style.width).toBe('0%');
    expect(fill(container).className).toContain('duration-300');
  });

  test('mark 画竖线，label 换右边的字', () => {
    const { container } = render(<Progress percent={30} mark={60} label="3 / 10 次" />);
    const mark = container.querySelector('[data-progress-mark]') as HTMLElement;
    expect(mark.style.left).toBe('60%');
    expect(screen.getByText('3 / 10 次')).toBeTruthy();
    expect(screen.queryByText('30%')).toBeNull();
  });

  test('读失败：不画条、不画 0%，写「没读到」，悬停给原因', () => {
    const { container } = render(<Progress percent={{ ok: false, reason: '连不上额度接口' }} />);
    expect(screen.getByText('没读到').getAttribute('title')).toBe('连不上额度接口');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).not.toContain('0%');
  });

  test('Read 读成了照常画', () => {
    const { container } = render(<Progress percent={{ ok: true, value: 80 }} />);
    expect(fill(container).style.width).toBe('80%');
  });
});
