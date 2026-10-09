// Gemini CLI 的钩子（#232）：登记在 ~/.gemini/settings.json 的 hooks（和 Claude 同一个写法，timeout 按毫秒），
// Windows 上命令写 node 加引号（它用 PowerShell 跑钩子命令，启动器的退出码 PowerShell 拿不到）。
// 只动本脚本的，别人的钩子、别的设置一条不碰；hooksConfig 把钩子关了的不替人打开。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyHooks, checkHooks, hookCommand } from '../src/hooks.ts';
import { exitCode } from '../src/report.ts';
import { HOOK_GAPS, HOOK_TARGETS } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  expectKind,
  getJson,
  HOOK_FILES,
  makeRepo,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-10-09T15:00:00Z');
const SETTINGS = '~/.gemini/settings.json';
const GEMINI = HOOK_TARGETS.find((t) => t.format === 'gemini');
const MATCHER = '^(run_shell_command|read_file|read_many_files|grep_search|search_file_content)$';

function machine() {
  const home = tempDir('home');
  const src = sources(makeRepo({}, undefined, HOOK_FILES));
  const ctx = ctxFor(home, ['gemini']);
  return {
    home,
    apply: () => applyHooks(ctx, src, new Backups(home, PLATFORM, NOW)),
    check: () => checkHooks(ctx, src),
    /** 登记的命令：各平台一律 node 加引号 */
    cmd: (script: string) => hookCommand(home, PLATFORM, script, true),
    settings: () =>
      getJson(home, '.gemini/settings.json') as Record<string, unknown> & { hooks: Record<string, unknown> },
  };
}

describe('登记在哪、挂在哪', () => {
  it('Gemini CLI 的目标：~/.gemini/settings.json，开会话 90 秒、调工具前（BeforeTool）10 秒，按毫秒写；挂跑命令、读文件、搜内容几个工具', () => {
    expect(GEMINI?.settings.linux).toBe('.gemini/settings.json');
    expect(GEMINI?.nodeOnWindows).toBe(true);
    expect(GEMINI?.hooks).toEqual([
      { event: 'SessionStart', script: 'session-start.mjs', timeout: 90_000 },
      { event: 'BeforeTool', matcher: MATCHER, script: 'pretool-gemini.mjs', timeout: 10_000 },
    ]);
    expect(HOOK_GAPS.gemini).toBeUndefined();
  });

  it('matcher 锚定了：只匹配这几个工具，不连 list_directory、glob、MCP 工具一起匹配上', () => {
    const re = new RegExp(MATCHER);
    for (const name of [
      'run_shell_command',
      'read_file',
      'read_many_files',
      'grep_search',
      'search_file_content',
    ])
      expect([name, re.test(name)]).toEqual([name, true]);
    for (const name of ['list_directory', 'glob', 'write_file', 'mcp_fs_read_file', 'read_file_extra'])
      expect([name, re.test(name)]).toEqual([name, false]);
  });

  it('Windows 上也写 node 加引号（PowerShell 拿不到启动器的退出码，拦下会变成放行）；故意造出的失败：不写 nodeOnWindows 就是启动器', () => {
    expect(hookCommand('C:/Users/u', 'win32', 'pretool-gemini.mjs', true)).toBe(
      'node "C:/Users/u/.fleet-dao/hooks/pretool-gemini.mjs"',
    );
    expect(hookCommand('C:/Users/u', 'win32', 'pretool-gemini.mjs')).toBe(
      'C:/Users/u/.fleet-dao/bin/quiet-pretool-gemini.exe',
    );
  });
});

describe('装', () => {
  it('新机器：登记两条、查全绿、第二遍零改动；不装启动器', () => {
    const m = machine();
    const lines = m.apply();
    expectKind(lines, SETTINGS, 'changed');
    expect(lines.find((l) => l.key === '~/.fleet-dao/bin')).toBeUndefined();
    expect(m.settings().hooks).toEqual({
      SessionStart: [{ hooks: [{ type: 'command', command: m.cmd('session-start.mjs'), timeout: 90_000 }] }],
      BeforeTool: [
        {
          matcher: MATCHER,
          hooks: [{ type: 'command', command: m.cmd('pretool-gemini.mjs'), timeout: 10_000 }],
        },
      ],
    });
    const checked = m.check();
    expectKind(checked, SETTINGS, 'ok');
    expect(exitCode(checked)).toBe(0);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });

  it('别的设置、别人的钩子原样留着，本脚本的接在后面', () => {
    const m = machine();
    const mine = {
      matcher: 'write_file',
      hooks: [{ name: 'lint', type: 'command', command: 'node /x/lint.js' }],
    };
    put(
      m.home,
      '.gemini/settings.json',
      JSON.stringify(
        { theme: 'GitHub', hooksConfig: { notifications: false }, hooks: { BeforeTool: [mine] } },
        null,
        2,
      ),
    );
    expectKind(m.apply(), SETTINGS, 'changed');
    const s = m.settings();
    expect(s.theme).toBe('GitHub');
    expect(s.hooksConfig).toEqual({ notifications: false });
    expect((s.hooks.BeforeTool as unknown[])[0]).toEqual(mine);
    expect(exitCode(m.check())).toBe(0);
    const [stamp] = readdirSync(join(m.home, '.fleet-dao', 'backups'));
    expect(
      getJson(join(m.home, '.fleet-dao', 'backups', stamp ?? ''), '.gemini/settings.json'),
    ).toMatchObject({ theme: 'GitHub' });
  });
});

describe('Gemini CLI 自己的开关把钩子关了：不替人打开，报出来', () => {
  it('hooksConfig.enabled 是 false：登记照写，写报没做成、查判漂移，开关一个字不动', () => {
    const m = machine();
    put(m.home, '.gemini/settings.json', JSON.stringify({ hooksConfig: { enabled: false } }));
    const lines = m.apply();
    expectKind(lines, SETTINGS, 'failed');
    expect(lines.find((l) => l.key === SETTINGS)?.text).toContain('hooksConfig.enabled 是 false');
    expect(m.settings().hooksConfig).toEqual({ enabled: false });
    expect(Object.keys(m.settings().hooks)).toEqual(['SessionStart', 'BeforeTool']);
    expectKind(m.check(), SETTINGS, 'drift');
  });

  it('hooksConfig.disabled 里列了本脚本的命令（/hooks disable 关的）：查判漂移；别人的名字列在里面不算', () => {
    const m = machine();
    m.apply();
    const s = m.settings();
    put(m.home, '.gemini/settings.json', JSON.stringify({ ...s, hooksConfig: { disabled: ['lint'] } }));
    expectKind(m.check(), SETTINGS, 'ok');
    put(
      m.home,
      '.gemini/settings.json',
      JSON.stringify({ ...s, hooksConfig: { disabled: ['lint', m.cmd('pretool-gemini.mjs')] } }),
    );
    const drift = m.check().find((l) => l.key === SETTINGS);
    expect(drift?.kind).toBe('drift');
    expect(drift?.text).toContain('hooksConfig.disabled 里列了本脚本的 1 条');
    expectKind(m.apply(), SETTINGS, 'failed');
  });

  it('settings.json 带注释（不是严格的 JSON）：不动、报出来，不当成空的重写', () => {
    const m = machine();
    const text = '{\n  // 我的设置\n  "theme": "GitHub"\n}\n';
    put(m.home, '.gemini/settings.json', text);
    expectKind(m.apply(), SETTINGS, 'failed');
    expectKind(m.check(), SETTINGS, 'drift');
  });
});
