// 只验 support 的 SDK 装配边界，创建函数已 mock，不起真实服务端。
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  requireServer: vi.fn(),
  createLocal: vi.fn(),
  createTimeSkipping: vi.fn(),
}));
vi.mock('@fleet-dao/conventions/temporal-test-server', () => ({ requireTestServer: mocks.requireServer }));
vi.mock('@fleet-dao/conventions/temporal-test-cli', async (original) => ({
  ...(await original<typeof import('@fleet-dao/conventions/temporal-test-cli')>()),
  prepareTemporalCli: mocks.prepare,
}));
vi.mock('@temporalio/testing', () => ({
  TestWorkflowEnvironment: { createLocal: mocks.createLocal, createTimeSkipping: mocks.createTimeSkipping },
}));
vi.mock('@temporalio/worker', () => ({ DefaultLogger: class {}, Runtime: { install: vi.fn() } }));
vi.mock('../src/worker.ts', () => ({ bundleEngineWorkflows: vi.fn(), createEngineWorker: vi.fn() }));

// 隔离装配测试用别名调用；能力标记只认真正需要 CLI 的实际服务端用例。
import { createEnv, createRealEnv as createEnvironment } from './support.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

it('直接创建入口准备失败不调用 SDK，不触发隐式下载', () => {
  const failure = new Error('Temporal preparation 失败：fixture missing');
  mocks.prepare.mockImplementation(() => {
    throw failure;
  });
  expect(() => createEnvironment()).toThrow(failure);
  expect(mocks.createLocal).not.toHaveBeenCalled();
});

it('准备过的 CLI 只以 existing-path 交给 SDK，返回同一可清理环境', async () => {
  const prepared = { path: '/fixture/temporal', version: '1.9.1' };
  const environment = { teardown: vi.fn() };
  mocks.prepare.mockReturnValue(prepared);
  mocks.createLocal.mockResolvedValue(environment);
  expect(await createEnvironment()).toBe(environment);
  expect(mocks.createLocal).toHaveBeenCalledExactlyOnceWith({
    server: { executable: { type: 'existing-path', path: prepared.path } },
  });
  expect(environment.teardown).not.toHaveBeenCalled();
  await environment.teardown();
  expect(environment.teardown).toHaveBeenCalledTimes(1);
});

it('SDK失败保留cause和真实合并阶段，不重试或退回下载', async () => {
  mocks.prepare.mockReturnValue({ path: '/fixture/temporal', version: '1.9.1' });
  const failure = new Error('fixture connection failed');
  mocks.createLocal.mockRejectedValue(failure);
  await expect(createEnvironment()).rejects.toMatchObject({
    cause: failure,
    message: expect.stringContaining('start-or-connect 失败'),
  });
  expect(mocks.createLocal).toHaveBeenCalledTimes(1);
});

it('时间跳跃环境不做真 CLI 准备', async () => {
  const environment = {};
  mocks.createTimeSkipping.mockResolvedValue(environment);
  mocks.requireServer.mockReturnValue('/fixture/time-skipping-server');
  expect(await createEnv()).toBe(environment);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.createLocal).not.toHaveBeenCalled();
  expect(mocks.createTimeSkipping).toHaveBeenCalledExactlyOnceWith({
    server: { executable: { type: 'existing-path', path: '/fixture/time-skipping-server' } },
  });
});

it('时间跳跃制品准备失败时不调用SDK，不隐式下载', () => {
  mocks.requireServer.mockImplementation(() => {
    throw new Error('time-skipping preparation 失败');
  });
  expect(() => createEnv()).toThrow('time-skipping preparation 失败');
  expect(mocks.createTimeSkipping).not.toHaveBeenCalled();
});
