// 钩子：脚本拷进 ~/.fleet-dao/hooks/，在 ~/.claude/settings.json 里登记；只动本脚本管的那几条，别的钩子、别的设置一条不碰。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyHooks, checkHooks, type HookSkip, hookCommand, ownedScript } from '../src/hooks.ts';
import { exitCode } from '../src/report.ts';
import { type AgentId, HOOK_TARGETS } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  expectKind,
  get,
  getJson,
  HOOK_FILES,
  kinds,
  makeRepo,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-09-26T06:00:00Z');
const SETTINGS = '~/.claude/settings.json';
const SCRIPTS = '~/.fleet-dao/hooks';
/** 调工具前那条登记的 matcher（targets.ts，一组一个）：下面「挂在哪些工具上」那组钉住它们的值 */
const PRETOOL_MATCHERS = HOOK_TARGETS.flatMap((t) => t.hooks)
  .filter((h) => h.script === 'pretool.mjs')
  .map((h) => h.matcher ?? '没写 matcher');

/** 装好以后 PreToolUse 下该有的几组：一个 matcher 一组，都跑 pretool.mjs */
const pretoolGroups = (command: string): Group[] =>
  PRETOOL_MATCHERS.map((matcher) => ({ matcher, hooks: [{ type: 'command', command, timeout: 10 }] }));

function machine(
  installed: AgentId[] = ['claude'],
  hooks: Record<string, string> | null = HOOK_FILES,
  skip?: HookSkip,
) {
  const home = tempDir('home');
  const src = sources(makeRepo({}, undefined, hooks));
  const ctx = ctxFor(home, installed);
  return {
    home,
    apply: () => applyHooks(ctx, src, new Backups(home, PLATFORM, NOW), skip),
    check: () => checkHooks(ctx, src, skip),
    cmd: (script: string) => hookCommand(home, PLATFORM, script),
    settings: () => getJson(home, '.claude/settings.json') as Settings,
  };
}

interface Handler {
  type?: string;
  command?: string;
  timeout?: number;
}
interface Group {
  matcher?: string;
  hooks: Handler[];
}
interface Settings {
  hooks: Record<string, Group[]>;
  [k: string]: unknown;
}

/** 本机现在手装的那份（fleet-guard 两条）加 jev-shim 的一条、别的设置 */
function lived(): Settings {
  return {
    env: { SOME_FLAG: '1' },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: 'node /x/.local/share/fleet-guard/pretool.mjs', timeout: 10 }],
        },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'node /x/my-own-check.mjs' }] },
      ],
      PostToolUse: [
        {
          matcher: 'mcp__jev-ultrafast__browser_goal',
          hooks: [{ type: 'command', command: 'node /x/.local/share/jev-shim/ledger.mjs', timeout: 10 }],
        },
      ],
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: 'node /x/.local/share/fleet-guard/session-start.mjs', timeout: 30 },
          ],
        },
        { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] },
      ],
    },
    autoUpdatesChannel: 'latest',
  };
}

describe('装', () => {
  it('脚本拷进 ~/.fleet-dao/hooks/，settings.json 里登记两条；查判一致；第二遍零改动', () => {
    const m = machine();
    const lines = m.apply();
    expectKind(lines, SCRIPTS, 'changed');
    expectKind(lines, SETTINGS, 'changed');
    expect(get(m.home, '.fleet-dao/hooks/session-start.mjs')).toBe(HOOK_FILES['session-start.mjs']);
    const s = m.settings();
    expect(s.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: m.cmd('session-start.mjs'), timeout: 90 }] },
    ]);
    expect(s.hooks.PreToolUse).toEqual(pretoolGroups(m.cmd('pretool.mjs')));
    expect(m.cmd('pretool.mjs')).toMatch(/^node ".*\/\.fleet-dao\/hooks\/pretool\.mjs"$/);
    const checked = m.check();
    expectKind(checked, SCRIPTS, 'ok');
    expectKind(checked, SETTINGS, 'ok');
    expect(exitCode(checked)).toBe(0);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });

  it('钩子没装：--check 判红（脚本、登记都缺失，退出码 1）', () => {
    const m = machine();
    const lines = m.check();
    expectKind(lines, SCRIPTS, 'missing');
    expectKind(lines, SETTINGS, 'missing');
    expect(exitCode(lines)).toBe(1);
    put(
      m.home,
      '.claude/settings.json',
      JSON.stringify({ hooks: { PostToolUse: lived().hooks.PostToolUse } }),
    );
    const partly = m.check();
    expectKind(partly, SETTINGS, 'missing');
    expect(partly.find((l) => l.key === SETTINGS)?.text).toContain(
      '没登记 SessionStart（session-start.mjs）、PreToolUse（pretool.mjs，matcher Bash|PowerShell|Read|Grep）',
    );
  });

  it('装好以后有人删了本脚本那条：查判缺失，再写补回来', () => {
    const m = machine();
    m.apply();
    const s = m.settings();
    s.hooks.PreToolUse = [];
    put(m.home, '.claude/settings.json', JSON.stringify(s));
    expectKind(m.check(), SETTINGS, 'missing');
    expectKind(m.apply(), SETTINGS, 'changed');
    expect(exitCode(m.check())).toBe(0);
  });

  it('以前装的只挂 Bash|PowerShell 一组：查判漂移（多出那组、缺了该有的），再写换成现在的，别的不动', () => {
    const m = machine();
    const before = lived();
    before.hooks.PreToolUse = [
      {
        matcher: 'Bash|PowerShell',
        hooks: [{ type: 'command', command: m.cmd('pretool.mjs'), timeout: 10 }],
      },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'node /x/my-own-check.mjs' }] },
    ];
    before.hooks.SessionStart = [
      { hooks: [{ type: 'command', command: m.cmd('session-start.mjs'), timeout: 90 }] },
    ];
    put(m.home, '.claude/settings.json', JSON.stringify(before));
    const old = m.check().find((l) => l.key === SETTINGS);
    expect(old?.kind).toBe('drift');
    expect(old?.text).toContain('pretool.mjs 多登记了一条：挂在 PreToolUse 上、matcher 是 "Bash|PowerShell"');
    expectKind(m.apply(), SETTINGS, 'changed');
    const s = m.settings();
    expect(s.hooks.PreToolUse).toEqual([before.hooks.PreToolUse[1], ...pretoolGroups(m.cmd('pretool.mjs'))]);
    expect(s.hooks.PostToolUse).toEqual(before.hooks.PostToolUse);
    expect(exitCode(m.check())).toBe(0);
  });
});

// 调工具前那条挂在哪些工具上（改标准：targets.ts 在 standard-paths.json 里）：跑命令的 Bash、PowerShell，
// 读文件、搜内容的 Read、Grep——2026-09-27 帅位用命令读漏了 reclaude 的设备密钥，只拦命令、Read 照样能读进对话。
// Glob 只列路径（和 ls 一样放行），不挂：挂上只会多一个要认的别家工具名（Grok 把 Glob 换成它的 list_dir）。
// Devin 不换 Claude 的工具名、按不锚定的正则比它自己的小写名字，所以另一组锚定的 ^(exec|read|grep)$。
describe('调工具前那条挂在哪些工具上', () => {
  it('两组：Claude 的名字 Bash、PowerShell、Read、Grep（只含字母和 |，逐个全等比）；Devin 的名字 exec、read、grep（锚定）', () => {
    expect(PRETOOL_MATCHERS).toEqual(['Bash|PowerShell|Read|Grep', '^(exec|read|grep)$']);
  });

  it('Devin 那组锚定了：不会连 notebook_read、read_subagent、mcp_read_resource、MCP 工具一起匹配上', () => {
    const devin = new RegExp(PRETOOL_MATCHERS[1] ?? '');
    for (const name of ['exec', 'read', 'grep']) expect([name, devin.test(name)]).toEqual([name, true]);
    for (const name of [
      'notebook_read',
      'read_subagent',
      'mcp_read_resource',
      'mcp__fs__read',
      'Read',
      'Bash',
    ]) {
      expect([name, devin.test(name)]).toEqual([name, false]);
    }
  });

  // 登记了、脚本却认不得的工具名，钩子按「认不出按拦处理」会把那个工具的每次调用都拦下：登记的每一个都要认得
  it('登记的每个工具名，仓里的 pretool.mjs 都认得：正常的一次调用放行', async () => {
    const hook = fileURLToPath(new URL('../../../agents/hooks/pretool.mjs', import.meta.url));
    const lib = (await import(pathToFileURL(hook).href)) as {
      decide(raw: string, cwd?: string): { code: number; message?: string };
    };
    const normal: Record<string, Record<string, unknown>> = {
      Bash: { command: 'git status' },
      PowerShell: { command: 'Get-ChildItem' },
      Read: { file_path: '/work/repo/README.md' },
      Grep: { pattern: 'TODO', path: '/work/repo/src' },
      exec: { command: 'git status', shell_id: 'main' },
      read: { file_path: '/work/repo/README.md' },
      grep: { pattern: 'TODO', path: '/work/repo/src' },
    };
    const names = PRETOOL_MATCHERS.flatMap((m) => m.replace(/^\^\(|\)\$$/g, '').split('|'));
    expect([...names].sort()).toEqual(Object.keys(normal).sort());
    for (const name of names) {
      const got = lib.decide(
        JSON.stringify({ tool_name: name, tool_input: normal[name], cwd: '/work/repo' }),
      );
      expect([name, got.code, got.message]).toEqual([name, 0, undefined]);
    }
  });

  it('替别的用户写（法国装机）：开会话那条不登记、说清为什么，调工具前那条照装', () => {
    const skip: HookSkip = { event: 'SessionStart', why: '开会话钩子要在那个用户自己能写的检出里快进' };
    const m = machine(['claude'], HOOK_FILES, skip);
    const lines = m.apply();
    expectKind(lines, SCRIPTS, 'changed');
    expectKind(lines, SETTINGS, 'changed');
    expect(lines.find((l) => l.key === 'SessionStart')).toMatchObject({
      kind: 'skip',
      text: `SessionStart：${skip.why}`,
    });
    const s = m.settings();
    expect(Object.keys(s.hooks)).toEqual(['PreToolUse']);
    expect(s.hooks.PreToolUse).toEqual(pretoolGroups(m.cmd('pretool.mjs')));
    expect(exitCode(m.check())).toBe(0);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });
});

describe('别的钩子、别的设置一条不碰', () => {
  it('jev-shim 的、自己加的、别家的钩子和 env 原样留着；以前手装的 fleet-guard 两条换成本脚本的；原文件先备份', () => {
    const m = machine();
    const before = lived();
    put(m.home, '.claude/settings.json', JSON.stringify(before, null, 2));
    const drift = m.check();
    expectKind(drift, SETTINGS, 'drift');
    expect(drift.find((l) => l.key === SETTINGS)?.text).toContain('还挂着以前手装的');
    const lines = m.apply();
    expectKind(lines, SETTINGS, 'changed');
    const text = lines.find((l) => l.key === SETTINGS)?.text ?? '';
    expect(text).toContain('换掉了以前手装的 2 条');
    expect(text).toContain('别的 3 条钩子没动');
    const s = m.settings();
    expect(s.env).toEqual(before.env);
    expect(s.autoUpdatesChannel).toBe('latest');
    expect(s.hooks.PostToolUse).toEqual(before.hooks.PostToolUse);
    expect(s.hooks.PreToolUse).toEqual([
      before.hooks.PreToolUse?.[1],
      ...pretoolGroups(m.cmd('pretool.mjs')),
    ]);
    expect(s.hooks.SessionStart).toEqual([
      before.hooks.SessionStart?.[1],
      { hooks: [{ type: 'command', command: m.cmd('session-start.mjs'), timeout: 90 }] },
    ]);
    const all = JSON.stringify(s);
    expect(all).not.toContain('fleet-guard');
    const backups = join(m.home, '.fleet-dao', 'backups');
    const [stamp] = readdirSync(backups);
    expect(getJson(join(backups, stamp ?? ''), '.claude/settings.json')).toEqual(before);
    expect(exitCode(m.check())).toBe(0);
  });

  it('同一个组里还有别人的钩子：只拿掉本脚本那一条，组留着', () => {
    const m = machine();
    put(
      m.home,
      '.claude/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash|PowerShell',
              hooks: [
                { type: 'command', command: 'node /x/.local/share/fleet-guard/pretool.mjs', timeout: 10 },
                { type: 'command', command: 'node /x/audit.mjs' },
              ],
            },
          ],
        },
      }),
    );
    m.apply();
    expect(m.settings().hooks.PreToolUse?.[0]).toEqual({
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: 'node /x/audit.mjs' }],
    });
  });

  it('文件是 \\r\\n 换行：写回去还是 \\r\\n', () => {
    const m = machine();
    put(m.home, '.claude/settings.json', JSON.stringify({ env: {} }, null, 2).replaceAll('\n', '\r\n'));
    m.apply();
    expect(get(m.home, '.claude/settings.json')).toContain('\r\n');
    expect(exitCode(m.check())).toBe(0);
  });
});

describe('读不懂、被人改坏：不当成空的重写，报出来', () => {
  it('不是 JSON：写不动它、报没做成，文件一个字不动；查判漂移', () => {
    const m = machine();
    put(m.home, '.claude/settings.json', '{ 坏了');
    const lines = m.apply();
    expectKind(lines, SETTINGS, 'failed');
    expect(lines.find((l) => l.key === SETTINGS)?.text).toContain('不是合法的 JSON');
    expect(get(m.home, '.claude/settings.json')).toBe('{ 坏了');
    expectKind(m.check(), SETTINGS, 'drift');
  });

  it('hooks 不是对象、整份是数组：不动', () => {
    const m = machine();
    put(m.home, '.claude/settings.json', JSON.stringify({ hooks: [] }));
    expectKind(m.apply(), SETTINGS, 'failed');
    expect(get(m.home, '.claude/settings.json')).toBe('{"hooks":[]}');
    put(m.home, '.claude/settings.json', '[]');
    expectKind(m.apply(), SETTINGS, 'failed');
    expect(get(m.home, '.claude/settings.json')).toBe('[]');
  });

  it('disableAllHooks 开着：登记照写，但报没做成、要人看；查判漂移', () => {
    const m = machine();
    put(m.home, '.claude/settings.json', JSON.stringify({ disableAllHooks: true }));
    const lines = m.apply();
    expectKind(lines, SETTINGS, 'failed');
    expect(lines.find((l) => l.key === SETTINGS)?.text).toContain('disableAllHooks 开着');
    expect(m.settings().disableAllHooks).toBe(true);
    expect(m.settings().hooks.SessionStart).toHaveLength(1);
    expectKind(m.check(), SETTINGS, 'drift');
    expectKind(m.apply(), SETTINGS, 'failed');
  });

  it('登记得不对（timeout 被改、同一组登记了两遍）：查判漂移，再写每组只留一条对的', () => {
    const m = machine();
    m.apply();
    const s = m.settings();
    const group = s.hooks.PreToolUse?.[0] as Group;
    (group.hooks[0] as Handler).timeout = 99;
    s.hooks.PreToolUse?.push(structuredClone(group));
    put(m.home, '.claude/settings.json', JSON.stringify(s));
    const drift = m.check().find((l) => l.key === SETTINGS)?.text ?? '';
    expect(drift).toContain('pretool.mjs 登记了 2 次');
    expect(drift).toContain('timeout 是 99，应是 10');
    m.apply();
    expect(m.settings().hooks.PreToolUse).toEqual(pretoolGroups(m.cmd('pretool.mjs')));
    expect(exitCode(m.check())).toBe(0);
  });

  it('脚本被人改了：查判漂移，再写换回仓里的', () => {
    const m = machine();
    m.apply();
    put(m.home, '.fleet-dao/hooks/pretool.mjs', '// 被人改了\n');
    const drift = m.check();
    expectKind(drift, SCRIPTS, 'drift');
    expect(drift.find((l) => l.key === SCRIPTS)?.text).toContain('改了 pretool.mjs');
    expectKind(m.apply(), SCRIPTS, 'changed');
    expect(get(m.home, '.fleet-dao/hooks/pretool.mjs')).toBe(HOOK_FILES['pretool.mjs']);
  });

  it('仓里没有 agents/hooks/（检出太旧）：脚本查判没查成、登记照查（缺失），写报没做成，不登记指向空处的命令', () => {
    const m = machine(['claude'], null);
    const checked = m.check();
    expectKind(checked, SCRIPTS, 'unknown');
    expectKind(checked, SETTINGS, 'missing');
    expect(exitCode(checked)).toBe(1);
    const lines = m.apply();
    expectKind(lines, SCRIPTS, 'failed');
    expectKind(lines, SETTINGS, 'failed');
    expect(existsSync(join(m.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('仓里的 agents/hooks/ 少了登记要用的脚本：不登记', () => {
    const m = machine(['claude'], { 'session-start.mjs': '// 只有这一个\n' });
    const lines = m.apply();
    expectKind(lines, SETTINGS, 'failed');
    expect(lines.find((l) => l.key === SETTINGS)?.text).toContain('没有 pretool.mjs');
  });
});

describe('各家：装在哪、没装的说为什么', () => {
  it('没装读这份设置的那几家：跳过，什么都不写；装了的别家逐家说为什么没装钩子', () => {
    const m = machine(['codex', 'pi']);
    const lines = m.apply();
    expect(kinds(lines, SCRIPTS)).toEqual(['skip']);
    expect(existsSync(join(m.home, '.fleet-dao'))).toBe(false);
    expect(existsSync(join(m.home, '.claude'))).toBe(false);
    expect(lines.find((l) => l.key === 'Codex')?.text).toContain('/hooks 审过、信任了才跑');
    expect(lines.find((l) => l.key === 'pi')?.text).toContain('没有配置式的钩子');
    expect(exitCode(lines)).toBe(0);
  });

  it('只装了 Grok：它借道读 ~/.claude/settings.json，照样装、写明借道', () => {
    const m = machine(['grok']);
    const lines = m.apply();
    expectKind(lines, SETTINGS, 'changed');
    expect(lines.find((l) => l.key === SETTINGS)?.text).toContain('Grok（借道）');
  });

  it('认得哪些命令是本脚本管的：新的、以前手装的；别人的不认', () => {
    expect(ownedScript('node "C:/Users/u/.fleet-dao/hooks/pretool.mjs"')).toEqual({
      script: 'pretool.mjs',
      legacy: false,
    });
    expect(ownedScript('node C:\\Users\\u\\.local\\share\\fleet-guard\\session-start.mjs')).toEqual({
      script: 'session-start.mjs',
      legacy: true,
    });
    expect(ownedScript('node /x/.local/share/jev-shim/ledger.mjs')).toBeNull();
    expect(ownedScript('node /x/fleet-guard/pretool.mjs.bak')).toBeNull();
    expect(ownedScript(undefined)).toBeNull();
  });
});
