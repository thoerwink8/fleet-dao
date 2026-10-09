// Kimi Code 的钩子（#232）：~/.kimi-code/config.toml 的 [[hooks]]，本脚本那几条写在末尾一块托管块里，块外一个字不碰；
// 和权限那块（permissions-vendors.ts）同一个文件、各管各的。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyHooks, checkHooks, hookCommand } from '../src/hooks.ts';
import { applyOtherPermissions, checkOtherPermissions } from '../src/permissions-vendors.ts';
import { exitCode } from '../src/report.ts';
import { HOOK_GAPS, HOOK_TARGETS } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  expectKind,
  get,
  HOOK_FILES,
  makeRepo,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-10-09T17:00:00Z');
const KEY = '~/.kimi-code/config.toml#hooks';
const PERM = '~/.kimi-code/config.toml#permission';
const KIMI = HOOK_TARGETS.find((t) => t.format === 'kimi');

function machine() {
  const home = tempDir('home');
  const src = sources(makeRepo({}, undefined, HOOK_FILES));
  const ctx = ctxFor(home, ['kimi']);
  return {
    home,
    apply: () => applyHooks(ctx, src, new Backups(home, PLATFORM, NOW)),
    check: () => checkHooks(ctx, src),
    applyPerms: () => applyOtherPermissions(ctx, src, new Backups(home, PLATFORM, NOW)),
    checkPerms: () => checkOtherPermissions(ctx, src),
    cmd: (script: string) => hookCommand(home, PLATFORM, script),
    config: () => get(home, '.kimi-code/config.toml'),
  };
}

/** 逐行读出 [[hooks]] 每张表的键值（只认本测试写出来的那种简单写法） */
function hookTables(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('[')) {
      cur = l === '[[hooks]]' ? {} : null;
      if (cur) out.push(cur);
      continue;
    }
    const m = /^(\w+)\s*=\s*(.*)$/.exec(l);
    if (cur && m?.[1] && m[2] !== undefined) cur[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
  }
  return out;
}

describe('登记在哪、挂在哪', () => {
  it('Kimi Code 的目标：~/.kimi-code/config.toml，开会话 90 秒、调工具前 10 秒只挂 ^(Bash|Read|Grep)$', () => {
    expect(KIMI?.settings.linux).toBe('.kimi-code/config.toml');
    expect(KIMI?.hooks).toEqual([
      { event: 'SessionStart', script: 'session-start.mjs', timeout: 90 },
      { event: 'PreToolUse', matcher: '^(Bash|Read|Grep)$', script: 'pretool-kimi.mjs', timeout: 10 },
    ]);
    expect(HOOK_GAPS.kimi).toBeUndefined();
    const re = /^(Bash|Read|Grep)$/;
    for (const name of ['Bash', 'Read', 'Grep']) expect(re.test(name)).toBe(true);
    for (const name of ['Glob', 'Write', 'ReadMediaFile', 'mcp__fs__Read'])
      expect([name, re.test(name)]).toEqual([name, false]);
  });
});

describe('装', () => {
  it('新机器：写出一块 [[hooks]]，每张表只有 event、matcher、command、timeout（多一个键 Kimi 整份配置读不起来）；查全绿；第二遍零改动', () => {
    const m = machine();
    expectKind(m.apply(), KEY, 'changed');
    const tables = hookTables(m.config());
    expect(tables).toEqual([
      { event: 'SessionStart', command: m.cmd('session-start.mjs'), timeout: '90' },
      {
        event: 'PreToolUse',
        matcher: '^(Bash|Read|Grep)$',
        command: m.cmd('pretool-kimi.mjs'),
        timeout: '10',
      },
    ]);
    for (const t of tables)
      for (const k of Object.keys(t)) expect(['event', 'matcher', 'command', 'timeout']).toContain(k);
    const checked = m.check();
    expectKind(checked, KEY, 'ok');
    expect(exitCode(checked)).toBe(0);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });

  it('原有的配置、别人的 [[hooks]] 一个字不动，块接在末尾；原文件先备份', () => {
    const m = machine();
    const before = [
      'default_permission_mode = "auto"',
      '',
      '[[hooks]]',
      'event = "Notification"',
      'matcher = "task\\\\.completed"',
      'command = "terminal-notifier -title Kimi"',
      '',
    ].join('\n');
    put(m.home, '.kimi-code/config.toml', before);
    expectKind(m.apply(), KEY, 'changed');
    expect(m.config().startsWith(before)).toBe(true);
    expect(hookTables(m.config())).toHaveLength(3);
    const [stamp] = readdirSync(join(m.home, '.fleet-dao', 'backups'));
    expect(get(join(m.home, '.fleet-dao', 'backups', stamp ?? ''), '.kimi-code/config.toml')).toBe(before);
    expect(exitCode(m.check())).toBe(0);
  });

  it('和权限那块同一个文件：两块各写各的，先写哪块都一样，两边查都绿', () => {
    for (const order of ['hooks-first', 'perms-first'] as const) {
      const m = machine();
      if (order === 'hooks-first') {
        m.apply();
        m.applyPerms();
      } else {
        m.applyPerms();
        m.apply();
      }
      expect([order, exitCode(m.check())]).toEqual([order, 0]);
      expectKind(m.checkPerms(), PERM, 'ok');
      expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
      expect(m.applyPerms().filter((l) => l.kind === 'changed')).toEqual([]);
    }
  });

  it('块被人改了：查判漂移，写换回仓里的', () => {
    const m = machine();
    m.apply();
    put(m.home, '.kimi-code/config.toml', m.config().replace('timeout = 10', 'timeout = 600'));
    const drift = m.check().find((l) => l.key === KEY);
    expect(drift?.kind).toBe('drift');
    expect(drift?.text).toContain('和仓里的不一样');
    expectKind(m.apply(), KEY, 'changed');
    expect(exitCode(m.check())).toBe(0);
  });
});

describe('读不懂、块外混进本脚本的：不猜，报出来', () => {
  it('hooks 被写成 [hooks] 表或顶层 hooks = []：[[hooks]] 加不进去，不动、报没做成，查判漂移', () => {
    for (const text of ['[hooks]\nfoo = 1\n', 'hooks = []\n']) {
      const m = machine();
      put(m.home, '.kimi-code/config.toml', text);
      expectKind(m.apply(), KEY, 'failed');
      expect(m.config()).toBe(text);
      expectKind(m.check(), KEY, 'drift');
    }
  });

  it('[features] 下的 hooks = true 不是顶层的 hooks，照常写', () => {
    const m = machine();
    put(m.home, '.kimi-code/config.toml', '[features]\nhooks = true\n');
    expectKind(m.apply(), KEY, 'changed');
    expect(exitCode(m.check())).toBe(0);
  });

  it('托管块的标记缺一行：不动、报没做成', () => {
    const m = machine();
    m.apply();
    const broken = m.config().replace(/# <<< fleet-dao 钩子\r?\n?/, '');
    put(m.home, '.kimi-code/config.toml', broken);
    expectKind(m.apply(), KEY, 'failed');
    expect(m.config()).toBe(broken);
  });

  it('块外有跑本脚本命令的 [[hooks]]（以前手抄的）：查判漂移；写时整张收回块里，别人的 [[hooks]]、紧挨下一张表的注释留着', () => {
    const m = machine();
    const mine = `[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = ${JSON.stringify(m.cmd('pretool-kimi.mjs'))}\n\n`;
    const theirs = '# 我的提醒\n[[hooks]]\nevent = "Notification"\ncommand = "notify-send done"\n';
    put(m.home, '.kimi-code/config.toml', `model = "k3"\n\n${mine}${theirs}`);
    const drift = m.check().find((l) => l.key === KEY);
    expect(drift?.kind).toBe('drift');
    expect(drift?.text).toContain('块外有 1 条');
    const lines = m.apply();
    expectKind(lines, KEY, 'changed');
    expect(lines.find((l) => l.key === KEY)?.text).toContain('收回了块里');
    expect(m.config().startsWith(`model = "k3"\n\n${theirs}`)).toBe(true);
    expect(hookTables(m.config()).map((t) => t.event)).toEqual([
      'Notification',
      'SessionStart',
      'PreToolUse',
    ]);
    expect(exitCode(m.check())).toBe(0);
  });

  it('Kimi Code 自己改写配置、把块的两行标记连同注释丢了：同步认得出那两张是本脚本的，收回块里，不登记两遍', () => {
    const m = machine();
    m.apply();
    const stripped = m.config().replace(/^# .*fleet-dao 钩子.*\r?\n/gm, '');
    put(m.home, '.kimi-code/config.toml', stripped);
    expect(stripped).not.toContain('# >>>');
    expectKind(m.check(), KEY, 'drift');
    m.apply();
    expect(hookTables(m.config())).toHaveLength(2);
    expect(exitCode(m.check())).toBe(0);
  });

  it('多行字符串里像表头的行不当表头：里面写着本脚本的命令也不删', () => {
    const m = machine();
    const text = `notes = """\n[[hooks]]\ncommand = ${JSON.stringify(m.cmd('pretool-kimi.mjs'))}\n"""\n`;
    put(m.home, '.kimi-code/config.toml', text);
    m.apply();
    expect(m.config().startsWith(text)).toBe(true);
  });
});
