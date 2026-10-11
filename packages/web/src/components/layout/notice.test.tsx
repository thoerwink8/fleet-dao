// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Notice, type NoticeTone } from './notice';

afterEach(cleanup);

describe('Notice', () => {
  test.each(['fail', 'stall', 'info', 'done'] as NoticeTone[])('tone=%s 渲染 data-tone', (tone) => {
    render(<Notice tone={tone}>说明</Notice>);
    const el = screen.getByText('说明').closest('[data-tone]') as HTMLElement;
    expect(el.dataset.tone).toBe(tone);
    cleanup();
  });

  test('fail、stall 是 alert，info、done 是 status', () => {
    const { rerender } = render(<Notice tone="fail">x</Notice>);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<Notice tone="stall">x</Notice>);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<Notice tone="info">x</Notice>);
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(<Notice tone="done">x</Notice>);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  test('标题、正文、右侧操作都渲染', () => {
    render(
      <Notice tone="fail" title="没读成" action={<button type="button">重试</button>}>
        连不上后端
      </Notice>,
    );
    expect(screen.getByText('没读成')).toBeTruthy();
    expect(screen.getByText('连不上后端')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
