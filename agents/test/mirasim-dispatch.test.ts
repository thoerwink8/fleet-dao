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
  hostPort(env: NodeJS.ProcessEnv, explicit?: string, listDir?: (dir: string) => string[]): string;
  explicitReportTo(explicit: string | undefined, env: NodeJS.ProcessEnv): string;
  isCommanderWorkdir(workdir: string): boolean;
  findCommander(records: unknown[]): string | null;
  resolveReportTo(
    explicit: string | undefined,
    env: NodeJS.ProcessEnv,
    loadRecords: () => unknown[],
  ): string | null;
  Stop: new (step: string, next: string, code?: number) => Error;
}

const mod = (await import(pathToFileURL(SCRIPT).href)) as DispatchMod;

/** 固定宿主端口，不读本机真实的 ~/.mirasim/run（CI 上没有）。 */
const ENV: NodeJS.ProcessEnv = { MIRASIM_HOST_PORT: '4970' };

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
    const code = mod.dispatchRun(['--title', 't', '--workdir', 'D:/repo'], {
      exec,
      server: 'unused.cjs',
      env: ENV,
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it('缺 --title、缺 --workdir 各自退出码 2', () => {
    expect(
      mod.dispatchRun(['--workdir', 'D:/repo', '--prompt', 'p'], { server: 'unused.cjs', env: ENV }),
    ).toBe(2);
    expect(mod.dispatchRun(['--title', 't', '--prompt', 'p'], { server: 'unused.cjs', env: ENV })).toBe(2);
  });

  it('grok 快档 id 退出码 2，不调 prompt', () => {
    const calls: string[] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      return { code: 0, stdout: '{}', stderr: '' };
    };
    for (const model of ['grok-4.7-high-fast', 'cursor/grok-4.7-build-fast@500k', 'grok-4.7-low-fast']) {
      const code = mod.dispatchRun([...base, '--model', model], { exec, server: 'unused.cjs', env: ENV });
      expect(code).toBe(2);
    }
    expect(mod.dispatchRun([...base, '--model', 'grok-4.7'], { exec, server: 'unused.cjs', env: ENV })).toBe(
      1,
    );
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
    const code = mod.dispatchRun(base, { exec, server: 'unused.cjs', env: ENV, now: 1 });
    expect(code).toBe(1);
    expect(atoms).toEqual(['prompt']);
  });

  it('prompt 输出不是 JSON：退出码 1，不重派', () => {
    const atoms: string[] = [];
    const exec = (_cmd: string, args: string[]) => {
      atoms.push(args[args.indexOf('call') + 1] ?? '');
      return { code: 0, stdout: '不是 json', stderr: '' };
    };
    expect(mod.dispatchRun(base, { exec, server: 'unused.cjs', env: ENV, now: 1 })).toBe(1);
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
      env: ENV,
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
        env: ENV,
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
      { exec, server: 'unused.cjs', env: ENV },
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
      env: ENV,
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
      env: ENV,
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

  it('命令行优先于环境变量；不像会话 key 的环境变量不当回报去向', () => {
    expect(mod.explicitReportTo(' claude:from-cli ', { MIRASIM_SESSION_KEY: 'claude:from-env' })).toBe(
      'claude:from-cli',
    );
    expect(mod.explicitReportTo(undefined, { MIRASIM_SESSION_KEY: ' claude:from-env ' })).toBe(
      'claude:from-env',
    );
    expect(mod.explicitReportTo('', { MIRASIM_SESSION_KEY: 'not-a-key' })).toBe('');
    expect(mod.explicitReportTo(undefined, {})).toBe('');
  });

  it('给了显式去向就不读会话记录', () => {
    let reads = 0;
    const load = () => {
      reads += 1;
      return [];
    };
    expect(mod.resolveReportTo('claude:from-cli', { MIRASIM_SESSION_KEY: 'claude:from-env' }, load)).toBe(
      'claude:from-cli',
    );
    expect(mod.resolveReportTo(undefined, { MIRASIM_SESSION_KEY: 'claude:from-env' }, load)).toBe(
      'claude:from-env',
    );
    expect(reads).toBe(0);
    expect(mod.resolveReportTo(undefined, {}, load)).toBeNull();
    expect(reads).toBe(1);
  });

  it('给了 --report-to，会话目录读不了也照派', () => {
    const { env } = homeWithServer();
    mkdirSync(join(env.USERPROFILE ?? '', '.mirasim', 'sessions'), { recursive: true });
    writeFileSync(join(env.USERPROFILE ?? '', '.mirasim', 'sessions', 'claude'), 'not-a-dir');
    const calls: string[] = [];
    const exec = () => {
      calls.push('called');
      return {
        code: 0,
        stdout: JSON.stringify({ frames: [{ type: 'accepted', sessionKey: 'kimi:x' }] }),
        stderr: '',
      };
    };
    const code = mod.dispatchRun(
      ['--title', 't', '--workdir', 'D:/repo', '--prompt', 'p', '--report-to', 'claude:from-cli'],
      {
        exec,
        server: 'unused.cjs',
        env: { ...env, MIRASIM_HOST_PORT: '4970' },
        log: () => {},
      },
    );
    expect(code).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('只有 MIRASIM_SESSION_KEY、会话目录读不了也照派', () => {
    const { env } = homeWithServer();
    mkdirSync(join(env.USERPROFILE ?? '', '.mirasim', 'sessions'), { recursive: true });
    writeFileSync(join(env.USERPROFILE ?? '', '.mirasim', 'sessions', 'claude'), 'not-a-dir');
    const calls: string[] = [];
    const exec = (_cmd: string, args: string[]) => {
      calls.push(args[args.indexOf('call') + 1] ?? '');
      return {
        code: 0,
        stdout: JSON.stringify({ frames: [{ type: 'accepted', sessionKey: 'kimi:x' }] }),
        stderr: '',
      };
    };
    const code = mod.dispatchRun(['--title', 't', '--workdir', 'D:/repo', '--prompt', 'p'], {
      exec,
      server: 'unused.cjs',
      env: { ...env, MIRASIM_HOST_PORT: '4970', MIRASIM_SESSION_KEY: 'claude:from-env' },
      log: () => {},
    });
    expect(code).toBe(0);
    expect(calls[0]).toBe('prompt');
  });

  it('工作目录在 fleet-dao 工作树里算指挥会话，别的仓不算', () => {
    expect(mod.isCommanderWorkdir('D:\\frank\\fleet-dao\\')).toBe(true);
    expect(mod.isCommanderWorkdir('D:/frank/fleet-dao/.claude/worktrees/x')).toBe(true);
    expect(mod.isCommanderWorkdir('D:\\frank\\fleet-ade\\.claude\\worktrees\\x')).toBe(false);
    expect(mod.isCommanderWorkdir('D:/frank/my-fleet-dao')).toBe(false);
  });

  it('猜：工作树里正在跑的最新一条；心跳、已结束、别的仓都不算', () => {
    expect(
      mod.findCommander([
        {
          runState: 'running',
          title: '无人值守心跳',
          workdir: 'D:\\frank\\fleet-dao\\.claude\\worktrees\\h',
          sessionId: 'heart',
          updatedAt: '9',
        },
        {
          runState: 'completed',
          title: '指挥',
          workdir: 'D:\\frank\\fleet-dao\\.claude\\worktrees\\old',
          sessionId: 'done',
          updatedAt: '8',
        },
        {
          runState: 'running',
          title: '别的',
          workdir: 'D:\\frank\\fleet-ade\\.claude\\worktrees\\x',
          sessionId: 'ade',
          updatedAt: '7',
        },
        {
          runState: 'running',
          title: '指挥',
          workdir: 'D:\\frank\\fleet-dao\\.claude\\worktrees\\early',
          sessionId: 'early',
          updatedAt: '1',
        },
        {
          runState: 'running',
          title: '指挥',
          workdir: 'D:/fleet-dao',
          sessionId: 'root',
          updatedAt: '2',
        },
        {
          runState: 'running',
          title: '指挥',
          workdir: 'D:\\frank\\fleet-dao\\.claude\\worktrees\\late',
          sessionId: 'late',
          updatedAt: '3',
        },
      ]),
    ).toBe('claude:late');
  });

  it('有 MIRASIM_SESSION_KEY 就写进交代，不再按目录猜', () => {
    const payloads: { prompt?: string }[] = [];
    const exec = (_cmd: string, args: string[]) => {
      payloads.push(JSON.parse(args[args.indexOf('--args') + 1] ?? '{}'));
      return {
        code: 0,
        stdout: JSON.stringify({ frames: [{ type: 'accepted', sessionKey: 'kimi:x' }] }),
        stderr: '',
      };
    };
    const code = mod.dispatchRun(['--title', 't', '--workdir', 'D:/repo', '--prompt', 'p'], {
      exec,
      server: 'unused.cjs',
      env: { ...ENV, MIRASIM_SESSION_KEY: 'claude:from-env' },
      records: [
        {
          runState: 'running',
          title: '指挥',
          workdir: 'D:/fleet-dao',
          sessionId: 'guessed',
          updatedAt: '9',
        },
      ],
      log: () => {},
    });
    expect(code).toBe(0);
    expect(payloads[0]?.prompt).toContain('--to claude:from-env');
    expect(payloads[0]?.prompt).not.toContain('claude:guessed');
  });

  it('猜不到：退出码 2，一次都不派，并写明怎么补', () => {
    const calls: string[] = [];
    const errs: string[] = [];
    const orig = console.error;
    console.error = (line?: unknown) => {
      errs.push(String(line));
    };
    const exec = () => {
      calls.push('called');
      return { code: 0, stdout: '{}', stderr: '' };
    };
    let code = 0;
    try {
      code = mod.dispatchRun(['--title', 't', '--workdir', 'D:/repo', '--prompt', 'p'], {
        exec,
        server: 'unused.cjs',
        env: { ...ENV, MIRASIM_SESSION_KEY: 'nope' },
        records: [
          {
            runState: 'running',
            title: '别的仓',
            workdir: 'D:/frank/fleet-ade/.claude/worktrees/x',
            sessionId: 'ade',
            updatedAt: '9',
          },
        ],
      });
    } finally {
      console.error = orig;
    }
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(errs.join('\n')).toContain('--report-to');
    expect(errs.join('\n')).toContain('MIRASIM_SESSION_KEY');
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

// #4075：不带端口的 ui-cli 会起一次性私服，子会话随命令退出一起死。端口必须找到，找不到就停、不调。
describe('hostPort 宿主端口', () => {
  const none = () => [] as string[];

  it('显式 --port 优先于环境变量和 run 目录', () => {
    expect(mod.hostPort({ MIRASIM_HOST_PORT: '5000' }, '6000', () => ['local-4970.token'])).toBe('6000');
  });

  it('没给 --port 用 MIRASIM_HOST_PORT', () => {
    expect(mod.hostPort({ MIRASIM_HOST_PORT: '5000' }, undefined, () => ['local-4970.token'])).toBe('5000');
  });

  it('都没有时读 ~/.mirasim/run：有 4970 用 4970，不认别的文件', () => {
    const dirs: string[] = [];
    const list = (dir: string) => {
      dirs.push(dir);
      return ['local-14939.token', 'space-api.env', 'local-4970.token'];
    };
    expect(mod.hostPort({ USERPROFILE: 'C:/u', HOME: 'C:/u' }, undefined, list)).toBe('4970');
    expect(dirs[0]?.replaceAll('\\', '/')).toBe('C:/u/.mirasim/run');
  });

  it('run 目录只有一个宿主：用它', () => {
    expect(mod.hostPort({ HOME: '/h' }, undefined, () => ['local-4950.token'])).toBe('4950');
  });

  it('run 目录有多个宿主又没有 4970：退出码 2，要 --port', () => {
    expect(() =>
      mod.hostPort({ HOME: '/h' }, undefined, () => ['local-4950.token', 'local-4939.token']),
    ).toThrow(/多个宿主/);
  });

  it('都找不到：抛退出码 2 的 Stop；读不了目录当成空', () => {
    let caught: unknown;
    try {
      mod.hostPort({ HOME: '/h' }, undefined, () => {
        throw new Error('ENOENT');
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(mod.Stop);
    expect((caught as { code: number }).code).toBe(2);
    expect(() => mod.hostPort({ HOME: '/h' }, undefined, none)).toThrow(/找不到在跑的 mirasim/);
  });

  it('dispatch：找不到宿主就退出码 2，一次都不调 ui-cli', () => {
    const { env } = homeWithServer();
    const calls: string[] = [];
    const exec = () => {
      calls.push('called');
      return { code: 0, stdout: '{}', stderr: '' };
    };
    expect(mod.dispatchRun(base, { exec, server: 'unused.cjs', env })).toBe(2);
    expect(calls).toEqual([]);
  });

  it('dispatch：每次调 ui-cli 都带 --port', () => {
    const argvs: string[][] = [];
    const exec = (_cmd: string, args: string[]) => {
      argvs.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ frames: [{ type: 'accepted', sessionKey: 'kimi:x' }] }),
        stderr: '',
      };
    };
    expect(mod.dispatchRun(base, { exec, server: 'unused.cjs', env: ENV, log: () => {} })).toBe(0);
    expect(argvs).toHaveLength(2);
    for (const args of argvs) expect(args.slice(1, 4)).toEqual(['ui-cli', '--port', '4970']);
  });
});
