// report.mjs：缺参数不发；发出去要看到 ok。
import { describe, expect, it } from 'vitest';

const SCRIPT = new URL('../skills/mirasim-sessions/scripts/report.mjs', import.meta.url).href;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
interface ReportMod {
  reportRun(
    argv: string[],
    io?: {
      exec?: (cmd: string, args: string[]) => ExecResult;
      env?: NodeJS.ProcessEnv;
      server?: string;
      now?: number;
      readFile?: (path: string) => string;
      log?: (line: string) => void;
    },
  ): number;
}

const mod = (await import(SCRIPT)) as ReportMod;
const base = ['--to', 'claude:cmd', '--title', '#1', '--file', 'body.md'];
/** 固定宿主端口，不读本机真实的 ~/.mirasim/run（CI 上没有）。 */
const ENV: NodeJS.ProcessEnv = { MIRASIM_HOST_PORT: '4970' };

describe('report.mjs', () => {
  it('缺 --file：退出码 2，一次都不发', () => {
    const calls: string[] = [];
    const code = mod.reportRun(['--to', 'claude:cmd', '--title', '活'], {
      exec: () => {
        calls.push('called');
        return { code: 0, stdout: '{}', stderr: '' };
      },
      server: 'unused.cjs',
      env: ENV,
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it('ok 才算发出，正文带活名', () => {
    const payloads: { sessionKey?: string; prompt?: string }[] = [];
    const lines: string[] = [];
    const exec = (_cmd: string, args: string[]) => {
      payloads.push(JSON.parse(args[args.indexOf('--args') + 1] ?? '{}'));
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    };
    const code = mod.reportRun(base, {
      exec,
      server: 'unused.cjs',
      env: ENV,
      now: 4,
      readFile: () => '做到哪',
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(payloads[0]).toMatchObject({ sessionKey: 'claude:cmd', prompt: '[#1 回报]\n做到哪' });
    expect(lines.join('\n')).toContain('ok 已发给 claude:cmd');
  });

  it('宿主回 ok 不是 true：退出码 1', () => {
    const exec = () => ({ code: 0, stdout: JSON.stringify({ ok: false }), stderr: '' });
    expect(mod.reportRun(base, { exec, server: 'unused.cjs', env: ENV, readFile: () => 'x' })).toBe(1);
  });
});
