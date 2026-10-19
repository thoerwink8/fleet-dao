import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoundedLegacyAdmission } from '../src/real/legacy-admission-process.ts';
import type { LegacyRequest } from '../src/real/legacy-admission-protocol.ts';

const children: ChildProcess[] = [];
const fixture = fileURLToPath(new URL('./fixtures/legacy-admission-process.mjs', import.meta.url));
const input: LegacyRequest['input'] = {
  schemaVersion: 1,
  taskId: randomUUID(),
  namespace: 'test',
  workflowId: 'task:a/b#1',
  runId: randomUUID(),
  workflowType: 'taskWorkflow',
  taskQueue: 'test',
  generation: 1,
  inputCanonical: '{}',
  inputHash: 'a'.repeat(64),
};
const audit = { actor: { kind: 'engine' as const, id: 'fixture' }, via: 'engine' as const };
const databaseUrl = 'postgres://fixture:fixture@127.0.0.1/fixture';
const options = (signal = new AbortController().signal, ms = 4000) => ({
  signal,
  deadlineAt: performance.now() + ms,
});
function setup(mode = 'normal', change?: (child: ChildProcess) => void) {
  let ready!: Promise<unknown>, child!: ChildProcess, closed!: Promise<unknown>;
  const coordinator = createBoundedLegacyAdmission(
    { databaseUrl },
    {
      launch: () => {
        child = spawn(process.execPath, [fixture], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
          env: { SystemRoot: process.env.SystemRoot, LEGACY_FIXTURE_MODE: mode },
        });
        children.push(child);
        ready = once(child, 'message');
        closed = once(child, 'close');
        change?.(child);
        return child;
      },
    },
  );
  return { coordinator, ready: () => ready, child: () => child, closed: () => closed };
}
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }),
  );
});

describe('独立 legacy SQL 宿主', () => {
  it('预取消、不足收尾预算和非法输入不spawn', async () => {
    const s = setup(),
      controller = new AbortController();
    controller.abort();
    expect(await s.coordinator.admit(input, audit, options(controller.signal))).toEqual({
      kind: 'unknown',
      code: 'cancelled',
    });
    expect(await s.coordinator.admit(input, audit, options(undefined, 999))).toEqual({
      kind: 'unknown',
      code: 'deadline',
    });
    expect(
      await s.coordinator.admit({ ...input, inputCanonical: 'x'.repeat(13 * 1024 * 1024) }, audit, options()),
    ).toEqual({ kind: 'unknown', code: 'input_limit' });
    expect(s.child()).toBeUndefined();
    expect(s.coordinator.status().active).toBe(0);
  });
  it('正常完整帧+exit0+pipeclose才允许，真实子PID已退出', async () => {
    const s = setup();
    expect(await s.coordinator.admit(input, audit, options())).toMatchObject({
      kind: 'allowed',
      status: 'admitted',
    });
    expect(s.child().pid).not.toBe(process.pid);
    expect(s.child().exitCode).toBe(0);
    expect(s.child().stdout?.destroyed).toBe(true);
    expect(s.child().stdin?.destroyed).toBe(true);
    expect(s.coordinator.status()).toEqual({ active: 0, cleanupPending: 0 });
  });
  it('受控barrier前取消：SIGKILL确实终止自己子PID，后续可重新用槽', async () => {
    let signal: NodeJS.Signals | number | undefined;
    const s = setup('hang', (child) => {
      const kill = child.kill.bind(child);
      child.kill = (requested) => {
        signal = requested;
        return kill(requested);
      };
    });
    const controller = new AbortController();
    const run = s.coordinator.admit(input, audit, options(controller.signal));
    await s.ready();
    controller.abort();
    expect(await run).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(signal).toBe('SIGKILL');
    expect(s.child().signalCode).toBe('SIGKILL');
    expect(s.coordinator.status().active).toBe(0);
  });
  it.each(['hang', 'success-hang'])('%s 到期限强杀，allowed帧也不能替代退出', async (mode) => {
    const s = setup(mode),
      start = Date.now();
    expect(await s.coordinator.admit(input, audit, options(undefined, 2000))).toEqual({
      kind: 'unknown',
      code: 'deadline',
    });
    expect(Date.now() - start).toBeLessThan(2500);
    expect(s.child().signalCode).toBe('SIGKILL');
    expect(s.coordinator.status().active).toBe(0);
  });
  it.each(['crash', 'success-crash'])('%s 不把完整allowed变成允许', async (mode) => {
    const s = setup(mode);
    expect(await s.coordinator.admit(input, audit, options())).toEqual({
      kind: 'unknown',
      code: 'child_failed',
    });
    expect(s.child().exitCode).not.toBe(0);
    expect(s.coordinator.status().active).toBe(0);
  });
  it.each(['oversize', 'extra', 'truncated', 'wrong-id', 'bad-result'])(
    '%s 原始流/身份/shape错误为unknown',
    async (mode) => {
      const s = setup(mode);
      expect(await s.coordinator.admit(input, audit, options())).toEqual({
        kind: 'unknown',
        code: 'protocol',
      });
      expect(s.coordinator.status().active).toBe(0);
    },
  );
  it('取消后故意延迟kill让allowed真到达，也不接纳它', async () => {
    let actualKill!: ChildProcess['kill'];
    const s = setup('late', (child) => {
      actualKill = child.kill.bind(child);
      child.kill = (signal) => {
        setTimeout(() => actualKill(signal), 80);
        return true;
      };
    });
    const controller = new AbortController(),
      run = s.coordinator.admit(input, audit, options(controller.signal));
    await s.ready();
    controller.abort();
    expect(await run).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(s.child().signalCode).toBe('SIGKILL');
  });
  it('kill未确认不无限堆子：unknown后仍占槽，真实close后才释放', async () => {
    let actualKill!: ChildProcess['kill'];
    const s = setup('hang', (child) => {
      actualKill = child.kill.bind(child);
      child.kill = () => false;
    });
    try {
      const run = s.coordinator.admit(input, audit, options(undefined, 1400));
      await s.ready();
      expect(await run).toEqual({ kind: 'unknown', code: 'cleanup_pending' });
      expect(s.coordinator.status()).toEqual({ active: 1, cleanupPending: 1 });
      expect(await s.coordinator.admit(input, audit, options())).toEqual({
        kind: 'unknown',
        code: 'capacity',
      });
    } finally {
      actualKill('SIGKILL');
      await s.closed();
      expect(s.coordinator.status()).toEqual({ active: 0, cleanupPending: 0 });
    }
  });
  it('同步spawn失败无活子进程、归还槽并返回脱敏unknown', async () => {
    const c = createBoundedLegacyAdmission(
      { databaseUrl },
      {
        launch: () => {
          throw new Error('private URL');
        },
      },
    );
    expect(await c.admit(input, audit, options())).toEqual({ kind: 'unknown', code: 'child_failed' });
    expect(c.status().active).toBe(0);
  });
  it('父总期限只认单调时钟，运行中墙钟回拨不延长强杀时间', async () => {
    const s = setup('hang'),
      started = performance.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      expect(await s.coordinator.admit(input, audit, options(undefined, 1800))).toEqual({
        kind: 'unknown',
        code: 'deadline',
      });
      expect(performance.now() - started).toBeLessThan(2300);
      expect(s.child().signalCode).toBe('SIGKILL');
    } finally {
      clock.mockRestore();
    }
  });
});
