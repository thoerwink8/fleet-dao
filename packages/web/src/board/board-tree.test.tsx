// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { Board, Me } from '../api/types';
import { renderApp } from '../test/harness';
import { BoardTree, type TreeFilter } from './board-tree';

afterEach(cleanup);

let board: Board;
let me: Me;

beforeAll(async () => {
  const api = createMockApi({ live: false });
  board = await api.board('r-orbit');
  me = await api.me();
});

function Harness() {
  const [filter, setFilter] = useState<TreeFilter>({ stuck: false, mine: false });
  return <BoardTree board={board} me={me} filter={filter} onFilter={setFilter} />;
}

const list = () => screen.getByRole('list', { name: 'orbit 的需求' });
const issueNumbers = () =>
  within(list())
    .getAllByText(/^#\d+$/)
    .map((el) => Number(el.textContent?.slice(1)));

describe('手机上的看板：可折叠的树形列表', () => {
  test('默认列出这个仓的全部需求：没做完的按优先级在前，做完的在后', () => {
    renderApp(<Harness />);
    expect(issueNumbers()).toEqual([12, 14, 15, 16, 17, 18, 19, 20, 21, 11]);
  });

  test('「只看卡住的」只留等人、停滞、失败的', () => {
    renderApp(<Harness />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '只看卡住的' }));
    });
    expect(issueNumbers()).toEqual([15, 17, 19]);
  });

  test('「只看我提的」按登录用户过滤', () => {
    renderApp(<Harness />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '只看我提的' }));
    });
    expect(issueNumbers()).toEqual([12, 15, 18, 19, 21]);
  });

  test('在跑的需求默认展开子任务，点一下收起', () => {
    renderApp(<Harness />);
    expect(screen.getByText('登录页输入框与倒计时')).toBeTruthy();
    const toggle = screen.getAllByRole('button', { name: '收起子任务' })[0];
    if (!toggle) throw new Error('找不到收起按钮');
    act(() => {
      fireEvent.click(toggle);
    });
    expect(screen.queryByText('登录页输入框与倒计时')).toBeNull();
  });

  test('每张卡一句白话：在写码的子任务写明谁在干哪一步', () => {
    renderApp(<Harness />);
    expect(screen.getByText(/Opus 5\.5 正在写验证码过期的测试，已 \d+ 分钟/)).toBeTruthy();
  });
});
