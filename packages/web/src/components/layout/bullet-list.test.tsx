// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { BulletList } from './bullet-list';

afterEach(cleanup);

describe('BulletList', () => {
  test('每条一个 li，前面的圆点读屏跳过', () => {
    const { container } = render(<BulletList items={['甲', '乙']} data-x="1" />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelectorAll('li > span[aria-hidden]')).toHaveLength(2);
    expect(container.querySelector('ul')?.getAttribute('data-x')).toBe('1');
  });
});
