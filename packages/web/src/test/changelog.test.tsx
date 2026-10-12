// @vitest-environment happy-dom
// /changelog 页的钉子（#227 切片、#1255）：
// - 页面顶上是只读的「已发布的提交」（读法国发布历史）：每条提交号、标题、发于何时；读不到整份写没查成和原因，
//   某一条标题读不到只那一条写原因，接口挂了写没读成；一条记录都没有写明「还没有发布记录」，不当成没查成；
// - 页面上没有「发布 v<N>」按钮和弹窗，没有「版本里程碑发版」的说法（发版单位是主线提交，决定 0032）；

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { ReleasedCommits } from '../api/types';
import ChangelogPage from '../routes/changelog';
import { renderApp } from './harness';

afterEach(cleanup);

const AS_OF = '2026-10-07T10:00:00.000Z';
const A = `6896b3cb${'a'.repeat(32)}`;
const B = `5f1e2d3c${'b'.repeat(32)}`;
const C = `4e0d1c2b${'c'.repeat(32)}`;

type Commit = Extract<ReleasedCommits, { state: 'ok' }>['commits'][number];
const commit = (sha: string, over: Partial<Commit> = {}): Commit => ({
  sha,
  short: sha.slice(0, 12),
  title: `标题 ${sha.slice(0, 4)}`,
  titleWhy: null,
  at: '2026-10-07T05:00:00.000Z',
  event: 'release',
  ...over,
});

/** 假后端，「已发布的提交」接口回这一样；给 Error 就当接口本身挂了。 */
function released(answer: ReleasedCommits | Error): FleetApi {
  const api = createMockApi({ live: false });
  const franceReleasedCommits: FleetApi['franceReleasedCommits'] = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return Object.assign(api, { franceReleasedCommits }) as MockApi as unknown as FleetApi;
}

/** 等「已发布的提交」那块画出来，回它的列表。 */
async function commitRows(): Promise<HTMLElement[]> {
  await screen.findByRole('heading', { name: '更新日志' });
  const list = await waitFor(() => {
    const el = document.querySelector('[data-released-commits]');
    if (!(el instanceof HTMLElement)) throw new Error('列表还没画出来');
    return el;
  });
  return within(list).getAllByRole('listitem');
}

/** 页里那一块区块（列表或没查成的原因）；#1902 起区块里没有自己的标题。 */
function commitsPanel(): HTMLElement {
  const section = document.querySelector('section');
  if (!section) throw new Error('找不到已发布的提交那一块');
  return section;
}

describe('/changelog 页：已发布的提交', () => {
  test('读到了：每条写提交号、标题、发于何时，回滚的标出来，新的在前；假后端默认数据也能画', async () => {
    renderApp(<ChangelogPage />, {
      api: released({
        state: 'ok',
        commits: [
          commit(A, { title: '探针每次结论落一条历史 (#1225)' }),
          commit(B, { title: '额度读取 (#1228)', event: 'rollback' }),
          commit(C, { title: '路由页 (#1224)' }),
        ],
        asOf: AS_OF,
      }),
    });
    const rows = await commitRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain(A.slice(0, 12));
    expect(rows[0]?.textContent).toContain('探针每次结论落一条历史 (#1225)');
    expect(rows[0]?.textContent).toContain('发于');
    expect(rows[1]?.textContent).toContain('回滚');
    expect(rows[2]?.textContent).not.toContain('回滚');
    // 页标题下不再有一层卡内标题「已发布的提交」；时间一行，绝对时间在悬停里
    expect(screen.queryByRole('heading', { name: '已发布的提交' })).toBeNull();
    expect(commitsPanel().textContent).not.toContain('已发布的提交');
    // 标题截断后自己也带 title（整句悬停），所以按 data-released-at 找时间那一格（原来取行里第一个 [title]）
    const when = rows[0]?.querySelector('[data-released-at]');
    expect(when?.textContent).toMatch(/^发于 /);
    expect(when?.getAttribute('title')).toMatch(/\d+月\d+日 \d+:\d+/);
    // 指路去法国页的入口，不在这一页给按钮
    expect(screen.getByRole('link', { name: '法国' }).getAttribute('href')).toBe('/france');
  });

  test('没有「发布 v<N>」按钮和弹窗，没有「版本里程碑发版」的说法，也没有发布命令', async () => {
    renderApp(<ChangelogPage />, {
      api: released({ state: 'ok', commits: [commit(A)], asOf: AS_OF }),
    });
    await commitRows();
    expect(screen.queryByRole('button', { name: /^发布/ })).toBeNull();
    // 页面自己写的话：标题、说明、列表
    const own = [commitsPanel().textContent, document.querySelector('header')?.textContent ?? ''].join('\n');
    expect(own).not.toMatch(/发布 v|里程碑发版|版本里程碑|这一版是|publish:pr|release\/v\d/);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('默认假后端：页面能画出来、也没有「发布 v」按钮', async () => {
    renderApp(<ChangelogPage />);
    const rows = await commitRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: /发布 v/ })).toBeNull();
  });
});

describe('/changelog 页：故意造出的失败照实说', () => {
  test('读不到发布历史：写「没查成」和原因，不画空列表、不写「没发过」', async () => {
    renderApp(<ChangelogPage />, {
      api: released({ state: 'unreadable', why: '读法国发布历史失败：ENOENT .history', asOf: AS_OF }),
    });
    expect(await screen.findByText(/没查成：读法国发布历史失败：ENOENT \.history/)).toBeTruthy();
    expect(document.querySelector('[data-released-commits]')).toBeNull();
    expect(commitsPanel().textContent).not.toContain('还没有发布记录');
  });

  test('某一条的标题读不到：只那一条写原因，别的条照常', async () => {
    renderApp(<ChangelogPage />, {
      api: released({
        state: 'ok',
        commits: [commit(A, { title: null, titleWhy: '读标题失败：403' }), commit(B, { title: '好的标题' })],
        asOf: AS_OF,
      }),
    });
    const rows = await commitRows();
    expect(rows[0]?.textContent).toContain('没查成：读标题失败：403');
    expect(rows[1]?.textContent).toContain('好的标题');
    expect(rows[1]?.textContent).not.toContain('没查成');
  });

  test('接口本身挂了：写「已发布的提交没读成」，不拿上一次的顶', async () => {
    renderApp(<ChangelogPage />, { api: released(new ApiError(500, 'internal', '后端出错了')) });
    expect(await screen.findByText(/已发布的提交没读成：后端出错了/)).toBeTruthy();
    expect(document.querySelector('[data-released-commits]')).toBeNull();
  });

  test('历史里一条都没有：明说「还没有发布记录」，这是查成了，不写没查成', async () => {
    renderApp(<ChangelogPage />, { api: released({ state: 'ok', commits: [], asOf: AS_OF }) });
    expect(await screen.findByText('法国的发布历史里还没有发布记录')).toBeTruthy();
    expect(commitsPanel().textContent).not.toContain('没查成');
  });
});

describe('/changelog 页：版式与已删的对照区（#1821）', () => {
  test('提交行标题列带 min-w-0 flex-1、标题一行截断不挤走徽标和时间；没有 CHANGELOG.md 对照区', async () => {
    // 标题列又被写回固定轨道，或对照区回来，这一条会红。
    // 照路由页样板（#1914「一行不折」）：原来窄屏把徽标和时间折到第二行（flex-wrap），现在标题截断、整句在悬停，
    // 徽标、时间不让位（shrink-0）。原断言「标题的父元素 min-w-0 flex-1」「行 flex-wrap」改成下面等价的版式断言。
    renderApp(<ChangelogPage />, {
      api: released({ state: 'ok', commits: [commit(A, { event: 'rollback' })], asOf: AS_OF }),
    });
    const [row] = await commitRows();
    const titleCol = row?.querySelector('[data-commit-row]');
    expect(titleCol?.className).toContain('min-w-0');
    expect(titleCol?.className).toContain('flex-1');
    const nameLine = row?.querySelector('[data-row-name-line]');
    expect(nameLine?.className).toContain('whitespace-nowrap');
    const title = nameLine?.querySelector('p');
    expect(title?.className).toContain('truncate');
    expect(title?.getAttribute('title')).toBe(`标题 ${A.slice(0, 4)}`);
    expect(row?.querySelector('[data-released-at]')?.className).toContain('shrink-0');
    // 回滚标成状态标签（data-tone），不是手写的小块
    expect(row?.querySelector('[data-tone="stall"]')?.textContent).toBe('回滚');
    expect(screen.queryByRole('heading', { name: 'CHANGELOG.md 对照' })).toBeNull();
    expect(screen.queryByRole('button', { name: /还没收进版本/ })).toBeNull();
  });
});

describe('/changelog 页：照路由页样板的标题块和行尾菜单', () => {
  test('标题块三行：最近一次的标题和提交号、多久前发布加状态、绝对时间和发布回滚几次；三行都不折', async () => {
    renderApp(<ChangelogPage />, {
      api: released({
        state: 'ok',
        commits: [
          commit(A, { title: '探针每次结论落一条历史 (#1225)' }),
          commit(B, { event: 'rollback', at: '2026-10-06T05:00:00.000Z' }),
        ],
        asOf: AS_OF,
      }),
    });
    await commitRows();
    const hero = document.querySelector('[data-changelog-hero]') as HTMLElement;
    expect(hero.textContent).toContain('探针每次结论落一条历史 (#1225)');
    expect(hero.textContent).toContain(A.slice(0, 12));
    const line = hero.querySelector('[data-hero-line]') as HTMLElement;
    expect(line.textContent).toContain('发布到法国');
    expect(line.querySelector('[data-tone="done"]')?.textContent).toBe('最新');
    expect(line.className).toContain('whitespace-nowrap');
    expect(hero.querySelector('[data-hero-notes]')?.textContent).toContain('最近 2 次里发布 1、回滚 1');
    // 标题块不在区块里（区块里没有自己的标题，#1902）
    expect(commitsPanel().contains(hero)).toBe(false);
  });

  test('最近一次是回滚：结论写回滚，状态黄；读不到、没有记录时不画标题块', async () => {
    renderApp(<ChangelogPage />, {
      api: released({ state: 'ok', commits: [commit(A, { event: 'rollback' })], asOf: AS_OF }),
    });
    await commitRows();
    const line = document.querySelector('[data-changelog-hero] [data-hero-line]') as HTMLElement;
    expect(line.textContent).toContain('回滚到这个提交');
    expect(line.querySelector('[data-tone="stall"]')?.textContent).toBe('回滚');
    cleanup();
    renderApp(<ChangelogPage />, { api: released({ state: 'ok', commits: [], asOf: AS_OF }) });
    await screen.findByText('法国的发布历史里还没有发布记录');
    expect(document.querySelector('[data-changelog-hero]')).toBeNull();
  });

  test('行尾「⋯」：复制完整的 40 位提交号', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp(<ChangelogPage />, { api: released({ state: 'ok', commits: [commit(A)], asOf: AS_OF }) });
    const [row] = await commitRows();
    const trigger = within(row as HTMLElement).getByRole('button', { name: `更多操作：${A.slice(0, 12)}` });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '复制完整提交号' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(A));
  });
});
