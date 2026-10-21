// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { InfoTip } from './info-tip';

afterEach(cleanup);

describe('InfoTip', () => {
  test('一个有名字的按钮；聚焦它显示说明', async () => {
    render(<InfoTip content="每 15 分钟扫一次" />);
    const btn = screen.getByRole('button', { name: '说明' });
    expect(screen.queryByText('每 15 分钟扫一次')).toBeNull();
    fireEvent.focus(btn);
    expect((await screen.findAllByText('每 15 分钟扫一次')).length).toBeGreaterThan(0);
  });

  test('label 换读屏名', () => {
    render(<InfoTip content="x" label="为什么" />);
    expect(screen.getByRole('button', { name: '为什么' })).toBeTruthy();
  });
});
