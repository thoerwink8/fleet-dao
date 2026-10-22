// @vitest-environment happy-dom
// 法国总览页（#618 第 1 版，#3533 照 Arco 改版）：运行概况（两个指标 + 描述列表）、引擎、版本、机器表、更多。
// 做完的标准：① 每一项读不到就写「没读到 + 原因」，不拿 0 或假 ok 顶；② 故意造一项失败，那一项写没读到，别的项照常；
// ③ 定时任务的入口带标签：有失败标红、没查全标橙（判法照 schedules 页）；④ 一台只画本台一行，多台时远程环境各一行，点箭头看快照。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs, Setting } from '../api/types';
import France from '../routes/france';
import { renderApp } from '../test/harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function envData(overrides: Partial<EnvResponse['facts']> = {}): EnvResponse {
  return {
    name: { name: '法国' },
    asOf: '2026-10-05T02:00:00.000Z',
    facts: {
      engine: {
        ok: true,
        value: { state: 'on', detail: '探到了在拉活的工人' },
      },
      master: {
        ok: true,
        value: {
          on: true,
          why: 'set',
          by: 'user:frank',
          at: '2026-10-05T01:00:00.000Z',
          detail: '开着：引擎在接活',
        },
      },
      version: {
        ok: true,
        value: {
          current: 'abcdef1234567890',
          behind: 3,
          detail: '在用 abcdef123456，落后主线 3 个提交',
          problems: [],
        },
      },
      sessions: {
        ok: true,
        value: { total: 2, byStage: { execute: 1, verify: 1 } },
      },
      pools: { ok: true, value: { count: 3, running: 1, unread: 0, stale: 1 } },
      health: {
        ok: true,
        value: { ok: true, total: 9, failing: [], notWired: ['deploy_lag'] },
      },
      schedule: {
        ok: true,
        value: {
          status: 'fresh',
          lastSuccessAt: '2026-10-05T01:55:00.000Z',
          outcome: 'ok',
          scanned: 4,
        },
      },
      ...overrides,
    },
  };
}

function jobsData(overrides: Partial<Jobs['jobs'][number]>[] = []): Jobs {
  const base: Jobs['jobs'][number] = {
    id: 'quota',
    name: '额度读取',
    schedule: '*/5 * * * *',
    expectEveryMinutes: 10,
    status: 'fresh',
    lastSuccessAt: '2026-10-05T01:58:00.000Z',
    lastRun: {
      startedAt: '2026-10-05T01:58:00.000Z',
      endedAt: '2026-10-05T01:58:10.000Z',
      outcome: 'ok',
      scanned: 12,
    },
  };
  return {
    asOf: '2026-10-05T02:00:00.000Z',
    jobs:
      overrides.length === 0
        ? [base]
        : overrides.map((o, i) => ({
            ...base,
            id: `job-${i}`,
            name: `任务-${i}`,
            ...o,
          })),
  };
}

function apiWith(envD: EnvResponse, jobsD?: Jobs | { error: Error }): MockApi {
  const inner = createMockApi({ live: false });
  return {
    ...inner,
    env: () => Promise.resolve(envD),
    // 这些用例看的是只有一台：不画远程行。两台的在下面另写。
    nodes: async () => ({ ...(await inner.nodes()), nodes: [] }),
    jobs:
      jobsD && 'error' in jobsD
        ? () => Promise.reject(jobsD.error)
        : () => Promise.resolve(jobsD ?? jobsData()),
  } as MockApi;
}

function renderFrance(envD: EnvResponse, jobsD?: Jobs | { error: Error }) {
  return renderApp(<France />, {
    api: apiWith(envD, jobsD) as unknown as FleetApi,
    route: '/france',
  });
}

/** 描述列表里一项：找到它的标签，取同一行的值。 */
function factValue(label: string): HTMLElement {
  const dt = screen.getAllByText(label).find((el) => el.tagName === 'DT');
  const dd = dt?.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`「${label}」后面没有值`);
  return dd;
}

/** 指标：标签文字在指标的第一行（描述列表里还有同名的标签，所以按指标容器找）。 */
const stat = (label: string) => {
  const el = Array.from(document.querySelectorAll<HTMLElement>('[data-stat]')).find((s) =>
    s.textContent?.startsWith(label),
  );
  if (!el) throw new Error(`找不到指标「${label}」`);
  return within(el);
};

describe('法国总览页：运行概况', () => {
  test('两个指标 + 描述列表都在：引擎运行中、会话 2 个、池 3 块、健康没红的、最近拉单；定时任务在「更多」里', async () => {
    renderFrance(envData(), jobsData());
    expect(await screen.findByRole('heading', { name: '运行概况' })).toBeTruthy();
    expect((await screen.findAllByText('在跑的会话')).length).toBeGreaterThanOrEqual(1);
    expect(stat('在跑的会话').getByText('2')).toBeTruthy();
    expect(stat('健康检查').getByText('9')).toBeTruthy();
    expect(stat('健康检查').getByText('项通过')).toBeTruthy();
    expect(within(factValue('引擎进程')).getByText('运行中')).toBeTruthy();
    expect(factValue('在跑的会话').textContent).toContain('2 个');
    expect(factValue('池占用').textContent).toContain('3 块');
    expect(factValue('健康').textContent).toContain('没红的');
    expect(factValue('最近拉单').textContent).toContain('按期');
    // 「更多」里的定时任务入口
    const entry = (await screen.findByRole('link', { name: /定时任务/ })) as HTMLAnchorElement;
    expect(entry.getAttribute('href')).toBe('/schedules');
    expect(entry.textContent).toContain('共 1 项');
  });

  test('故意造版本一项读不到：版本卡写「没读到 + 原因」，别的项照常显示数，不拿 0 冒充', async () => {
    renderFrance(
      envData({
        version: { ok: false, reason: '假后端没有发布目录，读不到在用版本' },
      }),
      jobsData(),
    );
    expect(await screen.findByText('假后端没有发布目录，读不到在用版本')).toBeTruthy();
    // 版本卡里那一项的「没读到」
    const version = screen.getByRole('heading', { name: '版本' }).closest('section') as HTMLElement;
    expect(within(version).getAllByText('没读到').length).toBeGreaterThanOrEqual(1);
    // 别的项不受影响
    expect(within(factValue('引擎进程')).getByText('运行中')).toBeTruthy();
    expect(factValue('健康').textContent).toContain('没红的');
  });

  test('引擎按配置没开用灰点、不是红；真 down 才红', async () => {
    renderFrance(
      envData({
        engine: {
          ok: true,
          value: { state: 'off', detail: '按 FLEET_SERVICES 没开' },
        },
      }),
      jobsData(),
    );
    const off = (await within(await waitForValue('引擎进程')).findByText('按配置没开')).closest(
      '[data-level]',
    ) as HTMLElement;
    expect(off.dataset.level).toBe('default');
    cleanup();
    renderFrance(
      envData({
        engine: {
          ok: true,
          value: { state: 'down', detail: '探不到在线的工人' },
        },
      }),
      jobsData(),
    );
    const down = (await within(await waitForValue('引擎进程')).findByText('没连上')).closest(
      '[data-level]',
    ) as HTMLElement;
    expect(down.dataset.level).toBe('error');
  });

  test('定时任务里有一个失败的：「更多」里的入口带红标签「失败 1」，概况提示条也写出来', async () => {
    renderFrance(
      envData(),
      jobsData([
        {
          id: 'patrol',
          name: '巡检',
          lastRun: {
            startedAt: '2026-10-05T01:40:00.000Z',
            endedAt: '2026-10-05T01:41:00.000Z',
            outcome: 'failed',
          },
          lastSuccessAt: '2026-10-05T00:40:00.000Z',
          status: 'fresh',
        },
      ]),
    );
    const entry = await screen.findByRole('link', { name: /定时任务/ });
    await waitFor(() => expect(within(entry).getByText('失败 1')).toBeTruthy());
    expect(within(entry).getByText('失败 1').closest('[data-look]')?.getAttribute('data-look')).toBe('error');
    const verdict = await waitFor(() => {
      const el = document.querySelector('[data-france-verdict]');
      if (!el) throw new Error('还没有提示条');
      return el;
    });
    expect(verdict.textContent).toContain('定时任务失败 1 个');
  });

  test('定时任务没查全或过期：入口带橙标签，不写失败', async () => {
    renderFrance(envData(), jobsData([{ status: 'overdue' }]));
    const entry = await screen.findByRole('link', { name: /定时任务/ });
    await waitFor(() => expect(within(entry).getByText('没查全或过期 1')).toBeTruthy());
    expect(within(entry).getByText('没查全或过期 1').closest('[data-look]')?.getAttribute('data-look')).toBe(
      'warning',
    );
    expect(within(entry).queryByText(/失败/)).toBeNull();
  });

  test('故意造定时任务接口读不到：入口写「没读到 + 原因」，不拿 0 冒充「没有失败」；概况照常显示', async () => {
    renderFrance(envData(), {
      error: new Error('拉 /api/jobs 没成（测试故意造的）'),
    });
    const entry = await screen.findByRole('link', { name: /定时任务/ });
    await waitFor(() => expect(entry.textContent).toContain('没读到：拉 /api/jobs 没成（测试故意造的）'));
    expect(entry.textContent).not.toContain('失败');
    expect(within(factValue('引擎进程')).getByText('运行中')).toBeTruthy();
    expect(factValue('健康').textContent).toContain('没红的');
  });

  test('一项一项如实读：会话那项没读到写原因、不拿 0 顶；池给数；健康红了就写红', async () => {
    renderFrance(
      envData({
        sessions: { ok: false, reason: '读在跑的会话没成：库连不上（测试故意造的）' },
        health: { ok: true, value: { ok: false, total: 9, failing: ['temporal', 'engine'], notWired: [] } },
      }),
      jobsData(),
    );
    expect(await screen.findByText(/读在跑的会话没成：库连不上（测试故意造的）/)).toBeTruthy();
    expect(stat('在跑的会话').getByText('没读到')).toBeTruthy();
    expect(within(factValue('在跑的会话')).getByText('没读到')).toBeTruthy();
    expect(factValue('池占用').textContent).toContain('3 块');
    expect(stat('健康检查').getByText('2')).toBeTruthy();
    expect(stat('健康检查').getByText('项红')).toBeTruthy();
    expect(factValue('健康').textContent).toContain('红：temporal、engine');
  });
});

/** 描述列表要等数据回来才有：等到有那一项再取。 */
async function waitForValue(label: string): Promise<HTMLElement> {
  await screen.findAllByText(label);
  return factValue(label);
}

describe('概况提示条（本台现在最该看的一件事）', () => {
  const verdict = () => document.querySelector('[data-france-verdict]') as HTMLElement | null;

  test('落后主线：橙提示条写落后几个提交', async () => {
    renderFrance(envData(), jobsData());
    await waitFor(() => expect(verdict()?.textContent).toMatch(/落后主线 \d+ 个提交/));
    expect(verdict()?.querySelector('[data-look]')?.getAttribute('data-look')).toBe('warning');
    // 名字不是标题元素：页标题「法国」只有一个
    expect(screen.getAllByRole('heading', { name: '法国' })).toHaveLength(1);
  });

  test('【故意造出的失败】健康两项红：提示条红底，写健康几项红、哪几项，其余几件跟在后面', async () => {
    renderFrance(
      envData({
        health: { ok: true, value: { ok: false, total: 9, failing: ['routes', 'quota'], notWired: [] } },
        sessions: { ok: false, reason: '库连不上（测试故意造的）' },
      }),
      jobsData(),
    );
    await waitFor(() => expect(verdict()?.textContent).toContain('健康 2 项红：routes、quota'));
    expect(verdict()?.querySelector('[data-look]')?.getAttribute('data-look')).toBe('error');
    expect(verdict()?.textContent).toContain('1 项没读到');
  });

  test('一切正常（版本一样、健康没红、没有没读到的）：不画提示条', async () => {
    renderFrance(
      envData({
        version: {
          ok: true,
          value: { current: 'abcdef1234567890', behind: 0, detail: '在用', problems: [] },
        },
      }),
      jobsData(),
    );
    await waitForValue('引擎进程');
    // 发版卡（mock）也说没落后之前，env 这边的 behind 是 0
    await waitFor(() => expect(screen.queryByText(/落后主线 3 个提交/)).toBeNull());
  });
});

describe('机器表：一台只有本台一行，多台时远程环境各一行', () => {
  const rows = () => Array.from(document.querySelectorAll('[data-machines] tr[data-row-key]'));

  test('只有一台：表里只有本台一行，没有展开箭头；总开关、版本、更多都在这一页', async () => {
    renderFrance(envData(), jobsData());
    expect(await screen.findByRole('heading', { name: '法国' })).toBeTruthy();
    expect(screen.getByTestId('engine-master')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '版本' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '更多' })).toBeTruthy();
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-row-key'))).toEqual(['local']));
    const machines = document.querySelector('[data-machines]') as HTMLElement;
    expect(within(machines).getByText('就是这台，写操作在这里做', { exact: false })).toBeTruthy();
    expect(machines.querySelector('button[aria-label="展开"]')).toBeNull();
  });

  function twoNodes(over: { node?: MockApi['node'] } = {}) {
    const inner = createMockApi({ live: false });
    return {
      ...inner,
      env: () => Promise.resolve(envData()),
      nodes: async () => ({
        ...(await inner.nodes()),
        nodes: [
          {
            id: 'wsl',
            name: '本机 WSL',
            freshness: 'fresh' as const,
            receivedAt: new Date().toISOString(),
            reportedAt: new Date().toISOString(),
          },
        ],
      }),
      jobs: () => Promise.resolve(jobsData()),
      ...over,
    } as MockApi;
  }

  test('两台时：本台一行、本机 WSL 一行；点箭头才展开那一台的快照，六项都在', async () => {
    renderApp(<France />, { api: twoNodes() as unknown as FleetApi, route: '/france' });
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-row-key'))).toEqual(['local', 'wsl']));
    const wsl = rows()[1] as HTMLElement;
    expect(within(wsl).getByText('在线')).toBeTruthy();
    expect(within(wsl).getByText('远程')).toBeTruthy();
    expect(document.querySelector('[data-detail-for]')).toBeNull();
    fireEvent.click(within(wsl).getByRole('button', { name: '展开' }));
    const detail = (await waitFor(() => {
      const el = document.querySelector('[data-detail-for="wsl"]');
      if (!el) throw new Error('还没展开');
      return el;
    })) as HTMLElement;
    for (const label of ['引擎进程', '在跑的会话', '池占用', '健康', '在用版本', '最近拉单']) {
      await waitFor(() => expect(within(detail).getByText(label)).toBeTruthy());
    }
    fireEvent.click(within(wsl).getByRole('button', { name: '收起' }));
    await waitFor(() => expect(document.querySelector('[data-detail-for]')).toBeNull());
  });

  test('【故意造出的失败】两台时远程快照没读成：展开写原因、不画空格子，本台概况照常', async () => {
    const api = twoNodes({
      node: async () => {
        throw new Error('快照读不了（测试故意造的）');
      },
    });
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: '展开' }));
    expect(await screen.findByText(/快照读不了（测试故意造的）/)).toBeTruthy();
    expect(document.querySelector('[data-detail-for="wsl"] dl')).toBeNull();
    expect(within(factValue('引擎进程')).getByText('运行中')).toBeTruthy();
  });

  describe('失联与久没报的环境', () => {
    function remote(agoMs: number, opts: { route?: string } = {}) {
      const inner = createMockApi({ live: false });
      const t = Date.now();
      const at = new Date(t - agoMs).toISOString();
      const state = agoMs > 5 * 60_000 ? ('stale' as const) : ('fresh' as const);
      const snapFacts = envData({
        health: {
          ok: true,
          value: { ok: false, total: 9, failing: ['routes', 'deploy_lag'], notWired: [] },
        },
      }).facts;
      const api = {
        ...inner,
        env: () => Promise.resolve(envData()),
        nodes: async () => ({
          ...(await inner.nodes()),
          nodes: [{ id: 'wsl', name: '本机', freshness: state, receivedAt: at, reportedAt: at }],
        }),
        node: async () => {
          const detail = await inner.node('wsl');
          return {
            ...detail,
            id: 'wsl',
            name: '本机',
            freshness: state,
            receivedAt: at,
            reportedAt: at,
            env: { ...detail.env, name: { name: '本机' }, asOf: at, facts: snapFacts },
          };
        },
        jobs: () => Promise.resolve(jobsData()),
      } as unknown as MockApi;
      renderApp(<France />, { api: api as unknown as FleetApi, route: opts.route ?? '/france' });
    }
    const row = () => document.querySelector('[data-machines] tr[data-row-key="wsl"]') as HTMLElement;
    const detail = () => document.querySelector('[data-detail-for="wsl"]') as HTMLElement | null;

    test('失联（6 小时没报）：状态写失联，说明写失联多久；展开的快照整块灰字、不带状态色，并说明是旧数据', async () => {
      remote(6 * 60 * 60_000);
      await waitFor(() => expect(row()).toBeTruthy());
      expect(within(row()).getByText('失联')).toBeTruthy();
      expect(row().textContent).toContain('失联 6 小时');
      fireEvent.click(within(row()).getByRole('button', { name: '展开' }));
      await waitFor(() => expect(detail()?.textContent).toContain('失联，以下是旧数据'));
      // 旧的「运行中」「2 项红」不带状态色，不让它们看起来像现在的状态
      await waitFor(() => expect(within(detail() as HTMLElement).getByText('运行中')).toBeTruthy());
      expect(within(detail() as HTMLElement).getByText('2 项红')).toBeTruthy();
      expect(detail()?.querySelector('[data-status]')).toBeNull();
    });

    test('25 小时没报：仍在表里一行，说明写「1 天 1 小时前的旧数据」；点开才出旧快照，能再收起', async () => {
      remote(25 * 60 * 60_000);
      await waitFor(() => expect(row()).toBeTruthy());
      expect(within(row()).getByText('失联')).toBeTruthy();
      expect(row().textContent).toContain('1 天 1 小时前的旧数据');
      expect(detail()).toBeNull();
      fireEvent.click(within(row()).getByRole('button', { name: '展开' }));
      await waitFor(() => expect(detail()?.querySelector('dl')).toBeTruthy());
      expect(detail()?.textContent).toContain('失联，以下是旧数据');
      fireEvent.click(within(row()).getByRole('button', { name: '收起' }));
      await waitFor(() => expect(detail()).toBeNull());
    });

    test('选中的远程环境（?node=wsl）默认展开，即使 5 天没报也一样', async () => {
      remote(5 * 24 * 60 * 60_000, { route: '/france?node=wsl' });
      await waitFor(() => expect(detail()).toBeTruthy());
      expect(row().getAttribute('aria-current')).toBe('true');
      await waitFor(() => expect(detail()?.querySelector('dl')).toBeTruthy());
    });

    test('从没收到过快照的环境：状态写没数据，展开明说从没收到过，不画空格子', async () => {
      const inner = createMockApi({ live: false });
      const api = {
        ...inner,
        env: () => Promise.resolve(envData()),
        nodes: async () => ({
          ...(await inner.nodes()),
          nodes: [{ id: 'wsl', name: 'wsl', freshness: 'never' as const }],
        }),
        jobs: () => Promise.resolve(jobsData()),
      } as unknown as MockApi;
      renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
      await waitFor(() => expect(row()).toBeTruthy());
      expect(within(row()).getByText('没数据')).toBeTruthy();
      fireEvent.click(within(row()).getByRole('button', { name: '展开' }));
      await waitFor(() =>
        expect(detail()?.querySelector('[data-env-never]')?.textContent).toContain('从没收到过'),
      );
      expect(detail()?.querySelector('dl')).toBeNull();
    });
  });
});

describe('总开关和引擎进程是两件事', () => {
  test('总开关关、引擎在跑：引擎卡里写明不派活、进程还在；概况里「引擎进程」仍写运行中', async () => {
    const inner = apiWith(
      envData({
        engine: { ok: true, value: { state: 'on', detail: '探到了在拉活的工人' } },
        master: {
          ok: true,
          value: { on: false, why: 'set', detail: '关着：不拉单、不派活' },
        },
      }),
      jobsData(),
    );
    const off: Setting = {
      key: 'engine.master',
      value: false,
      version: 2,
      updatedAt: '2026-10-05T01:00:00.000Z',
      updatedBy: 'user:frank',
    };
    const api = {
      ...inner,
      settings: async () => {
        const base = await inner.settings();
        return { settings: [...base.settings.filter((s) => s.key !== 'engine.master'), off] };
      },
    } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const sentence = /总开关关着只是不派活，引擎进程还在跑/;
    const card = await screen.findByTestId('engine-master');
    expect(await within(card).findByText(sentence)).toBeTruthy();
    expect(within(await waitForValue('引擎进程')).getByText('运行中')).toBeTruthy();
    expect(screen.getAllByText(sentence)).toHaveLength(1);
  });
});
