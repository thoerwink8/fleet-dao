// @vitest-environment happy-dom
// LoadError（#902 缺陷 D5）：读失败的那一块要写明没读成、原因，并给「重试」——点了把所有读失败的查询再读一遍，读好的不动。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { LoadError, Page } from './page';

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
