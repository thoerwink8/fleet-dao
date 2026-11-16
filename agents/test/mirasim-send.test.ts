// send.mjs：给在跑的会话发后续消息，必须带回报去向；找不到指挥会话就不发。
import { describe, expect, it } from 'vitest';

interface Mod {
  sendRun(
    argv: string[],
    io?: {
      exec?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };
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
      records: [],
      readFile: () => 'x',
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it('缺 --file：退出码 2', () => {
    expect(mod.sendRun(['--to', 'kimi:abc'], { exec: () => ({ code: 0, stdout: '{}', stderr: '' }) })).toBe(
      2,
    );
  });
});
