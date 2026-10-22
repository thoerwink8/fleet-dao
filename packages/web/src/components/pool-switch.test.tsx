// @vitest-environment happy-dom
// 额度页每个池一行的停用开关：关必须写原因；复查日期可不填；封号只显示；读不到标没查成。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { SWITCH_DECIDED_BY, SWITCH_REVOKE_WHEN } from '../lib/pool-holds';
import QuotaPage from '../routes/quota';
import SettingsPage from '../routes/settings';
import { renderApp } from '../test/harness';

afterEach(cleanup);

const switchOf = (poolId: string) => screen.getByRole('switch', { name: `${poolId} 的开关` });

describe('额度页停用开关', () => {
  test('每个池一行有一个开关，默认开着', async () => {
    const api = createMockApi({ live: false });
    const { pools } = await api.pools();
    renderApp(<QuotaPage />, { api });
    await screen.findByRole('columnheader', { name: '启用' });
    await waitFor(() => expect(switchOf('claude-a').getAttribute('aria-checked')).toBe('true'));
    for (const p of pools) {
      const row = document.querySelector(`tr[data-row-key="${p.id}"]`) as HTMLElement;
      expect(within(row).getByRole('switch', { name: `${p.id} 的开关` })).toBeTruthy();
    }
  });

  test('【故意造出的失败】关开关没写原因：确认停用点不下去，不写设置', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<QuotaPage />, { api });
    const sw = await screen.findByRole('switch', { name: 'claude-a 的开关' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(sw);
    const confirm = await screen.findByRole('button', { name: '确认停用' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(confirm);
    expect(spy).not.toHaveBeenCalled();
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  test('写了原因、不填复查日期：存进 engine.poolHolds，没有 reviewBy', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<QuotaPage />, { api });
    const sw = await screen.findByRole('switch', { name: 'claude-a 的开关' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(sw);
    fireEvent.change(screen.getByLabelText('原因'), { target: { value: '被封号' } });
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toBe('engine.poolHolds');
    expect(spy.mock.calls[0]?.[1]).toEqual({
      value: {
        'claude-a': {
          reason: '被封号',
          decidedBy: SWITCH_DECIDED_BY,
          revokeWhen: SWITCH_REVOKE_WHEN,
        },
      },
      version: 0,
      reason: '被封号',
    });
    await waitFor(() => expect(switchOf('claude-a').getAttribute('aria-checked')).toBe('false'));
    expect(switchOf('claude-b').getAttribute('aria-checked')).toBe('true');
  });

  test('确认停用一个池时，别的池认不出的暂停原样写回', async () => {
    const api = createMockApi({ live: false });
    const bad = { reason: '被封号' };
    const real = api.poolHolds.bind(api);
    api.poolHolds = async () => {
      const v = await real();
      return {
        ...v,
        problems: [...v.problems, { poolId: 'claude-b', why: '缺 decidedBy，这个池照样按暂停办' }],
        opaque: { ...v.opaque, 'claude-b': bad },
      };
    };
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<QuotaPage />, { api });
    const sw = await screen.findByRole('switch', { name: 'claude-a 的开关' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    const other = switchOf('claude-b');
    expect(other.getAttribute('aria-checked')).toBe('false');
    expect(other.closest('tr')?.querySelector('[data-pool-flag="没查成"]')).toBeTruthy();
    fireEvent.click(sw);
    expect(await screen.findByText(/claude-b 的暂停认不出，这次会原样留着/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('原因'), { target: { value: '被封号' } });
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const body = spy.mock.calls[0]?.[1] as { value: Record<string, unknown> };
    expect(body.value['claude-b']).toEqual(bad);
    expect(body.value['claude-a']).toMatchObject({ reason: '被封号' });
  });

  test('填了复查日期就一起存', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<QuotaPage />, { api });
    const sw = await screen.findByRole('switch', { name: 'relay 的开关' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(sw);
    fireEvent.change(screen.getByLabelText('原因'), { target: { value: '先停' } });
    fireEvent.change(screen.getByLabelText('复查日期（可不填）'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = spy.mock.calls[0]?.[1] as { value: { relay: { reviewBy?: string } } };
    expect(body.value.relay.reviewBy).toBe('2026-12-01');
  });

  test('引擎探到登录失效：这一行写封号，开关仍开着，不自己改设置', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    const real = api.poolHolds.bind(api);
    api.poolHolds = async () => {
      const v = await real();
      return {
        ...v,
        legacy: [
          {
            poolId: 'claude-a',
            title: '账号池 claude-a 整池暂停：登录失效',
            since: '2026-10-01T00:00:00.000Z',
            alsoSwitched: false,
          },
        ],
      };
    };
    renderApp(<QuotaPage />, { api });
    const sw = await screen.findByRole('switch', { name: 'claude-a 的开关' });
    const row = sw.closest('tr') as HTMLElement;
    await waitFor(() => expect(row.querySelector('[data-pool-flag="封号"]')).toBeTruthy());
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(spy).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】暂停设置读不到：每一行写没查成，开关点不了', async () => {
    const api = createMockApi({ live: false });
    api.poolHolds = async () => {
      throw new Error('库连不上');
    };
    const { pools } = await api.pools();
    renderApp(<QuotaPage />, { api });
    await screen.findByRole('columnheader', { name: '启用' });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-pool-flag="没查成"]').length).toBe(pools.length),
    );
    for (const p of pools) {
      expect((switchOf(p.id) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('设置页不再有整池暂停', () => {
  test('旧入口删了', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByTestId('dispatch-r-orbit');
    expect(screen.queryByTestId('pool-holds')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('整池暂停');
  });
});
