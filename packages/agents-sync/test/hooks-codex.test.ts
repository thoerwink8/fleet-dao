// Codex 的钩子（#232）：登记在 ~/.codex/hooks.json（和 Claude 同一个写法），替本脚本那几条在 ~/.codex/config.toml 记上信任
// （hooks-codex.ts）。只动本脚本的，别人的钩子、别的配置一条不碰；人在 /hooks 里关掉的不替人打开。
import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyHooks, checkHooks, type HookSkip, hookCommand } from '../src/hooks.ts';
import { codexHookHash, scanCodexConfig } from '../src/hooks-codex.ts';
import { exitCode } from '../src/report.ts';
import { HOOK_GAPS, HOOK_TARGETS } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  expectKind,
  get,
  getJson,
  HOOK_FILES,
  linkDir,
  makeRepo,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-10-09T14:00:00Z');
const HOOKS_JSON = '~/.codex/hooks.json';
const TRUST = '~/.codex/config.toml#hooks.state';
const CODEX = HOOK_TARGETS.find((t) => t.format === 'codex');

function machine(skip?: HookSkip, home = tempDir('home')) {
  const src = sources(makeRepo({}, undefined, HOOK_FILES));
  const ctx = ctxFor(home, ['codex']);
  const cmd = (script: string) => hookCommand(home, PLATFORM, script);
  return {
    home,
    apply: () => applyHooks(ctx, src, new Backups(home, PLATFORM, NOW), skip),
    check: () => checkHooks(ctx, src, skip),
    cmd,
    hooksJson: () => getJson(home, '.codex/hooks.json') as { hooks: Record<string, unknown[]> },
    config: () => get(home, '.codex/config.toml'),
    /** Codex 给 hooks.json 里第 g 组第 h 条记信任用的键（路径是真实路径：Windows 上临时目录可能是 8.3 短名） */
    key: (event: string, g: number, h = 0) =>
      `${join(realpathSync.native(join(home, '.codex')), 'hooks.json')}:${event}:${g}:${h}`,
    hash: (event: string, matcher: string | undefined, script: string, timeout: number) =>
      codexHookHash(event, matcher, cmd(script), timeout),
  };
}

/** config.toml 里 [hooks.state."K"] 的 trusted_hash、enabled（逐行认的结果） */
function state(text: string, key: string) {
  const s = scanCodexConfig(text);
  if (!s.ok) throw new Error(s.why);
  const e = s.value.entries.get(key);
  return { trusted: e?.trustedHash?.value, enabled: e?.enabled?.value };
}

describe('登记在哪、挂在哪', () => {
  it('Codex 的目标：~/.codex/hooks.json，开会话一条（90 秒）、调工具前一条只挂 ^Bash$（Codex 跑命令一律叫 Bash，没有单独的读文件工具）', () => {
    expect(CODEX?.hooks).toEqual([
      { event: 'SessionStart', script: 'session-start.mjs', timeout: 90 },
      { event: 'PreToolUse', matcher: '^Bash$', script: 'pretool-codex.mjs', timeout: 10 },
    ]);
    expect(CODEX?.settings.linux).toBe('.codex/hooks.json');
    expect(HOOK_GAPS.codex).toBeUndefined();
  });

  it('信任的哈希和 Codex 自己算的一样（2026-10-09 本机 codex 0.162 的 app-server hooks/list 报的 currentHash）', () => {
    expect(codexHookHash('PreToolUse', 'Bash', 'C:/Users/u/.fleet-dao/bin/quiet-pretool-codex.exe', 10)).toBe(
      'sha256:b6ddca5375a8826405877abed02f44d4e04a1a98d7426a562d4f273ac9e229cb',
    );
    expect(
      codexHookHash(
        'SessionStart',
        undefined,
        'node "C:/Users/Ada Lovelace/.fleet-dao/hooks/session-start.mjs"',
        90,
      ),
    ).toBe('sha256:ed19c7032af3cb4f61e53728d2cad92b5d817de73631d8ff2fa4c0bdd31a32ff');
    // 故意造出的失败：命令差一个字、timeout 不同，哈希就不同（Codex 判「改过了」、跳过不跑）
    expect(
      codexHookHash('PreToolUse', 'Bash', 'C:/Users/u/.fleet-dao/bin/quiet-pretool-codex.ex', 10),
    ).not.toBe('sha256:b6ddca5375a8826405877abed02f44d4e04a1a98d7426a562d4f273ac9e229cb');
    expect(
      codexHookHash('PreToolUse', 'Bash', 'C:/Users/u/.fleet-dao/bin/quiet-pretool-codex.exe', 11),
    ).not.toBe('sha256:b6ddca5375a8826405877abed02f44d4e04a1a98d7426a562d4f273ac9e229cb');
  });
});

describe('装', () => {
  it('新机器：hooks.json 登记两条、config.toml 记上两条信任；查全绿；第二遍零改动', () => {
    const m = machine();
    const lines = m.apply();
    expectKind(lines, HOOKS_JSON, 'changed');
    expectKind(lines, TRUST, 'changed');
    expect(m.hooksJson().hooks).toEqual({
      SessionStart: [{ hooks: [{ type: 'command', command: m.cmd('session-start.mjs'), timeout: 90 }] }],
      PreToolUse: [
        { matcher: '^Bash$', hooks: [{ type: 'command', command: m.cmd('pretool-codex.mjs'), timeout: 10 }] },
      ],
    });
    const toml = m.config();
    expect(state(toml, m.key('session_start', 0)).trusted).toBe(
      m.hash('SessionStart', undefined, 'session-start.mjs', 90),
    );
    expect(state(toml, m.key('pre_tool_use', 0)).trusted).toBe(
      m.hash('PreToolUse', '^Bash$', 'pretool-codex.mjs', 10),
    );
    const checked = m.check();
    expectKind(checked, HOOKS_JSON, 'ok');
    expectKind(checked, TRUST, 'ok');
    expect(exitCode(checked)).toBe(0);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });

  it('没装：查判缺失（登记缺、信任缺）', () => {
    const m = machine();
    const checked = m.check();
    expectKind(checked, HOOKS_JSON, 'missing');
    expectKind(checked, TRUST, 'missing');
    expect(exitCode(checked)).toBe(1);
  });

  it('家目录是个链接（或 Windows 的 8.3 短名）：信任的键用解开后的真实路径，和 Codex 报的一样', () => {
    const real = tempDir('real-home');
    const link = join(tempDir('link'), 'home');
    linkDir(real, link);
    const m = machine(undefined, link);
    m.apply();
    const s = scanCodexConfig(m.config());
    if (!s.ok) throw new Error(s.why);
    const keys = [...s.value.entries.keys()];
    expect(keys).toHaveLength(2);
    const realJson = join(realpathSync.native(real), '.codex', 'hooks.json');
    for (const k of keys) expect(k.startsWith(`${realJson}:`)).toBe(true);
    // 故意造出的失败：按链接路径拼的键 Codex 不认
    expect(keys.some((k) => k.startsWith(join(link, '.codex', 'hooks.json')))).toBe(false);
    expect(exitCode(m.check())).toBe(0);
  });

  it('替别的用户写（法国装机）：开会话那条不登记，只登记、只信任调工具前那条', () => {
    const m = machine({ event: 'SessionStart', why: '开会话钩子要在那个用户自己能写的检出里快进' });
    m.apply();
    expect(Object.keys(m.hooksJson().hooks)).toEqual(['PreToolUse']);
    expect(state(m.config(), m.key('pre_tool_use', 0)).trusted).toBe(
      m.hash('PreToolUse', '^Bash$', 'pretool-codex.mjs', 10),
    );
    expect(exitCode(m.check())).toBe(0);
  });
});

describe('别人的钩子、别的配置一条不碰', () => {
  it('hooks.json 里别人的钩子留着，本脚本的接在后面；信任的键按实际位置数（别人那组在前，本脚本是第 1 组）', () => {
    const m = machine();
    const mine = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/audit.py' }],
    };
    put(
      m.home,
      '.codex/hooks.json',
      JSON.stringify({ description: '我的钩子', hooks: { PreToolUse: [mine] } }),
    );
    expectKind(m.apply(), HOOKS_JSON, 'changed');
    const j = m.hooksJson() as unknown as { description: string; hooks: { PreToolUse: unknown[] } };
    expect(j.description).toBe('我的钩子');
    expect(j.hooks.PreToolUse[0]).toEqual(mine);
    const toml = m.config();
    expect(state(toml, m.key('pre_tool_use', 1)).trusted).toBe(
      m.hash('PreToolUse', '^Bash$', 'pretool-codex.mjs', 10),
    );
    // 别人那条没替它记信任
    expect(state(toml, m.key('pre_tool_use', 0)).trusted).toBeUndefined();
    expect(exitCode(m.check())).toBe(0);
  });

  it('config.toml 里原有的配置（多行字符串、跨行数组、项目信任、别人的钩子信任）一个字不动，信任接在末尾一块；原文件先备份', () => {
    const m = machine();
    const before = [
      'model = "gpt-6"',
      'notes = """',
      '[hooks.state."不是表头，在多行字符串里"]',
      '"""',
      'list = [',
      '  "a",',
      '  ["b", "c"],',
      ']',
      '',
      "[projects.'d:\\frank\\fleet-dao']",
      'trust_level = "trusted"',
      '',
      '[hooks.state."/x/other/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:别人的"',
      '',
    ].join('\n');
    put(m.home, '.codex/config.toml', before);
    expectKind(m.apply(), TRUST, 'changed');
    const after = m.config();
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain('# >>> fleet-dao 钩子信任');
    expect(state(after, '/x/other/hooks.json:stop:0:0').trusted).toBe('sha256:别人的');
    const backups = join(m.home, '.fleet-dao', 'backups');
    const [stamp] = readdirSync(backups);
    expect(get(join(backups, stamp ?? ''), '.codex/config.toml')).toBe(before);
    expect(exitCode(m.check())).toBe(0);
  });

  it('人在 /hooks 里已经信任过（表写在块外）：一样的不动；信任的是旧版本的，只改那一行 trusted_hash', () => {
    const m = machine();
    m.apply();
    const hooks = get(m.home, '.codex/hooks.json');
    const pre = m.key('pre_tool_use', 0);
    const start = m.key('session_start', 0);
    const outside = [
      `[hooks.state."${pre.replaceAll('\\', '\\\\')}"]`,
      'trusted_hash = "sha256:旧的"',
      '',
      `[hooks.state."${start.replaceAll('\\', '\\\\')}"]`,
      `trusted_hash = "${m.hash('SessionStart', undefined, 'session-start.mjs', 90)}"`,
      '',
    ].join('\n');
    put(m.home, '.codex/config.toml', outside);
    const drift = m.check();
    expectKind(drift, TRUST, 'drift');
    expect(drift.find((l) => l.key === TRUST)?.text).toContain('信任的是旧版本');
    expectKind(m.apply(), TRUST, 'changed');
    const after = m.config();
    expect(after).not.toContain('# >>> fleet-dao 钩子信任');
    expect(state(after, pre).trusted).toBe(m.hash('PreToolUse', '^Bash$', 'pretool-codex.mjs', 10));
    expect(get(m.home, '.codex/hooks.json')).toBe(hooks);
    expect(exitCode(m.check())).toBe(0);
  });
});

describe('人关掉的、读不懂的：不替人做主，报出来', () => {
  it('人在 /hooks 里关掉了调工具前那条（enabled = false）：不替人打开，写报没做成、查判漂移；块里的那条重写时照抄 enabled = false', () => {
    const m = machine();
    m.apply();
    const pre = m.key('pre_tool_use', 0);
    const toml = m.config().replace(/(\[hooks\.state\."[^\n]*pre_tool_use:0:0"\]\n)/, '$1enabled = false\n');
    put(m.home, '.codex/config.toml', toml);
    const drift = m.check();
    expectKind(drift, TRUST, 'drift');
    expect(drift.find((l) => l.key === TRUST)?.text).toContain('被关掉了');
    expectKind(m.apply(), TRUST, 'failed');
    expect(state(m.config(), pre).enabled).toBe(false);
  });

  it('[features] hooks = false：Codex 的钩子整个关了，报出来，不动那一行', () => {
    const m = machine();
    put(m.home, '.codex/config.toml', '[features]\nhooks = false\n');
    const lines = m.apply();
    expectKind(lines, TRUST, 'failed');
    expect(lines.find((l) => l.key === TRUST)?.text).toContain('[features] hooks = false');
    expect(m.config()).toContain('[features]\nhooks = false\n');
    expectKind(m.check(), TRUST, 'drift');
  });

  it('hooks.state 用内联表写、托管块标记缺一行：逐行认不准，查报没查成、写报没做成，文件一个字不动', () => {
    for (const text of ['hooks = { state = {} }\n', '# >>> fleet-dao 钩子信任\n[hooks.state."x"]\n']) {
      const m = machine();
      put(m.home, '.codex/config.toml', text);
      expectKind(m.check(), TRUST, 'unknown');
      expectKind(m.apply(), TRUST, 'failed');
      expect(m.config()).toBe(text);
    }
  });

  it('hooks.json 读不懂：登记那行没做成，信任那行也不记', () => {
    const m = machine();
    put(m.home, '.codex/hooks.json', '{ 坏了');
    const lines = m.apply();
    expectKind(lines, HOOKS_JSON, 'failed');
    expectKind(lines, TRUST, 'failed');
    expectKind(m.check(), TRUST, 'unknown');
  });
});
