// @vitest-environment happy-dom
// /changelog 页（发布记录，#227 切片、#1255、#3509 改版）的钉子：
// - 页面是只读的「已发布的提交」表（读法国发布历史）：每条提交号、标题、类型、发于何时；读不到整份写没查成和原因，
//   某一条标题读不到，那一格写「没读到」、原因在顶上一条提示里；接口挂了写没读成；一条记录都没有写明「还没有发布记录」，不当成没查成；
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

/** 等「已发布的提交」那张表画出来，回它的数据行（不含表头）。 */
async function commitRows(): Promise<HTMLElement[]> {
  await screen.findByRole('heading', { level: 1, name: '发布记录' });
  const list = await waitFor(() => {
    const el = document.querySelector('[data-released-commits]');
    if (!(el instanceof HTMLElement)) throw new Error('列表还没画出来');
    return el;
  });
  return within(list).getAllByRole('row').slice(1);
}

/** 页里那一块区块（列表或空状态）。 */
function commitsPanel(): HTMLElement {
  const section = document.querySelector('section');
  if (!section) throw new Error('找不到已发布的提交那一块');
  return section;
}

describe('/changelog 页：已发布的提交', () => {
  test('读到了：每条写提交号、标题、类型、发于何时，回滚的标出来，新的在前；假后端默认数据也能画', async () => {
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
    expect(rows[0]?.textContent).toContain('发布');
    expect(rows[1]?.textContent).toContain('回滚');
    expect(rows[2]?.textContent).not.toContain('回滚');
    // 回滚是橙标签，正常发布是灰标签（颜色只给异常）
    expect(rows[1]?.querySelector('[data-event] [data-look]')?.getAttribute('data-look')).toBe('warning');
    expect(rows[0]?.querySelector('[data-event] [data-look]')?.getAttribute('data-look')).toBe('default');
    // 区块头：「最近 N 条」，不暗示是全部历史
    expect(commitsPanel().textContent).toContain('最近 3 条');
    // 绝对时间写在相对时间下面，也在悬停里
    const when = rows[0]?.querySelector('[data-released-at]');
    expect(when?.textContent).toMatch(/^发于 /);
    expect(when?.getAttribute('title')).toMatch(/\d+月\d+日 \d+:\d+/);
    // 指路去法国页的入口（面包屑和区块头各一个），不在这一页给发布按钮
    expect(screen.getByRole('link', { name: '法国' }).getAttribute('href')).toBe('/france');
    expect(screen.getByRole('link', { name: '去法国页发布' }).getAttribute('href')).toBe('/france');
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
  test('读不到发布历史：写「没查成」和原因，不画空列表、不写「没发过」，并说明这不等于没发过', async () => {
    renderApp(<ChangelogPage />, {
      api: released({ state: 'unreadable', why: '读法国发布历史失败：ENOENT .history', asOf: AS_OF }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('没查成：读法国发布历史失败：ENOENT .history');
    expect(alert.textContent).toContain('这不等于没发过');
    expect(alert.querySelector('button')?.textContent).toContain('重试');
    expect(document.querySelector('[data-released-commits]')).toBeNull();
    expect(document.body.textContent).not.toContain('还没有发布记录');
  });

  test('某一条的标题读不到：那一格写「没读到」，原因在顶上提示里写一次，别的条照常', async () => {
    renderApp(<ChangelogPage />, {
      api: released({
        state: 'ok',
        commits: [commit(A, { title: null, titleWhy: '读标题失败：403' }), commit(B, { title: '好的标题' })],
        asOf: AS_OF,
      }),
    });
    const rows = await commitRows();
    expect(rows[0]?.textContent).toContain('没读到');
    expect(rows[0]?.textContent).toContain(A.slice(0, 12));
    expect(rows[0]?.textContent).not.toContain('读标题失败');
    expect(rows[1]?.textContent).toContain('好的标题');
    expect(rows[1]?.textContent).not.toContain('没读到');
    expect(screen.getByText(/有 1 条的标题没查成：读标题失败：403/)).toBeTruthy();
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
    // 空状态时「去法国页发布」只留空状态按钮一处，区块头不再重复
    expect(screen.getAllByRole('link', { name: '去法国页发布' })).toHaveLength(1);
  });

  test('读成过、这次刷新没成：照旧画上一次的表，顶上写刷新没成', async () => {
    const api = released({ state: 'ok', commits: [commit(A)], asOf: AS_OF });
    renderApp(<ChangelogPage />, { api, staleTime: 0 });
    await commitRows();
    (api as unknown as { franceReleasedCommits: () => Promise<never> }).franceReleasedCommits = () =>
      Promise.reject(new ApiError(500, 'internal', '后端出错了'));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('刷新没成');
    expect(alert.textContent).toContain('后端出错了');
    expect(document.querySelector('[data-released-commits]')).not.toBeNull();
  });
});

describe('/changelog 页：行尾菜单', () => {
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
