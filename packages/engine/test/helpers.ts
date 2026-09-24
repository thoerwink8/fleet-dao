// 测试共用：vitest 里用的那部分（每条用例一个测试服务端），其余在 support.ts。
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterEach, beforeAll, beforeEach } from 'vitest';
import { createEnv, engineBundle } from './support.ts';

export * from './support.ts';

/**
 * 每条用例一个测试服务端（起一个一两百毫秒）。跳时间是整个服务端共用的：上一条用例留下的工作流
 * （比如空闲等待中的合并队列）挂在已经关掉的任务队列上，会把跳时间锁住，下一条用例的定时器只能按真实时间走。
 */
export function useEnv(): () => TestWorkflowEnvironment {
  let env: TestWorkflowEnvironment | undefined;
  beforeAll(async () => {
    await engineBundle();
  }, 120_000);
  beforeEach(async () => {
    env = await createEnv();
  }, 60_000);
  afterEach(async () => {
    await env?.teardown();
    env = undefined;
  }, 60_000);
  return () => {
    if (!env) throw new Error('测试服务端还没起');
    return env;
  };
}
