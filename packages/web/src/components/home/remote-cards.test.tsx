// @vitest-environment happy-dom
// 看别的环境的快照时（RemoteViewProvider）：「在跑的」卡片的链接改成指向 GitHub 上那张单（站内详情读的是本台的库、对不上），
// 「要你拍的」的「去答」置灰并说明要去那台上答；看本台时两样照旧。
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { RemoteViewProvider } from '../node-notice';
import { RunningCard } from './running-card';
import type { HomeRunning } from './types';

afterEach(cleanup);

const running: HomeRunning = {
  issueNumber: 77,
  title: '把看板切到本机',
  repo: 'acme/widgets',
  segment: 'doing',
  waitingReason: 'nothing',
  link: '/tasks/t-77',
};

function view(ui: React.ReactElement, remote: { name: string } | null) {
  return render(
    <MemoryRouter>
      <RemoteViewProvider value={remote}>{ui}</RemoteViewProvider>
    </MemoryRouter>,
  );
}

describe('看别的环境的快照', () => {
  test('在跑的卡片：链接指向 GitHub 上那张单（新窗口），不指向站内详情', () => {
    view(<RunningCard item={running} />, { name: '本机 WSL' });
    const a = document.querySelector('[data-running-card] a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://github.com/acme/widgets/issues/77');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noreferrer');
  });
});

describe('看本台：照旧', () => {
  test('在跑的卡片链接是站内单子详情', () => {
    view(<RunningCard item={running} />, null);
    expect(document.querySelector('[data-running-card] a')?.getAttribute('href')).toBe('/tasks/t-77');
  });
});
