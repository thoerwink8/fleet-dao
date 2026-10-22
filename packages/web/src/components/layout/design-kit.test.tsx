// @vitest-environment happy-dom
// 陈列页专用件：样本块、按钮样本、对比度表（读不出来写「算不出」，不拿空冒充通过）。
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ButtonSamples,
  ContrastTable,
  DesignPanel,
  Kbd,
  LoadingButtonSamples,
  Ruled,
  ShapeSample,
  TypeSample,
} from './design-kit';

afterEach(cleanup);

describe('design-kit', () => {
  test('DesignPanel 标出当前亮暗', () => {
    render(
      <DesignPanel mode="dark">
        <span>里面</span>
      </DesignPanel>,
    );
    expect(document.querySelector('[data-gallery="dark"]')?.textContent).toBe('里面');
  });

  test('字号、圆角阴影样本把字写出来', () => {
    render(
      <>
        <TypeSample level="display">display 28</TypeSample>
        <ShapeSample look="modal">modal</ShapeSample>
        <Ruled>
          <Kbd>⌘K</Kbd>
        </Ruled>
      </>,
    );
    expect(screen.getByText('display 28')).toBeTruthy();
    expect(screen.getByText('modal')).toBeTruthy();
    expect(screen.getByText('⌘K')).toBeTruthy();
  });

  test('按钮样本：五种样子都在，主按钮只有一个', () => {
    render(<ButtonSamples />);
    const variants = [...document.querySelectorAll('button')].map((b) => b.getAttribute('data-variant'));
    for (const v of ['primary', 'secondary', 'outline', 'text', 'danger']) expect(variants).toContain(v);
    expect(variants.filter((v) => v === 'primary')).toHaveLength(1);
  });

  test('忙态按钮样本：每个都在忙，loadingText 换字', () => {
    render(
      <MemoryRouter>
        <LoadingButtonSamples icon={null} />
      </MemoryRouter>,
    );
    const busy = document.querySelector('[data-design-loading]');
    expect(busy).not.toBeNull();
    expect(busy?.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText('正在提交…')).toBeTruthy();
  });

  test('对比度表：画出行，每格是数字或「算不出」，没有 NaN', () => {
    render(<ContrastTable />);
    const text = document.body.textContent ?? '';
    expect(screen.getAllByRole('table').length).toBe(2);
    expect(text).toContain('foreground');
    expect(text).not.toContain('NaN');
  });
});
