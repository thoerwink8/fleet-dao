// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { QuotaWindowView } from '../api/types';
import QuotaPage from '../routes/quota';
import { openSummary, renderApp, summaryCount } from '../test/harness';
import { amountPair, QuotaCell, QuotaDetail } from './quota';

afterEach(cleanup);

const NOW = Date.parse('2026-09-25T10:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

function cell(
  w: Omit<QuotaWindowView, 'stale' | 'label' | 'unit' | 'source'> &
    Partial<Pick<QuotaWindowView, 'stale' | 'label' | 'unit' | 'source'>>,
) {
  const full: QuotaWindowView = {
    stale: false,
    label: w.window,
    unit: 'percent',
    source: 'claude-usage',
    ...w,
  };
  const { container } = render(<QuotaCell w={full} now={NOW} />);
  return container.firstElementChild as HTMLElement;
}

describe('额度格', () => {
  test('快清零还剩不少：高亮并提示先用它', () => {
    const el = cell({
      window: '5h',
      utilization: 0.18,
      resetsAt: at(38),
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.dataset.hot).toBe('true');
    expect(screen.getByText(/先用它/)).toBeTruthy();
    expect(screen.getByText('38 分钟后')).toBeTruthy();
  });

  test('离清零还早就不高亮', () => {
    const el = cell({
      window: '5h',
      utilization: 0.18,
      resetsAt: at(240),
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.dataset.hot).toBeUndefined();
  });

  test('读数过期（后端判的 stale）就不喊「先用它」：旧数不能当现值', () => {
    const el = cell({
      window: '5h',
      utilization: 0.18,
      resetsAt: at(38),
      reading: 'measured',
      readAt: at(-42),
      stale: true,
    });
    expect(el.dataset.hot).toBeUndefined();
    expect(el.dataset.stale).toBe('true');
    // 页脚那一行「42 分钟前读」和过期说明各有一处「42 分钟前」，页脚那处标停滞色
    expect(screen.getAllByText('42 分钟前').some((n) => n.parentElement?.dataset.tone === 'stall')).toBe(
      true,
    );
    expect(el.querySelector('[data-stale-note]')).toBeTruthy();
  });

  test('用了九成以上：标「快用完」', () => {
    const el = cell({
      window: '7d',
      utilization: 0.93,
      resetsAt: at(3000),
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.dataset.full).toBe('true');
    expect(screen.getByText(/快用完了/)).toBeTruthy();
  });

  test('每个数都写明来源：估算的标「估算」，美元窗写金额', () => {
    cell({
      window: 'month_usd',
      unit: 'usd',
      used: 12.5,
      limit: 20,
      resetsAt: at(20_000),
      reading: 'estimated',
      readAt: at(-2),
    });
    expect(screen.getByText('估算')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
  });

  test('拼车 5 小时美元上限（#76）：写已用和上限的金额、清零时刻、实读，悬停看得到读法 reclaude-carpool', () => {
    cell({
      window: '5h',
      label: 'carpool_5h_usd',
      unit: 'usd',
      used: 3.2,
      limit: 10,
      utilization: 0.32,
      resetsAt: at(90),
      reading: 'measured',
      source: 'reclaude-carpool',
      readAt: at(-3),
    });
    expect(screen.getByText('$3.20')).toBeTruthy();
    expect(screen.getByText('/ $10.00', { exact: false })).toBeTruthy();
    expect(screen.getByText('1 小时 30 分后')).toBeTruthy();
    const badge = screen.getByText('实读').closest('[data-source]') as HTMLElement;
    expect(badge.dataset.source).toBe('reclaude-carpool');
    expect(badge.title).toContain('reclaude-carpool');
  });

  test('没读到清零时间就直说', () => {
    cell({ window: 'points', utilization: 0.4, reading: 'measured', readAt: at(-1) });
    expect(screen.getByText('清零时间没读到')).toBeTruthy();
  });

  test('已用和上限同单位同小数位', () => {
    // 各自 formatCount 会混成「8,623.515 / 50.0 万」；同一行必须都用万、同一位小数
    expect(amountPair({ unit: 'points' }, 8_623.515, 500_000)).toBe('0.9 万 / 50.0 万');
    expect(amountPair({ unit: 'tokens' }, 178_472, 272_000)).toBe('17.8 万 / 27.2 万');
    expect(amountPair({ unit: 'points' }, 178.472, 272_000)).toBe('0.0 万 / 27.2 万');
    const el = cell({
      window: 'points',
      unit: 'points',
      used: 8_623.515,
      limit: 500_000,
      utilization: 8_623.515 / 500_000,
      reading: 'measured',
      readAt: at(-1),
      source: 'mirasim-relay',
    });
    expect(el.textContent).toContain('0.9 万');
    expect(el.textContent).toContain('/ 50.0 万');
    expect(el.textContent).not.toContain('8,623');
  });

  test('估算窗口写「前算」，不写「前读」', () => {
    const el = cell({
      window: 'month_usd',
      unit: 'usd',
      used: 12.5,
      limit: 20,
      reading: 'estimated',
      readAt: at(-2),
    });
    expect(el.textContent).toContain('前算');
    expect(el.textContent).not.toContain('前读');
    expect(el.textContent).toContain('按本机用量估算');
  });

  test('实读窗口写「前读」', () => {
    const el = cell({
      window: '5h',
      utilization: 0.4,
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.textContent).toContain('前读');
  });
});

describe('额度页页签筛出的行', () => {
  const tabRows = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>('tbody tr[data-row-key]')];

  test('页签上的数就是筛出来的行数；该先用的行写着池名（悬停是全文）和窗口名', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByRole('tab', { name: /^该先用/ });
    const hot = openSummary('该先用');
    expect(tabRows(hot)).toHaveLength(summaryCount('该先用'));
    const name = within(hot).getByTitle('Claude 订阅 · claude-b');
    expect(name.textContent).toContain('claude-b');
    expect(within(name.closest('tr') as HTMLElement).getByText('5 小时窗')).toBeTruthy();
    expect(within(name.closest('tr') as HTMLElement).getByText('该先用')).toBeTruthy();
    const full = openSummary('快用完');
    expect(tabRows(full)).toHaveLength(summaryCount('快用完'));
    for (const row of tabRows(full)) {
      expect(row.querySelector('[data-quota-line][data-full]')).toBeTruthy();
    }
    const stale = openSummary('读数过期或没查成');
    expect(tabRows(stale)).toHaveLength(summaryCount('读数过期或没查成'));
    expect(summaryCount('全部')).toBe(tabRows(openSummary('全部')).length);
  });

  test('过期的行里，估算的窗口写「前算」，不写「前读」', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByRole('tab', { name: /^读数过期或没查成/ });
    const stale = openSummary('读数过期或没查成');
    expect(stale.textContent).toContain('前算');
    const estimated = tabRows(stale).filter((r) => r.textContent?.includes('前算'));
    expect(estimated.length).toBeGreaterThan(0);
    for (const row of estimated) {
      expect(row.textContent).toContain('前算');
      expect(row.textContent).not.toContain('前读');
    }
  });
});

describe('读数过期、凭据过期（#1748）', () => {
  test('过期的实读不显示成「实读」，不喊「快用完」、不画红', () => {
    const el = cell({ window: '5h', utilization: 0.98, reading: 'measured', readAt: at(-130), stale: true });
    expect(el.dataset.full).toBeUndefined();
    expect(el.textContent).not.toContain('快用完');
    expect(el.textContent).not.toContain('实读');
    expect(el.textContent).toContain('读数过期');
    expect(el.querySelector('[data-stale-note]')?.textContent).toContain('不是现值');
  });

  test('Grok 令牌过期：额度页写原因和要人做什么，旧的 98% 不进「快用完」', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByRole('tab', { name: /^读数过期或没查成/ });
    expect(summaryCount('快用完')).toBeGreaterThan(0);
    const full = openSummary('快用完');
    expect(full.textContent).not.toContain('supergrok');
    expect(full.textContent).not.toContain('Grok');
    const staleBox = openSummary('读数过期或没查成');
    const line = staleBox.querySelector('[data-pool-problem="unreadable"]');
    expect(line?.textContent).toContain('额度读不到');
    expect(line?.textContent).toContain('登录令牌已过期');
    expect(line?.textContent).toContain('先等 grok 下次运行自己续');
    expect(line?.textContent).not.toContain('不会自己好');
    // 同一个池的毛病只写一遍：写在池名下，不在它的每个过期窗口行上重复
    expect(staleBox.querySelectorAll('[data-pool-problem][data-pool="supergrok"]')).toHaveLength(1);
  });
});

describe('额度页金额和窄表', () => {
  test('周期美元金额完整显示，金额元素不带省略号截断', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    const used = await screen.findByText(/^\$61\.20 \/ \$100/);
    expect(used.textContent).toContain('61%');
    const cell = used.closest('[data-quota-line]');
    expect(cell).toBeTruthy();
    const badge = within(cell as HTMLElement).getByText('实读');
    expect(badge.closest('[data-source]')?.getAttribute('data-source')).toBe('relay-web');
    // 别的池：月度美元仍是金额；百分比窗不改成美元。
    const month = screen.getByText(/^\$12\.50 \/ \$20\.00/);
    // 这个池的读数过期了：不挂「估算」牌，换成「读数过期」（#1748）
    expect(within(month.closest('[data-quota-line]') as HTMLElement).getByText('读数过期')).toBeTruthy();
    expect(screen.getAllByText('18%').length).toBeGreaterThan(0);
  });

  test('账号池一个池一行，不出现横向滚动（390 宽手机上也一样）（#1805）', async () => {
    const api = createMockApi({ live: false });
    const { pools } = await api.pools();
    renderApp(<QuotaPage />, { api });
    await screen.findByRole('columnheader', { name: '启用' });
    const matrix = document.querySelector('[data-quota-matrix]') as HTMLElement;
    expect(matrix).toBeTruthy();
    // 每个池有一个开关那一行；窗口各一行，列多了只在表自己的盒子里滚，页面不横滚
    const firstRows = [...matrix.querySelectorAll<HTMLElement>('tbody tr[data-row-key]')].filter(
      (r) => !(r.dataset.rowKey ?? '').includes('#'),
    );
    expect(firstRows).toHaveLength(pools.length);
    expect(matrix.querySelectorAll('[data-quota-line]')).toHaveLength(
      pools.reduce((n, p) => n + p.windows.length, 0),
    );
    expect(screen.queryByText('向右滑动，看其余窗口')).toBeNull();
    expect(matrix.querySelector('[data-table-scroll]')).toBeTruthy();
    // 容器没有超出自己的宽度（happy-dom 不排版，两边都是 0；真宽度在点验里量）
    const table = matrix.querySelector('table') as HTMLElement;
    expect(table.scrollWidth).toBeLessThanOrEqual(table.clientWidth);
    expect(matrix.scrollWidth).toBeLessThanOrEqual(matrix.clientWidth);
  });

  test('一个窗口一行：用量格是一根进度条（竖线标按时间该用到哪）加来源牌，清零在自己的列，消耗进度展开才看', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    const used = await screen.findByText(/^\$61\.20 \/ \$100/);
    const line = used.closest('[data-quota-line]') as HTMLElement;
    expect(within(line).getByRole('progressbar')).toBeTruthy();
    expect(line.querySelector('[data-progress-mark]')).toBeTruthy();
    expect(within(line).getByText('实读')).toBeTruthy();
    const tr = line.closest('tr') as HTMLElement;
    const cells = tr.querySelectorAll('td');
    // 展开箭头、池、窗口、用量、清零、状态、启用
    expect(cells).toHaveLength(7);
    expect(cells[4]?.textContent).toMatch(/后$/);
    fireEvent.click(within(tr).getByRole('button', { name: '展开' }));
    expect(document.querySelector('[data-quota-pace]')?.textContent).toMatch(/^按时间该用 \d+%，实际 61%/);
  });
});

describe('消耗进度一行（#2363）', () => {
  function line(w: Partial<QuotaWindowView> & Pick<QuotaWindowView, 'window'>) {
    const full: QuotaWindowView = {
      stale: false,
      label: w.window,
      unit: 'percent',
      source: 'claude-usage',
      reading: 'measured',
      readAt: at(-4),
      ...w,
    };
    const { container } = render(<QuotaDetail w={full} now={NOW} />);
    return container.querySelector<HTMLElement>('[data-quota-pace]');
  }

  test('周窗：已用 75%、过了 62%，写「按时间该用 62%，实际 75%」并标黄', () => {
    const el = line({ window: '7d', utilization: 0.75, resetsAt: at(0.38 * 7 * 1440) });
    expect(el?.textContent).toBe('按时间该用 62%，实际 75%');
    expect(el?.dataset.behind).toBe('true');
  });

  test('Cursor 桶推不出窗口长度：按 30 天估并写明', () => {
    const el = line({
      window: 'other',
      label: 'auto_percent',
      scope: 'auto',
      utilization: 0.13,
      resetsAt: at(0.02 * 30 * 1440),
    });
    expect(el?.textContent).toBe('按时间该用 98%，实际 13%（按 30 天估）');
    expect(el?.dataset.behind).toBeUndefined();
  });

  test('额度页每个读到了用量和清零时刻的窗口，条上有竖线，展开就有这一行', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByText(/^\$61\.20 \/ \$100/);
    expect(document.querySelectorAll('[data-progress-mark]').length).toBeGreaterThan(0);
    for (const b of screen.getAllByRole('button', { name: '展开' })) fireEvent.click(b);
    expect(screen.getAllByText(/^按时间该用 \d+%，实际 \d+%/).length).toBeGreaterThan(0);
  });

  test('清零时间、用量没读到或读数过期：不写这一行（不拿 0 顶）', () => {
    expect(line({ window: '7d', utilization: 0.5 })).toBeNull();
    expect(line({ window: '7d', resetsAt: at(600) })).toBeNull();
    expect(line({ window: '7d', utilization: 0.5, resetsAt: at(600), stale: true })).toBeNull();
  });
});

describe('窗口格子小标题', () => {
  test('按模型组的周窗写出模型名，原名在悬停里', () => {
    const el = cell({
      window: '7d_model',
      scope: 'opus',
      utilization: 0.4,
      resetsAt: at(3000),
      reading: 'measured',
      readAt: at(-4),
    });
    const title = within(el).getByText('周窗 · 单模型 · opus');
    expect(title.textContent).toBe('周窗 · 单模型 · opus');
    expect(title.getAttribute('title')).toBe('上游原名：7d_model');
  });

  test('没有 scope 的普通窗口不渲染小标题', () => {
    const el = cell({
      window: '5h',
      utilization: 0.4,
      resetsAt: at(120),
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.querySelector('[title^="上游原名"]')).toBeNull();
    expect(el.textContent).not.toContain('5 小时窗');
  });
});

describe('额度页照路由页样板（#1921）', () => {
  test('顶上结论只有一句：现在先用哪个池的哪个窗，哪个快用完；页签上有过期或没查成的数', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    const line = (await screen.findByText(/^现在先用 Claude 订阅 · claude-b/)) as HTMLElement;
    const hero = line.closest('[data-quota-hero]') as HTMLElement;
    expect(hero).toBeTruthy();
    expect(hero.querySelector('[data-hero-line]')).toBe(line);
    expect(line.textContent).toContain('5 小时窗还剩 82%');
    expect(line.textContent).toContain('清零');
    expect(line.textContent).toContain('快用完，调度会先绕开');
    expect(summaryCount('读数过期或没查成')).toBeGreaterThan(0);
  });

  test('池行：在跑几个和到期并成一行灰字；池的毛病收成一行，整句在悬停里，状态格写额度读不到', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await waitFor(() =>
      expect(
        document.querySelector('[data-quota-matrix] tr[data-row-key="supergrok"] [data-pool-problem]'),
      ).toBeTruthy(),
    );
    const row = document.querySelector('[data-quota-matrix] tr[data-row-key="supergrok"]') as HTMLElement;
    const meta = row.querySelector('[data-pool-meta]') as HTMLElement;
    expect(meta.textContent).toMatch(/在跑 \d+\/\d+ · .*到期/);
    const problem = row.querySelector('[data-pool-problem]') as HTMLElement;
    expect(problem.dataset.oneLine).toBe('true');
    expect(problem.getAttribute('title')).toContain('要人做');
    const status = row.querySelector('[data-status="quota:quota:unreadable"]') as HTMLElement;
    expect(status.textContent).toBe('额度读不到');
    expect(status.getAttribute('title')).toContain('要人做');
  });

  test('该先用的行：用量条在，状态格写「该先用」，不再描粗框', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByRole('tab', { name: /^该先用/ });
    const hot = document.querySelector('[data-quota-line][data-hot]') as HTMLElement;
    expect(hot).toBeTruthy();
    expect(hot.querySelector('[role="progressbar"]')).toBeTruthy();
    expect(hot.closest('tr')?.querySelector('[data-status="quota:quota:use-first"]')).toBeTruthy();
  });
});

describe('额度页观感（#1898）', () => {
  /** 在假数据上加一个没有任何额度窗的池、一个上游新出的窗口，再按需带上切号现状和对账两项。 */
  function apiWith(extra: { orgSwitch?: boolean; reconcile?: boolean } = {}) {
    const api = createMockApi({ live: false });
    const readAt = new Date().toISOString();
    return {
      ...api,
      pools: async () => {
        const base = await api.pools();
        const first = base.pools[0] as (typeof base.pools)[number];
        const empty = { ...first, id: 'carpool-empty', windows: [], quotaStatus: 'fresh' as const };
        const other = (label: string, scope?: string): QuotaWindowView => ({
          window: 'other',
          label,
          ...(scope ? { scope } : {}),
          unit: 'percent',
          source: 'cursor-dashboard',
          stale: false,
          utilization: 0.12,
          resetsAt: at(600),
          reading: 'measured',
          readAt,
        });
        const cursor = {
          ...first,
          id: 'cursor-x',
          windows: [other('api_percent', 'api'), other('brand_new_key')],
        };
        return {
          ...base,
          pools: [...base.pools, empty, cursor],
          ...(extra.orgSwitch
            ? {
                orgSwitch: {
                  state: 'known' as const,
                  live: 'carpool' as const,
                  whites: 0,
                  soloPaused: false,
                  updatedAt: readAt,
                },
              }
            : {}),
          ...(extra.reconcile
            ? { carpoolReconcile: { state: 'unavailable' as const, why: '还没读到拼车窗口' } }
            : {}),
        };
      },
    };
  }

  const matrixRows = (poolId: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-quota-matrix] tbody tr[data-row-key]')].filter(
      (r) => r.dataset.rowKey === poolId || (r.dataset.rowKey ?? '').startsWith(`${poolId}#`),
    );

  test('没有任何额度窗的池只画一行：用量那格写「无额度窗」，没有进度条', async () => {
    renderApp(<QuotaPage />, { api: apiWith() });
    await waitFor(() => expect(matrixRows('carpool-empty')).toHaveLength(1));
    const row = matrixRows('carpool-empty')[0] as HTMLElement;
    expect(within(row).getByText('无额度窗').closest('[data-quota-empty]')).toBeTruthy();
    expect(row.querySelector('[role="progressbar"]')).toBeNull();
    expect(row.querySelector('[data-quota-line]')).toBeNull();
  });

  test('窗口名一律中文：api_percent 变「指定模型额度」，认不出的写「未命名窗口」，原键只在悬停和展开里', async () => {
    renderApp(<QuotaPage />, { api: apiWith() });
    await waitFor(() => expect(matrixRows('cursor-x')).toHaveLength(2));
    const rows = matrixRows('cursor-x');
    const text = rows.map((r) => r.textContent).join('|');
    expect(text).toContain('指定模型额度');
    const unnamed = within(rows[1] as HTMLElement).getByText('未命名窗口');
    expect(unnamed.getAttribute('title')).toBe('上游原名：brand_new_key');
    expect(text).not.toContain('api_percent');
    expect(text).not.toContain('brand_new_key');
    expect(document.body.textContent).not.toContain('api_percent');
  });

  test('页内顶部只剩一条提醒：切号现状和对账合在一起', async () => {
    renderApp(<QuotaPage />, { api: apiWith({ orgSwitch: true, reconcile: true }) });
    const notice = await screen.findByTestId('quota-notice');
    expect(notice.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(1);
    expect(notice.textContent).toContain('挂着拼车');
    expect(notice.textContent).toContain('额度对账看不到：还没读到拼车窗口');
    expect(screen.queryByTestId('org-switch')).toBeNull();
    expect(screen.queryByTestId('carpool-reconcile')).toBeNull();
  });

  test('图例收进表头的 ⓘ，表上面没有灰色图例；用量格不用整块红底', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByRole('columnheader', { name: /账号池/ });
    expect(screen.getByRole('button', { name: '实读和估算是什么意思' })).toBeTruthy();
    expect(screen.queryByText(/实读 = 从官方接口/)).toBeNull();
    const full = document.querySelector('[data-quota-line][data-full]') as HTMLElement;
    expect(full).toBeTruthy();
    expect(full.className).not.toContain('bg-st-fail-soft');
    expect(full.className).not.toContain('border-st-fail-line');
  });
});
