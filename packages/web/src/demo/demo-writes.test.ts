// @vitest-environment happy-dom
// 演示版游客的「写」：只在正式驾驶舱里有的写操作（发演示链接、作废、改默认范围、改思考档位）一律回「没开放」，
// 不去碰假数据；模块没开放时那个模块的写（改设置、处理通知）也一样挡掉。模块开了，写只改浏览器里这份假数据。
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('#brand', async () => await import('../brand/demo'));

import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { setDemoScopeForTest } from './access';
import { createDemoApi } from './api';
import type { DemoModule } from './scope';

afterEach(() => setDemoScopeForTest(null));

function scope(modules: DemoModule[]) {
  setDemoScopeForTest({ scope: { v: 1, modules, detail: 'process' }, source: 'link' });
}

const code = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
};

describe('演示版：只有正式驾驶舱才有的写，游客一律不行', () => {
  test('【故意造出的失败】把所有模块都开了也一样：发链接、作废、改默认范围、改思考档位、开关「让 AI 接活」都回 403 demo_hidden，假数据没动', async () => {
    scope(['board', 'task', 'quota', 'schedules', 'notifications', 'audit', 'settings']);
    const inner = createMockApi({ live: false });
    const api = createDemoApi(inner);
    const before = JSON.stringify((await inner.audit()).items);
    for (const call of [
      () => api.createDemoLink({ modules: ['board'], detail: 'status', expiresInDays: 7 }),
      () => api.revokeDemoLink('link-1'),
      () => api.updateDemoDefault({ modules: ['board'], detail: 'status' }),
      () => api.updateRouteEffort('opus-5.5', 'r-ca-opus', { effort: 'high', expected: null }),
      () => api.updateRepoDispatch('r-orbit', { on: false }),
    ]) {
      const err = await code(call());
      expect(err.status).toBe(403);
      expect(err.code).toBe('demo_hidden');
    }
    expect(JSON.stringify((await inner.audit()).items)).toBe(before);
  });
});

describe('演示版：模块没开放，那个模块的写也挡掉', () => {
  test('【故意造出的失败】没开设置：改设置回 demo_hidden，设置原样', async () => {
    scope(['board']);
    const inner = createMockApi({ live: false });
    const spy = vi.spyOn(inner, 'updateSetting');
    const err = await code(
      createDemoApi(inner).updateSetting('sessions.maxConcurrent', { value: 8, version: 0 }),
    );
    expect(err.code).toBe('demo_hidden');
    expect(spy).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】没开通知：处理通知回 demo_hidden，不去改假数据', async () => {
    scope(['board']);
    const inner = createMockApi({ live: false });
    const spy = vi.spyOn(inner, 'resolveNotification');
    const err = await code(createDemoApi(inner).resolveNotification('n-1'));
    expect(err.code).toBe('demo_hidden');
    expect(spy).not.toHaveBeenCalled();
  });

  test('开了设置：改设置转给假数据，别处看得到', async () => {
    scope(['settings']);
    const inner = createMockApi({ live: false });
    const api = createDemoApi(inner);
    const version =
      (await inner.settings()).settings.find((s) => s.key === 'sessions.maxConcurrent')?.version ?? 0;
    const saved = await api.updateSetting('sessions.maxConcurrent', { value: 8, version });
    expect(saved.value).toBe(8);
    expect((await inner.settings()).settings.find((s) => s.key === 'sessions.maxConcurrent')?.value).toBe(8);
  });
});
