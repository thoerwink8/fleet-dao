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

const accepted = (taskId = '') =>
  JSON.stringify({
    ok: true,
    frames: [{ type: 'accepted', sessionKey: 'kimi:abc', clientRef: 'atom-server-ref', taskId }],
  });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('send.mjs', () => {
  it.each(['', 'new-task'])('发送一次并返回宿主接受编号，taskId=%s', (taskId) => {
    const sent: { sessionKey?: string; prompt?: string }[] = [];
    const logs: string[] = [];
    const exec = (_c: string, args: string[]) => {
      sent.push(JSON.parse(args[args.indexOf('--args') + 1] ?? '{}'));
      return { code: 0, stdout: accepted(taskId), stderr: '' };
    };
    const code = mod.sendRun(['--to', 'kimi:abc', '--file', 'm.md', '--report-to', 'claude:cmd'], {
      exec,
      server: 'unused.cjs',
      env: ENV,
      readFile: () => '接着做 #33',
      log: (line) => logs.push(line),
    });
    expect(code).toBe(0);
    expect(sent[0]?.sessionKey).toBe('kimi:abc');
    expect(sent[0]?.prompt).toContain('接着做 #33');
    expect(sent[0]?.prompt).toContain('回报，必做');
    expect(sent[0]?.prompt).toContain('claude:cmd');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(logs.at(-1) ?? '')).toEqual({
      sessionKey: 'kimi:abc',
      clientRef: 'atom-server-ref',
      taskId,
    });
  });

  it.each([
    { ok: true },
    { ok: true, frames: [{ type: 'accepted', sessionKey: 'kimi:other', clientRef: 'atom-other' }] },
    { ok: true, frames: [{ type: 'accepted', sessionKey: 'kimi:abc', clientRef: '' }] },
  ])('接受回执缺失或不符时报告未知且不重发：%j', (response) => {
    let calls = 0;
    const logs: string[] = [];
    const code = mod.sendRun(['--to', 'kimi:abc', '--file', 'm.md', '--report-to', 'claude:cmd'], {
      exec: () => {
        calls++;
        return { code: 0, stdout: JSON.stringify(response), stderr: '' };
      },
      server: 'unused.cjs',
      env: ENV,
      readFile: () => '接着做',
      log: (line) => logs.push(line),
    });
    expect(code).not.toBe(0);
    expect(calls).toBe(1);
    expect(logs).toEqual([]);
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
      return { code: 0, stdout: accepted(), stderr: '' };
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
      return { code: 0, stdout: accepted(), stderr: '' };
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
      return { code: 0, stdout: accepted(), stderr: '' };
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
