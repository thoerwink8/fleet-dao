// 真的起 fleet 可执行入口（node bin/fleet），确认入口、退出码、stdout/stderr 接对了。
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeBackend, startFakeBackend } from './fake-backend.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet');

function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const backends: FakeBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) await b.close();
});

describe('fleet 可执行入口', () => {
  it('--help 退出 0，stdout 是中文说明，stderr 干净', async () => {
    const r = await run(['--help'], {});
    expect(r.code).toBe(0);
    expect(r.out).toContain('fleet —— 在 fleet 派的会话里');
    expect(r.err).toBe('');
  });

  it('真发一次请求：退出 0', async () => {
    const b = await startFakeBackend(() => ({ status: 204 }));
    backends.push(b);
    const r = await run(['say', '正在跑测试'], { FLEET_API: b.url, FLEET_TOKEN: 'tok-9' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('已记录。\n');
    expect(b.requests[0]?.body).toEqual({ text: '正在跑测试' });
  });

  it('缺环境变量：退出 2，原因写在 stderr', async () => {
    const r = await run(['task'], {});
    expect(r.code).toBe(2);
    expect(r.err).toContain('FLEET_API');
  });
});
