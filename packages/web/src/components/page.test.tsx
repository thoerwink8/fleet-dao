// @vitest-environment happy-dom
// LoadError（#902 缺陷 D5）：读失败的那一块要写明没读成、原因，并给「重试」——点了把所有读失败的查询再读一遍，读好的不动。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { LoadError } from './page';

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
