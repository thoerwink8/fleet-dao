// Antigravity 的钩子（#232）：登记在 ~/.gemini/config/hooks.json 名叫 fleet-dao 的那一项（整项归本脚本）。
// 它没有开会话事件，只登记调工具前那条，每次报一行为什么。别的项一条不碰；人把那一项 enabled 设成 false 的不替人打开。
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
  get,
  getJson,
  HOOK_FILES,
  makeRepo,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-10-09T16:00:00Z');
const FILE = '~/.gemini/config/hooks.json';
const AGY = HOOK_TARGETS.find((t) => t.format === 'agy');
const MATCHER = '^(run_command|view_file|grep_search)$';

function machine() {
  const home = tempDir('home');
  const src = sources(makeRepo({}, undefined, HOOK_FILES));
  const ctx = ctxFor(home, ['agy']);
  const cmd = (script: string) => hookCommand(home, PLATFORM, script);
  return {
    home,
    apply: () => applyHooks(ctx, src, new Backups(home, PLATFORM, NOW)),
    check: () => checkHooks(ctx, src),
    cmd,
    mine: () => ({
      PreToolUse: [
        { matcher: MATCHER, hooks: [{ type: 'command', command: cmd('pretool-agy.mjs'), timeout: 10 }] },
      ],
    }),
    file: () => getJson(home, '.gemini/config/hooks.json') as Record<string, unknown>,
  };
}

/** 别人起了名字的两项 */
const OTHERS = {
  'lint-checker': {
    PostToolUse: [
      { matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh', timeout: 10 }] },
    ],
  },
  'safety-gate': {
    enabled: false,
    PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './scripts/safety-check.sh' }] }],
  },
};

describe('登记在哪、挂在哪', () => {
  it('Antigravity 的目标：~/.gemini/config/hooks.json 的 fleet-dao 那一项，只有调工具前那条（锚定 run_command、view_file、grep_search）；没有开会话事件、写明为什么', () => {
    expect(AGY?.settings.linux).toBe('.gemini/config/hooks.json');
    expect(AGY?.name).toBe('fleet-dao');
    expect(AGY?.hooks).toEqual([
      { event: 'PreToolUse', matcher: MATCHER, script: 'pretool-agy.mjs', timeout: 10 },
    ]);
    expect(AGY?.lacks?.why).toContain('没有开会话事件');
    expect(HOOK_GAPS.agy).toBeUndefined();
    const re = new RegExp(MATCHER);
    for (const name of ['run_command', 'view_file', 'grep_search'])
      expect([name, re.test(name)]).toEqual([name, true]);
    for (const name of ['list_dir', 'find_by_name', 'write_to_file', 'run_command_x', 'mcp_view_file'])
      expect([name, re.test(name)]).toEqual([name, false]);
  });
});

describe('装', () => {
  it('新机器：写出 fleet-dao 一项，每次报一行没登记开会话钩子；查全绿；第二遍零改动', () => {
    const m = machine();
    const lines = m.apply();
    expectKind(lines, FILE, 'changed');
    expect(m.file()).toEqual({ 'fleet-dao': m.mine() });
    expect(lines.find((l) => l.key === 'Antigravity 的开会话钩子')?.kind).toBe('skip');
    const checked = m.check();
    expectKind(checked, FILE, 'ok');
    expect(checked.find((l) => l.key === 'Antigravity 的开会话钩子')?.text).toContain('没有开会话事件');
    expect(exitCode(checked)).toBe(0);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });

  it('别人的项原样留着（含 enabled: false 的），原文件先备份', () => {
    const m = machine();
    const before = JSON.stringify(OTHERS, null, 2);
    put(m.home, '.gemini/config/hooks.json', before);
    expectKind(m.apply(), FILE, 'changed');
    expect(m.file()).toEqual({ ...OTHERS, 'fleet-dao': m.mine() });
    const [stamp] = readdirSync(join(m.home, '.fleet-dao', 'backups'));
    expect(get(join(m.home, '.fleet-dao', 'backups', stamp ?? ''), '.gemini/config/hooks.json')).toBe(before);
    expect(exitCode(m.check())).toBe(0);
  });

  it('fleet-dao 那一项被人改了（timeout、多挂了一组）：查判漂移，写整项换回仓里的样子', () => {
    const m = machine();
    m.apply();
    put(
      m.home,
      '.gemini/config/hooks.json',
      JSON.stringify({
        'fleet-dao': {
          PreToolUse: [
            {
              matcher: MATCHER,
              hooks: [{ type: 'command', command: m.cmd('pretool-agy.mjs'), timeout: 99 }],
            },
            { matcher: '*', hooks: [{ type: 'command', command: m.cmd('pretool-agy.mjs'), timeout: 10 }] },
          ],
        },
      }),
    );
    const drift = m.check().find((l) => l.key === FILE);
    expect(drift?.kind).toBe('drift');
    expect(drift?.text).toContain('timeout 是 99');
    expectKind(m.apply(), FILE, 'changed');
    expect(m.file()).toEqual({ 'fleet-dao': m.mine() });
  });

  it('别的项里混进了本脚本的命令：查判漂移，写时从那一项摘掉（那一项别的钩子留着）', () => {
    const m = machine();
    const mixed = {
      ...OTHERS,
      'old-guard': {
        PreToolUse: [
          {
            matcher: 'run_command',
            hooks: [
              { type: 'command', command: m.cmd('pretool-agy.mjs'), timeout: 10 },
              { type: 'command', command: './audit.sh' },
            ],
          },
        ],
      },
    };
    put(m.home, '.gemini/config/hooks.json', JSON.stringify(mixed));
    const drift = m.check().find((l) => l.key === FILE);
    expect(drift?.text).toContain('别的钩子项里也登记着本脚本的 pretool-agy.mjs');
    m.apply();
    expect(m.file()['old-guard']).toEqual({
      PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './audit.sh' }] }],
    });
    expect(exitCode(m.check())).toBe(0);
  });
});

describe('人关掉的、读不懂的：不替人做主', () => {
  it('fleet-dao 那一项的 enabled 是 false：登记照对，写报没做成、查判漂移，enabled 不替人改', () => {
    const m = machine();
    put(
      m.home,
      '.gemini/config/hooks.json',
      JSON.stringify({ 'fleet-dao': { enabled: false, ...m.mine() } }),
    );
    const lines = m.apply();
    expectKind(lines, FILE, 'failed');
    expect(lines.find((l) => l.key === FILE)?.text).toContain('enabled 是 false');
    expect((m.file()['fleet-dao'] as { enabled?: boolean }).enabled).toBe(false);
    expectKind(m.check(), FILE, 'drift');
  });

  it('fleet-dao 那一项不是对象、整份不是 JSON：不动、报没做成', () => {
    for (const text of ['{"fleet-dao": "关了"}', '{ 坏了']) {
      const m = machine();
      put(m.home, '.gemini/config/hooks.json', text);
      expectKind(m.apply(), FILE, 'failed');
      expect(get(m.home, '.gemini/config/hooks.json')).toBe(text);
      expectKind(m.check(), FILE, 'drift');
    }
  });
});
