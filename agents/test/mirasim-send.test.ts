// send.mjs：给在跑的会话发后续消息，必须带回报去向；找不到指挥会话就不发。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface Mod {
  sendRun(
    argv: string[],
    io?: {
      exec?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };
      env?: NodeJS.ProcessEnv;
      server?: string;
      records?: unknown[];
      readFile?: (p: string) => string;
      log?: (s: string) => void;
    },
  ): number;
}
const mod = (await import(
  new URL('../skills/mirasim-sessions/scripts/send.mjs', import.meta.url).href
)) as Mod;

/** 固定宿主端口，不读本机真实的 ~/.mirasim/run（CI 上没有）。 */
const ENV: NodeJS.ProcessEnv = { MIRASIM_HOST_PORT: '4970' };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('send.mjs', () => {
  it('消息后面追加「回报，必做」和指挥会话号，发给指定会话', () => {
    const sent: { sessionKey?: string; prompt?: string }[] = [];
    const exec = (_c: string, args: string[]) => {
      sent.push(JSON.parse(args[args.indexOf('--args') + 1] ?? '{}'));
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    };
    const code = mod.sendRun(['--to', 'kimi:abc', '--file', 'm.md', '--report-to', 'claude:cmd'], {
      exec,
      server: 'unused.cjs',
      env: ENV,
      readFile: () => '接着做 #33',
      log: () => {},
    });
    expect(code).toBe(0);
    expect(sent[0]?.sessionKey).toBe('kimi:abc');
    expect(sent[0]?.prompt).toContain('接着做 #33');
    expect(sent[0]?.prompt).toContain('回报，必做');
    expect(sent[0]?.prompt).toContain('claude:cmd');
  });

  it('找不到指挥会话：退出码 2，一次都不发', () => {
    const calls: string[] = [];
    const exec = () => {
      calls.push('x');
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const code = mod.sendRun(['--to', 'kimi:abc', '--file', 'm.md'], {
      exec,
      server: 'unused.cjs',
      env: ENV,
      records: [],
      readFile: () => 'x',
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it('没给 --report-to 时用 MIRASIM_SESSION_KEY', () => {
    const sent: { prompt?: string }[] = [];
    const exec = (_c: string, args: string[]) => {
      sent.push(JSON.parse(args[args.indexOf('--args') + 1] ?? '{}'));
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    };
    const code = mod.sendRun(['--to', 'kimi:abc', '--file', 'm.md'], {
      exec,
      server: 'unused.cjs',
      env: { ...ENV, MIRASIM_SESSION_KEY: 'claude:from-env' },
      records: [],
      readFile: () => '接着做',
      log: () => {},
    });
    expect(code).toBe(0);
    expect(sent[0]?.prompt).toContain('claude:from-env');
  });

  it('--report-to 盖过环境变量', () => {
    const sent: { prompt?: string }[] = [];
    const exec = (_c: string, args: string[]) => {
      sent.push(JSON.parse(args[args.indexOf('--args') + 1] ?? '{}'));
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    };
    const code = mod.sendRun(['--to', 'kimi:abc', '--file', 'm.md', '--report-to', 'claude:from-cli'], {
      exec,
      server: 'unused.cjs',
      env: { ...ENV, MIRASIM_SESSION_KEY: 'claude:from-env' },
      records: [],
      readFile: () => '接着做',
      log: () => {},
    });
    expect(code).toBe(0);
    expect(sent[0]?.prompt).toContain('claude:from-cli');
    expect(sent[0]?.prompt).not.toContain('claude:from-env');
  });

  it('给了 --report-to，会话目录读不了也照发', () => {
    const root = mkdtempSync(join(tmpdir(), 'send-4087-'));
    roots.push(root);
    mkdirSync(join(root, '.mirasim', 'sessions'), { recursive: true });
    writeFileSync(join(root, '.mirasim', 'sessions', 'claude'), 'not-a-dir');
    const calls: string[] = [];
    const exec = () => {
      calls.push('called');
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    };
    const code = mod.sendRun(['--to', 'kimi:abc', '--file', 'm.md', '--report-to', 'claude:from-cli'], {
      exec,
      server: 'unused.cjs',
      env: { MIRASIM_HOST_PORT: '4970', USERPROFILE: root, HOME: root },
      readFile: () => '接着做',
      log: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['called']);
  });

  it('缺 --file：退出码 2', () => {
    expect(mod.sendRun(['--to', 'kimi:abc'], { exec: () => ({ code: 0, stdout: '{}', stderr: '' }) })).toBe(
      2,
    );
  });
});
