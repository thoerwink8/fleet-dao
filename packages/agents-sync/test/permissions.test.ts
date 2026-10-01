// 权限：仓里 agents/config/claude-permissions.json 合进 ~/.claude/settings.json 的 permissions 和 autoMode；补缺、不删机器上自己加的，读不懂就不动。
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

/** 这一项报告那行的话（同一项只报一行，断言看它说了什么） */
const textOf = (lines: { kind: string; key: string; text: string }[]): string =>
  lines
    .filter((l) => l.key === KEY)
    .map((l) => l.text)
    .join('\n');

/** 机器上 autoMode 那一层 */
interface Am {
  environment?: string[];
  allow?: string[];
  soft_deny?: string[];
  hard_deny?: string[];
  classifyAllShell?: boolean;
}
const amOf = (m: ReturnType<typeof machine>): Am => m.settings().autoMode as Am;

describe('装', () => {
  it('没有设置文件：新建，permissions 四项和 autoMode 两档都写上，家目录占位符换成这台的家目录', () => {
    const m = machine();
    expectKind(m.check(), KEY, 'missing');
    expectKind(m.apply(), KEY, 'changed');
    expect(permOf(m)).toEqual({
      defaultMode: 'auto',
      additionalDirectories: [join(m.home, '.claude')],
      allow: PERMS_SPEC.allow,
      deny: PERMS_SPEC.deny,
    });
    expect(amOf(m)).toEqual(PERMS_SPEC.autoMode);
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

  it('机器上的 autoMode：并进仓里的两条，机器上自己加的、别的档、别的键都不动', () => {
    const m = machine();
    put(
      m.home,
      '.claude/settings.json',
      JSON.stringify({
        autoMode: {
          environment: ['$defaults', '机器上自己加的一条'],
          allow: ['$defaults', '机器上自己加的例外'],
          soft_deny: ['机器上自己加的软拦'],
          hard_deny: ['机器上自己加的硬拦'],
          classifyAllShell: true,
        },
      }),
    );
    // 机器上这两档都在、都带了 "$defaults"，只少仓里的两条：算缺失，不算漂移
    expectKind(m.check(), KEY, 'missing');
    expectKind(m.apply(), KEY, 'changed');
    const am = amOf(m);
    expect(am.environment).toEqual(['$defaults', '机器上自己加的一条', '自己人：和工作仓同一个主人的仓']);
    expect(am.allow).toEqual([
      '$defaults',
      '机器上自己加的例外',
      '改自己仓里单子和 PR 的标题、正文、标签、评论、子单关系是日常',
    ]);
    // 本脚本不写 soft_deny、hard_deny、classifyAllShell：机器上的原样留着
    expect(am.soft_deny).toEqual(['机器上自己加的软拦']);
    expect(am.hard_deny).toEqual(['机器上自己加的硬拦']);
    expect(am.classifyAllShell).toBe(true);
    expectKind(m.check(), KEY, 'ok');
  });

  it('一直不写 autoMode 的老机器：同步时补上，两个数组的第一条都是 "$defaults"', () => {
    const m = machine();
    put(m.home, '.claude/settings.json', JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    expectKind(m.apply(), KEY, 'changed');
    const am = amOf(m);
    expect(am.environment?.[0]).toBe('$defaults');
    expect(am.allow?.[0]).toBe('$defaults');
  });

  it('仓里没写 autoMode（Devin 那种）：整段不管，机器上原有的一个不动', () => {
    const noAuto = JSON.stringify({ ...PERMS_SPEC, autoMode: undefined });
    const m = machine(['claude'], noAuto);
    const text = JSON.stringify({ autoMode: { environment: ['机器上的'], allow: ['机器上的'] } });
    put(m.home, '.claude/settings.json', text);
    expectKind(m.apply(), KEY, 'changed');
    expect(amOf(m)).toEqual({ environment: ['机器上的'], allow: ['机器上的'] });
  });

  it('defaultMode 不一样：覆盖成仓里的', () => {
    const m = machine();
    put(m.home, '.claude/settings.json', JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    expectKind(m.check(), KEY, 'drift');
    expectKind(m.apply(), KEY, 'changed');
    expect(permOf(m).defaultMode).toBe('auto');
  });

  // 创始人 2026-10-01：这台自己设成 bypassPermissions 的，保留、只报一行（仓里那份仍不许写，见下面的源文件用例）
  it('机器上自己设成 bypassPermissions：保留、不覆盖，报告里报出来', () => {
    const m = machine();
    put(
      m.home,
      '.claude/settings.json',
      JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }),
    );
    expectKind(m.check(), KEY, 'missing');
    expect(textOf(m.check())).toContain('这台自己设成 bypassPermissions');
    expectKind(m.apply(), KEY, 'changed');
    expect(textOf(m.apply())).toContain('这台自己设成 bypassPermissions');
    expect(permOf(m).defaultMode).toBe('bypassPermissions');
    // 保留的只是 defaultMode：allow、additionalDirectories、autoMode 照旧补上
    expect(permOf(m).allow).toEqual(PERMS_SPEC.allow);
    expect(permOf(m).additionalDirectories).toEqual([join(m.home, '.claude')]);
    expect(amOf(m).allow?.[0]).toBe('$defaults');
    // 改完再查：别的都补上了，只剩「这台自己设成 bypass」这一句
    expectKind(m.check(), KEY, 'ok');
    expect(textOf(m.check())).toContain('这台自己设成 bypassPermissions');
  });

  it('机器上是 auto、仓里也是 auto：照旧一致，不提 bypass 那句', () => {
    const m = machine();
    m.apply();
    expectKind(m.check(), KEY, 'ok');
    expect(textOf(m.check())).not.toContain('bypass');
    expect(textOf(m.apply())).not.toContain('bypass');
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

  it('autoMode：两档都带 "$defaults"（不带就是把内置规则整段换掉），而且只写日常、不写推删发强推', () => {
    if (!real.ok) throw new Error(real.why);
    const am = real.value.autoMode;
    expect(am).toBeDefined();
    if (am === undefined) return;
    expect(am.environment[0]).toBe('$defaults');
    expect(am.allow[0]).toBe('$defaults');
    // 决定 0007 第 5 条：和工作仓同一个主人的仓算自己的；改自己仓里单子和 PR 的标题、正文、标签、评论、子单关系是日常
    expect(am.environment.join('\n')).toContain('同一个 GitHub 主人');
    expect(am.allow.join('\n')).toContain('子单关系');
    // 2026-10-01 下午加的：从保险箱取凭证是日常，但「到处翻找凭证」不在这条里（放行的是正规取法，不是翻记录）
    expect(am.allow.join('\n')).toContain('取凭证走保险箱是日常');
    expect(am.allow.join('\n')).toContain('不含');
    // 同一天再收窄（创始人指出两处）：只指保险箱里那两个目录；写清登一次就回来的东西不在保险箱里
    // 当晚再收窄（创始人：「韶关 3 号楼这一种根本就不需要存进我们的保险箱里」）：保险箱只放我们自己有、
    // 丢了别处再也没有的东西；别人家的现场凭据（现场服务器 root、数据库账号）不算。
    expect(am.allow.join('\n')).toContain('workstation/vps-subscription/');
    expect(am.allow.join('\n')).toContain('登一次就能回来的');
    expect(am.allow.join('\n')).toContain('丢了别处再也没有');
    expect(am.allow.join('\n')).not.toContain('workstation/sites');
    expect(am.allow.join('\n')).toContain('别人家的现场凭据');
    // 不放宽的那几样：没有一条是给「推送/强推/删除/发布」开路的
    const allowed = am.allow.filter((r) => r !== '$defaults');
    expect(allowed.length).toBeGreaterThan(0);
    for (const r of allowed) expect(r).not.toMatch(/允许(推送|强推|删除|发布)/);
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
  bad('autoMode 不是对象', '{"autoMode": []}', 'drift');
  bad('autoMode.environment 不是数组', '{"autoMode": {"environment": "x"}}', 'drift');
  bad('autoMode.allow 不是数组', '{"autoMode": {"allow": 3}}', 'drift');
  // 机器上那一档在、却没带 "$defaults"：内置规则已经被整段换掉了，没有源文件也认得出，报出来、整份不动
  bad('机器上 autoMode.environment 没带 "$defaults"', '{"autoMode": {"environment": ["机器上的"]}}', 'drift');
});

describe('仓里的源文件', () => {
  it('没有这个文件：查报没查成、写报没做成，不拿空的顶上', () => {
    const m = machine(['claude'], null);
    expectKind(m.check(), KEY, 'unknown');
    expectKind(m.apply(), KEY, 'failed');
    expect(() => m.settings()).toThrow();
  });

  // 机器上自己设成 bypassPermissions 保留（上面「装」那一节的用例），源文件里写 bypassPermissions 照旧拒收：
  // 仓里那份会装到无人值守的机器上，写它就是要把「不用问」推给所有机器
  it('机器上、仓里都是 bypassPermissions：源文件拒收（FORBIDDEN_MODES 那条仍在），机器上的一个字节不碰', () => {
    const bypass = JSON.stringify({ ...PERMS_SPEC, defaultMode: 'bypassPermissions' });
    const m = machine(['claude'], bypass);
    const text = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });
    put(m.home, '.claude/settings.json', text);
    const parsed = parsePermissions(bypass, '/h');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.why).toContain('defaultMode 不许写 bypassPermissions');
    expectKind(m.check(), KEY, 'unknown');
    expectKind(m.apply(), KEY, 'failed');
    expect(get(m.home, '.claude/settings.json')).toBe(text);
  });

  it('仓里的 autoMode.allow 少一条（含新增的那类日常）：算缺失，--check 报出来，补上后 "$defaults" 还在最前', () => {
    // 拿真装过一遍的那份当底：别的项都在，只从机器上的 autoMode.allow 里去掉仓里有的一条
    const gone = PERMS_SPEC.autoMode.allow.find((r) => r !== '$defaults') as string;
    const m = machine();
    m.apply();
    const have = getJson(m.home, '.claude/settings.json') as { autoMode: { allow: string[] } };
    have.autoMode.allow = have.autoMode.allow.filter((r) => r !== gone);
    put(m.home, '.claude/settings.json', JSON.stringify(have));
    const check = m.check();
    expectKind(check, KEY, 'missing');
    expect(textOf(check)).toContain('autoMode.allow 少 1 条');
    expectKind(m.apply(), KEY, 'changed');
    const after = amOf(m);
    expect(after.allow?.[0]).toBe('$defaults');
    expect(after.allow).toContain(gone);
    expectKind(m.check(), KEY, 'ok');
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
    // autoMode：Danger 那句「少一个 "$defaults" 就把这一类的内置规则整段换掉」，宁可拒收也不替它补上
    ['autoMode 不是对象', JSON.stringify({ ...PERMS_SPEC, autoMode: [] })],
    [
      'autoMode.environment 没带 "$defaults"',
      JSON.stringify({
        ...PERMS_SPEC,
        autoMode: { ...PERMS_SPEC.autoMode, environment: ['只有自己的规则'] },
      }),
    ],
    [
      'autoMode.allow 没带 "$defaults"',
      JSON.stringify({ ...PERMS_SPEC, autoMode: { ...PERMS_SPEC.autoMode, allow: ['只有自己的规则'] } }),
    ],
    [
      'autoMode 里只有 "$defaults"、没有自己的规则',
      JSON.stringify({ ...PERMS_SPEC, autoMode: { environment: ['$defaults'], allow: ['$defaults'] } }),
    ],
    ['autoMode 少写一档', JSON.stringify({ ...PERMS_SPEC, autoMode: { allow: ['$defaults', '一条'] } })],
    [
      'autoMode.allow 不是数组',
      JSON.stringify({ ...PERMS_SPEC, autoMode: { ...PERMS_SPEC.autoMode, allow: 'x' } }),
    ],
    [
      'autoMode.allow 里有空串',
      JSON.stringify({ ...PERMS_SPEC, autoMode: { ...PERMS_SPEC.autoMode, allow: ['$defaults', ''] } }),
    ],
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
