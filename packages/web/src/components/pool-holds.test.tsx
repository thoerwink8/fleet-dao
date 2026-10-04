// @vitest-environment happy-dom
// 设置页「整池暂停」（#746）：新建要四项齐、撤回续期要写原因（不写不发请求）、到期标红、认不出的明说、旧提醒提示迁成开关。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { PoolHolds } from '../api/types';
import { renderApp } from '../test/harness';
import { PoolHoldsPanel } from './pool-holds';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

const NOW = Date.parse('2026-10-05T04:00:00Z'); // 北京时间 2026-10-05 12:00
const hold = (over: Record<string, unknown> = {}) => ({
  reason: '创始人要大用独享',
  decidedBy: '「法国暂时不用独享号」2026-09-27',
  revokeWhen: '创始人说可以用了',
  reviewBy: '2026-10-30',
  ...over,
});
const api = () => createMockApi({ live: false, now: () => NOW });
const seed = async (a: MockApi, value: unknown) => {
  await a.updateSetting('engine.poolHolds', { value, version: 0 });
};
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('新建', () => {
  test('四项齐了才能存：存下来的请求带版本号 0、没有 reason；成功后列表里有这一条', async () => {
    const a = api();
    const update = vi.spyOn(a, 'updateSetting');
    renderApp(<PoolHoldsPanel />, { api: a });
    await screen.findByText('现在没有整池暂停。');
    const submit = screen.getByRole('button', { name: '暂停这个池' });
    expect(submit).toHaveProperty('disabled', true);
    await waitFor(() => expect(screen.getByRole('option', { name: /claude-a/ })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('哪个账号池'), { target: { value: 'claude-a' } });
    fill('为什么停', '创始人要大用独享');
    fill('谁拍的（原话加日期，例如「某某原话」2026-10-05）', '「先停」2026-10-05');
    fill('什么条件下撤', '创始人说可以用了');
    expect(submit).toHaveProperty('disabled', true); // 还差复查日期
    fill('最迟复查日期（北京时间）', '2026-10-30');
    expect(submit).toHaveProperty('disabled', false);
    fireEvent.click(submit);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(update).toHaveBeenCalledExactlyOnceWith('engine.poolHolds', {
      value: {
        'claude-a': {
          reason: '创始人要大用独享',
          decidedBy: '「先停」2026-10-05',
          revokeWhen: '创始人说可以用了',
          reviewBy: '2026-10-30',
        },
      },
      version: 0,
    });
    await screen.findByTestId('hold-claude-a');
  });

  test('【故意造出的失败】日期没填或不是日期：存不了，说是哪一项（日历上没有的日子由 lib 的 draftProblem 测）', async () => {
    const a = api();
    const update = vi.spyOn(a, 'updateSetting');
    renderApp(<PoolHoldsPanel />, { api: a });
    await screen.findByText('现在没有整池暂停。');
    await waitFor(() => expect(screen.getByRole('option', { name: /claude-a/ })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('哪个账号池'), { target: { value: 'claude-a' } });
    fill('为什么停', '原因');
    fill('谁拍的（原话加日期，例如「某某原话」2026-10-05）', '原话 2026-10-05');
    fill('什么条件下撤', '条件');
    fill('最迟复查日期（北京时间）', '明天');
    expect(screen.getByText(/最迟复查日期：日期格式是 YYYY-MM-DD/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '暂停这个池' })).toHaveProperty('disabled', true);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('撤回、续期要写原因', () => {
  test('【故意造出的失败】不写原因：确认点不了、不发请求；写了原因才发，请求带 reason，设置里去掉这个池', async () => {
    const a = api();
    await seed(a, { 'claude-a': hold(), relay: hold() });
    const update = vi.spyOn(a, 'updateSetting');
    renderApp(<PoolHoldsPanel />, { api: a });
    const row = await screen.findByTestId('hold-claude-a');
    fireEvent.click(within(row).getByRole('button', { name: '撤回' }));
    const confirm = within(row).getByRole('button', { name: '确认撤回' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.click(confirm);
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(within(row).getByLabelText(/撤回原因/), { target: { value: '创始人说独享正常跑' } });
    fireEvent.click(within(row).getByRole('button', { name: '确认撤回' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(update).toHaveBeenCalledExactlyOnceWith('engine.poolHolds', {
      value: { relay: hold() },
      version: 1,
      reason: '创始人说独享正常跑',
    });
    await waitFor(() => expect(screen.queryByTestId('hold-claude-a')).toBeNull());
    expect(screen.getByTestId('hold-relay')).toBeTruthy();
  });

  test('续期：改复查日期要写原因，请求里只有这个池的复查日期变了', async () => {
    const a = api();
    await seed(a, { 'claude-a': hold({ reviewBy: '2026-10-01' }) });
    const update = vi.spyOn(a, 'updateSetting');
    renderApp(<PoolHoldsPanel />, { api: a });
    const row = await screen.findByTestId('hold-claude-a');
    fireEvent.click(within(row).getByRole('button', { name: '续期' }));
    fireEvent.change(within(row).getByLabelText('新的最迟复查日期'), { target: { value: '2026-11-30' } });
    fireEvent.change(within(row).getByLabelText(/续期原因/), { target: { value: '独享还要留给本机' } });
    fireEvent.click(within(row).getByRole('button', { name: '确认续期' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(update).toHaveBeenCalledExactlyOnceWith('engine.poolHolds', {
      value: { 'claude-a': hold({ reviewBy: '2026-11-30' }) },
      version: 1,
      reason: '独享还要留给本机',
    });
  });

  test('【故意造出的失败】后端说要原因（400 reason_required）：把后端的话弹出来，不冒充成功', async () => {
    const a = api();
    await seed(a, { 'claude-a': hold() });
    vi.spyOn(a, 'updateSetting').mockRejectedValueOnce(
      new ApiError(400, 'reason_required', '撤回或改 claude-a 的暂停要写原因'),
    );
    renderApp(<PoolHoldsPanel />, { api: a });
    const row = await screen.findByTestId('hold-claude-a');
    fireEvent.click(within(row).getByRole('button', { name: '撤回' }));
    fireEvent.change(within(row).getByLabelText(/撤回原因/), { target: { value: '试' } });
    fireEvent.click(within(row).getByRole('button', { name: '确认撤回' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没保存上', {
        description: '撤回或改 claude-a 的暂停要写原因',
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('到期标红、认不出明说、旧提醒提示迁成开关', () => {
  test('【故意造出的失败】过了复查日期：标红写「已过复查日期 N 天」、当天写「今天要复查」；还在名单里（不自动撤）', async () => {
    const a = api();
    await seed(a, {
      'claude-a': hold({ reviewBy: '2026-10-01' }),
      relay: hold({ reviewBy: '2026-10-05' }),
      'cursor-pro': hold(),
    });
    renderApp(<PoolHoldsPanel />, { api: a });
    const late = await screen.findByTestId('hold-claude-a');
    expect(within(late).getByRole('alert').textContent).toBe('已过复查日期 4 天');
    expect(within(screen.getByTestId('hold-relay')).getByRole('alert').textContent).toBe('今天要复查');
    expect(within(screen.getByTestId('hold-cursor-pro')).queryByRole('alert')).toBeNull();
    expect(screen.getByText('要人看')).toBeTruthy();
  });

  test('【故意造出的失败】设置里某一项认不出：明说按暂停办；新建被挡住；撤掉认不出的要写原因', async () => {
    const a = api();
    const view: PoolHolds = {
      holds: [],
      problems: [
        {
          poolId: 'claude-a',
          why: '设置 engine.poolHolds 里 claude-a 的暂停认不出（reviewBy：日历上没有这一天），这个池照样按暂停办',
        },
      ],
      holdAll: false,
      legacy: [],
      version: 2,
      today: '2026-10-05',
      asOf: '2026-10-05T04:00:00.000Z',
    };
    vi.spyOn(a, 'poolHolds').mockResolvedValue(view);
    renderApp(<PoolHoldsPanel />, { api: a });
    await screen.findByText(/这个池照样按暂停办/);
    expect(screen.getByRole('button', { name: '暂停这个池' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '撤掉认不出的这几项' }));
    expect(screen.getByRole('button', { name: '确认撤掉' })).toHaveProperty('disabled', true);
  });

  test('【故意造出的失败】整份认不出：写明所有池按暂停办，只给「整份清空」（要原因）', async () => {
    const a = api();
    vi.spyOn(a, 'poolHolds').mockResolvedValue({
      holds: [],
      problems: [
        { poolId: null, why: '设置 engine.poolHolds 的值不是 {池编号: …}："停"，所有账号池按暂停办' },
      ],
      holdAll: true,
      legacy: [],
      version: 3,
      today: '2026-10-05',
      asOf: '2026-10-05T04:00:00.000Z',
    });
    renderApp(<PoolHoldsPanel />, { api: a });
    await screen.findByText(/所有账号池按暂停办/);
    fireEvent.click(screen.getByRole('button', { name: '整份清空' }));
    expect(screen.getByRole('button', { name: '确认清空' })).toHaveProperty('disabled', true);
  });

  test('旧的 pool-hold 提醒：写「请迁成开关」，点「迁成开关」把池和原因带进新建表单；已有开关的那个池只说多余', async () => {
    const a = api();
    vi.spyOn(a, 'poolHolds').mockResolvedValue({
      holds: [],
      problems: [],
      holdAll: false,
      legacy: [
        {
          poolId: 'claude-a',
          title: '账号池 claude-a 整池暂停：登录失效',
          since: '2026-10-01T00:00:00.000Z',
          alsoSwitched: false,
        },
        {
          poolId: 'relay',
          title: '账号池 relay 整池暂停：欠费',
          since: '2026-10-01T00:00:00.000Z',
          alsoSwitched: true,
        },
      ],
      version: 0,
      today: '2026-10-05',
      asOf: '2026-10-05T04:00:00.000Z',
    });
    renderApp(<PoolHoldsPanel />, { api: a });
    const box = await screen.findByTestId('pool-holds-legacy');
    expect(box.textContent).toContain('请迁成开关');
    expect(box.textContent).toContain('已经有开关了，这条提醒多余');
    await waitFor(() => expect(screen.getByRole('option', { name: /claude-a/ })).toBeTruthy());
    fireEvent.click(within(box).getByRole('button', { name: '迁成开关' }));
    expect((screen.getByLabelText('哪个账号池') as HTMLSelectElement).value).toBe('claude-a');
    expect((screen.getByLabelText('为什么停') as HTMLInputElement).value).toBe('登录失效');
  });

  test('【故意造出的失败】旧提醒没读成：明说没读成，不冒充没有', async () => {
    const a = api();
    vi.spyOn(a, 'poolHolds').mockResolvedValue({
      holds: [],
      problems: [],
      holdAll: false,
      legacy: [],
      legacyProblem: '读没处理的提醒没成：库连不上',
      version: 0,
      today: '2026-10-05',
      asOf: '2026-10-05T04:00:00.000Z',
    });
    renderApp(<PoolHoldsPanel />, { api: a });
    await screen.findByText(/没读成旧的 pool-hold 提醒：读没处理的提醒没成：库连不上/);
  });
});
