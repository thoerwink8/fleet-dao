// 权限：仓里 agents/config/claude-permissions.json 合进 ~/.claude/settings.json 的 permissions；补缺、不删机器上自己加的，读不懂就不动。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyPermissions, checkPermissions, parsePermissions } from '../src/permissions.ts';
import { exitCode } from '../src/report.ts';
import type { AgentId } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  expectKind,
  get,
  getJson,
  makeRepo,
  PERMS_JSON,
  PERMS_SPEC,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-09-30T06:00:00Z');
const KEY = '~/.claude/settings.json#permissions';

function machine(installed: AgentId[] = ['claude'], perms: string | null = PERMS_JSON, skip?: string) {
  const home = tempDir('home');
  const src = sources(makeRepo({}, undefined, undefined, perms));
  const ctx = ctxFor(home, installed);
  return {
    home,
    apply: () => applyPermissions(ctx, src, new Backups(home, PLATFORM, NOW), skip),
    check: () => checkPermissions(ctx, src, skip),
    settings: () => getJson(home, '.claude/settings.json') as Record<string, unknown>,
  };
}

interface Perm {
  defaultMode?: string;
  allow?: string[];
  deny?: string[];
  additionalDirectories?: string[];
}
const permOf = (m: ReturnType<typeof machine>): Perm => m.settings().permissions as Perm;

describe('装', () => {
  it('没有设置文件：新建，四项都写上，家目录占位符换成这台的家目录', () => {
    const m = machine();
    expectKind(m.check(), KEY, 'missing');
    expectKind(m.apply(), KEY, 'changed');
    expect(permOf(m)).toEqual({
      defaultMode: 'auto',
      additionalDirectories: [join(m.home, '.claude')],
      allow: PERMS_SPEC.allow,
      deny: PERMS_SPEC.deny,
    });
    expectKind(m.check(), KEY, 'ok');
  });

  it('设置文件里别的键、机器上自己加的 allow 都不动，已退役的摘掉', () => {
    const m = machine();
    put(
      m.home,
      '.claude/settings.json',
      JSON.stringify({
        model: 'x',
        env: { HTTP_PROXY: 'a', http_proxy: 'b' },
        permissions: { allow: ['Bash(old:*)', 'Bash(mine:*)'], ask: ['Edit'] },
      }),
    );
    expectKind(m.apply(), KEY, 'changed');
    const s = m.settings();
    expect(s.model).toBe('x');
    expect(s.env).toEqual({ HTTP_PROXY: 'a', http_proxy: 'b' });
    const p = s.permissions as Perm & { ask: string[] };
    expect(p.ask).toEqual(['Edit']);
    expect(p.allow).toEqual(['Bash(mine:*)', 'Read', 'Bash(git:*)']);
  });

  it('defaultMode 不一样：覆盖成仓里的', () => {
    const m = machine();
    put(m.home, '.claude/settings.json', JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    expectKind(m.check(), KEY, 'drift');
    expectKind(m.apply(), KEY, 'changed');
    expect(permOf(m).defaultMode).toBe('auto');
  });

  it('已经一致：再跑不改、不备份', () => {
    const m = machine();
    m.apply();
    const before = get(m.home, '.claude/settings.json');
    expectKind(m.apply(), KEY, 'ok');
    expect(get(m.home, '.claude/settings.json')).toBe(before);
  });

  it('改之前先备份原文件，CRLF 保持', () => {
    const m = machine();
    put(m.home, '.claude/settings.json', '{\r\n  "model": "x"\r\n}\r\n');
    const [l] = m.apply();
    expect(l?.text).toContain('备份');
    expect(get(m.home, '.claude/settings.json')).toContain('\r\n');
  });
});

describe('仓里真的那份权限文件（agents/config/claude-permissions.json）', () => {
  const real = parsePermissions(
    readFileSync(
      fileURLToPath(new URL('../../../agents/config/claude-permissions.json', import.meta.url)),
      'utf8',
    ),
    '/h',
  );

  it('合规矩、认得出：默认模式 auto，不能是 bypassPermissions', () => {
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect(real.value.defaultMode).toBe('auto');
  });

  it('创始人 2026-09-30 要的最宽松：shell 整个放开、没有 deny，旧的 9 条拒绝只摘不留', () => {
    if (!real.ok) throw new Error(real.why);
    expect(real.value.allow).toContain('Bash');
    expect(real.value.allow).toContain('PowerShell');
    expect(real.value.deny).toEqual([]);
    expect(real.value.retiredDeny).toContain('Bash(cat:*)');
    expect(real.value.retiredDeny).toContain('PowerShell(Select-String:*)');
  });
});

describe('放宽：把旧的拒绝撤了、同一条改放行（retiredDeny）', () => {
  const spec = { ...PERMS_SPEC, allow: ['Read', 'Bash(cat:*)'], deny: [], retiredDeny: ['Bash(cat:*)'] };

  it('机器上旧的 deny 被摘掉、allow 补上；不算「allow 和 deny 相反」', () => {
    const m = machine(['claude'], JSON.stringify(spec));
    put(
      m.home,
      '.claude/settings.json',
      JSON.stringify({ permissions: { deny: ['Bash(cat:*)', 'Bash(mine:*)'] } }),
    );
    expectKind(m.check(), KEY, 'drift');
    expectKind(m.apply(), KEY, 'changed');
    const p = permOf(m);
    expect(p.deny).toEqual(['Bash(mine:*)']);
    expect(p.allow).toEqual(['Read', 'Bash(cat:*)']);
    expectKind(m.check(), KEY, 'ok');
  });

  it('没写在 retiredDeny 里的相反条目照旧不动、报没做成（不因为放宽就乱摘）', () => {
    const m = machine(['claude'], JSON.stringify(spec));
    const text = JSON.stringify({ permissions: { deny: ['Read'] } });
    put(m.home, '.claude/settings.json', text);
    expectKind(m.apply(), KEY, 'failed');
    expect(get(m.home, '.claude/settings.json')).toBe(text);
  });

  it('源文件里 retiredDeny 的条目还留在 deny 里：拒收', () => {
    const bad = JSON.stringify({ ...spec, deny: ['Bash(cat:*)'], allow: ['Read'] });
    const m = machine(['claude'], bad);
    expectKind(m.check(), KEY, 'unknown');
    expectKind(m.apply(), KEY, 'failed');
  });
});

describe('不写', () => {
  it('没装 Claude Code：跳过，不建文件', () => {
    const m = machine(['codex']);
    expectKind(m.apply(), KEY, 'skip');
  });

  it('替别的用户写（skip 给了原因）：整段不写，只报 skip', () => {
    const m = machine(['claude'], PERMS_JSON, '替别的用户写不写权限');
    expectKind(m.check(), KEY, 'skip');
    expectKind(m.apply(), KEY, 'skip');
    expect(() => m.settings()).toThrow();
  });
});

// 故意造出失败：读不懂、相反、源文件坏，都得报出来、不动文件、不当成没事
describe('读不懂就不动', () => {
  const bad = (name: string, text: string, kindCheck: string) =>
    it(name, () => {
      const m = machine();
      put(m.home, '.claude/settings.json', text);
      expectKind(m.check(), KEY, kindCheck);
      const out = m.apply();
      expectKind(out, KEY, 'failed');
      expect(exitCode(out)).toBe(1);
      expect(get(m.home, '.claude/settings.json')).toBe(text);
    });
  bad('不是 JSON', '{ nope', 'drift');
  bad('整份不是对象', '[]', 'drift');
  bad('permissions 不是对象', '{"permissions": []}', 'drift');
  bad('allow 不是数组', '{"permissions": {"allow": "Read"}}', 'drift');
  bad('机器上把仓里 deny 的放进了 allow', '{"permissions": {"allow": ["Bash(cat:*)"]}}', 'drift');
  bad('机器上把仓里 allow 的放进了 deny', '{"permissions": {"deny": ["Read"]}}', 'drift');
});

describe('仓里的源文件', () => {
  it('没有这个文件：查报没查成、写报没做成，不拿空的顶上', () => {
    const m = machine(['claude'], null);
    expectKind(m.check(), KEY, 'unknown');
    expectKind(m.apply(), KEY, 'failed');
    expect(() => m.settings()).toThrow();
  });

  const invalid: [string, string][] = [
    ['不是 JSON', '{ x'],
    ['defaultMode 写 bypassPermissions', JSON.stringify({ ...PERMS_SPEC, defaultMode: 'bypassPermissions' })],
    ['defaultMode 没写', JSON.stringify({ ...PERMS_SPEC, defaultMode: undefined })],
    ['同一条同时在 allow 和 deny', JSON.stringify({ ...PERMS_SPEC, deny: ['Read'] })],
    ['退役的还在 allow 里', JSON.stringify({ ...PERMS_SPEC, retired: ['Read'] })],
    ['allow 有重复', JSON.stringify({ ...PERMS_SPEC, allow: ['Read', 'Read'] })],
    ['allow 里有空串', JSON.stringify({ ...PERMS_SPEC, allow: [''] })],
    ['retired 不是数组', JSON.stringify({ ...PERMS_SPEC, retired: 'x' })],
  ];
  for (const [name, text] of invalid) {
    it(`${name}：拒收，设置文件不碰`, () => {
      expect(parsePermissions(text, '/h').ok).toBe(false);
      const m = machine(['claude'], text);
      expectKind(m.check(), KEY, 'unknown');
      expectKind(m.apply(), KEY, 'failed');
      expect(() => m.settings()).toThrow();
    });
  }
});
