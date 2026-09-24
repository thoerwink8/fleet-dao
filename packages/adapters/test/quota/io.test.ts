// 生产用的起进程与建空目录：起的是本机 node，不出网。
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { childEnv, runCommand, scratchDir } from '../../src/quota/io.ts';

const node = process.execPath;
const baseEnv = childEnv(process.env);

describe('起子进程', () => {
  it('收齐 stdout / stderr 和退出码；stdin 是关着的，不会干等输入', async () => {
    const script = [
      "let got = '';",
      "process.stdin.on('data', (d) => { got += d; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('out:' + got.length);",
      "  process.stderr.write('err');",
      '  process.exit(3);',
      '});',
    ].join('\n');
    const r = await runCommand([node, '-e', script], {
      cwd: process.cwd(),
      env: baseEnv,
      signal: new AbortController().signal,
    });
    expect(r).toMatchObject({ code: 3, stdout: 'out:0', stderr: 'err', killed: false });
  });

  it('只带给定的环境：宿主里的 ANTHROPIC_* 过不去', async () => {
    const env = childEnv({ ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/x' }, { EXTRA: 'yes' });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    const r = await runCommand(
      [node, '-e', 'process.stdout.write(String(process.env.ANTHROPIC_BASE_URL) + "," + process.env.EXTRA)'],
      { cwd: process.cwd(), env, signal: new AbortController().signal },
    );
    expect(r.stdout).toBe('undefined,yes');
  });

  it('叫停：进程被杀、标 killed，不挂住', async () => {
    const controller = new AbortController();
    const pending = runCommand([node, '-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: baseEnv,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const r = await pending;
    expect(r.killed).toBe(true);
    expect(r.code).not.toBe(0);
  });

  it('命令不存在：spawnError，不抛', async () => {
    const r = await runCommand(['/definitely/not/here/fleet-quota-bin'], {
      cwd: process.cwd(),
      env: baseEnv,
      signal: new AbortController().signal,
    });
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(r.code).toBeNull();
  });
});

describe('用完即删的空目录', () => {
  it('建出来是空的，dispose 之后不在了', async () => {
    const dir = await scratchDir();
    expect(existsSync(dir.path)).toBe(true);
    await dir.dispose();
    expect(existsSync(dir.path)).toBe(false);
  });
});
