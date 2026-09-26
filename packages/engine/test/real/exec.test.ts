// 以会话用户的身份跑命令：生产走 sudo fleet-agent-scope（这里用假帮手核对命令行、字节进出），没跑成的讲清楚。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeFailure, localExec, scopeExec } from '../../src/real/exec.ts';

let dir: string;
let helper: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-exec-'));
  helper = join(dir, 'fake-scope.mjs');
  // 假帮手：把收到的参数和标准输入的字节原样报回来（标准输出是一段 JSON 加原样的输入字节）。
  writeFileSync(
    helper,
    `const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  if (process.argv.includes('--fail')) { process.stderr.write('帮手说：不行'); process.exit(64); }
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), bytes: input.length }) + '\\n');
  process.stdout.write(input);
});`,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('以会话用户的身份跑命令', { timeout: 30_000 }, () => {
  it('生产：经 fleet-agent-scope run 起，带用户、工作目录、命令；二进制输入输出原样进出', async () => {
    const exec = scopeExec({
      helper,
      sudo: [process.execPath],
      limits: { memoryMax: '512M', memorySwapMax: '0' },
    });
    const payload = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    const r = await exec({
      user: 'fleet-agent-carpool',
      cwd: '/var/lib/fleet-work/acme-widgets/12-a',
      argv: ['/usr/bin/git', 'status'],
      stdin: payload,
      timeoutMs: 10_000,
      scopeId: 'run-1-g1',
    });
    expect(r.code).toBe(0);
    const newline = r.stdout.indexOf(10);
    const head = JSON.parse(r.stdout.subarray(0, newline).toString('utf8'));
    expect(head.args).toEqual([
      'run',
      'run-1-g1',
      '--user',
      'fleet-agent-carpool',
      '--memory-max',
      '512M',
      '--memory-swap-max',
      '0',
      '--cwd',
      '/var/lib/fleet-work/acme-widgets/12-a',
      '--',
      '/usr/bin/git',
      'status',
    ]);
    expect(head.bytes).toBe(payload.length);
    expect(r.stdout.subarray(newline + 1)).toEqual(payload);
  });

  it('帮手拒了（退出码 64）：结果带退出码和它说的话，不当成功', async () => {
    const exec = scopeExec({ helper, sudo: [process.execPath] });
    const r = await exec({
      user: 'fleet-agent-carpool',
      cwd: '/var/lib/fleet-work/x/y',
      argv: ['/usr/bin/git', '--fail'],
      timeoutMs: 10_000,
      scopeId: 's-1',
    });
    expect(r.code).toBe(64);
    expect(describeFailure('读头', r)).toBe('读头：退出码 64（帮手说：不行）');
  });

  it('命令行拼不出来的（相对工作目录、坏的 scope 编号、别的用户）：起之前就拒', () => {
    const exec = scopeExec({ helper, sudo: [process.execPath] });
    const base = { user: 'fleet-agent-carpool' as const, argv: ['/usr/bin/git'], timeoutMs: 1000 };
    expect(() => exec({ ...base, cwd: 'relative', scopeId: 'ok' })).toThrow('绝对路径');
    expect(() => exec({ ...base, cwd: '/x', scopeId: 'bad id' })).toThrow('会话编号');
    expect(() => exec({ ...base, user: 'root' as never, cwd: '/x', scopeId: 'ok' })).toThrow('会话用户');
  });

  it('起不来、超时：结果讲清楚是哪一种', async () => {
    const missing = scopeExec({ helper: join(dir, 'nope'), sudo: [join(dir, 'no-such-binary')] });
    const r = await missing({
      user: 'fleet-agent-carpool',
      cwd: '/x',
      argv: ['/usr/bin/true'],
      timeoutMs: 5000,
      scopeId: 'a',
    });
    expect(r.code).toBeNull();
    expect(describeFailure('建树', r)).toContain('没起来');

    const slow = localExec();
    const t = await slow({
      user: 'fleet-agent-carpool',
      cwd: dir,
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 200,
      scopeId: 'b',
    });
    expect(t.timedOut).toBe(true);
    expect(describeFailure('等', t)).toBe('等：超时被停');
  });

  it('生产配置下不许用本机执行器（那等于以引擎的身份在会话的树里跑）', () => {
    expect(() => localExec({ FLEET_ENV: 'production' })).toThrow('scope');
    expect(() => localExec({})).toThrow('scope');
    expect(() => localExec({ FLEET_ENV: 'development' })).not.toThrow();
  });
});
