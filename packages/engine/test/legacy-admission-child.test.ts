import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_REQUEST_MAX_BYTES,
  LegacyRequestSchema,
  legacyFrame,
} from '../src/real/legacy-admission-protocol.ts';

const entry = fileURLToPath(new URL('../src/real/legacy-admission-child.ts', import.meta.url));
function request(port: number, budgetMs = 700) {
  return LegacyRequestSchema.parse({
    version: 1,
    id: randomUUID(),
    databaseUrl: `postgres://fixture:fixture@127.0.0.1:${port}/fixture`,
    killAt: Date.now() + 8000,
    budgetMs,
    input: {
      schemaVersion: 1,
      taskId: randomUUID(),
      namespace: 'fixture',
      workflowId: 'task:a/b#1',
      runId: randomUUID(),
      workflowType: 'taskWorkflow',
      taskQueue: 'fixture',
      generation: 1,
      inputCanonical: '{}',
      inputHash: 'a'.repeat(64),
    },
    audit: { actor: { kind: 'engine', id: 'fixture' }, via: 'engine' },
  });
}
async function blackhole() {
  const sockets = new Set<net.Socket>();
  let accepts = 0,
    startups = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    accepts++;
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => {
      startups++;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listener');
  return {
    port: address.port,
    state: () => ({ accepts, startups, active: sockets.size }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function child() {
  const c = spawn(process.execPath, [entry], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { SystemRoot: process.env.SystemRoot },
  });
  c.stdin.on('error', () => {});
  c.stdout.resume();
  return c;
}
async function cleanup(c: ChildProcess) {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const closed = once(c, 'close');
  c.kill('SIGKILL');
  await closed;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    // Linux容器的init可能尚未reap孤儿；zombie已退出且不持有连接。
    if (process.platform === 'linux') {
      const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0];
      return state !== 'Z';
    }
    return true;
  } catch {
    return false;
  }
};
describe('真实固定child生命周期，loopback不是真实数据库验收', () => {
  it.each(['empty', 'truncated', 'extra', 'oversize'])(
    '%s EOF/原始流不完整，开库前非0退出',
    async (mode) => {
      const server = await blackhole(),
        c = child(),
        closed = once(c, 'close');
      try {
        let frame = legacyFrame(request(server.port), LEGACY_REQUEST_MAX_BYTES);
        if (mode === 'empty') frame = Buffer.alloc(0);
        if (mode === 'truncated') frame = frame.subarray(0, frame.length - 1);
        if (mode === 'extra') frame = Buffer.concat([frame, Buffer.from('x')]);
        if (mode === 'oversize') {
          frame = Buffer.alloc(4);
          frame.writeUInt32BE(0xffffffff);
        }
        c.stdin.end(frame);
        await closed;
        expect(c.exitCode).toBe(65);
        expect(server.state().accepts).toBe(0);
      } finally {
        await cleanup(c);
        await server.close();
      }
    },
    10000,
  );
  it('无父强杀时自身watchdog硬退出，startup黑洞不留连接', async () => {
    const server = await blackhole(),
      c = child(),
      closed = once(c, 'close');
    try {
      c.stdin.end(legacyFrame(request(server.port), LEGACY_REQUEST_MAX_BYTES));
      await closed;
      expect(c.exitCode).toBe(70);
      expect(c.signalCode).toBe(null);
      expect(server.state().startups).toBe(1);
      await expect.poll(() => server.state().active).toBe(0);
    } finally {
      await cleanup(c);
      await server.close();
    }
  }, 10000);
  it('真实父进程在startup后退出：child及连接有界清净，不称数据库回滚', async () => {
    const server = await blackhole();
    let orphanPid: number | undefined;
    const host = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/legacy-admission-orphan-parent.mjs', import.meta.url))],
      {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
        env: { SystemRoot: process.env.SystemRoot },
      },
    );
    const message = once(host, 'message'),
      hostClosed = once(host, 'close');
    try {
      host.stdin?.end(legacyFrame(request(server.port, 3000), LEGACY_REQUEST_MAX_BYTES));
      const [value] = await message;
      orphanPid = (value as { childPid: number }).childPid;
      expect(orphanPid).not.toBe(process.pid);
      // 整段 test:changed 里这个子进程超过 5 秒才连上。仍要等到 startups 变成 1。
      await expect.poll(() => server.state().startups, { timeout: 20000 }).toBe(1);
      expect(alive(orphanPid)).toBe(true);
      expect(server.state().active).toBe(1);
      host.send('exit-now');
      await hostClosed;
      expect(host.exitCode).toBe(0);
      // Windows宿主可能随父退出立即回收子进程；本项只证明父丢失后有界清净，
      // 上一项独立证明在没有父强杀时实际由watchdog退出。
      await expect.poll(() => server.state().active, { timeout: 6000 }).toBe(0);
      await expect.poll(() => alive(orphanPid as number), { timeout: 4000 }).toBe(false);
    } finally {
      await cleanup(host);
      // 只收本测试固定host实际创建并回传的确切PID，不按名字找/杀共享服务。
      if (orphanPid !== undefined && alive(orphanPid)) process.kill(orphanPid, 'SIGKILL');
      await server.close();
    }
  }, 45000);
});
