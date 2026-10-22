// @vitest-environment happy-dom
// LoadError（#902 缺陷 D5）：读失败的那一块要写明没读成、原因，并给「重试」——点了把所有读失败的查询再读一遍，读好的不动。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LoadError, LoadingRows, LoadPartial, LoadStale } from './load-state';
import { Page } from './page';

afterEach(cleanup);

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls = { bad: 0, good: 0 };
  let healed = false;
  const bad = () =>
    qc.fetchQuery({
      queryKey: ['bad'],
      queryFn: async () => {
        calls.bad += 1;
        if (!healed) throw new Error('连不上后端');
        return 'ok';
      },
    });
  const good = () =>
    qc.fetchQuery({
      queryKey: ['good'],
      queryFn: async () => {
        calls.good += 1;
        return 'ok';
      },
    });
  return { qc, calls, bad, good, heal: () => (healed = true) };
}

describe('LoadError', () => {
  test('写明哪一块没读成和原因，并给「重试」按钮', () => {
    const { qc } = setup();
    render(
      <QueryClientProvider client={qc}>
        <LoadError what="额度" error={new Error('连不上后端')} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('alert').textContent).toContain('额度没读成：连不上后端');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  test('点「重试」：只重读失败的查询，读好的不动；后端好了以后数据回来', async () => {
    const { qc, calls, bad, good, heal } = setup();
    await good();
    await expect(bad()).rejects.toThrow('连不上后端');
    render(
      <QueryClientProvider client={qc}>
        <LoadError error={new Error('连不上后端')} />
      </QueryClientProvider>,
    );
    // 第一次点：后端还没好，照样失败（不报「成了」）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });
    await waitFor(() => expect(calls.bad).toBe(2));
    expect(qc.getQueryState(['bad'])?.status).toBe('error');
    // 后端好了再点：数据回来
    heal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });
    await waitFor(() => expect(qc.getQueryData(['bad'])).toBe('ok'));
    expect(calls.good).toBe(1);
  });
});

describe('五种样子（#3509）', () => {
  test('loading：骨架行和列表行一样高，不画 0', () => {
    render(<LoadingRows rows={3} />);
    const rows = document.querySelectorAll('[data-skeleton-row]');
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.className).toContain('h-row');
    expect(document.body.textContent).toBe('');
  });

  test('error 红、stale 橙：都带「重试」；stale 说明下面是上一次的数据，过期了直说', () => {
    const { qc } = setup();
    render(
      <QueryClientProvider client={qc}>
        <LoadError what="额度" error={new Error('超时')} />
        <LoadStale what="任务列表" when="5 分钟前" error={new Error('网关超时')} />
        <LoadStale expired error={new Error('网关超时')} />
      </QueryClientProvider>,
    );
    const [err, stale, expired] = screen.getAllByRole('alert');
    expect(err?.dataset.look).toBe('error');
    expect(stale?.dataset.look).toBe('warning');
    expect(stale?.textContent).toContain('任务列表刷新没成，下面是5 分钟前读到的：网关超时');
    expect(expired?.textContent).toContain('数据已过期');
    expect(screen.getAllByRole('button', { name: '重试' })).toHaveLength(3);
  });

  test('stale 直接收 viewOf 的 stale：时间自己算，过了 staleAfterMs 标已过期，重试走它自己的 retry', () => {
    const retry = vi.fn();
    const now = Date.parse('2026-10-21T10:00:00Z');
    const stale = { error: new Error('网关超时'), dataUpdatedAt: now - 3 * 60_000, retry };
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LoadStale stale={stale} now={now} />
        <LoadStale stale={stale} now={now} staleAfterMs={60_000} />
      </QueryClientProvider>,
    );
    const [fresh, expired] = screen.getAllByRole('alert');
    expect(fresh?.textContent).toContain('刷新没成，下面是3 分钟前读到的：网关超时');
    expect(expired?.textContent).toContain('数据已过期，下面是3 分钟前读到的');
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0] as HTMLElement);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('partial：橙提示写清缺了哪部分，不打断读屏', () => {
    render(<LoadPartial>「来自需求 N」没查成：需求库读超时</LoadPartial>);
    const el = screen.getByRole('status');
    expect(el.dataset.look).toBe('warning');
    expect(el.textContent).toContain('没查成');
  });
});

// #1588：1024 宽时页头 flex-wrap，标题块不能收缩，描述一长就把右侧操作区挤到下一行。
describe('Page 页头', () => {
  test('带操作和长描述时，lg（1024）及以上页头不换行，描述在标题块里折行；窄一点整排操作掉到标题下面（#1806）', () => {
    const { container } = render(
      <Page
        title="操作记录"
        description={`这段说明很长，长到在 1024 宽会把右侧刷新条挤到下一行。${'再长一点。'.repeat(40)}`}
        actions={<button type="button">刷新</button>}
      >
        正文
      </Page>,
    );
    const header = container.querySelector('header');
    expect(header).toBeTruthy();
    expect(header?.className).toContain('flex-wrap');
    expect(header?.className).toContain('lg:flex-nowrap');
    const titleBlock = screen.getByRole('heading', { level: 1 }).parentElement;
    expect(titleBlock).toBe(header?.firstElementChild);
    expect(titleBlock?.className).toContain('min-w-0');
    expect(titleBlock?.className).toContain('lg:flex-1');
    const actions = screen.getByRole('button', { name: '刷新' }).parentElement;
    expect(actions).toBeTruthy();
    expect(actions?.parentElement).toBe(header);
    expect(actions?.className).toContain('lg:shrink-0');
  });

  test('不带操作时不渲染操作区容器', () => {
    const { container } = render(
      <Page title="通知" description="一句说明">
        正文
      </Page>,
    );
    const header = container.querySelector('header');
    expect(header).toBeTruthy();
    expect(screen.getByRole('heading', { name: '通知' })).toBeTruthy();
    expect(header?.querySelector(':scope > div.flex')).toBeNull();
    expect(header?.children).toHaveLength(1);
  });
});
