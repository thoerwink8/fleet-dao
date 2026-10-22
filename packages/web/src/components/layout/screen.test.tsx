// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { BareFrame, Screen } from './screen';

afterEach(cleanup);

describe('Screen', () => {
  test('main 里有 h1 标题、说明和操作', () => {
    render(
      <Screen title="这一页没能显示" mark={<i data-mark />} actions={<a href="/">回去</a>}>
        <p>说明</p>
      </Screen>,
    );
    expect(document.querySelector('main')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: '这一页没能显示' })).toBeTruthy();
    expect(screen.getByText('说明')).toBeTruthy();
    expect(screen.getByRole('link', { name: '回去' })).toBeTruthy();
    expect(document.querySelector('[data-mark]')).toBeTruthy();
  });
});

describe('BareFrame', () => {
  test('整屏高的外框，包住子内容', () => {
    const { container } = render(<BareFrame>里面</BareFrame>);
    expect((container.firstElementChild as HTMLElement).className).toContain('h-dvh');
    expect(screen.getByText('里面')).toBeTruthy();
  });
});
