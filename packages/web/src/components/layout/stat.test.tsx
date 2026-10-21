// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Stat, StatGrid } from './stat';
import { LAYOUT_TONES } from './tone';

afterEach(cleanup);

describe('Stat', () => {
  test('标签、数字、单位；数字用无衬线等宽数字（num），不用等宽字体', () => {
    render(<Stat label="在跑" value="3" unit="个" />);
    expect(screen.getByText('在跑').className).toContain('text-meta');
    expect(screen.getByText('个')).toBeTruthy();
    const value = screen.getByText('3').parentElement as HTMLElement;
    expect(value.className).toContain('num');
    expect(value.className).toContain('text-display');
    expect(value.className).not.toContain('font-mono');
  });

  test('不画图标、不是链接、自己不画卡片（#3509 减法）', () => {
    const { container } = render(<Stat label="完成" value="40" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain('bg-card');
    expect(root.className).not.toContain('shadow');
  });

  test.each(LAYOUT_TONES)('tone=%s 渲染 data-tone', (tone) => {
    render(<Stat label="x" value="1" tone={tone} />);
    expect(document.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe(tone);
    cleanup();
  });

  test('颜色只给异常：失败红、停滞橙，完成、在跑不上色', () => {
    const cases = { fail: 'text-fail-ink', stall: 'text-warn-ink', doubt: 'text-warn-ink' } as const;
    for (const tone of LAYOUT_TONES) {
      render(<Stat label="x" value="7" tone={tone} />);
      const cls = (screen.getByText('7').parentElement as HTMLElement).className;
      const want = cases[tone as keyof typeof cases];
      if (want) expect(cls).toContain(want);
      else {
        expect(cls).not.toContain('text-fail-ink');
        expect(cls).not.toContain('text-warn-ink');
        expect(cls).not.toContain('text-success-ink');
        expect(cls).not.toContain('text-brand-ink');
      }
      cleanup();
    }
  });
});

describe('StatGrid', () => {
  test('一排指标：md 起一行不折，手机折成两行', () => {
    const { container } = render(
      <StatGrid cols={4}>
        <div />
      </StatGrid>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('flex-wrap');
    expect(el.className).toContain('md:flex-nowrap');
    expect(el.dataset.cols).toBe('4');
  });
});
