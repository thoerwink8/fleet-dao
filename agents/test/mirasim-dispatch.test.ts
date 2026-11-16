// dispatch.mjs：参数缺了不调 prompt；prompt 回来拿不到会话号就停，不再调一次 prompt。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../skills/mirasim-sessions/scripts/dispatch.mjs', import.meta.url));

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
interface DispatchMod {
  dispatchRun(
    argv: string[],
    io?: {
      exec?: (cmd: string, args: string[]) => ExecResult;
      env?: NodeJS.ProcessEnv;
      log?: (line: string) => void;
      server?: string;
      now?: number;
      records?: unknown[];
    },
  ): number;
  parseArgs(argv: string[]): Record<string, string>;
  pickSessionKey(parsed: unknown, want: { agent: string; workdir: string }): string | null;
  mirasimServer(env: NodeJS.ProcessEnv): string;
  Stop: new (step: string, next: string, code?: number) => Error;
}

const mod = (await import(pathToFileURL(SCRIPT).href)) as DispatchMod;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function homeWithServer(version = '9.9.9'): { env: NodeJS.ProcessEnv; server: string } {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-4019-'));
  roots.push(root);
  const server = join(root, '.mirasim', 'app', version, 'server.cjs');
  mkdirSync(join(root, '.mirasim', 'app', version), { recursive: true });
  writeFileSync(server, '// 假的 server.cjs，测试不真跑\n');
  writeFileSync(
    join(root, '.mirasim', 'app', 'state.json'),
    JSON.stringify({ good: version, pending: '0.0.1' }),
  );
  return { env: { USERPROFILE: root, HOME: root }, server };
}

const base = [
  '--title',
  '【pi】#4019 一句',
  '--workdir',
  'D:/repo',
  '--prompt',
  '照做',
  '--report-to',
  'claude:cmd',
];

describe('dispatch.mjs 参数缺失', () => {
  it('缺 --prompt：退出码 2，一次都不调 mirasim', () => {
    const calls: string[] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const code = mod.dispatchRun(['--title', 't', '--workdir', 'D:/repo'], { exec, server: 'unused.cjs' });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it('缺 --title、缺 --workdir 各自退出码 2', () => {
    expect(mod.dispatchRun(['--workdir', 'D:/repo', '--prompt', 'p'], { server: 'unused.cjs' })).toBe(2);
    expect(mod.dispatchRun(['--title', 't', '--prompt', 'p'], { server: 'unused.cjs' })).toBe(2);
  });

  it('grok 快档 id 退出码 2，不调 prompt', () => {
    const calls: string[] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      return { code: 0, stdout: '{}', stderr: '' };
    };
    for (const model of ['grok-4.7-high-fast', 'cursor/grok-4.7-build-fast@500k', 'grok-4.7-low-fast']) {
      const code = mod.dispatchRun([...base, '--model', model], { exec, server: 'unused.cjs' });
      expect(code).toBe(2);
    }
    expect(mod.dispatchRun([...base, '--model', 'grok-4.7'], { exec, server: 'unused.cjs' })).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('state.json 用 good 的版本，不用 pending', () => {
    const { env, server } = homeWithServer('9.9.9');
    expect(mod.mirasimServer(env)).toBe(server);
  });
});

describe('dispatch.mjs 拿不到会话号', () => {
  it('prompt 的帧里没有对得上的会话：退出码 1，不再调 prompt，也不改名', () => {
    const atoms: string[] = [];
    const exec = (_cmd: string, args: string[]) => {
      const atom = args[args.indexOf('call') + 1] ?? '';
      atoms.push(atom);
      return {
        code: 0,
        stdout: JSON.stringify({
          frames: [
            {
              sessions: [{ agent: 'kimi', workdir: 'D:/other', sessionKey: 'kimi:elsewhere', createdAt: 9 }],
            },
          ],
        }),
        stderr: '',
      };
    };
    const code = mod.dispatchRun(base, { exec, server: 'unused.cjs', now: 1 });
    expect(code).toBe(1);
    expect(atoms).toEqual(['prompt']);
  });

  it('prompt 输出不是 JSON：退出码 1，不重派', () => {
    const atoms: string[] = [];
    const exec = (_cmd: string, args: string[]) => {
      atoms.push(args[args.indexOf('call') + 1] ?? '');
      return { code: 0, stdout: '不是 json', stderr: '' };
    };
    expect(mod.dispatchRun(base, { exec, server: 'unused.cjs', now: 1 })).toBe(1);
    expect(atoms).toEqual(['prompt']);
  });

  it('拿到会话号就改名，prompt 只调一次，标题原样传给 renameSession', () => {
    const atoms: string[] = [];
    const payloads: unknown[] = [];
    const exec = (_cmd: string, args: string[]) => {
      const atom = args[args.indexOf('call') + 1] ?? '';
      atoms.push(atom);
      const raw = args[args.indexOf('--args') + 1] ?? '{}';
      payloads.push(JSON.parse(raw));
      if (atom === 'prompt') {
        return {
          code: 0,
          stdout: JSON.stringify({
            frames: [
              {
                sessions: [
                  { agent: 'kimi', workdir: 'D:/repo', sessionKey: 'kimi:old', createdAt: 1 },
                  { agent: 'kimi', workdir: 'D:/repo', sessionKey: 'kimi:new', createdAt: 5 },
                ],
              },
            ],
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const lines: string[] = [];
    const code = mod.dispatchRun(base, {
      exec,
      server: 'unused.cjs',
      now: 7,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(atoms).toEqual(['prompt', 'renameSession']);
    expect(payloads[1]).toEqual({ sessionKey: 'kimi:new', title: '【pi】#4019 一句' });
    expect(lines.join('\n')).toMatch(/kimi:new/);
    expect((payloads[0] as { clientRef: string }).clientRef).toBe('d-7');
  });
});

describe('回报去向', () => {
  it('干活的会话默认是 omp（agent kimi），不传 model 和 effort（ACP 不认 set_model）', () => {
    const sent: Record<string, unknown>[] = [];
    const exec = (_cmd: string, args: string[]) => {
      sent.push(JSON.parse(args[args.indexOf('--args') + 1] ?? '{}'));
      return {
        code: 0,
        stdout: JSON.stringify({ frames: [{ type: 'accepted', sessionKey: 'kimi:x' }] }),
        stderr: '',
      };
    };
    const code = mod.dispatchRun(
      ['--title', 't', '--workdir', 'D:/repo', '--prompt', 'p', '--report-to', 'claude:c'],
      {
        exec,
        server: 'unused.cjs',
        log: () => {},
      },
    );
    expect(code).toBe(0);
    expect(sent[0]).toMatchObject({ agent: 'kimi' });
    expect(sent[0]).not.toHaveProperty('model');
    expect(sent[0]).not.toHaveProperty('effort');
  });

  it('--agent pi：退出码 2，一次都不派', () => {
    const calls: string[] = [];
    const exec = () => {
      calls.push('called');
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const code = mod.dispatchRun(
      ['--title', 't', '--workdir', 'D:/repo', '--prompt', 'p', '--agent', 'pi', '--report-to', 'claude:c'],
      { exec, server: 'unused.cjs' },
    );
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it('找不到指挥会话：退出码 2，一次都不派', () => {
    const calls: string[] = [];
    const exec = () => {
      calls.push('called');
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const code = mod.dispatchRun(['--title', 't', '--workdir', 'D:/repo', '--prompt', 'p'], {
      exec,
      server: 'unused.cjs',
      records: [],
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it('从会话记录里挑正在跑、目录以 fleet-dao 结尾、最近更新的，并写进交代', () => {
    const payloads: { prompt?: string }[] = [];
    const exec = (_cmd: string, args: string[]) => {
      const atom = args[args.indexOf('call') + 1] ?? '';
      payloads.push(JSON.parse(args[args.indexOf('--args') + 1] ?? '{}'));
      if (atom === 'prompt') {
        return {
          code: 0,
          stdout: JSON.stringify({
            frames: [{ type: 'accepted', sessionKey: 'pi:accepted' }],
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const code = mod.dispatchRun(['--title', '【pi】一句', '--workdir', 'D:/repo', '--prompt', '照做'], {
      exec,
      server: 'unused.cjs',
      now: 3,
      records: [
        {
          runState: 'running',
          title: '无人值守心跳',
          workdir: 'D:/fleet-dao',
          sessionId: 'heart',
          updatedAt: '9',
        },
        { runState: 'completed', title: '旧的', workdir: 'D:/fleet-dao', sessionId: 'old', updatedAt: '8' },
        {
          runState: 'running',
          title: '指挥',
          workdir: 'D:\\repo\\fleet-dao\\',
          sessionId: 'early',
          updatedAt: '1',
        },
        { runState: 'running', title: '指挥', workdir: 'D:/other', sessionId: 'nope', updatedAt: '9' },
        { runState: 'running', title: '指挥', workdir: 'D:/fleet-dao', sessionId: 'late', updatedAt: '2' },
      ],
    });
    expect(code).toBe(0);
    expect(payloads[0]?.prompt).toContain('【回报，必做】');
    expect(payloads[0]?.prompt).toContain('--to claude:late');
    expect(payloads[0]?.prompt).toContain('report.mjs');
    expect(payloads[0]?.prompt).not.toContain('_tmp');
    expect(payloads[1]).toEqual({ sessionKey: 'pi:accepted', title: '【pi】一句' });
  });
});

describe('pickSessionKey', () => {
  it('接受帧的会话号优先于列表里更新的那一个', () => {
    expect(
      mod.pickSessionKey(
        {
          frames: [
            { type: 'accepted', sessionKey: 'pi:accepted' },
            { sessions: [{ agent: 'pi', workdir: 'D:/repo', sessionKey: 'pi:newer', createdAt: 9 }] },
          ],
        },
        { agent: 'pi', workdir: 'D:/repo' },
      ),
    ).toBe('pi:accepted');
  });

  it('没有 sessionKey 的项不算', () => {
    expect(
      mod.pickSessionKey(
        { frames: [{ sessions: [{ agent: 'pi', workdir: 'D:/repo' }] }] },
        { agent: 'pi', workdir: 'D:/repo' },
      ),
    ).toBeNull();
  });
});
