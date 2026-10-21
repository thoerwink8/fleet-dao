// @vitest-environment happy-dom
// 主页三块（决定 0093）：要你拍的、在跑的、上线了的，从上到下；要你拍的点选项就是拍板。
// 看门狗的卡没有「处理」：写谁在修（引擎或指挥官会话）、修了多久、开了多久；还没人接就照实写。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import HomePage from '../routes/home';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const block = (name: 'ask' | 'run' | 'alarm' | 'shipped') =>
  document.querySelector(`[data-home-block="${name}"]`) as HTMLElement;

/** 按钮的名字：有字写字，只有图标的（「更多」）写 aria-label。 */
const nameOf = (b: HTMLElement) => b.getAttribute('aria-label') ?? b.textContent;

async function ready() {
  await waitFor(() => expect(document.querySelectorAll('[data-ask-row]').length).toBeGreaterThan(0));
  await waitFor(() => expect(document.querySelectorAll('[data-shipped-row]').length).toBeGreaterThan(0));
  await waitFor(() => expect(document.querySelectorAll('[data-run-row="local"]').length).toBeGreaterThan(0));
}

describe('工作台列表块', () => {
  test('从上到下：要你拍的、在跑的任务（左列），卡住报警、最近上线（右列）', async () => {
    renderApp(<HomePage />);
    await ready();
    const order = [...document.querySelectorAll('[data-home-block]')].map((el) =>
      el.getAttribute('data-home-block'),
    );
    expect(order).toEqual(['ask', 'run', 'alarm', 'shipped']);
  });

  test('要你拍的：只放人闸，一行写要定什么、推荐哪个、为什么；多于两个选项的收进「更多」；没选项的写请直接回复', async () => {
    renderApp(<HomePage />);
    await ready();
    const rows = [...block('ask').querySelectorAll('[data-ask-row]')] as HTMLElement[];
    // 看门狗的卡不在这里，在「卡住报警」里
    expect(rows.map((r) => r.getAttribute('data-ask-row'))).toEqual(['gate', 'gate', 'gate', 'gate']);
    // 拍了但系统没做成的（n-11，#2353）照旧在这里，写上次没做成的原因
    const app = rows.find((r) => r.textContent?.includes('acme/fluxwatch')) as HTMLElement;
    expect(app.textContent).toContain(
      '上次选「我装好了，再查一次」没做成：「干活的」机器人 还没装到 acme/fluxwatch',
    );
    const release = rows.find((r) => r.textContent?.includes('发布 v2.3')) as HTMLElement;
    expect(release.textContent).toContain('对外发布到生产');
    expect(release.textContent).toContain('推荐：发布。CI 全绿');
    // 一行两个选项按钮，第三个收进「更多」
    const buttons = within(release).getAllByRole('button').map(nameOf);
    expect(buttons).toEqual(['发布', '今晚再发', expect.stringContaining('更多选项')]);
    const plain = rows.find((r) => r.textContent?.includes('#15 在问你')) as HTMLElement;
    expect(plain.textContent).toContain('没有选项，请直接回复');
    expect(
      within(plain)
        .getByRole('link', { name: /去回复/ })
        .getAttribute('href'),
    ).toBe('/notifications?level=decision');
    // 别的卡住报警（额度读不到、子任务停滞）不进工作台，在通知中心
    expect(document.querySelector('[data-home]')?.textContent).not.toContain('额度读不到');
  });

  test('整页只有一个主按钮：最上面那条的推荐项；其余选项都是灰的次按钮', async () => {
    renderApp(<HomePage />);
    await ready();
    const home = document.querySelector('[data-home]') as HTMLElement;
    const primary = [...home.querySelectorAll('button[data-variant="primary"], a[data-variant="primary"]')];
    expect(primary).toHaveLength(1);
    expect(block('ask').contains(primary[0] ?? null)).toBe(true);
    expect(home.querySelectorAll('[data-variant="outline"]')).toHaveLength(0);
  });

  test('点推荐的选项就是拍板：调回答接口，这条从要你拍的里走掉', async () => {
    const { api } = renderApp(<HomePage />);
    const answer = vi.spyOn(api, 'answerNotification');
    await ready();
    const release = [...block('ask').querySelectorAll('[data-ask-row]')].find((r) =>
      r.textContent?.includes('发布 v2.3'),
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(within(release).getByRole('button', { name: '发布' }));
    });
    await waitFor(() => expect(answer).toHaveBeenCalledWith('n-1', { optionId: 'release' }));
    await waitFor(() => expect(block('ask').textContent).not.toContain('发布 v2.3'));
  });

  test('看门狗的卡没有「处理」：首页上找不到这个按钮；还没人接写开了多久', async () => {
    renderApp(<HomePage />);
    await ready();
    expect(screen.queryByRole('button', { name: '处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '处理中' })).toBeNull();
    const home = document.querySelector('[data-home]') as HTMLElement;
    expect(within(home).queryByRole('button', { name: '处理' })).toBeNull();
    const dog = block('alarm').querySelector('[data-ask-row="watchdog"]') as HTMLElement;
    expect(dog.textContent).toContain('主线 4 小时 12 分没合 PR');
    const repair = dog.querySelector('[data-ask-repair="waiting"]');
    expect(repair?.textContent).toMatch(/^还没人接 · 开了 /);
    expect(within(dog).queryByRole('button', { name: '处理' })).toBeNull();
    expect(within(dog).getByRole('link', { name: /看看/ })).toBeTruthy();
  });

  test('看门狗的卡：有人在修时写引擎或指挥官会话、修了多久、开了多久', async () => {
    const api = createMockApi({ live: false });
    const real = api.notifications.bind(api);
    api.notifications = async (q) => {
      const page = await real(q);
      const dog = page.items.find((n) => n.id === 'n-10');
      if (!dog) throw new Error('假数据里没有看门狗的卡');
      const handling = (who: string, since: string): NonNullable<(typeof dog)['handling']> => ({
        stage: 'pr_open',
        stageText: 'PR 开着',
        since,
        who,
        line: `${who}在修`,
        problems: [],
      });
      const engine = {
        ...dog,
        handling: handling('法国引擎', new Date(Date.parse(dog.createdAt) + 5 * 60_000).toISOString()),
      };
      const commander = {
        ...dog,
        id: 'n-10b',
        title: '备份定时任务没跑成',
        dedupeKey: 'watchdog:job:backup',
        handling: handling('指挥官会话', dog.createdAt),
      };
      return {
        ...page,
        items: page.items.map((n) => (n.id === 'n-10' ? engine : n)).concat(commander),
        counts: { ...page.counts, alert: page.counts.alert + 1 },
      };
    };
    renderApp(<HomePage />, { api });
    await ready();
    const ask = block('alarm');
    expect(within(ask).queryByRole('button', { name: '处理' })).toBeNull();
    const rows = [...ask.querySelectorAll('[data-ask-row="watchdog"]')] as HTMLElement[];
    const engine = rows.find((r) => r.textContent?.includes('主线 4 小时')) as HTMLElement;
    const commander = rows.find((r) => r.textContent?.includes('备份定时任务')) as HTMLElement;
    expect(engine.querySelector('[data-ask-repair="fixing"]')?.textContent).toMatch(
      /^法国引擎在修 · 修了 .+ · 开了 /,
    );
    expect(commander.querySelector('[data-ask-repair="fixing"]')?.textContent).toMatch(
      /^指挥官会话在修 · 修了 .+ · 开了 /,
    );
  });

  test('在跑的：引擎的单和本机会话都在，一行写谁在做和卡没卡', async () => {
    renderApp(<HomePage />);
    await ready();
    const run = block('run');
    expect(run.querySelectorAll('[data-run-row="engine"]').length).toBeGreaterThan(0);
    const local = run.querySelector('[data-run-row="local"]') as HTMLElement;
    expect(local.textContent).toContain('本机 创始人的电脑 · Claude Code');
    // 一行一个状态：每一行的状态格都有字典里的状态标签
    for (const row of run.querySelectorAll('[data-run-row]')) {
      expect(row.closest('tr')?.querySelector('[data-status^="tone:"]')).not.toBeNull();
    }
  });

  test('上线了的：一句话改了什么，带上同一版还带的 PR', async () => {
    renderApp(<HomePage />);
    await ready();
    const first = block('shipped').querySelector('[data-shipped-row]') as HTMLElement;
    expect(first.textContent).toContain('主页改成三块：要你拍的、在跑的、上线了的');
    expect(first.textContent).not.toContain('(#1745)');
    expect(first.querySelector('[data-shipped-carried]')?.textContent).toContain('还带了 2 个：#1744');
  });

  test('没有要拍的：写「没有要你拍的」，不画空表', async () => {
    const api = createMockApi({ live: false });
    const real = api.notifications.bind(api);
    api.notifications = async (q) => ({ ...(await real(q)), items: [] });
    renderApp(<HomePage />, { api });
    await waitFor(() => expect(block('ask')?.textContent).toContain('没有要你拍的'));
  });

  test('【故意造出的失败】通知没读成：要你拍的那块写没读成和重试，不写成「没有要你拍的」', async () => {
    const api = createMockApi({ live: false });
    api.notifications = () => Promise.reject(new ApiError(500, 'internal', '库连不上'));
    renderApp(<HomePage />, { api });
    await waitFor(() => expect(block('ask')?.textContent).toContain('要你拍的没读成'));
    expect(block('ask').textContent).not.toContain('没有要你拍的');
    // 卡住报警读的是同一份通知：同样写没读成，不写成「没有卡住报警」
    await waitFor(() => expect(block('alarm')?.textContent).toContain('卡住报警没读成'));
    expect(block('alarm').textContent).not.toContain('没有卡住报警');
  });

  test('没有卡住报警：写「没有卡住报警」', async () => {
    const api = createMockApi({ live: false });
    const real = api.notifications.bind(api);
    api.notifications = async (q) => ({
      ...(await real(q)),
      items: (await real(q)).items.filter((n) => !n.dedupeKey?.startsWith('watchdog:')),
    });
    renderApp(<HomePage />, { api });
    await waitFor(() => expect(block('alarm')?.textContent).toContain('没有卡住报警'));
  });

  test('【故意造出的失败】上线记录读不到：照实写没查成，不当成没发过', async () => {
    const api = createMockApi({ live: false });
    api.franceReleasedCommits = async () => ({
      state: 'unreadable',
      why: '读法国的发布历史失败',
      asOf: new Date().toISOString(),
    });
    renderApp(<HomePage />, { api });
    await waitFor(() =>
      expect(block('shipped')?.textContent).toContain('上线记录没查成：读法国的发布历史失败'),
    );
    expect(screen.queryByText('法国的发布历史里还没有发布记录')).toBeNull();
  });
});
