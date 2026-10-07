// @vitest-environment happy-dom
// /france 页「发布到法国」按钮（#1232）。做完的标准：
// ① 能点时：点开弹窗写明要发的提交、CI 绿、带上哪几个 PR、发完引擎总开关和接活开关恢复到发版前的样子（#1256）；点「确认发布」才发，只带主线头的提交号；先不＝不发；
// ② 不能点（没装接活单元、CI 红或在跑、已是最新、已有发版在走）：按钮置灰、原因列在旁边，点不出弹窗；
// ③ 后端拒了（头换了等）：不当成发出去了，按钮回来；④ 最近一次的结果（等法国接、被拒、做完）各写各的，读不到写没查成。
// ⑤ 入口在「在用版本」那一行（#1255）：写落后几个提交、要发的主线头提交号和标题，按钮就在这一行里、全页只有这一颗；
//    发版卡读不到时这一行写没查成和原因、不画点不了的假按钮；页面上没有「版本里程碑发版」的说法。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs, ReleaseCard } from '../api/types';
import France from '../routes/france';
import { renderApp } from '../test/harness';

afterEach(cleanup);

const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const ASOF = '2026-10-07T10:00:00.000Z';
const NONE = { state: 'none', target: null, at: null, why: null, phase: null } as const;

function envOk(): EnvResponse {
  const fact = <T,>(value: T) => ({ ok: true as const, value });
  return {
    name: { name: '法国' },
    asOf: ASOF,
    facts: {
      engine: fact({ state: 'on' }),
      version: fact({ current: LIVE, behind: 3, detail: '在用', problems: [] }),
      sessions: fact({ total: 0, byStage: {} }),
      pools: fact({ count: 0, running: 0, unread: 0, stale: 0 }),
      health: fact({ ok: true, total: 0, failing: [], notWired: [] }),
      schedule: fact({ status: 'fresh', lastSuccessAt: ASOF, outcome: 'ok' }),
    },
  };
}

function card(action: Partial<ReleaseCard['action']> = {}): ReleaseCard {
  return {
    mainline: {
      state: 'ok',
      commit: { sha: HEAD, short: HEAD.slice(0, 12), title: '刷新耗时表 (#1230)', at: ASOF },
      ci: { state: 'green' },
    },
    deployed: {
      state: 'ok',
      sha: LIVE,
      short: LIVE.slice(0, 12),
      title: '探针历史 (#1225)',
      titleWhy: null,
      deployedAt: ASOF,
      deployedAtWhy: null,
    },
    gap: {
      state: 'ahead',
      count: 7,
      prs: [
        { number: 1230, title: '刷新耗时表' },
        { number: 1229, title: '任务页暂停继续' },
      ],
      nonPr: 0,
    },
    lastDone: { state: 'unreadable', why: '测试里不读' },
    action: { state: 'ready', reasons: [], installed: true, last: NONE, ...action },
    asOf: ASOF,
  };
}

function setup(c: ReleaseCard, release?: (sha: string) => Promise<unknown>) {
  const calls: string[] = [];
  const inner = createMockApi({ live: false });
  const api = {
    ...inner,
    env: () => Promise.resolve(envOk()),
    jobs: () => Promise.resolve({ asOf: ASOF, jobs: [] } satisfies Jobs),
    franceReleaseCard: () => Promise.resolve(c),
    franceRelease: async (sha: string) => {
      calls.push(sha);
      if (release) return release(sha);
      return { requested: true, sha, at: ASOF };
    },
  } as MockApi;
  renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
  return { calls };
}

const button = () => screen.findByRole('button', { name: '发布到法国' });

describe('/france 页「发布到法国」按钮', () => {
  test('能点：点开弹窗写明提交、CI 绿、带上的 PR、总开关保持关；确认才发，只带主线头的提交号', async () => {
    const { calls } = setup(card());
    const btn = await button();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(HEAD.slice(0, 12))).toBeTruthy();
    expect(within(dialog).getByText(/刷新耗时表 \(#1230\)/)).toBeTruthy();
    expect(within(dialog).getByText('主线 CI 是绿的。')).toBeTruthy();
    expect(within(dialog).getByText(/会带上 7 个提交/)).toBeTruthy();
    expect(within(dialog).getByText(/任务页暂停继续/)).toBeTruthy();
    expect(within(dialog).getByText(/发完把引擎总开关和接活开关恢复到发版前的样子/)).toBeTruthy();
    expect(dialog.textContent).not.toContain('保持关，要开就点');
    expect(calls).toEqual([]); // 点开弹窗还没发
    fireEvent.click(within(dialog).getByRole('button', { name: '确认发布' }));
    await waitFor(() => expect(calls).toEqual([HEAD]));
  });

  test('弹窗里点「先不」：不发', async () => {
    const { calls } = setup(card());
    fireEvent.click(await button());
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls).toEqual([]);
  });

  test('法国还没装接活单元：按钮置灰，写「法国还没装发版接活单元」，点不出弹窗', async () => {
    const { calls } = setup(
      card({ state: 'blocked', installed: false, reasons: ['法国还没装发版接活单元（缺 x）'] }),
    );
    const btn = await button();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText(/法国还没装发版接活单元/)).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('CI 不是绿的、已有发版在走、已是最新：置灰，每条原因都列出来', async () => {
    setup(
      card({
        state: 'blocked',
        reasons: ['主线 CI 不是绿的（红）：failure', '已有发版在走', '法国已经是最新，没有要发的'],
      }),
    );
    expect(((await button()) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('主线 CI 不是绿的（红）：failure')).toBeTruthy();
    expect(await screen.findByText('已有发版在走')).toBeTruthy();
    expect(await screen.findByText('法国已经是最新，没有要发的')).toBeTruthy();
  });

  test('后端拒了（比如头在点之前换了）：不当成发出去了，按钮回来能再点', async () => {
    const { calls } = setup(card(), async () => {
      throw new Error('主线头已经不是 2005b290a 了');
    });
    fireEvent.click(await button());
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认发布' }));
    await waitFor(() => expect(calls).toEqual([HEAD]));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(((await button()) as HTMLButtonElement).disabled).toBe(false);
  });

  test('最近一次的结果：等法国接、被拒（带原因）、做完（写总开关和接活开关恢复到发版前的样子）', async () => {
    const pending = { ...NONE, state: 'pending' } as const;
    setup(card({ state: 'blocked', reasons: ['上一份发布请求还没被法国接走'], last: pending }));
    expect(await screen.findByText(/发布请求已提交，等法国接活/)).toBeTruthy();
    cleanup();

    setup(
      card({
        last: {
          state: 'refused',
          target: HEAD,
          at: '2026-10-07T11:30:00.000Z',
          why: '这个提交的 CI 不是绿的（red）',
          phase: null,
        },
      }),
    );
    const refused = await screen.findByText(/上一次被法国拒了/);
    expect(refused.textContent).toContain('这个提交的 CI 不是绿的（red）');
    expect(refused.textContent).toContain('现场没动');
    cleanup();

    setup(
      card({
        last: {
          state: 'done',
          target: `提交 ${HEAD.slice(0, 12)}`,
          at: '2026-10-07T11:40:00.000Z',
          why: null,
          phase: '第 8 步「派清单」',
        },
      }),
    );
    const done = await screen.findByText(/上一趟发完了/);
    expect(done.textContent).toContain('引擎总开关和接活开关已恢复到发版前的样子');
    // 旧说法「发完保持关、要开就点总开关」不再有（发完恢复发版前的样子，不用人再去开）
    expect(done.textContent).not.toContain('保持关');
    expect(within(done).queryByRole('link', { name: '引擎总开关' })).toBeNull();
  });

  test('入口在「在用版本」那一行：写落后 7 个提交、要发的主线头提交号和标题，按钮在这一行里、全页只有这一颗', async () => {
    setup(card());
    const row = (await screen.findByText('在用版本')).closest('[data-france-fact],[data-env-fact]');
    if (!(row instanceof HTMLElement)) throw new Error('找不到「在用版本」那一格');
    const btn = await within(row).findByRole('button', { name: '发布到法国' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(within(row).getByText('落后主线 7 个提交')).toBeTruthy();
    const head = row.querySelector('[data-entry-head]');
    expect(head?.textContent).toContain(HEAD.slice(0, 12));
    expect(head?.textContent).toContain('刷新耗时表 (#1230)');
    expect(screen.getAllByRole('button', { name: '发布到法国' })).toHaveLength(1);
    // 发版卡（下面那块）只读：里面没有按钮
    const panel = (await screen.findByRole('heading', { name: '发版' })).closest('section');
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).queryByRole('button')).toBeNull();
  });

  test('【故意造出的失败】发版卡读不到：「在用版本」那一行写没查成和原因，不画点不了的假按钮', async () => {
    const inner = createMockApi({ live: false });
    const api = {
      ...inner,
      env: () => Promise.resolve(envOk()),
      jobs: () => Promise.resolve({ asOf: ASOF, jobs: [] } satisfies Jobs),
      franceReleaseCard: () => Promise.reject(new Error('后端 502')),
    } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const row = (await screen.findByText('在用版本')).closest('[data-france-fact],[data-env-fact]');
    if (!(row instanceof HTMLElement)) throw new Error('找不到「在用版本」那一格');
    expect(await within(row).findByText(/发布入口没查成：.*后端 502/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发布到法国' })).toBeNull();
  });

  test('【故意造出的失败】已是最新：入口写「已是主线最新」不写落后几个，按钮置灰', async () => {
    const same = card({ state: 'blocked', reasons: ['法国已经是最新，没有要发的'] });
    same.gap = { state: 'same' };
    setup(same);
    const row = (await screen.findByText('在用版本')).closest('[data-france-fact],[data-env-fact]');
    if (!(row instanceof HTMLElement)) throw new Error('找不到「在用版本」那一格');
    expect(await within(row).findByText('已是主线最新')).toBeTruthy();
    expect(row.querySelector('[data-entry-gap="ahead"]')).toBeNull();
    expect(((await button()) as HTMLButtonElement).disabled).toBe(true);
  });

  test('页面上没有「版本里程碑发版」的说法，也没有指去发版卡或更新日志页发布的旧话', async () => {
    setup(card());
    await button();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/里程碑发版|版本里程碑|发布 v\d/);
    expect(text).not.toContain('「发版」卡里的「发布到法国」');
  });

  test('最近一次的结果读不到：写没查成 + 原因，不当成没点过', async () => {
    setup(
      card({
        state: 'blocked',
        reasons: ['读上一份请求在不在失败：EIO'],
        last: { ...NONE, state: 'unreadable', why: '读上一份请求在不在失败：EIO' },
      }),
    );
    const line = await screen.findByText(/上一次的结果没查成/);
    expect(line.textContent).toContain('EIO');
  });
});
