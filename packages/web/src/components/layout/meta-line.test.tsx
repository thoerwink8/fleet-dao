// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { MetaLine } from './meta-line';

afterEach(cleanup);

describe('MetaLine', () => {
  test('分隔点只画在项之间，空项跳过', () => {
    const { container } = render(
      <MetaLine items={['仓#12', null, '开单 1 小时前', false, '', 'PR #1833']} />,
    );
    expect(container.querySelectorAll('[data-meta-sep]')).toHaveLength(2);
    expect(container.textContent).toBe('仓#12·开单 1 小时前·PR #1833');
  });

  test('只有一项不画点；没有项也不报错', () => {
    const one = render(<MetaLine items={['只有我']} />);
    expect(one.container.querySelectorAll('[data-meta-sep]')).toHaveLength(0);
    one.unmount();
    const none = render(<MetaLine items={[]} />);
    expect(none.container.textContent).toBe('');
  });
});
