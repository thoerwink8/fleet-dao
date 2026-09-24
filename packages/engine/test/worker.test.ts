// worker 入口：环境变量怎么读；真把 src/main.ts 当进程起起来（和线上一样由 Node 直接跑 .ts），连上测试服务端跑完一个需求。
// 入口文件写坏了（语法、少了 .ts 后缀、不可擦除的写法）单元测试照样全绿，只有真起进程才看得出来（windsurf-dao@32ea2fe65 那类）。
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type RequirementResult, requirementWorkflowId, WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { configFromEnv, createEngineWorker, DEFAULT_CLI_BIN_DIR } from '../src/worker.ts';
import { createEnv, engineBundle, requirementInput, waitUntil } from './support.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

describe('worker 配置', () => {
  it('不给环境变量就用默认值：127.0.0.1:7243、命名空间 fleet、任务队列 fleet；fleet 命令的后端地址没有默认值', () => {
    expect(configFromEnv({})).toEqual({
      address: '127.0.0.1:7243',
      namespace: 'fleet',
      taskQueue: 'fleet',
      shutdownGraceSeconds: 30,
      maxConcurrentActivities: 40,
      agentApiUrl: null,
      cliBinDir: DEFAULT_CLI_BIN_DIR,
    });
    expect(DEFAULT_CLI_BIN_DIR.replaceAll('\\', '/')).toMatch(/packages\/cli\/bin$/);
  });

  it('按环境变量改；数字不合法的回默认值', () => {
    const config = configFromEnv({
      TEMPORAL_ADDRESS: '10.0.0.1:7233',
      TEMPORAL_NAMESPACE: 'other',
      FLEET_TASK_QUEUE: 'q',
      FLEET_SHUTDOWN_GRACE_SECONDS: 'abc',
      FLEET_MAX_ACTIVITIES: '8',
      FLEET_AGENT_API_URL: 'http://127.0.0.1:9999',
      FLEET_CLI_BIN: '/opt/fleet/cli/bin',
    });
    expect(config).toEqual({
      address: '10.0.0.1:7233',
      namespace: 'other',
      taskQueue: 'q',
      shutdownGraceSeconds: 30,
      maxConcurrentActivities: 8,
      agentApiUrl: 'http://127.0.0.1:9999',
      cliBinDir: '/opt/fleet/cli/bin',
    });
  });
});

describe('worker 起来之前', { timeout: 60_000 }, () => {
  it('先收掉上一轮留下的会话（引擎被强杀时它们留在自己的 scope 里）', async () => {
    const env = await createEnv();
    try {
      const calls: string[] = [];
      const worker = await createEngineWorker({
        config: {
          ...configFromEnv({}),
          address: env.address,
          namespace: env.namespace ?? 'default',
          taskQueue: 'reap',
        },
        ports: createFakeWorld().ports,
        signAgentToken: () => 't',
        connection: env.nativeConnection,
        workflowBundle: await engineBundle(),
        reapOrphanSessions: async () => {
          calls.push('reap');
          return 2;
        },
        log: (message) => calls.push(message),
      });
      await worker.runUntil(Promise.resolve());
      expect(calls).toEqual(['reap', '收掉上一轮留下的会话 2 个']);
    } finally {
      await env.teardown();
    }
  });
});

describe('worker 进程', { timeout: 120_000 }, () => {
  let env: TestWorkflowEnvironment | undefined;
  let child: ChildProcess | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      child.kill();
      await exited;
    }
    child = undefined;
    await env?.teardown();
    env = undefined;
  });

  const run = (extraEnv: Record<string, string>) => {
    const out: string[] = [];
    const proc = spawn(process.execPath, [MAIN], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d) => out.push(String(d)));
    proc.stderr?.on('data', (d) => out.push(String(d)));
    return { proc, out };
  };

  it('没接上真实现就明说起不来，退出码 1，不假装在干活', async () => {
    const { proc, out } = run({ FLEET_ENGINE_PORTS: '' });
    child = proc;
    const code = await new Promise((resolve) => proc.once('exit', resolve));
    expect(code).toBe(1);
    expect(out.join('')).toContain('FLEET_ENGINE_PORTS=fake');
  });

  it('按环境变量连上服务端，用假实现把一个需求从头跑到关单', async () => {
    env = await createEnv();
    const taskQueue = `smoke-${Date.now()}`;
    const { proc, out } = run({
      TEMPORAL_ADDRESS: env.address,
      TEMPORAL_NAMESPACE: env.namespace ?? 'default',
      FLEET_TASK_QUEUE: taskQueue,
      FLEET_ENGINE_PORTS: 'fake',
    });
    child = proc;
    await waitUntil(
      () => out.join('').includes('worker 已起') || proc.exitCode !== null,
      'worker 起来',
      60_000,
    );
    expect(out.join('')).toContain(`任务队列 ${taskQueue}`);
    const input = requirementInput();
    const handle = await env.client.workflow.start(WORKFLOW_TYPES.requirement, {
      taskQueue,
      workflowId: requirementWorkflowId(input.repo, input.issueNumber),
      args: [input],
    });
    const result = (await handle.result()) as RequirementResult;
    expect(result.state).toBe('done');
    expect(result.subtasks.map((s) => s.state)).toEqual(['merged']);
  });
});
