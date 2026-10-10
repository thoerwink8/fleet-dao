// @vitest-environment happy-dom
// 设置页「账密登录」一节：第一次设、改、各种错落在哪一栏、改完怎么说。后端的规则（api/src/credentials.ts）由假后端照样做。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { Credentials } from '../api/types';
import { renderApp } from '../test/harness';
import { CredentialsSection } from './credentials-section';

afterEach(cleanup);

const GOOD = 'a-long-enough-pass';

function setup(over: Partial<FleetApi> = {}) {
  const api = createMockApi({ live: false });
  Object.assign(api, over);
  renderApp(<CredentialsSection />, { api });
  return api;
}

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const form = (name: string) => screen.getByRole('form', { name }) as HTMLFormElement;

describe('第一次设账密', () => {
  test('现状写「还没设过」；表单只有用户名、密码、再输一遍，没有「当前密码」', async () => {
    setup();
    expect(await screen.findByText(/还没设过账密/)).toBeTruthy();
    expect(screen.getByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.getByLabelText('再输一遍新密码')).toBeTruthy();
    expect(screen.queryByLabelText('当前密码')).toBeNull();
    // autocomplete：设新密码用 new-password，让密码管理器提示保存
    expect(screen.getByLabelText('密码').getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByLabelText('用户名').getAttribute('autocomplete')).toBe('username');
    // 只提示后端明说的最低长度
    expect(screen.getByText(/至少 10 位，别的不限/)).toBeTruthy();
  });

  test('填好提交：updateCredentials 收到用户名和密码（不带当前密码）；成功后现状变「已设」、说明别处登录作废、表单换成「改」', async () => {
    const api = setup();
    const spy = vi.spyOn(api, 'updateCredentials');
    await screen.findByText(/还没设过账密/);
    type('用户名', ' founder ');
    type('密码', GOOD);
    type('再输一遍新密码', GOOD);
    fireEvent.submit(form('设账密'));
    expect(await screen.findByText(/已设账密：用户名/)).toBeTruthy();
    expect(spy).toHaveBeenCalledExactlyOnceWith({ username: 'founder', newPassword: GOOD });
    expect(screen.getByRole('status').textContent).toContain('别处');
    expect(screen.getByRole('status').textContent).toContain('作废');
    // 换成改账密：要当前密码；密码没留在页面上
    expect(await screen.findByLabelText('当前密码')).toBeTruthy();
    expect(document.body.textContent).not.toContain(GOOD);
    // 操作记录里有这一条（假后端照真后端记）
    expect((await api.audit()).items[0]?.action).toBe('credentials.set');
  });

  test('【故意造出的失败】密码太短：当场提示最低长度，不发请求；两次不一样也不发', async () => {
    const api = setup();
    const spy = vi.spyOn(api, 'updateCredentials');
    await screen.findByText(/还没设过账密/);
    type('用户名', 'founder');
    type('密码', 'short');
    type('再输一遍新密码', 'short');
    fireEvent.submit(form('设账密'));
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent)).toContain('密码至少 10 位。');
    type('密码', GOOD);
    type('再输一遍新密码', `${GOOD}x`);
    fireEvent.submit(form('设账密'));
    expect(await screen.findByText('两次输入的新密码不一样。')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】没填用户名：提示第一次要同时设用户名，不发请求', async () => {
    const api = setup();
    const spy = vi.spyOn(api, 'updateCredentials');
    await screen.findByText(/还没设过账密/);
    type('密码', GOOD);
    type('再输一遍新密码', GOOD);
    fireEvent.submit(form('设账密'));
    expect(await screen.findByText('第一次设账密要同时设用户名。')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】后端说用户名格式不对（400 invalid_username，field=username）：话落在用户名那一栏', async () => {
    setup();
    await screen.findByText(/还没设过账密/);
    type('用户名', '!!');
    type('密码', GOOD);
    type('再输一遍新密码', GOOD);
    fireEvent.submit(form('设账密'));
    const err = await screen.findByText(/3–32 位，字母或数字开头，只能用/);
    expect(err.id).toBe('cred-username-error');
    expect(screen.getByLabelText('用户名').getAttribute('aria-invalid')).toBe('true');
  });

  test('【故意造出的失败】不是飞书登录后 10 分钟内（canSetWithoutCurrent=false）：先说清怎么办、提交按钮点不了', async () => {
    const credentials = (): Promise<Credentials> =>
      Promise.resolve({
        hasPassword: false,
        username: null,
        passwordChangedAt: null,
        canSetWithoutCurrent: false,
      });
    setup({ credentials });
    expect(await screen.findByText(/飞书登录后 10 分钟内设/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '设账密' })).toHaveProperty('disabled', true);
  });

  test('【故意造出的失败】后端拒了（403 recent_feishu_login_required）：整体错误原话显示，表单留着', async () => {
    const updateCredentials = () =>
      Promise.reject(
        new ApiError(403, 'recent_feishu_login_required', '第一次设密码要在飞书登录后 10 分钟内设'),
      );
    setup({ updateCredentials });
    await screen.findByText(/还没设过账密/);
    type('用户名', 'founder');
    type('密码', GOOD);
    type('再输一遍新密码', GOOD);
    fireEvent.submit(form('设账密'));
    expect((await screen.findAllByRole('alert')).some((a) => a.textContent?.includes('10 分钟内设'))).toBe(
      true,
    );
    expect(screen.getByLabelText('密码')).toBeTruthy();
  });
});

describe('改账密', () => {
  async function withPassword(over: Partial<FleetApi> = {}) {
    const api = createMockApi({ live: false });
    await api.updateCredentials({ username: 'founder', newPassword: GOOD });
    Object.assign(api, over);
    renderApp(<CredentialsSection />, { api });
    await screen.findByText(/已设账密：用户名/);
    return api;
  }

  test('现状写用户名和上次改密码的时间；表单有当前密码，用户名预填、新密码留空', async () => {
    await withPassword();
    expect(screen.getByText('founder')).toBeTruthy();
    expect(screen.getByText(/上次改密码/)).toBeTruthy();
    expect((screen.getByLabelText(/^用户名/) as HTMLInputElement).value).toBe('founder');
    expect(screen.getByLabelText('当前密码').getAttribute('autocomplete')).toBe('current-password');
    expect((screen.getByLabelText(/^新密码/) as HTMLInputElement).value).toBe('');
  });

  test('只改密码：updateCredentials 收到新密码和当前密码，不带没改的用户名；成功说别处登录作废', async () => {
    const api = await withPassword();
    const spy = vi.spyOn(api, 'updateCredentials');
    type('当前密码', GOOD);
    type(/^新密码/, 'another-long-pass');
    type('再输一遍新密码', 'another-long-pass');
    fireEvent.submit(form('改账密'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('作废'));
    expect(spy).toHaveBeenCalledExactlyOnceWith({ newPassword: 'another-long-pass', currentPassword: GOOD });
  });

  test('只改用户名：不带新密码，成功说密码没动、别处登录还在', async () => {
    const api = await withPassword();
    const spy = vi.spyOn(api, 'updateCredentials');
    type('当前密码', GOOD);
    type(/^用户名/, 'founder2');
    fireEvent.submit(form('改账密'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('founder2'));
    expect(screen.getByRole('status').textContent).toContain('别处的登录也还在');
    expect(spy).toHaveBeenCalledExactlyOnceWith({ username: 'founder2', currentPassword: GOOD });
  });

  test('【故意造出的失败】当前密码输错（401 bad_current_password）：话落在「当前密码」栏、栏清空、光标回去；不跳走', async () => {
    await withPassword();
    type('当前密码', 'definitely-wrong-1');
    type(/^新密码/, 'another-long-pass');
    type('再输一遍新密码', 'another-long-pass');
    fireEvent.submit(form('改账密'));
    const err = await screen.findByText('当前密码不对');
    expect(err.id).toBe('cred-current-error');
    expect((screen.getByLabelText('当前密码') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('当前密码')));
    // 没改成：现状还是原来的
    expect(screen.getByText(/已设账密：用户名/)).toBeTruthy();
  });

  test('【故意造出的失败】没填当前密码 / 什么都没改：当场提示，不发请求', async () => {
    const api = await withPassword();
    const spy = vi.spyOn(api, 'updateCredentials');
    fireEvent.submit(form('改账密'));
    expect(await screen.findByText('改之前要输入当前密码。')).toBeTruthy();
    type('当前密码', GOOD);
    fireEvent.submit(form('改账密'));
    expect(await screen.findByText('用户名和新密码都没有改动。')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】锁了（429）：整体错误说锁到几分钟后，不落在某一栏', async () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const updateCredentials = () => Promise.reject(new ApiError(429, 'locked', '锁了', { until }));
    await withPassword({ updateCredentials });
    type('当前密码', GOOD);
    type(/^新密码/, 'another-long-pass');
    type('再输一遍新密码', 'another-long-pass');
    fireEvent.submit(form('改账密'));
    const alert = await screen.findByText(/已临时锁住/);
    expect(alert.textContent).toMatch(/\d+ 分钟后/);
    expect(alert.id).not.toBe('cred-current-error');
  });

  test('【故意造出的失败】读不到后端：写没有保存，不假装成功', async () => {
    const updateCredentials = () => Promise.reject(new ApiError(0, 'network', '连不上后端：Failed to fetch'));
    await withPassword({ updateCredentials });
    type('当前密码', GOOD);
    type(/^新密码/, 'another-long-pass');
    type('再输一遍新密码', 'another-long-pass');
    fireEvent.submit(form('改账密'));
    expect((await screen.findByText(/没有保存/)).textContent).toContain('读不到后端');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

test('【故意造出的失败】读不到账密状态：写没读成和原因，带重试；不显示表单冒充「没设过」', async () => {
  const credentials = vi
    .fn<FleetApi['credentials']>()
    .mockRejectedValueOnce(new ApiError(500, 'credentials_missing', '读不到这个账号的登录信息'))
    .mockResolvedValue({
      hasPassword: false,
      username: null,
      passwordChangedAt: null,
      canSetWithoutCurrent: true,
    });
  setup({ credentials });
  expect((await screen.findByRole('alert')).textContent).toContain(
    '账密状态没读成：读不到这个账号的登录信息',
  );
  expect(screen.queryByRole('form', { name: '设账密' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('form', { name: '设账密' })).toBeTruthy();
});

describe('密码表单可访问性', () => {
  test('密码表单带用户名字段', async () => {
    setup();
    await screen.findByText(/还没设过账密/);
    const f = form('设账密');
    // 密码管理器要认的隐藏用户名：autocomplete=username，不挡看得见的那一栏。
    const hidden = f.querySelector(
      'input[autocomplete="username"][hidden], input[autocomplete="username"].sr-only',
    );
    expect(hidden).toBeTruthy();
    expect((hidden as HTMLInputElement).getAttribute('autocomplete')).toBe('username');
    expect(f.querySelector('input[type="password"], input[autocomplete="new-password"]')).toBeTruthy();
  });

  test('已设账密时密码表单仍带隐藏用户名字段', async () => {
    const api = createMockApi({ live: false });
    await api.updateCredentials({ username: 'founder', newPassword: GOOD });
    renderApp(<CredentialsSection />, { api });
    await screen.findByText(/已设账密：用户名/);
    const f = form('改账密');
    const hidden = f.querySelector(
      'input[autocomplete="username"][hidden], input[autocomplete="username"].sr-only',
    );
    expect(hidden).toBeTruthy();
    expect((hidden as HTMLInputElement).value).toBe('founder');
  });
});
