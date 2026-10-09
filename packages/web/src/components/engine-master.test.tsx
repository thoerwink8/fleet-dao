// @vitest-environment happy-dom
// 设置页「仓库」一节开头：总开关读不到时，状态句不能叠成「总开关总开关」。
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from '../test/harness';

afterEach(cleanup);

describe('设置页仓库一节的总开关状态', () => {
  test('总开关读不到：状态是「总开关现在是开是关没查成」，不含「总开关总开关」', async () => {
    const api = createMockApi({ live: false });
    api.settings = async () => {
      throw new ApiError(500, 'internal', '库连不上（测试故意造的）');
    };
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    const note = await screen.findByTestId('engine-master-relation');
    await waitFor(() => expect(note.textContent).toContain('总开关现在是开是关没查成'));
    expect(note.textContent).not.toContain('总开关总开关');
  });
});
