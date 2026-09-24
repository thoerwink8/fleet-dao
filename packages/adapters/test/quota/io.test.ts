// 生产用的起进程与建空目录：起的是本机 node，不出网。
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv, listDir, productionQuotaIo, quotaWorkDir, runCommand } from '../../src/quota/io.ts';

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

  it('只带给定的环境：宿主里的 ANTHROPIC_* 过不去，配置额外变量里的也兜住', async () => {
    const env = childEnv(
      { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/x' },
      { EXTRA: 'yes', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' },
    );
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
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

describe('子进程的固定工作目录', () => {
  let home = '';
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fleet-quota-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('没有就建，每次都是同一个空目录', async () => {
    const first = await quotaWorkDir(home);
    expect(existsSync(first)).toBe(true);
    expect(await quotaWorkDir(home)).toBe(first);
    expect(first).toBe(join(home, '.cache', 'fleet-dao', 'quota-cwd'));
  });

  it('里面有东西（比如别人放的 .claude 项目设置）就不用，抛错', async () => {
    const dir = await quotaWorkDir(home);
    await mkdir(join(dir, '.claude'));
    await expect(quotaWorkDir(home)).rejects.toThrowError(/不是空的/);
  });
});

describe('列目录', () => {
  it('目录不在就照实抛 ENOENT，不折成空列表（「不在」和「空」是两回事）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-quota-list-'));
    try {
      expect(await listDir(dir)).toEqual([]);
      await expect(listDir(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('生产用的外部能力', () => {
  it('八样齐全，库函数拿它就能跑；readAllQuotas 自己不补默认值', () => {
    const io = productionQuotaIo();
    expect(Object.keys(io).sort()).toEqual(
      ['env', 'fetch', 'homeDir', 'listDir', 'openWebSocket', 'readFile', 'runCommand', 'workDir'].sort(),
    );
  });
});
