// 钩子：脚本拷进 ~/.fleet-dao/hooks/，在 ~/.claude/settings.json 里登记；只动本脚本管的那几条，别的钩子、别的设置一条不碰。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyHooks, checkHooks, type HookSkip, handlerFor, hookCommand, ownedScript } from '../src/hooks.ts';
import { exitCode } from '../src/report.ts';
import { readSources } from '../src/sync.ts';
import { type AgentId, HOOK_TARGETS } from '../src/targets.ts';
import { runChild } from './child.ts';
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

it('后台脱离原语随钩子安装，缺依赖时报真实路径', () => {
  const repo = makeRepo({}, undefined, { ...HOOK_FILES, 'background-launch.mjs': '// launcher' });
  const missing = sources(repo).hooks;
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.why).toContain('agents/local-sessions/detach.mjs');
  put(repo, 'agents/local-sessions/detach.mjs', 'export const spawnDetached = () => {};');
  const complete = sources(repo).hooks;
  expect(complete.ok).toBe(true);
  if (complete.ok)
    expect(complete.tree.get('_detach.mjs')?.toString()).toBe('export const spawnDetached = () => {};');
});

/**
 * 装好以后 PreToolUse 下该有的几组：照 Claude 那份登记的顺序一条一组（决定 0083：用户级只留拦密钥）。
 * cmd 把脚本名换成这台机器上登记的命令。
 */
const pretoolGroups = (m: { home: string; cmd: (script: string) => string }): Group[] =>
  (HOOK_TARGETS.find((t) => t.format === 'claude')?.hooks ?? [])
    .filter((h) => h.event === 'PreToolUse')
    .map((h) => ({
      ...(h.matcher === undefined ? {} : { matcher: h.matcher }),
      hooks: [
        h.exec
          ? // Claude 那组：exec 形式直接起 node，不经 Git Bash、不经启动器
            {
              type: 'command',
              command: 'node',
              args: [join(m.home, '.fleet-dao', 'hooks', h.script).replaceAll('\\', '/')],
              timeout: h.timeout,
              onFailure: 'block',
            }
          : {
              type: 'command',
              command: m.cmd(h.script),
              timeout: h.timeout,
              // Windows 上命令是启动器 exe：exec 形式（空 args，Grok 照常加载），不经 Git Bash
              ...(m.cmd(h.script).endsWith('.exe') ? { args: [] } : {}),
              onFailure: 'block',
            },
      ],
    }));

/** 用户级开会话那条（加载器）：Windows 上是启动器 exe，写空 args 走 exec 形式 */
const loaderGroup = (m: { cmd: (script: string) => string }): Group => ({
  hooks: [
    {
      type: 'command',
      command: m.cmd('plugin-loader.mjs'),
      timeout: 10,
      ...(m.cmd('plugin-loader.mjs').endsWith('.exe') ? { args: [] } : {}),
    },
  ],
});

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
  args?: string[];
  onFailure?: string;
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
  it('脚本拷进 ~/.fleet-dao/hooks/，settings.json 里只登记调工具前；查判一致；第二遍零改动', () => {
    const m = machine();
    const lines = m.apply();
    expectKind(lines, SCRIPTS, 'changed');
    expectKind(lines, SETTINGS, 'changed');
    expect(get(m.home, '.fleet-dao/hooks/session-start.mjs')).toBe(HOOK_FILES['session-start.mjs']);
    const s = m.settings();
    expect(Object.keys(s.hooks)).toEqual(['SessionStart', 'PreToolUse']);
    expect(s.hooks.PreToolUse).toEqual(pretoolGroups(m));
    expect(s.hooks.SessionStart).toEqual([loaderGroup(m)]);
    if (PLATFORM === 'win32') {
      expect(m.cmd('pretool.mjs')).toMatch(/\/\.fleet-dao\/bin\/quiet-pretool\.exe$/);
      expect(m.cmd('pretool.mjs')).not.toMatch(/[\s"$&|<>]/);
      expect(existsSync(m.cmd('pretool.mjs'))).toBe(true);
      expect(existsSync(m.cmd('session-start.mjs'))).toBe(false);
    } else {
      expect(m.cmd('pretool.mjs')).toMatch(/^node ".*\/\.fleet-dao\/hooks\/pretool\.mjs"$/);
    }
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
    const missing = partly.find((l) => l.key === SETTINGS)?.text ?? '';
    expect(missing).toContain('SessionStart（plugin-loader.mjs）');
    expect(missing).toContain(
      'PreToolUse（pretool.mjs，matcher Bash|PowerShell|Read|Grep|Agent|Task|Monitor|Workflow|mcp__mirasim__deliver_artifact|PushNotification）',
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
    expect(s.hooks.PreToolUse).toEqual([before.hooks.PreToolUse[1], ...pretoolGroups(m)]);
    expect(s.hooks.PostToolUse).toEqual(before.hooks.PostToolUse);
    expect(s.hooks.SessionStart).toEqual([loaderGroup(m)]);
    expect(exitCode(m.check())).toBe(0);
  });
});

// 调工具前那条超时即拦（决定 0093 B1）：Claude Code 默认钩子超时就放行，等于安全检查空过。
// 不做「连续超时自动放行」：超时就拦，恢复路径见 docs/ops.md「钩子超时被拦」。
describe('调工具前那条超时即拦', () => {
  it('Claude 那份里调工具前的每一条都是 onFailure: block', () => {
    const claude = HOOK_TARGETS.find((t) => t.format === 'claude');
    const pre = (claude?.hooks ?? []).filter((h) => h.event === 'PreToolUse');
    expect(pre.length).toBeGreaterThan(0);
    for (const h of pre) expect([h.matcher, h.onFailure]).toEqual([h.matcher, 'block']);
  });

  it('以前登记的没写 onFailure（超时放行）：查判漂移，再写补上，别的不动', () => {
    const m = machine();
    m.apply();
    const s = m.settings();
    for (const g of s.hooks.PreToolUse ?? []) for (const h of g.hooks) delete h.onFailure;
    put(m.home, '.claude/settings.json', JSON.stringify(s));
    const drift = m.check().find((l) => l.key === SETTINGS);
    expect(drift?.kind).toBe('drift');
    expect(drift?.text).toContain('onFailure 是 undefined，应是 block');
    expectKind(m.apply(), SETTINGS, 'changed');
    expect(m.settings().hooks.PreToolUse).toEqual(pretoolGroups(m));
    expect(exitCode(m.check())).toBe(0);
  });

  it('Claude 那组是 exec 形式直接起 node（不经 Git Bash、不经启动器）；以前登记的 shell 形式判漂移，再写换掉、不留两条', () => {
    const m = machine();
    m.apply();
    const s = m.settings();
    const first = s.hooks.PreToolUse?.[0]?.hooks[0];
    expect(first?.command).toBe('node');
    expect(first?.args).toEqual([join(m.home, '.fleet-dao', 'hooks', 'pretool.mjs').replaceAll('\\', '/')]);
    const old = s.hooks.PreToolUse?.[0];
    if (old)
      old.hooks = [{ type: 'command', command: m.cmd('pretool.mjs'), timeout: 10, onFailure: 'block' }];
    put(m.home, '.claude/settings.json', JSON.stringify(s));
    expect(m.check().find((l) => l.key === SETTINGS)?.text).toContain('命令和本机该有的不一样');
    expectKind(m.apply(), SETTINGS, 'changed');
    expect(m.settings().hooks.PreToolUse).toEqual(pretoolGroups(m));
  });

  it.skipIf(PLATFORM !== 'win32')(
    'Windows 上第二组（Devin、Grok）命令是启动器 exe、写空 args（Grok 照常加载），少了判漂移',
    () => {
      const m = machine();
      m.apply();
      const s = m.settings();
      const second = s.hooks.PreToolUse?.[1]?.hooks[0];
      expect(second?.command).toMatch(/\/quiet-pretool\.exe$/);
      expect(second?.args).toEqual([]);
      if (second) delete second.args;
      put(m.home, '.claude/settings.json', JSON.stringify(s));
      expect(m.check().find((l) => l.key === SETTINGS)?.text).toContain('args 是 null，应是 []');
    },
  );

  it('别家写法不加 onFailure、args（它们没有这个开关，Kimi Code 多一个键整份配置读不起来）', () => {
    for (const t of HOOK_TARGETS.filter((x) => x.format !== 'claude')) {
      for (const spec of t.hooks) {
        const h = handlerFor(t, { ...spec, onFailure: 'block', exec: true }, 'C:/Users/u', 'win32');
        expect(Object.keys(h).sort()).toEqual(['command', 'timeout', 'type']);
      }
    }
  });
});

// 调工具前那条挂在哪些工具上（改标准：targets.ts 在 standard-paths.json 里）：跑命令的 Bash、PowerShell，
// 读文件、搜内容的 Read、Grep——2026-09-27 帅位用命令读漏了 reclaude 的设备密钥，只拦命令、Read 照样能读进对话。
// Glob 只列路径（和 ls 一样放行），不挂：挂上只会多一个要认的别家工具名（Grok 把 Glob 换成它的 list_dir）。
// Devin 不换 Claude 的工具名、按不锚定的正则比它自己的小写名字，所以另一组锚定的；Grok 跳过第一组（exec 形式带非空 args），
// 它的 run_terminal_command、read_file 也放进这一组（grep 两家同名）。
describe('调工具前那条挂在哪些工具上', () => {
  it('两组：Claude 的名字 Bash、PowerShell、Read、Grep 加起后台活的 Agent、Task、Monitor、Workflow，再加算「送到创始人手上」的 deliver_artifact、PushNotification（逐个全等比）；Devin 的名字 exec、read、grep 加 Grok 的 run_terminal_command、read_file（锚定）', () => {
    expect(PRETOOL_MATCHERS).toEqual([
      'Bash|PowerShell|Read|Grep|Agent|Task|Monitor|Workflow|mcp__mirasim__deliver_artifact|PushNotification',
      '^(exec|read|grep|run_terminal_command|read_file)$',
    ]);
  });

  it('Devin 那组锚定了：不会连 notebook_read、read_subagent、mcp_read_resource、MCP 工具一起匹配上', () => {
    const devin = new RegExp(PRETOOL_MATCHERS[1] ?? '');
    for (const name of ['exec', 'read', 'grep', 'run_terminal_command', 'read_file'])
      expect([name, devin.test(name)]).toEqual([name, true]);
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
      run_terminal_command: { command: 'git status' },
      read_file: { target_file: '/work/repo/README.md' },
      Agent: { prompt: '查一下', description: '查' },
      Task: { prompt: '查一下', description: '查' },
      Monitor: { command: 'until false; do sleep 1; done' },
      Workflow: { script: 'x' },
      mcp__mirasim__deliver_artifact: { path: '/work/repo/_tmp/answer.md' },
      PushNotification: { message: '答复发你了', status: 'proactive' },
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

  it('跳过已经不在目标里的 SessionStart：多报一行，登记仍只有调工具前', () => {
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
    expect(s.hooks.PreToolUse).toEqual(pretoolGroups(m));
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
    expect(s.hooks.PreToolUse).toEqual([before.hooks.PreToolUse?.[1], ...pretoolGroups(m)]);
    expect(s.hooks.SessionStart).toEqual([before.hooks.SessionStart?.[1], loaderGroup(m)]);
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
    expect(m.settings().hooks.PreToolUse).toHaveLength(2);
    expect(m.settings().hooks.SessionStart).toEqual([loaderGroup(m)]);
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
    expect(m.settings().hooks.PreToolUse).toEqual(pretoolGroups(m));
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

  it('退役脚本查出漂移后清除，当前helper保留，二次apply不变', () => {
    const scripts = {
      ...HOOK_FILES,
      'background-recovery.mjs': '// recovery',
      'session-id.mjs': '// pure sid',
    };
    const m = machine(['claude'], scripts);
    m.apply();
    for (const name of ['steer-recover.mjs', 'inbox-tick.mjs', 'inbox-watch.mjs', 'steer-shown.mjs'])
      put(m.home, '.fleet-dao/hooks/' + name, '// retired');
    const drift = m.check();
    expectKind(drift, SCRIPTS, 'drift');
    for (const name of ['inbox-tick.mjs', 'inbox-watch.mjs', 'steer-shown.mjs'])
      expect(drift.find((l) => l.key === SCRIPTS)?.text).toContain(name);
    expectKind(m.apply(), SCRIPTS, 'changed');
    expect(readdirSync(join(m.home, '.fleet-dao', 'hooks')).sort()).toEqual(Object.keys(scripts).sort());
    expect(exitCode(m.check())).toBe(0);
    expectKind(m.apply(), SCRIPTS, 'ok');
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
    expect(lines.find((l) => l.key === SETTINGS)?.text).toContain('没有 plugin-loader.mjs');
  });
});

describe('Windows 上不经 cmd 启动', () => {
  it('没有空格的家目录：命令是单个不带引号的静默启动器；有空格就退回 node 加引号；Linux 始终 node', () => {
    expect(hookCommand('C:/Users/u', 'win32', 'pretool.mjs')).toBe(
      'C:/Users/u/.fleet-dao/bin/quiet-pretool.exe',
    );
    expect(hookCommand('C:/Users/u', 'win32', 'session-start.mjs')).toBe(
      'C:/Users/u/.fleet-dao/bin/quiet-session-start.exe',
    );
    expect(hookCommand('C:/Users/Ada Lovelace', 'win32', 'stop.mjs')).toBe(
      'node "C:/Users/Ada Lovelace/.fleet-dao/hooks/stop.mjs"',
    );
    expect(hookCommand('/home/u', 'linux', 'prompt-log.mjs')).toBe(
      'node "/home/u/.fleet-dao/hooks/prompt-log.mjs"',
    );
  });
});

describe('各家：装在哪、没装的说为什么', () => {
  it('没装读钩子设置的那几家：跳过，什么都不写；装了的别家逐家说为什么没装钩子', () => {
    const m = machine(['dsh', 'pi']);
    const lines = m.apply();
    expect(kinds(lines, SCRIPTS)).toEqual(['skip']);
    expect(existsSync(join(m.home, '.fleet-dao'))).toBe(false);
    expect(existsSync(join(m.home, '.claude'))).toBe(false);
    expect(lines.find((l) => l.key === 'dsh')?.text).toContain('没有自带的全局钩子');
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
    expect(ownedScript('C:/Users/u/.fleet-dao/bin/quiet-session-start.exe')).toEqual({
      script: 'session-start.mjs',
      legacy: false,
    });
    expect(ownedScript('C:/Users/u/.fleet-dao/bin/quiet-prompt-log.exe')).toEqual({
      script: 'prompt-log.mjs',
      legacy: false,
    });
    expect(ownedScript('C:/Users/u/.fleet-dao/bin/quiet-pretool.exe.bak')).toBeNull();
    expect(ownedScript('node C:\\Users\\u\\.local\\share\\fleet-guard\\session-start.mjs')).toEqual({
      script: 'session-start.mjs',
      legacy: true,
    });
    expect(ownedScript('node /x/.local/share/jev-shim/ledger.mjs')).toBeNull();
    expect(ownedScript('node /x/fleet-guard/pretool.mjs.bak')).toBeNull();
    expect(ownedScript(undefined)).toBeNull();
  });
});

it('完整源码readSources到临时安装，真实main-thread与session-start可加载新helper', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const read = readSources(repo);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error(read.why);
  const home = tempDir('full-source-hooks');
  const ctx = ctxFor(home, ['claude']);
  const src = read.value;
  expectKind(applyHooks(ctx, src, new Backups(home, PLATFORM, NOW)), SCRIPTS, 'changed');
  for (const name of ['session-id.mjs', 'background-recovery.mjs'])
    expect(existsSync(join(home, '.fleet-dao', 'hooks', name))).toBe(true);
  for (const name of ['inbox-tick.mjs', 'inbox-watch.mjs', 'steer-shown.mjs'])
    expect(existsSync(join(home, '.fleet-dao', 'hooks', name))).toBe(false);
  const installed = join(home, '.fleet-dao', 'hooks');
  const transcript = put(
    home,
    'transcript.jsonl',
    JSON.stringify({
      type: 'user',
      uuid: 'restart-full',
      origin: { kind: 'task-notification' },
      message: {
        content:
          '<task-notification><task-id>agent-full</task-id><summary>Agent check did not finish before the previous session ended</summary></task-notification>',
      },
    }),
  );
  const r = runChild(process.execPath, [join(installed, 'main-thread.mjs')], {
    input: JSON.stringify({ session_id: 'full', tool_name: 'Bash', transcript_path: transcript }),
    env: { ...process.env, FLEET_HEADLESS: '', FLEET_INBOX_SEEN_DIR: join(home, 'restart-state') },
  });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('agent-full');
  const start = await import(pathToFileURL(join(installed, 'session-start.mjs')).href);
  expect(
    start.recentPrompts({
      home,
      now: NOW.getTime(),
      sessionId: 'full',
      env: { FLEET_MIRASIM_DIR: join(home, 'none') },
    }),
  ).toEqual([]);
  expect(exitCode(checkHooks(ctx, src))).toBe(0);
  expectKind(applyHooks(ctx, src, new Backups(home, PLATFORM, NOW)), SCRIPTS, 'ok');
});
