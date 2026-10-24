// 决定 0085：别的仓放 .fleet-plugins.json 且 track 含 process，才把过程组写进那个仓的项目设置。
// 命令指向这台 ~/.fleet-dao/hooks/。fleet-dao 自己的 $CLAUDE_PROJECT_DIR/agents/hooks/ 算已经登记，不重复写。
// 没标记：不新建项目设置；已经写过的过程钩子要拿掉。标记读不成、项目设置读不成：一个字不改，退出 0。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from '../child.ts';
import { interactiveHookEnv } from '../hook-env.ts';

const LOADER = fileURLToPath(new URL('../../hooks/plugin-loader.mjs', import.meta.url));
const HOOKS = 'C:/Users/ada/.fleet-dao/hooks';

interface Handler {
  type: string;
  command: string;
  args?: string[];
  timeout: number;
  async?: boolean;
  asyncRewake?: boolean;
  rewakeMessage?: string;
  rewakeSummary?: string;
}
interface Group {
  matcher?: string;
  hooks: Handler[];
}
interface Settings {
  hooks?: Record<string, Group[]>;
  env?: Record<string, string>;
}
interface Lib {
  PROCESS_HOOKS: {
    event: string;
    script: string;
    timeout: number;
    asyncRewake?: boolean;
    rewakeMessage?: string;
    rewakeSummary?: string;
  }[];
  scriptOf(command: unknown): string | null;
  handlerScript(handler: unknown): string | null;
  formatJson(value: unknown): string;
  trackOf(text: string): string[];
  commandFor(hooksDir: string, script: string): string;
  applyCatalog(
    settings: unknown,
    track: string[],
    hooksDir: string,
    options?: { projectDir?: string },
  ): Settings;
}

const lib = (await import(pathToFileURL(LOADER).href)) as Lib;
const { PROCESS_HOOKS, RETIRED_PROCESS_HOOKS } = (await import(
  pathToFileURL(fileURLToPath(new URL('../../hooks/plugin-catalog.mjs', import.meta.url))).href
)) as { PROCESS_HOOKS: Lib['PROCESS_HOOKS']; RETIRED_PROCESS_HOOKS: string[] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-loader-'));
  dirs.push(dir);
  return dir;
}

function scriptsOf(settings: Settings): string[] {
  const names: string[] = [];
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        const name = lib.scriptOf(handler.command);
        if (name !== null) names.push(name);
      }
    }
  }
  return names;
}

const projectHooks = (): Settings => ({
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/agents/hooks/bootstrap.mjs"',
            timeout: 120,
          },
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/agents/hooks/session-start.mjs"',
            timeout: 90,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/agents/hooks/main-thread.mjs"',
            timeout: 10,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/agents/hooks/continuation-progress.mjs"',
            timeout: 10,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/agents/hooks/stop.mjs"', timeout: 10 },
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/agents/hooks/work-watch.mjs"',
            timeout: 11_400,
            asyncRewake: true,
            rewakeMessage: PROCESS_HOOKS.find((h) => h.script === 'work-watch.mjs')?.rewakeMessage ?? '',
            rewakeSummary: PROCESS_HOOKS.find((h) => h.script === 'work-watch.mjs')?.rewakeSummary ?? '',
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/agents/hooks/prompt-log.mjs"',
            timeout: 30,
          },
        ],
      },
    ],
    StopFailure: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/agents/hooks/quota-stop.mjs"',
            timeout: 10,
          },
        ],
      },
    ],
  },
});

describe('订阅目录（决定 0085）', () => {
  it('过程组包含完成进展登记，超时和 fleet-dao 项目设置一致', () => {
    expect(PROCESS_HOOKS.map((hook) => [hook.script, hook.event, hook.timeout])).toEqual([
      ['bootstrap.mjs', 'SessionStart', 120],
      ['session-start.mjs', 'SessionStart', 90],
      ['main-thread.mjs', 'PreToolUse', 10],
      ['continuation-progress.mjs', 'PostToolUse', 10],
      ['stop.mjs', 'Stop', 10],
      ['work-watch.mjs', 'Stop', 11_400],
      ['prompt-log.mjs', 'UserPromptSubmit', 30],
      ['quota-stop.mjs', 'StopFailure', 10],
    ]);
  });

  it('前台钩子超时按秒写，不超过 600（写成毫秒是 30000 这种数）；工人终态后台叫醒钩子超时比它们最长等的 3 小时长、不超过 4 小时', async () => {
    for (const hook of PROCESS_HOOKS)
      if (hook.asyncRewake !== true) expect(hook.timeout, hook.script).toBeLessThanOrEqual(600);
    const watch = PROCESS_HOOKS.filter((hook) => hook.asyncRewake === true);
    expect(watch.map((hook) => hook.script)).toEqual(['work-watch.mjs']);
    for (const hook of watch) {
      const { WATCH_MAX_MS } = (await import(
        pathToFileURL(fileURLToPath(new URL(`../../hooks/${hook.script}`, import.meta.url))).href
      )) as { WATCH_MAX_MS: number };
      expect(WATCH_MAX_MS, hook.script).toBe(3 * 3_600_000);
      expect(hook.timeout * 1000).toBeGreaterThan(WATCH_MAX_MS);
      expect(hook.timeout).toBeLessThanOrEqual(4 * 3600);
    }
  });

  it('工人终态钩子写进设置时带 "asyncRewake": true 和叫醒提示（后台跑、退出码 2 叫醒主线程），别的钩子不带', () => {
    const next = lib.applyCatalog({}, ['process'], HOOKS);
    const stop = next.hooks?.Stop?.flatMap((group) => group.hooks) ?? [];
    expect(RETIRED_PROCESS_HOOKS).toContain('inbox-watch.mjs');
    expect(stop.some((h) => lib.handlerScript(h) === 'inbox-watch.mjs')).toBe(false);
    // 工人终态（单 #2761）：只在 pnpm work run 派的工人到终态时叫醒
    const work = stop.find((handler) => lib.scriptOf(handler.command) === 'work-watch.mjs');
    expect(work?.asyncRewake).toBe(true);
    expect(work?.rewakeMessage).toContain('到了终态');
    expect(work?.rewakeSummary).toBeTruthy();
    const others = Object.values(next.hooks ?? {})
      .flatMap((groups) => groups.flatMap((group) => group.hooks))
      .filter((handler) => handler !== work);
    for (const handler of others) {
      expect(handler).not.toHaveProperty('asyncRewake');
      expect(handler).not.toHaveProperty('async');
    }
    // 本仓项目设置里的工人终态钩子也是后台叫醒的（本仓的会话读的是它，不是加载器写的那份）
    const repo = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../.claude/settings.json', import.meta.url)), 'utf8'),
    ) as Settings;
    for (const [script, want] of [['work-watch.mjs', work]] as const) {
      const mine = (repo.hooks?.Stop ?? [])
        .flatMap((group) => group.hooks)
        .find((handler) => lib.scriptOf(handler.command) === script);
      expect(mine?.asyncRewake, script).toBe(true);
      expect(mine?.timeout, script).toBe(want?.timeout);
      expect(mine?.rewakeMessage, script).toBe(want?.rewakeMessage);
      expect(mine?.rewakeSummary, script).toBe(want?.rewakeSummary);
    }
  });

  it('空设置加上 process：八条命令都指向安装目录，不指向别的仓的 agents/hooks', () => {
    const next = lib.applyCatalog({}, ['process'], HOOKS);
    expect(scriptsOf(next)).toEqual(PROCESS_HOOKS.map((hook) => hook.script));
    const handlers = Object.values(next.hooks ?? {}).flatMap((groups) =>
      groups.flatMap((group) => group.hooks),
    );
    expect(handlers.map((handler) => handler.command)).toEqual(
      PROCESS_HOOKS.map((hook) => lib.commandFor(HOOKS, hook.script)),
    );
    expect(handlers.map((handler) => handler.timeout)).toEqual(PROCESS_HOOKS.map((hook) => hook.timeout));
    expect(JSON.stringify(next)).not.toContain('agents/hooks/');
    expect(JSON.stringify(next)).not.toContain('plugin-loader.mjs');
  });

  it('fleet-dao 已经用本仓 agents/hooks 登记过的不重复写；缺的那条补到安装目录', () => {
    const full = projectHooks();
    expect(lib.applyCatalog(full, ['process'], HOOKS)).toEqual(full);
    const missing = projectHooks();
    delete missing.hooks?.UserPromptSubmit;
    const next = lib.applyCatalog(missing, ['process'], HOOKS);
    expect(scriptsOf(next).filter((name) => name === 'bootstrap.mjs')).toEqual(['bootstrap.mjs']);
    const added = next.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    expect(added?.command).toBe(lib.commandFor(HOOKS, 'prompt-log.mjs'));
    expect(added?.timeout).toBe(30);
  });

  it('没标记不给空设置造 hooks；有标记再拿掉，过程钩子没了，别人的钩子还在', () => {
    expect(lib.applyCatalog({}, [], HOOKS)).toEqual({});
    expect(lib.applyCatalog({ env: { A: '1' } }, [], HOOKS)).toEqual({ env: { A: '1' } });
    const on = lib.applyCatalog(
      {
        env: { A: '1' },
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/x/mine.mjs"', timeout: 5 }] },
          ],
        },
      },
      ['process'],
      HOOKS,
    );
    const off = lib.applyCatalog(on, [], HOOKS);
    expect(JSON.stringify(off)).not.toContain('bootstrap.mjs');
    expect(off.env).toEqual({ A: '1' });
    expect(off.hooks?.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/x/mine.mjs"', timeout: 5 }] },
    ]);
  });

  it('【故意造出的失败】拿掉标记之后还留着过程钩子：这条对不上', () => {
    const on = lib.applyCatalog({}, ['process'], HOOKS);
    const off = lib.applyCatalog(on, [], HOOKS);
    expect(JSON.stringify(off)).not.toContain('bootstrap.mjs');
    expect(off).not.toEqual(on);
    const stillWrites = on;
    expect(JSON.stringify(stillWrites)).toContain('bootstrap.mjs');
    expect(stillWrites).not.toEqual(off);
  });

  it('exec 形式（command: "node"、脚本写在 args 里）认得出是同一个脚本，不再补一条重复的', () => {
    const exec = projectHooks();
    const pre = exec.hooks?.PreToolUse?.[0];
    if (pre === undefined) throw new Error('夹具里没有 PreToolUse');
    pre.hooks = [
      {
        type: 'command',
        command: 'node',
        args: ['${CLAUDE_PROJECT_DIR}/agents/hooks/main-thread.mjs'],
        timeout: 10,
      },
    ];
    expect(lib.handlerScript(pre.hooks[0])).toBe('main-thread.mjs');
    expect(lib.applyCatalog(exec, ['process'], HOOKS)).toEqual(exec);
    // 【故意造出的失败】只看 command 字符串的旧判断：认不出，会再补一条安装目录的
    expect(lib.scriptOf('node')).toBeNull();
  });

  it('校准旧受管登记的事件、matcher、超时和后台唤醒字段，并合并重复登记', () => {
    const command = lib.commandFor(HOOKS, 'work-watch.mjs');
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10, async: true }] }],
        Stop: [{ hooks: [{ type: 'command', command, timeout: 5, asyncRewake: false }] }],
      },
    };
    const next = lib.applyCatalog(input, ['process'], HOOKS);
    const matches = Object.entries(next.hooks ?? {}).flatMap(([event, groups]) =>
      groups.flatMap((g) =>
        g.hooks.filter((h) => h.command === command).map((h) => ({ event, group: g, h })),
      ),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.event).toBe('Stop');
    expect(matches[0]?.group).not.toHaveProperty('matcher');
    expect(matches[0]?.h).toMatchObject({ timeout: 11_400, asyncRewake: true });
    expect(matches[0]?.h).not.toHaveProperty('async');
    expect(matches[0]?.h.rewakeMessage).toContain('到了终态');
    expect(lib.applyCatalog(next, ['process'], HOOKS)).toEqual(next);
    expect(input.hooks.PreToolUse[0]?.matcher).toBe('Bash');
  });

  it('普通前台钩子不保留旧的 async、asyncRewake、条件和唤醒提示', () => {
    const command = lib.commandFor(HOOKS, 'main-thread.mjs');
    const next = lib.applyCatalog(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command,
                  timeout: 1,
                  async: true,
                  asyncRewake: true,
                  rewakeMessage: 'old',
                  rewakeSummary: 'old',
                  if: 'Bash(git *)',
                },
              ],
            },
          ],
        },
      },
      ['process'],
      HOOKS,
    );
    const managed = next.hooks?.PreToolUse?.flatMap((g) => g.hooks).find((h) => h.command === command);
    expect(managed).toEqual({ type: 'command', command, timeout: 10 });
    expect(lib.applyCatalog(next, ['process'], HOOKS)).toEqual(next);
  });

  it('第三方同名、不同目录、带额外参数或shell操作的命令原样保留，也不压住受管登记', () => {
    const path = `${HOOKS}/stop.mjs`;
    const foreign = [
      { type: 'command', command: 'node "D:/other/agents/hooks/stop.mjs"', timeout: 3 },
      { type: 'command', command: `node "${path}" && node other.mjs`, timeout: 4 },
      { type: 'command', command: 'echo', args: [path], timeout: 5 },
      { type: 'command', command: 'node', args: [path, '--foreign-mode'], timeout: 6 },
      { type: 'command', command: `node "${HOOKS}/never-managed.mjs"`, timeout: 7 },
    ];
    const input = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: foreign }] } };
    const next = lib.applyCatalog(input, ['process'], HOOKS);
    expect(next.hooks?.PreToolUse?.[0]).toEqual(input.hooks.PreToolUse[0]);
    expect(
      next.hooks?.Stop?.flatMap((g) => g.hooks).some((h) => h.command === lib.commandFor(HOOKS, 'stop.mjs')),
    ).toBe(true);
    expect(lib.applyCatalog(next, [], HOOKS)).toEqual(input);
    expect(lib.applyCatalog(next, ['process'], HOOKS)).toEqual(next);
  });

  it('当前项目绝对路径的exec登记保留形式，其他项目同名登记不接管', () => {
    const owned = {
      type: 'command',
      command: 'node',
      args: ['D:/current/agents/hooks/main-thread.mjs'],
      timeout: 1,
    };
    const foreign = { ...owned, args: ['D:/other/agents/hooks/main-thread.mjs'] };
    const next = lib.applyCatalog({ hooks: { Stop: [{ hooks: [owned, foreign] }] } }, ['process'], HOOKS, {
      projectDir: 'D:/current',
    });
    expect(next.hooks?.Stop?.[0]?.hooks[0]).toEqual(foreign);
    expect(next.hooks?.PreToolUse?.[0]?.hooks).toEqual([{ ...owned, timeout: 10 }]);
    expect(lib.applyCatalog(next, ['process'], HOOKS, { projectDir: 'D:/current' })).toEqual(next);
  });

  it('显式退役名在退订后仍清掉受管登记，不误删别的目录或未知名字', () => {
    RETIRED_PROCESS_HOOKS.push('retired-synthetic.mjs');
    try {
      const owned = { type: 'command', command: `node "${HOOKS}/retired-synthetic.mjs"`, timeout: 5 };
      const foreign = { ...owned, command: 'node "D:/other/agents/hooks/retired-synthetic.mjs"' };
      const unknown = { ...owned, command: `node "${HOOKS}/never-managed.mjs"` };
      const next = lib.applyCatalog({ hooks: { Stop: [{ hooks: [owned, foreign, unknown] }] } }, [], HOOKS);
      expect(next.hooks?.Stop?.[0]?.hooks).toEqual([foreign, unknown]);
      expect(lib.applyCatalog(next, [], HOOKS)).toEqual(next);
    } finally {
      RETIRED_PROCESS_HOOKS.pop();
    }
  });

  it('绝对 node executable 的 exec 登记保持直接启动形式并校准目录字段', () => {
    for (const command of ['C:/Program Files/nodejs/node.exe', '/usr/bin/node']) {
      const owned = { type: 'command', command, args: [`${HOOKS}/stop.mjs`], timeout: 1 };
      const next = lib.applyCatalog({ hooks: { Stop: [{ hooks: [owned] }] } }, ['process'], HOOKS);
      expect(next.hooks?.Stop?.[0]?.hooks[0]).toEqual({ ...owned, timeout: 10 });
      expect(lib.applyCatalog(next, ['process'], HOOKS)).toEqual(next);
    }
  });

  it('写盘排版和 biome 一致：本仓的 .claude/settings.json 原样过一遍不变；只含标量的短数组写一行', () => {
    const repo = readFileSync(
      fileURLToPath(new URL('../../../.claude/settings.json', import.meta.url)),
      'utf8',
    );
    expect(`${lib.formatJson(JSON.parse(repo))}\n`).toBe(repo);
    expect(lib.formatJson({ a: ['x', 'y'], b: {}, c: [] })).toBe(
      '{\n  "a": ["x", "y"],\n  "b": {},\n  "c": []\n}',
    );
    const long = Array.from({ length: 12 }, (_, i) => `item-number-${i}`);
    expect(lib.formatJson({ a: long })).toContain('[\n    "item-number-0",');
  });

  it('订阅文件不是带 track 字符串数组的对象就抛', () => {
    expect(lib.trackOf('{"track":["process"]}')).toEqual(['process']);
    expect(() => lib.trackOf('[]')).toThrow(/对象/);
    expect(() => lib.trackOf('{"a":1}')).toThrow(/track/);
    expect(() => lib.trackOf('{"track":[1]}')).toThrow(/track/);
  });

  it('本仓路径和安装目录认的是同一个脚本；反斜杠也认', () => {
    expect(lib.scriptOf('node "$CLAUDE_PROJECT_DIR/agents/hooks/bootstrap.mjs"')).toBe('bootstrap.mjs');
    expect(lib.scriptOf('node "C:\\Users\\a\\.fleet-dao\\hooks\\stop.mjs"')).toBe('stop.mjs');
    expect(lib.scriptOf('node "/x/mine.mjs"')).toBeNull();
  });
});

describe('加载器真跑（决定 0085）', () => {
  function run(cwd: string, env: Record<string, string> = {}) {
    return runChild(process.execPath, [LOADER], {
      cwd,
      input: JSON.stringify({ cwd }),
      // 不往跑测试的这个会话自己的 CLAUDE_ENV_FILE 里写
      env: { ...interactiveHookEnv(), CLAUDE_ENV_FILE: '', ...env },
    });
  }

  it('配了备用代理：往 CLAUDE_ENV_FILE 追加代理变量（每个仓开会话都走这个用户级钩子）；没配不写', () => {
    const home = temp();
    mkdirSync(join(home, '.fleet-dao'));
    const envFile = join(temp(), 'env.sh');
    const env = { HOME: home, USERPROFILE: home, CLAUDE_ENV_FILE: envFile };
    expect(run(temp(), env).status).toBe(0);
    expect(existsSync(envFile)).toBe(false);
    writeFileSync(join(home, '.fleet-dao', 'fallback-proxy'), 'http://127.0.0.1:7890\n');
    const r = run(temp(), env);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toContain('export HTTPS_PROXY=http://127.0.0.1:7890\n');
  });

  function readSettings(cwd: string): string | null {
    const file = join(cwd, '.claude', 'settings.json');
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  it('有标记才写出七条；没有标记、原来也没有项目设置：不建文件', () => {
    const bare = temp();
    const none = run(bare);
    expect(none.status).toBe(0);
    expect(none.stderr).toBe('');
    expect(readSettings(bare)).toBeNull();

    const cwd = temp();
    writeFileSync(join(cwd, '.fleet-plugins.json'), '{"track":["process"]}\n');
    const wrote = run(cwd);
    expect(wrote.status, wrote.stderr).toBe(0);
    const text = readSettings(cwd);
    if (text === null) throw new Error('订阅了却没写项目设置');
    for (const hook of PROCESS_HOOKS) {
      expect(text).toContain(`hooks/${hook.script}`);
      expect(text).toContain(`"timeout": ${hook.timeout}`);
    }
    // 写进文件的 Stop 盯账钩子带 "asyncRewake": true（后台跑，退出码 2 叫醒主线程）
    const written = JSON.parse(text) as Settings;
    const watch = (written.hooks?.Stop ?? [])
      .flatMap((group) => group.hooks)
      .find((handler) => lib.scriptOf(handler.command) === 'work-watch.mjs');
    expect(watch?.asyncRewake).toBe(true);
    expect(text).toContain('"asyncRewake": true');
    expect(text).not.toContain('agents/hooks/');
  });

  it('本仓这份项目设置（main-thread 是 exec 形式）跑过加载器：一个字节不变，不补重复项', () => {
    const cwd = temp();
    mkdirSync(join(cwd, '.claude'));
    const repo = readFileSync(
      fileURLToPath(new URL('../../../.claude/settings.json', import.meta.url)),
      'utf8',
    );
    writeFileSync(join(cwd, '.claude', 'settings.json'), repo);
    writeFileSync(join(cwd, '.fleet-plugins.json'), '{ "track": ["process"] }\n');
    const r = run(cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(readSettings(cwd)).toBe(repo);
  });

  it('拿掉标记：已经写上的过程钩子从项目设置里消失', () => {
    const cwd = temp();
    writeFileSync(join(cwd, '.fleet-plugins.json'), '{"track":["process"]}\n');
    expect(run(cwd).status).toBe(0);
    rmSync(join(cwd, '.fleet-plugins.json'));
    const again = run(cwd);
    expect(again.status, again.stderr).toBe(0);
    const text = readSettings(cwd);
    expect(text).not.toContain('bootstrap.mjs');
    expect(text).not.toContain('session-start.mjs');
  });

  it('【故意造出的失败】引擎无头、标记坏了、项目设置读不成：都不改文件', () => {
    const headless = temp();
    writeFileSync(join(headless, '.fleet-plugins.json'), '{"track":["process"]}\n');
    const skipped = run(headless, { FLEET_HEADLESS: '1' });
    expect(skipped.status).toBe(0);
    expect(readSettings(headless)).toBeNull();

    const bad = temp();
    mkdirSync(join(bad, '.claude'));
    const original = '{\n  "env": {}\n}\n';
    writeFileSync(join(bad, '.claude', 'settings.json'), original);
    writeFileSync(join(bad, '.fleet-plugins.json'), '{');
    const unread = run(bad);
    expect(unread.status).toBe(0);
    expect(unread.stderr).toContain('订阅文件读不成，项目钩子没改');
    expect(readSettings(bad)).toBe(original);

    const broken = temp();
    mkdirSync(join(broken, '.claude'));
    writeFileSync(join(broken, '.claude', 'settings.json'), '{');
    writeFileSync(join(broken, '.fleet-plugins.json'), '{"track":["process"]}\n');
    const stuck = run(broken);
    expect(stuck.status).toBe(0);
    expect(stuck.stderr).toContain('项目设置读不成，没改');
    expect(readSettings(broken)).toBe('{');
  });

  // #2721：Grok、Cursor、Mirasim 起的引擎会话不带 FLEET_HEADLESS，照样跑用户级的这个加载器，改了树里的项目设置，
  // 交活核对看到 M .claude/settings.json 就判返工。引擎的树都是从 bundle 取的，一定有 refs/fleet/incoming（本机的检出没有）。
  it('【故意造出的失败】引擎的树（有 refs/fleet/incoming）、没带 FLEET_HEADLESS：项目设置一个字节不改', () => {
    const cwd = temp();
    const git = (...args: string[]) =>
      runChildOk('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
    git('init', '-q');
    mkdirSync(join(cwd, '.claude'));
    const original = '{\n  "env": {}\n}\n';
    writeFileSync(join(cwd, '.claude', 'settings.json'), original);
    writeFileSync(join(cwd, '.fleet-plugins.json'), '{"track":["process"]}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/fleet/incoming', 'HEAD');
    const r = run(cwd, { FLEET_HEADLESS: '' });
    expect(r.status, r.stderr).toBe(0);
    expect(readSettings(cwd)).toBe(original);

    // 同样的树没有这个引用（本机的检出）：照旧写
    git('update-ref', '-d', 'refs/fleet/incoming');
    expect(run(cwd, { FLEET_HEADLESS: '' }).status).toBe(0);
    expect(readSettings(cwd)).not.toBe(original);
  });
});

it('真实退役inbox-watch精确清受管登记，混组第三方原样保留且幂等', () => {
  const name = 'inbox-watch.mjs';
  const owned = [
    { type: 'command', command: lib.commandFor(HOOKS, name), timeout: 1 },
    { type: 'command', command: 'node "D:/current/agents/hooks/' + name + '"', timeout: 1 },
    ...['$CLAUDE_PROJECT_DIR', '${CLAUDE_PROJECT_DIR}'].map((p) => ({
      type: 'command',
      command: 'node "' + p + '/agents/hooks/' + name + '"',
      timeout: 1,
    })),
    ...['node', 'C:/Program Files/nodejs/node.exe'].map((command) => ({
      type: 'command',
      command,
      args: [HOOKS + '/' + name],
      timeout: 1,
    })),
  ];
  const foreign = [
    { type: 'command', command: 'node "D:/other/agents/hooks/' + name + '"', timeout: 2 },
    { type: 'command', command: 'node "/thirdparty/' + name + '"', timeout: 3 },
    { type: 'command', command: 'node', args: [HOOKS + '/' + name, '--foreign'], timeout: 4 },
    { type: 'command', command: lib.commandFor(HOOKS, name) + ' && echo next', timeout: 5 },
    { type: 'command', command: lib.commandFor(HOOKS, 'unknown.mjs'), timeout: 6 },
    { type: 'command', command: 'echo thirdparty', timeout: 7 },
  ];
  const input = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', tag: 'keep', hooks: [...owned, ...foreign] }],
      Stop: [{ hooks: owned }],
    },
  };
  const before = structuredClone(input);
  for (const track of [[], ['process']]) {
    const next = lib.applyCatalog(input, track, HOOKS, { projectDir: 'D:/current' });
    expect(next.hooks?.PreToolUse?.[0]).toEqual({ matcher: 'Bash', tag: 'keep', hooks: foreign });
    expect(
      Object.values(next.hooks ?? {})
        .flatMap((gs) => gs.flatMap((g) => g.hooks))
        .filter((h) => owned.some((o) => JSON.stringify(o) === JSON.stringify(h))),
    ).toEqual([]);
    expect(lib.applyCatalog(next, track, HOOKS, { projectDir: 'D:/current' })).toEqual(next);
  }
  expect(input).toEqual(before);
});
