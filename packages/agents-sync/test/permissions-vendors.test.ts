// 其他几家 AI 的权限（src/permissions-vendors.ts）：Kimi、Codex 各一块托管块，Devin 走 JSON 合并；读不懂就不动。假家目录，不碰真机器。
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import {
  applyOtherPermissions,
  checkOtherPermissions,
  parseRule,
  shellPrefix,
  toCodex,
  toDevin,
  toKimi,
} from '../src/permissions-vendors.ts';
import { exitCode } from '../src/report.ts';
import type { AgentId } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  expectKind,
  get,
  getJson,
  makeRepo,
  PERMS_SPEC,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-09-30T06:00:00Z');
const KIMI = '~/.kimi-code/config.toml#permission';
const CODEX = '~/.codex/rules/default.rules#permission';
const DEVIN_REL = PLATFORM === 'win32' ? 'AppData/Roaming/devin/config.json' : '.config/devin/config.json';
const DEVIN = `~/${DEVIN_REL}#permissions`;

function machine(installed: AgentId[], spec: unknown = PERMS_SPEC, skip?: string) {
  const home = tempDir('home');
  const src = sources(makeRepo({}, undefined, undefined, JSON.stringify(spec)));
  const ctx = ctxFor(home, installed);
  return {
    home,
    apply: () => applyOtherPermissions(ctx, src, new Backups(home, PLATFORM, NOW), skip),
    check: () => checkOtherPermissions(ctx, src, skip),
  };
}

const lineOf = (lines: readonly { kind: string; key: string; text: string }[], key: string) =>
  lines.find((l) => l.key === key);

describe('翻译', () => {
  it('拆规则、认命令前缀', () => {
    expect(parseRule('Bash(git:*)')).toEqual({ tool: 'Bash', arg: 'git:*' });
    expect(parseRule('Read')).toEqual({ tool: 'Read', arg: null });
    expect(shellPrefix('Bash(git:*)')).toBe('git');
    expect(shellPrefix('PowerShell(ts-node:*)')).toBe('ts-node');
    expect(shellPrefix('Bash(git commit:*)')).toBeNull();
    expect(shellPrefix('Bash(git *)')).toBeNull();
    expect(shellPrefix('Read')).toBeNull();
  });

  it('Kimi：Bash(x:*) → Bash(x *)，文档列的工具名照抄，别的不翻', () => {
    expect(toKimi('Bash(git:*)')).toBe('Bash(git *)');
    expect(toKimi('PowerShell(git:*)')).toBe('Bash(git *)');
    expect(toKimi('Read')).toBe('Read');
    expect(toKimi('Workflow')).toBeNull();
    expect(toKimi('WebFetch')).toBeNull();
  });

  it('整个 shell 放开（Bash、PowerShell 不带括号）和整个 MCP 服务：Kimi、Devin 有对应写法，Codex 没有', () => {
    expect(toKimi('Bash')).toBe('Bash');
    expect(toKimi('PowerShell')).toBe('Bash');
    expect(toKimi('mcp__playwright')).toBe('mcp__playwright__*');
    expect(toKimi('mcp__claude_ai_Claude_Docs')).toBe('mcp__claude_ai_Claude_Docs__*');
    expect(toKimi('mcp__playwright__browser_click')).toBeNull();
    expect(toDevin('Bash')).toBe('exec');
    expect(toDevin('PowerShell')).toBe('exec');
    expect(toDevin('mcp__chrome-devtools')).toBe('mcp__chrome-devtools__*');
    expect(toCodex('Bash')).toBeNull();
    expect(toCodex('mcp__playwright')).toBeNull();
  });

  it('Codex：只有命令前缀', () => {
    expect(toCodex('Bash(git:*)')).toBe('git');
    expect(toCodex('PowerShell(pnpm:*)')).toBe('pnpm');
    expect(toCodex('Read')).toBeNull();
  });

  it('Devin：Exec、Read(**)、Write(**)、grep', () => {
    expect(toDevin('Bash(git:*)')).toBe('Exec(git)');
    expect(toDevin('Read')).toBe('Read(**)');
    expect(toDevin('Edit')).toBe('Write(**)');
    expect(toDevin('Write')).toBe('Write(**)');
    expect(toDevin('Grep')).toBe('grep');
    expect(toDevin('Agent')).toBeNull();
  });
});

describe('Kimi', () => {
  it('没有配置文件：新建，最前面一行默认模式 auto，规则块拒绝在放行前', () => {
    const m = machine(['kimi']);
    expectKind(m.check(), KIMI, 'missing');
    expectKind(m.apply(), KIMI, 'changed');
    const text = get(m.home, '.kimi-code/config.toml');
    expect(text).toContain('default_permission_mode = "auto"');
    expect(text.indexOf('default_permission_mode')).toBeLessThan(text.indexOf('[[permission.rules]]'));
    const deny = text.indexOf('decision = "deny"');
    const allow = text.indexOf('decision = "allow"');
    expect(deny).toBeGreaterThan(-1);
    expect(deny).toBeLessThan(allow);
    expect(text).toContain('pattern = "Bash(cat *)"');
    expect(text).toContain('pattern = "Bash(git *)"');
    expect(text).toContain('pattern = "Read"');
    expectKind(m.check(), KIMI, 'ok');
  });

  it('别的内容一行不碰，默认模式加在第一个表头之前', () => {
    const m = machine(['kimi']);
    const mine = '# 我的注释\ndefault_model = "k2"\n\n[loop_control]\nmax_steps = 5\n';
    put(m.home, '.kimi-code/config.toml', mine);
    expectKind(m.apply(), KIMI, 'changed');
    const text = get(m.home, '.kimi-code/config.toml');
    expect(text).toContain(mine.trim());
    expect(text.indexOf('default_permission_mode')).toBeLessThan(text.indexOf('[loop_control]'));
    expect(text.indexOf('[loop_control]')).toBeLessThan(text.indexOf('[[permission.rules]]'));
  });

  it('默认模式写成别的（比如上一版同步写的 yolo、或 manual）：漂移、改成 auto，只动这一行', () => {
    for (const old of ['yolo', 'manual']) {
      const m = machine(['kimi']);
      put(m.home, '.kimi-code/config.toml', `default_permission_mode = "${old}"   # 旧的\n[a]\nb = 1\n`);
      expectKind(m.check(), KIMI, 'drift');
      m.apply();
      const text = get(m.home, '.kimi-code/config.toml');
      expect(text).toContain('default_permission_mode = "auto"');
      expect(text).not.toContain(`"${old}"`);
      expect(text).toContain('[a]\nb = 1');
    }
  });

  it('已经一致：再跑不改文件、不备份', () => {
    const m = machine(['kimi']);
    m.apply();
    const before = get(m.home, '.kimi-code/config.toml');
    expectKind(m.apply(), KIMI, 'ok');
    expect(get(m.home, '.kimi-code/config.toml')).toBe(before);
  });

  it('块里被手改：漂移，写回仓里的；块外自己的规则不动', () => {
    const m = machine(['kimi']);
    put(m.home, '.kimi-code/config.toml', '[[permission.rules]]\ndecision = "ask"\npattern = "Bash(rm *)"\n');
    m.apply();
    const text = get(m.home, '.kimi-code/config.toml').replace(
      'pattern = "Bash(git *)"',
      'pattern = "Bash(git ZZZ)"',
    );
    put(m.home, '.kimi-code/config.toml', text);
    expectKind(m.check(), KIMI, 'drift');
    m.apply();
    const back = get(m.home, '.kimi-code/config.toml');
    expect(back).toContain('pattern = "Bash(git *)"');
    expect(back).not.toContain('ZZZ');
    expect(back).toContain('pattern = "Bash(rm *)"');
    expectKind(m.check(), KIMI, 'ok');
  });

  it('仓里退役、删掉的规则：块整块重写，旧的不留', () => {
    const m = machine(['kimi']);
    m.apply();
    const m2 = machine(['kimi'], { ...PERMS_SPEC, allow: ['Read'] });
    put(m2.home, '.kimi-code/config.toml', get(m.home, '.kimi-code/config.toml'));
    expectKind(m2.check(), KIMI, 'drift');
    m2.apply();
    expect(get(m2.home, '.kimi-code/config.toml')).not.toContain('Bash(git *)');
  });

  // 故意造出失败：读不懂就不动、报没做成
  const bad = (name: string, text: string) =>
    it(`${name}：查报没查成、写报没做成，文件原样`, () => {
      const m = machine(['kimi']);
      put(m.home, '.kimi-code/config.toml', text);
      expectKind(m.check(), KIMI, 'unknown');
      const out = m.apply();
      expectKind(out, KIMI, 'failed');
      expect(exitCode(out)).toBe(1);
      expect(get(m.home, '.kimi-code/config.toml')).toBe(text);
    });
  bad('有多行字符串', 'x = """\n[a]\n"""\n');
  bad('托管块少了结尾一行', '# >>> fleet-dao 权限（旧）\n[[permission.rules]]\n');
  bad('托管块开头出现两次', '# >>> fleet-dao 权限\n# >>> fleet-dao 权限\n# <<< fleet-dao 权限\n');
  bad('默认模式写了两遍', 'default_permission_mode = "yolo"\ndefault_permission_mode = "auto"\n');

  it('配置文件是个链接：不碰', () => {
    const m = machine(['kimi']);
    const real = join(tempDir('real'), 'c.toml');
    put(join(real, '..'), 'c.toml', 'x = 1\n');
    mkdirSync(join(m.home, '.kimi-code'), { recursive: true });
    symlinkSync(real, join(m.home, '.kimi-code', 'config.toml'), 'file');
    expectKind(m.check(), KIMI, 'drift');
    expectKind(m.apply(), KIMI, 'failed');
  });
});

describe('Codex', () => {
  it('没有 rules 文件：新建目录和文件，拒绝 cat、放行 git，翻不了的算出条数', () => {
    const m = machine(['codex']);
    expectKind(m.check(), CODEX, 'missing');
    const out = m.apply();
    expectKind(out, CODEX, 'changed');
    expect(lineOf(out, CODEX)?.text).toContain('1 条 Claude 的规则这家没有对应写法');
    const text = get(m.home, '.codex/rules/default.rules');
    expect(text).toContain('prefix_rule(pattern=["cat"], decision="forbidden")');
    expect(text).toContain('prefix_rule(pattern=["git"], decision="allow")');
    expect(text).not.toContain('Read');
    expectKind(m.check(), CODEX, 'ok');
  });

  it('Codex 自己以后追加的规则、自己写的都留着，只换托管块', () => {
    const m = machine(['codex']);
    const mine = 'prefix_rule(pattern=["ls"], decision="allow")\n';
    put(m.home, '.codex/rules/default.rules', mine);
    m.apply();
    put(
      m.home,
      '.codex/rules/default.rules',
      `${get(m.home, '.codex/rules/default.rules')}prefix_rule(pattern=["curl"], decision="prompt")\n`,
    );
    expectKind(m.check(), CODEX, 'ok');
    const m2 = machine(['codex'], { ...PERMS_SPEC, allow: ['Bash(git:*)', 'Bash(npm:*)'] });
    put(m2.home, '.codex/rules/default.rules', get(m.home, '.codex/rules/default.rules'));
    expectKind(m2.check(), CODEX, 'drift');
    m2.apply();
    const text = get(m2.home, '.codex/rules/default.rules');
    expect(text).toContain('prefix_rule(pattern=["npm"], decision="allow")');
    expect(text).toContain(mine.trim());
    expect(text).toContain('prefix_rule(pattern=["curl"], decision="prompt")');
  });

  it('已经一致：再跑不改', () => {
    const m = machine(['codex']);
    m.apply();
    const before = get(m.home, '.codex/rules/default.rules');
    expectKind(m.apply(), CODEX, 'ok');
    expect(get(m.home, '.codex/rules/default.rules')).toBe(before);
  });

  it('托管块标记颠倒：不动、报没做成', () => {
    const m = machine(['codex']);
    const text = '# <<< fleet-dao 权限\n# >>> fleet-dao 权限\n';
    put(m.home, '.codex/rules/default.rules', text);
    expectKind(m.check(), CODEX, 'unknown');
    expectKind(m.apply(), CODEX, 'failed');
    expect(get(m.home, '.codex/rules/default.rules')).toBe(text);
  });
});

describe('Devin', () => {
  it('没有 config.json：新建，Exec、Read(**) 放行，Exec(cat) 拒绝', () => {
    const m = machine(['devin']);
    expectKind(m.check(), DEVIN, 'missing');
    expectKind(m.apply(), DEVIN, 'changed');
    const perm = (getJson(m.home, DEVIN_REL) as { permissions: { allow: string[]; deny: string[] } })
      .permissions;
    expect(perm.allow).toEqual(['Read(**)', 'Exec(git)']);
    expect(perm.deny).toEqual(['Exec(cat)']);
    expectKind(m.check(), DEVIN, 'ok');
  });

  it('自己的设置和自己加的规则不删；退役的摘掉；不写 defaultMode', () => {
    const m = machine(['devin'], { ...PERMS_SPEC, retired: ['Bash(old:*)'] });
    put(
      m.home,
      DEVIN_REL,
      JSON.stringify({ theme: 'x', permissions: { allow: ['Exec(old)', 'Exec(mine)'] } }),
    );
    expectKind(m.apply(), DEVIN, 'changed');
    const j = getJson(m.home, DEVIN_REL) as { theme: string; permissions: Record<string, unknown> };
    expect(j.theme).toBe('x');
    expect(j.permissions.allow).toEqual(['Exec(mine)', 'Read(**)', 'Exec(git)']);
    expect(j.permissions.defaultMode).toBeUndefined();
  });

  // 故意造出失败
  it('放行和拒绝相反：不动、报没做成', () => {
    const m = machine(['devin']);
    const text = JSON.stringify({ permissions: { allow: ['Exec(cat)'] } });
    put(m.home, DEVIN_REL, text);
    expectKind(m.check(), DEVIN, 'drift');
    expectKind(m.apply(), DEVIN, 'failed');
    expect(get(m.home, DEVIN_REL)).toBe(text);
  });

  it('config.json 带注释（它允许注释、本脚本读不了）：不动、报没做成', () => {
    const m = machine(['devin']);
    const text = '{\n  // 我的\n  "theme": "x"\n}\n';
    put(m.home, DEVIN_REL, text);
    expectKind(m.check(), DEVIN, 'drift');
    expectKind(m.apply(), DEVIN, 'failed');
    expect(get(m.home, DEVIN_REL)).toBe(text);
  });
});

describe('整体', () => {
  it('没装的不写、不建文件', () => {
    const m = machine([]);
    const out = m.apply();
    expect(out.every((l) => l.kind === 'skip')).toBe(true);
    expect(existsSync(join(m.home, '.kimi-code'))).toBe(false);
    expect(existsSync(join(m.home, '.codex'))).toBe(false);
  });

  it('--user 替别的用户写：整段只报一行 skip', () => {
    const m = machine(['kimi', 'codex', 'devin'], PERMS_SPEC, '替别的用户写不写权限');
    expect(m.apply()).toHaveLength(1);
    expectKind(m.apply(), '其他几家 AI 的权限', 'skip');
    expect(existsSync(join(m.home, '.kimi-code'))).toBe(false);
  });

  it('装了但做不了的几家：逐家一行为什么（Grok 直接读 Claude 那份，不另写）', () => {
    const m = machine(['grok', 'pi', 'dsh', 'agy', 'gemini']);
    const out = m.check();
    for (const name of ['Grok', 'pi', 'dsh', 'Antigravity', 'Gemini CLI'])
      expect(lineOf(out, `${name} 的权限`)?.kind).toBe('skip');
    expect(lineOf(out, 'Grok 的权限')?.text).toContain('~/.claude/settings.json');
  });

  // 故意造出失败：源文件读不到、不合规矩、翻译后自相矛盾，装了的每家都得报出来，不写
  it('仓里没有权限源文件：装了的各家都报没查成、没做成', () => {
    const home = tempDir('home');
    const src = sources(makeRepo({}, undefined, undefined, null));
    const ctx = ctxFor(home, ['kimi', 'codex', 'devin']);
    const check = checkOtherPermissions(ctx, src);
    expect(check.filter((l) => l.kind === 'unknown')).toHaveLength(3);
    const out = applyOtherPermissions(ctx, src, new Backups(home, PLATFORM, NOW));
    expect(out.filter((l) => l.kind === 'failed')).toHaveLength(3);
    expect(exitCode(out)).toBe(1);
    expect(existsSync(join(home, '.kimi-code'))).toBe(false);
  });

  it('源文件写 bypassPermissions：拒收，各家不写', () => {
    const m = machine(['kimi', 'codex', 'devin'], { ...PERMS_SPEC, defaultMode: 'bypassPermissions' });
    expect(m.apply().filter((l) => l.kind === 'failed')).toHaveLength(3);
    expect(existsSync(join(m.home, '.kimi-code'))).toBe(false);
  });

  it('翻译后同一条既放行又拒绝（Bash 和 PowerShell 的同名命令落到同一条）：不写', () => {
    const spec = { ...PERMS_SPEC, allow: ['Bash(x:*)'], deny: ['PowerShell(x:*)'] };
    const m = machine(['kimi', 'codex', 'devin'], spec);
    const out = m.apply();
    expect(out.filter((l) => l.kind === 'failed')).toHaveLength(3);
    expect(existsSync(join(m.home, '.kimi-code'))).toBe(false);
    expect(existsSync(join(m.home, '.codex'))).toBe(false);
  });
});
