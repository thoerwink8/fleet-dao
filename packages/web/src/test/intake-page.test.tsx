// @vitest-environment happy-dom
// 提需求页（#2062）整页，接假后端（判法和真后端同一份 shared 的 requestActions）：
// 列表一行的各项、筛选和搜索、菜单只出能做的、删不了写原因、删除确认框 → 最近删除 → 恢复（剧本②）、
// 结案锁死和「接着这条提」挂在原条下面（剧本③）、拍板卡只有拍板人能点、多选批量归档 / 删除留下做不了的、
// 单子面板带版本号改栏、手机两个画面、角标是「等我的」件数。每个读不到、没成的分支都有一条故意造出的失败。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiProvider } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { DELETE_CONFIRM_TEXT } from '../components/intake/request-menu';
import { useBadgeCount } from '../lib/pwa/hooks';
import Intake from '../routes/intake';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function viewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, px]) =>
          kind === 'min' ? width >= Number(px) : width <= Number(px),
        ),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

const row = (seq: number) => document.querySelector<HTMLElement>(`[data-request-row="${seq}"]`);
const rowSeqs = () =>
  [...document.querySelectorAll<HTMLElement>('[data-request-row]')].map((el) =>
    Number(el.dataset.requestRow),
  );

async function listed(seq: number) {
  return waitFor(() => {
    const el = row(seq);
    if (!el) throw new Error(`列表里还没有需求 ${seq}`);
    return el;
  });
}

async function openRowMenu(seq: number) {
  const el = await listed(seq);
  const trigger = within(el).getByRole('button', { name: `更多操作：需求 ${seq}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const menu = await screen.findByRole('menu');
  // 打开才读这一条能做什么：等「在读」那一行没了
  await waitFor(() => expect(within(menu).queryByText('在读这条能做什么……')).toBeNull());
  return menu;
}

function wide() {
  viewport(1920);
}

describe('列表', () => {
  test('一行：头像、标题、预览、等我、搁置 N 天、单号；置顶在前；「接着这条提」缩进挂在原条下面', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake' });
    await listed(45);
    const seqs = rowSeqs();
    expect(seqs[0]).toBe(31);
    expect(seqs.indexOf(44)).toBe(seqs.indexOf(31) + 1);
    expect(row(44)?.dataset.child).toBe('true');
    expect(row(45)?.querySelector('[data-waiting="unread"]')?.textContent).toContain('等我');
    expect(row(43)?.querySelector('[data-waiting="decide"]')).not.toBeNull();
    expect(row(41)?.textContent).toContain('搁置 16 天');
    expect(row(31)?.textContent).toContain('#12');
    expect(row(45)?.textContent).toContain('fxc188：跟着顶栏也行');
    expect(row(31)?.querySelector('[aria-label="置顶"]')).not.toBeNull();
    // 已归档、最近删除的不在进行中
    expect(seqs).not.toContain(30);
    expect(seqs).not.toContain(28);
    expect(document.querySelector('[data-view-entry="已归档"]')?.textContent).toContain('（2）');
  });

  test('「等我的」只剩等我的；按 #单号 搜得到结案开出的那条', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?filter=todo' });
    await waitFor(() => expect(rowSeqs().sort()).toEqual([31, 43, 45]));
    cleanup();
    renderApp(<Intake />, { route: '/intake?q=%2312' });
    await waitFor(() => expect(rowSeqs()).toEqual([31]));
  });

  test('【故意造出的失败】后端没接上需求表：写原因，不画成「没有需求」；角标不当 0', async () => {
    wide();
    const api = createMockApi({ live: false, requests: { mode: 'unavailable' } });
    renderApp(<Intake />, { route: '/intake', api });
    const box = await waitFor(() => {
      const el = document.querySelector('[data-requests-unavailable]');
      if (!el) throw new Error('还没写原因');
      return el;
    });
    expect(box.textContent).toContain('没接上需求表');
    expect(rowSeqs()).toEqual([]);
    expect(document.body.textContent).not.toContain('这一项下面没有需求');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>{children}</ApiProvider>
      </QueryClientProvider>
    );
    const badge = renderHook(() => useBadgeCount(), { wrapper });
    await waitFor(() => expect(qc.getQueryState(['requests', 'active', 'all', ''])?.status).toBe('success'));
    expect(badge.result.current).toBeUndefined();
  });

  test('【故意造出的失败】列表读不到：写「需求列表没读成」和原因、给重试', async () => {
    wide();
    const api = createMockApi({ live: false });
    api.requests = async () => {
      throw new ApiError(0, 'network', '连不上驾驶舱后端');
    };
    renderApp(<Intake />, { route: '/intake', api });
    await waitFor(() => expect(document.body.textContent).toContain('需求列表没读成：连不上驾驶舱后端'));
  });

  test('角标是「等我的」件数（等我拍板 1 + 有我没读的 1 + 引擎在问我 1）', async () => {
    const api = createMockApi({ live: false });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>{children}</ApiProvider>
      </QueryClientProvider>
    );
    const badge = renderHook(() => useBadgeCount(), { wrapper });
    await waitFor(() => expect(badge.result.current).toBe(3));
  });
});

describe('菜单和删除（剧本②）', () => {
  test('只有自己说过话：菜单有「删除」；确认框写明 30 天；删了进「最近删除」，能恢复', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake' });
    const menu = await openRowMenu(46);
    fireEvent.click(within(menu).getByRole('menuitem', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(DELETE_CONFIRM_TEXT);
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(row(46)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /已归档/ }));
    await listed(30);
    fireEvent.click(screen.getByRole('button', { name: /最近删除/ }));
    const deleted = await listed(46);
    expect(deleted.textContent).toContain('彻底删除');
    fireEvent.click(within(deleted).getAllByRole('button')[0] as HTMLElement);
    const restore = await screen.findByRole('button', { name: '恢复' });
    fireEvent.click(restore);
    await waitFor(() => expect(document.querySelector('[data-deleted-bar]')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '回到已归档' }));
    fireEvent.click(await screen.findByRole('button', { name: '回到进行中' }));
    await listed(46);
  });

  test('别人说过话：菜单里没有「删除」，悬停「放下」写为什么不能删', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake' });
    const menu = await openRowMenu(45);
    expect(within(menu).queryByRole('menuitem', { name: '删除' })).toBeNull();
    const drop = within(menu).getByRole('menuitem', { name: '放下（写理由）' });
    expect(drop.getAttribute('title')).toContain('别人也说过话');
  });

  test('已结案：菜单里没有「删除」，只有「归档」，悬停写原因', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake' });
    const menu = await openRowMenu(31);
    expect(within(menu).queryByRole('menuitem', { name: '删除' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: '归档' }).getAttribute('title')).toContain('已结案');
  });

  test('待拍板：菜单里没有「删除」，也没有「放下」「归档」可挂，单独写一句删不了', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake' });
    const menu = await openRowMenu(43);
    expect(within(menu).queryByRole('menuitem', { name: '删除' })).toBeNull();
    expect(menu.querySelector('[data-delete-note]')?.textContent).toContain('待拍板的需求不能删');
  });

  test('【故意造出的失败】菜单打开时读不到这一条：写原因，不出空菜单', async () => {
    wide();
    const api = createMockApi({ live: false });
    api.request = async () => {
      throw new ApiError(503, 'requests_unavailable', '库读不到');
    };
    renderApp(<Intake />, { route: '/intake', api });
    const el = await listed(46);
    fireEvent.pointerDown(within(el).getByRole('button', { name: '更多操作：需求 46' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu.textContent).toContain('没读到这条能做什么：库读不到'));
  });
});

describe('多选', () => {
  test('批量归档：已结案的归档了，讨论中的留在选中里写原因', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake' });
    await listed(31);
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    fireEvent.click(within(row(31) as HTMLElement).getAllByRole('button')[0] as HTMLElement);
    fireEvent.click(within(row(46) as HTMLElement).getAllByRole('button')[0] as HTMLElement);
    const bar = document.querySelector('[data-bulk-bar]') as HTMLElement;
    const archive = within(bar).getByRole('button', { name: '归档' });
    // 等两条的详情读到（能不能归档在详情里）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    fireEvent.click(archive);
    await waitFor(() => expect(row(31)).toBeNull());
    expect(row(46)?.dataset.picked).toBe('true');
    expect(row(46)?.querySelector('[data-blocked-why]')?.textContent).toContain('讨论中的需求不能归档');
  });

  test('批量删除：能删的删了，删不了的留着写原因', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake' });
    await listed(45);
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    fireEvent.click(within(row(46) as HTMLElement).getAllByRole('button')[0] as HTMLElement);
    fireEvent.click(within(row(45) as HTMLElement).getAllByRole('button')[0] as HTMLElement);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const bar = document.querySelector('[data-bulk-bar]') as HTMLElement;
    fireEvent.click(within(bar).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(DELETE_CONFIRM_TEXT);
    fireEvent.click(within(dialog).getByRole('button', { name: '删除能删的' }));
    await waitFor(() => expect(row(46)).toBeNull());
    expect(row(45)?.dataset.picked).toBe('true');
    expect(row(45)?.querySelector('[data-blocked-why]')?.textContent).toContain('别人也说过话');
  });
});

describe('对话', () => {
  test('排法：我在右带气泡，别人在左带名字，指挥官在左不带气泡；打开就记已读', async () => {
    wide();
    const { api } = renderApp(<Intake />, { route: '/intake?r=45' });
    await waitFor(() => expect(document.querySelectorAll('[data-message]').length).toBe(4));
    expect(document.querySelectorAll('[data-message="mine"]').length).toBe(1);
    expect(document.querySelectorAll('[data-message="other"]').length).toBe(2);
    expect(document.querySelector('[data-message="commander"]')?.textContent).toContain('指挥官');
    expect(document.querySelector('[data-unread-divider]')).not.toBeNull();
    await waitFor(async () =>
      expect((await api.request(45)).lastReadMessageId).toBe((await api.request(45)).messages.at(-1)?.id),
    );
  });

  test('拍板卡：拍板人能点「同意做」，点了结案、输入框换成细栏', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=43' });
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-decide-buttons]');
      if (!el) throw new Error('拍板卡还没出来');
      return el;
    });
    fireEvent.click(within(card).getByRole('button', { name: '同意做' }));
    await waitFor(() =>
      expect(document.querySelector('[data-intake-lock]')?.textContent).toContain('已结案，内容不再改'),
    );
    expect(document.querySelector('[data-intake-composer]')).toBeNull();
    expect(document.querySelector('[data-closed-line]')?.textContent).toContain('同意做');
  });

  test('拍板卡：不是拍板人只看到「等谁拍板」，没有按钮', async () => {
    wide();
    const api = createMockApi({ live: false, requests: { as: 'partner' } });
    renderApp(<Intake />, { route: '/intake?r=43', api });
    const wait = await waitFor(() => {
      const el = document.querySelector('[data-decide-wait]');
      if (!el) throw new Error('还没出来');
      return el;
    });
    expect(wait.textContent).toContain('等 阿岚 拍板');
    expect(document.querySelector('[data-decide-buttons]')).toBeNull();
  });

  test('【故意造出的失败】发没出去：字留在框里，框下写原因', async () => {
    wide();
    const api = createMockApi({ live: false });
    api.sendRequestMessage = async () => {
      throw new ApiError(409, 'request_refused', '已结案，内容不再改');
    };
    renderApp(<Intake />, { route: '/intake?r=46', api });
    const input = (await screen.findByRole('textbox', { name: '消息' })) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '按仓分组' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(document.querySelector('[data-send-error]')?.textContent).toContain('已结案'));
    expect(input.value).toBe('按仓分组');
  });

  test('【故意造出的失败】没有这条需求：写「没有需求 N」，不一直转', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=999' });
    await waitFor(() => expect(document.body.textContent).toContain('没有需求 999'));
  });
});

describe('结案锁死、接着这条提（剧本③）', () => {
  test('结案的没有输入框；「接着这条提」开出新的一条，挂在原条下面', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=31' });
    const lock = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-intake-lock]');
      if (!el) throw new Error('还没出细栏');
      return el;
    });
    expect(lock.textContent).toContain('已结案，内容不再改');
    expect(document.querySelector('[data-intake-composer]')).toBeNull();
    fireEvent.click(within(lock).getByRole('button', { name: /接着这条提/ }));
    await waitFor(() => expect(document.body.textContent).toContain('接着 需求 31 提'));
    const input = screen.getByRole('textbox', { name: '消息' });
    fireEvent.change(input, { target: { value: '抖音那张卡也一起填' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(document.querySelector('[data-continues]')?.textContent).toContain('接着 需求 31'),
    );
    await waitFor(() => {
      const seqs = rowSeqs();
      const at = seqs.indexOf(47);
      expect(at).toBeGreaterThan(seqs.indexOf(31));
      expect(row(47)?.dataset.child).toBe('true');
    });
  });
});

describe('单子面板', () => {
  test('滑出、记住开关；改一栏带着版本号，版本加 1', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=46' });
    const toggle = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-panel-toggle]');
      if (!el) throw new Error('还没出头部');
      return el;
    });
    expect(toggle.textContent).toContain('第 1 版');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(document.querySelector('[data-intake-panel-wrap]')?.getAttribute('data-open')).toBe('true'),
    );
    expect(
      localStorage.getItem('fleet-dao.intake-panel') ?? JSON.stringify(Object.values(localStorage)),
    ).toContain('true');
    const panel = document.querySelector('[data-intake-panel]') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: '改要什么' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: '要什么' }), {
      target: { value: '按仓分组显示' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: /存（第 2 版）/ }));
    await waitFor(() =>
      expect(panel.querySelector('[data-draft-version]')?.textContent).toContain('第 2 版'),
    );
    expect(panel.querySelector('[data-draft-field="want"]')?.textContent).toContain('人改过');
  });

  test('类别是下拉，只有需求、缺陷、杂项三个（写别的开单会失败）', async () => {
    wide();
    localStorage.setItem('fleet-dao.intake-panel', 'true');
    renderApp(<Intake />, { route: '/intake?r=46', api: createMockApi({ live: false }) });
    const panel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-intake-panel]');
      if (!el) throw new Error('面板还没出来');
      return el;
    });
    fireEvent.click(within(panel).getByRole('button', { name: '改类别' }));
    const select = within(panel).getByRole('combobox', { name: '类别' }) as HTMLSelectElement;
    const values = Array.from(select.options)
      .map((o) => o.value)
      .filter(Boolean);
    expect(values).toEqual(['需求', '缺陷', '杂项']);
  });

  test('【故意造出的失败】别人先改了（409）：写在那一栏下面，不当成存上了', async () => {
    wide();
    localStorage.setItem('fleet-dao.intake-panel', 'true');
    const api = createMockApi({ live: false });
    api.updateRequestDraft = async () => {
      throw new ApiError(409, 'request_refused', '草稿已经改到第 3 版，你看到的是第 1 版：刷新后再改');
    };
    renderApp(<Intake />, { route: '/intake?r=46', api });
    const toggle = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-panel-toggle]');
      if (!el) throw new Error('还没出头部');
      return el;
    });
    if (toggle.getAttribute('aria-pressed') !== 'true') fireEvent.click(toggle);
    const panel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-intake-panel]');
      if (!el) throw new Error('面板还没出来');
      return el;
    });
    fireEvent.click(within(panel).getByRole('button', { name: '改场景' }));
    fireEvent.click(within(panel).getByRole('button', { name: /存（第 2 版）/ }));
    await waitFor(() =>
      expect(panel.querySelector('[data-field-error]')?.textContent).toContain('改到第 3 版'),
    );
  });
});

describe('手机（<768）', () => {
  test('列表 → 对话两个画面；结案的没有「接着这条提」，单子只读、没有面板开关', async () => {
    viewport(390);
    renderApp(<Intake />, { route: '/intake' });
    const el = await listed(31);
    expect(document.querySelector('[data-intake-phone-chat]')).toBeNull();
    fireEvent.click(within(el).getAllByRole('button')[0] as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-intake-phone-chat]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-intake-lock]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /接着这条提/ })).toBeNull();
    expect(document.querySelector('[data-panel-toggle]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '看单子' }));
    await screen.findByText('单子 · 第 7 版（只读）');
    expect(screen.queryByRole('button', { name: /^改/ })).toBeNull();
  });
});

async function shown<T extends Element = HTMLElement>(selector: string): Promise<T> {
  return waitFor(() => {
    const el = document.querySelector<T>(selector);
    if (!el) throw new Error(`还没出来：${selector}`);
    return el;
  });
}

describe('和指挥官、引擎一起聊（B、C 片）', () => {
  test('方案卡：点「确认开单」走 confirm，幂等键是现在的草稿版本', async () => {
    wide();
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'requestAction');
    renderApp(<Intake />, { route: '/intake?r=90', api });
    const card = await shown('[data-proposal-card]');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '确认开单' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(90, { action: 'confirm', draftVersion: 2 }));
  });

  test('方案卡：点「改」打开对应草稿栏的输入框', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=90' });
    const card = await shown('[data-proposal-card]');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '改场景' }));
    const panel = await shown('[data-intake-panel]');
    await waitFor(() => expect(within(panel).getByRole('textbox', { name: '场景' })).not.toBeNull());
  });

  test('指挥官一问：点一个选项就当成一句话发出去，指挥官接着回；回过的那一问不能再点', async () => {
    wide();
    const { api } = renderApp(<Intake />, { route: '/intake?r=46' });
    const card = await shown('[data-question-card]');
    expect(within(card as HTMLElement).getByRole('button', { name: '我自己说' })).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '按仓分组' }));
    await waitFor(async () => {
      const d = await api.request(46);
      expect(d.messages.some((m) => m.kind === 'human' && m.body === '按仓分组')).toBe(true);
    });
    await waitFor(() => expect(document.querySelectorAll('[data-question-card]').length).toBe(2));
    // 只有最新那一问能点
    expect(document.querySelectorAll('[data-option]').length).toBe(3);
  });

  test('引擎提问：发起人点「回答」写回单子，显示「已写回单子」；「等我的」里的引擎提问跟着消掉', async () => {
    wide();
    const { api } = renderApp(<Intake />, { route: '/intake?r=31' });
    const ask = await shown('[data-engine-ask="pending"]');
    fireEvent.click(within(ask as HTMLElement).getByRole('button', { name: '回答' }));
    fireEvent.change(screen.getByRole('textbox', { name: '回答引擎的提问' }), {
      target: { value: '显示「未设置」' },
    });
    fireEvent.click(screen.getByRole('button', { name: '写回单子' }));
    await shown('[data-engine-ask="written"]');
    expect(document.querySelector('[data-engine-ask="written"]')?.textContent).toContain('显示「未设置」');
    const list = await api.requests({ view: 'active', filter: 'todo' });
    expect(list.items.map((r) => r.seq)).not.toContain(31);
  });

  test('【故意造出的失败】答复写回单子失败：写原因，答的字不丢，再点一次就是重试', async () => {
    wide();
    const api = createMockApi({ live: false });
    const real = api.answerEngineAsk.bind(api);
    let first = true;
    api.answerEngineAsk = async (seq, id, text) => {
      if (first) {
        first = false;
        throw new ApiError(502, 'answer_failed', 'GitHub 没写进去：502');
      }
      return real(seq, id, text);
    };
    const err = vi.spyOn(toast, 'error');
    renderApp(<Intake />, { route: '/intake?r=31', api });
    const ask = await shown('[data-engine-ask="pending"]');
    fireEvent.click(within(ask as HTMLElement).getByRole('button', { name: '回答' }));
    const box = screen.getByRole('textbox', { name: '回答引擎的提问' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '不列' } });
    fireEvent.click(screen.getByRole('button', { name: '写回单子' }));
    await waitFor(() => expect(String(err.mock.calls.at(-1)?.[0])).toContain('没写回去：GitHub 没写进去'));
    expect(box.value).toBe('不列');
    fireEvent.click(screen.getByRole('button', { name: '写回单子' }));
    await shown('[data-engine-ask="written"]');
  });

  test('进度卡：「#12 动手中……」画成一颗带链接的小卡，点了去 GitHub', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=31' });
    const cards = await waitFor(() => {
      const els = document.querySelectorAll<HTMLElement>('[data-message="progress"]');
      if (els.length === 0) throw new Error('还没出进度卡');
      return els;
    });
    const last = cards[cards.length - 1] as HTMLElement;
    expect(last.textContent).toContain('动手中 · 已合并 1/3 个子任务');
    expect(last.querySelector('a')?.getAttribute('href')).toMatch(/\/issues\/12$/);
  });

  test('建议改：人改过的栏，指挥官只出一张卡；点「采用」才改，改完写「已经是这样了」', async () => {
    wide();
    const { api } = renderApp(<Intake />, { route: '/intake?r=44' });
    const card = await shown('[data-suggest-card]');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '采用' }));
    await waitFor(async () => expect((await api.request(44)).request.draft.scene).toContain('一次填好'));
    await waitFor(() =>
      expect(document.querySelector('[data-suggest-card]')?.textContent).toContain('已经是这样了'),
    );
  });

  test('别家意见：每条能标采用或不用', async () => {
    wide();
    const { api } = renderApp(<Intake />, { route: '/intake?r=44' });
    const card = await shown('[data-review-card]');
    fireEvent.click(within(card as HTMLElement).getAllByRole('button', { name: '采用' })[0] as HTMLElement);
    await waitFor(async () => {
      const m = (await api.request(44)).messages.find((x) => x.card?.type === 'review');
      expect(m?.card?.type === 'review' ? m.card.items[0]?.verdict : null).toBe('adopt');
    });
    fireEvent.click(within(card as HTMLElement).getAllByRole('button', { name: '不用' })[1] as HTMLElement);
    await waitFor(async () => {
      const m = (await api.request(44)).messages.find((x) => x.card?.type === 'review');
      expect(m?.card?.type === 'review' ? m.card.items.map((i) => i.verdict) : []).toEqual([
        'adopt',
        'reject',
      ]);
    });
  });

  test('模型芯片：默认是用途里排第一的；只给这一条换，对话里出一条分隔线', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=46' });
    const chip = await shown<HTMLButtonElement>('[data-model-chip]');
    expect(chip.textContent).toContain('Claude Sonnet 5.5');
    fireEvent.pointerDown(chip, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Claude Opus 5.5' }));
    await shown('[data-message="model-switch"]');
    await waitFor(() => expect(document.querySelector('[data-model-chip]')?.textContent).toContain('Opus'));
  });

  test('两个人都说过话：输入框提示 @指挥官，有「让指挥官接着问」，点了指挥官接话', async () => {
    wide();
    const { api } = renderApp(<Intake />, { route: '/intake?r=45' });
    const input = (await screen.findByRole('textbox', { name: '消息' })) as HTMLTextAreaElement;
    expect(input.placeholder).toContain('@指挥官');
    const before = (await api.request(45)).messages.filter((m) => m.kind === 'commander').length;
    fireEvent.click(await shown('[data-nudge]'));
    await waitFor(async () =>
      expect((await api.request(45)).messages.filter((m) => m.kind === 'commander').length).toBe(before + 1),
    );
  });

  test('只有一个人在聊时没有「让指挥官接着问」（每句都回）；手机上没有模型芯片', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=46' });
    await shown('[data-model-chip]');
    expect(document.querySelector('[data-nudge]')).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    viewport(390);
    renderApp(<Intake />, { route: '/intake?r=46' });
    await screen.findByRole('textbox', { name: '消息' });
    expect(document.querySelector('[data-model-chip]')).toBeNull();
  });

  test('同意做：开出单，结案线写开成的单号', async () => {
    wide();
    renderApp(<Intake />, { route: '/intake?r=43' });
    const card = await shown('[data-decide-buttons]');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '同意做' }));
    await waitFor(() =>
      expect(document.querySelector('[data-closed-line]')?.textContent).toMatch(/开成 #\d+/),
    );
  });

  test('【故意造出的失败】同意做的回话没送到（网关超时）：去查这一版开没开成，开成了照实说，不让人重点', async () => {
    wide();
    const api = createMockApi({ live: false });
    const real = api.requestAction.bind(api);
    api.requestAction = async (seq, body) => {
      await real(seq, body);
      throw new ApiError(504, 'gateway_timeout', '网关等后端超时了');
    };
    const lookup = vi.spyOn(api, 'requestIssueOpening');
    const ok = vi.spyOn(toast, 'success');
    renderApp(<Intake />, { route: '/intake?r=43', api });
    const card = await shown('[data-decide-buttons]');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '同意做' }));
    await waitFor(() => expect(lookup).toHaveBeenCalledWith(43, 4));
    await waitFor(() => expect(String(ok.mock.calls.at(-1)?.[0])).toContain('单已经开出来了'));
  });
});
