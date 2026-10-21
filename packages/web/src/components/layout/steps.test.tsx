// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Steps } from './steps';

afterEach(cleanup);

const statuses = (c: HTMLElement) => Array.from(c.querySelectorAll('li')).map((li) => li.dataset.status);

describe('Steps', () => {
  test('按 current 推状态：之前 finish、当前 process、之后 wait', () => {
    const { container } = render(
      <Steps current={1} items={[{ title: '开单' }, { title: '验收' }, { title: '上线' }]} />,
    );
    expect(statuses(container)).toEqual(['finish', 'process', 'wait']);
    expect(container.querySelector('li[aria-current="step"]')?.textContent).toContain('验收');
  });

  test('item.status 优先：error 画叉', () => {
    const { container } = render(
      <Steps current={1} items={[{ title: 'a' }, { title: 'b', status: 'error', description: '没过' }]} />,
    );
    expect(statuses(container)).toEqual(['finish', 'error']);
    expect(screen.getByText('没过')).toBeTruthy();
    expect(container.querySelectorAll('svg')).toHaveLength(2); // 一个勾、一个叉
  });

  test('没走完的画序号；最后一步后面没有连线', () => {
    const { container } = render(<Steps current={0} items={[{ title: 'a' }, { title: 'b' }]} />);
    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('2');
    expect(container.querySelectorAll('li > [aria-hidden]')).toHaveLength(1);
  });
});
