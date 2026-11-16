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

const base = ['--title', '【pi】#4019 一句', '--workdir', 'D:/repo', '--prompt', '照做'];

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
            { sessions: [{ agent: 'pi', workdir: 'D:/other', sessionKey: 'pi:elsewhere', createdAt: 9 }] },
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
                  { agent: 'pi', workdir: 'D:/repo', sessionKey: 'pi:old', createdAt: 1 },
                  { agent: 'pi', workdir: 'D:/repo', sessionKey: 'pi:new', createdAt: 5 },
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
    expect(payloads[1]).toEqual({ sessionKey: 'pi:new', title: '【pi】#4019 一句' });
    expect(lines.join('\n')).toMatch(/pi:new/);
    expect((payloads[0] as { clientRef: string }).clientRef).toBe('d-7');
  });
});

describe('pickSessionKey', () => {
  it('没有 sessionKey 的项不算', () => {
    expect(
      mod.pickSessionKey(
        { frames: [{ sessions: [{ agent: 'pi', workdir: 'D:/repo' }] }] },
        { agent: 'pi', workdir: 'D:/repo' },
      ),
    ).toBeNull();
  });
});
