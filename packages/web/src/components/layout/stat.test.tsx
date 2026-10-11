// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { Stat, StatGrid } from './stat';
import { LAYOUT_TONES } from './tone';

afterEach(cleanup);

describe('Stat', () => {
  test('标签、数字、说明；数字用无衬线等宽数字（num），不用等宽字体', () => {
    render(<Stat label="在跑" value="3" hint="最近 1 小时" />);
    expect(screen.getByText('在跑')).toBeTruthy();
    expect(screen.getByText('最近 1 小时')).toBeTruthy();
    const value = screen.getByText('3');
    expect(value.className).toContain('num');
    expect(value.className).not.toContain('font-mono');
  });

  test.each(LAYOUT_TONES)('tone=%s 渲染 data-tone', (tone) => {
    render(<Stat label="x" value="1" tone={tone} />);
    expect(document.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe(tone);
    cleanup();
  });

  test('给了 to 就是链接', () => {
    render(
      <MemoryRouter>
        <Stat label="完成" value="40" to="/tasks" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('/tasks');
  });
});

describe('StatGrid', () => {
  test('手机两列，cols=4 在 lg 起四列', () => {
    const { container } = render(
      <StatGrid cols={4}>
        <div />
      </StatGrid>,
    );
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).toContain('grid-cols-2');
    expect(cls).toContain('lg:grid-cols-4');
  });
});
