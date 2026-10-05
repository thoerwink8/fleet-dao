// 改标准的路径清单（standard-paths.json）的读法和匹配：目录、通配、改名；认不出的清单一律报错，不当成「没碰到」。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../src/merge-gates.ts';
import {
  matchesStandardPath,
  parseStandardPaths,
  type StandardPath,
  standardFiles,
} from '../src/standard-paths.ts';

const file = (filename: string, previous?: string): ChangedFile => ({
  filename,
  status: previous ? 'renamed' : 'modified',
  ...(previous ? { previous } : {}),
});

const real = (): StandardPath[] => {
  const text = readFileSync(new URL('../standard-paths.json', import.meta.url), 'utf8');
  const parsed = parseStandardPaths(text);
  if (typeof parsed === 'string') throw new Error(`仓里真实的清单读不出：${parsed}`);
  return parsed;
};

describe('读清单', () => {
  it('仓里真实的 standard-paths.json 读得出来（没有 kind）；通用段的原件单列，仓根 AGENTS.md 不在里面', () => {
    const list = real();
    expect(list.length).toBeGreaterThan(3);
    expect(list.map((r) => r.path)).toContain('agents/shared-rules.md');
    expect(list.map((r) => r.path)).toContain('agents/**/*.md');
    // 通用段 2026-10-05 挪出了仓根 AGENTS.md，那里只剩本仓段，不算标准
    expect(list.map((r) => r.path)).not.toContain('AGENTS.md');
  });

  it('section 照样认（清单里眼下没有带 section 的条目，读法留着）', () => {
    expect(parseStandardPaths('{"paths":[{"path":"a.md","why":"w","section":" 某段 "}]}')).toEqual([
      { path: 'a.md', why: 'w', section: '某段' },
    ]);
  });

  it('认不出的都回一句为什么（不是空数组）：坏 JSON、没有 paths、空 paths、缺 why、绝对路径、..、反斜杠', () => {
    const bad: [string, RegExp][] = [
      ['{', /不是合法的 JSON/],
      ['[]', /没有 paths/],
      ['{"paths":{}}', /没有 paths/],
      ['{"paths":[]}', /paths 是空的/],
      ['{"paths":[{"path":"a"}]}', /认不出/],
      ['{"paths":[{"path":"a","why":"  "}]}', /没写为什么/],
      ['{"paths":[{"path":"/etc/x","why":"w"}]}', /不是仓内相对路径/],
      ['{"paths":[{"path":"a/../b","why":"w"}]}', /不是仓内相对路径/],
      ['{"paths":[{"path":"a\\\\b","why":"w"}]}', /不是仓内相对路径/],
      ['{"paths":[{"path":"a/*/","why":"w"}]}', /又是目录又带通配/],
      ['{"paths":[{"path":"a**/b","why":"w"}]}', /单独占一层/],
      ['{"paths":[{"path":"a/**b","why":"w"}]}', /单独占一层/],
      ['{"paths":[{"path":"a","why":"w","section":" "}]}', /section/],
    ];
    for (const [text, why] of bad) {
      const got = parseStandardPaths(text);
      expect(typeof got, text).toBe('string');
      expect(got as string, text).toMatch(why);
    }
  });
});

describe('匹配', () => {
  const m = (path: string, name: string) => matchesStandardPath(name, { path });

  it('单个文件：必须整名相等', () => {
    expect(m('AGENTS.md', 'AGENTS.md')).toBe(true);
    expect(m('AGENTS.md', 'docs/AGENTS.md')).toBe(false);
    expect(m('AGENTS.md', 'AGENTS.md.bak')).toBe(false);
  });

  it('目录：以 / 结尾，下面所有文件都算，同名前缀的别的目录不算', () => {
    expect(m('agents/test/rules/', 'agents/test/rules/a.test.ts')).toBe(true);
    expect(m('agents/test/rules/', 'agents/test/rules/sub/b.ts')).toBe(true);
    expect(m('agents/test/rules/', 'agents/test/rules')).toBe(false);
    expect(m('agents/test/rules/', 'agents/test/rules-extra/a.ts')).toBe(false);
  });

  it('通配：* 不跨目录，** 跨目录，** 后跟 / 时可以是零层', () => {
    expect(m('agents/**/*.md', 'agents/skills/foo/SKILL.md')).toBe(true);
    expect(m('agents/**/*.md', 'agents/README.md')).toBe(true);
    expect(m('agents/**/*.md', 'agents/skills/foo/run.mjs')).toBe(false);
    expect(m('agents/**/*.md', 'xagents/README.md')).toBe(false);
    expect(m('docs/*.md', 'docs/a.md')).toBe(true);
    expect(m('docs/*.md', 'docs/sub/a.md')).toBe(false);
    expect(m('docs/**', 'docs/sub/deep/a.md')).toBe(true);
    expect(m('docs/**', 'docs')).toBe(false);
    // 正则里的特殊字符按字面算
    expect(m('a.b/*.md', 'a.b/x.md')).toBe(true);
    expect(m('a.b/*.md', 'aXb/x.md')).toBe(false);
  });
});

describe('改到的文件里落进清单的', () => {
  it('真实清单：技能说明、通用段原件、钉规矩的测试、清单本身都算；技能脚本、仓根 AGENTS.md（只剩本仓段）和普通代码不算', () => {
    const hits = standardFiles(
      [
        file('agents/skills/discuss/SKILL.md'),
        file('agents/shared-rules.md'),
        file('AGENTS.md'),
        file('agents/test/rules/permissions.test.ts'),
        file('packages/conventions/standard-paths.json'),
        file('agents/skills/discuss/scripts/second-opinion.mjs'),
        file('packages/engine/src/workflows/task.ts'),
      ],
      real(),
    );
    expect(hits.map((h) => h.file)).toEqual([
      'agents/skills/discuss/SKILL.md',
      'agents/shared-rules.md',
      'agents/test/rules/permissions.test.ts',
      'packages/conventions/standard-paths.json',
    ]);
    // 通用段原件命中的是自己那条（理由写的是通用段），不是技能说明的通配
    expect(hits.find((h) => h.file === 'agents/shared-rules.md')).toMatchObject({
      rule: 'agents/shared-rules.md',
    });
    expect(hits[0]).toMatchObject({ rule: 'agents/**/*.md' });
  });

  it('【故意造出的失败】通用段原件挪出了标准目录（改名到别处）：旧名照样算碰了标准', () => {
    const hits = standardFiles([file('docs/shared-rules.md', 'agents/shared-rules.md')], real());
    expect(hits.map((h) => h.file)).toEqual(['agents/shared-rules.md']);
  });

  it('改名：新旧名字都算（从标准目录挪出去也是碰了它）；同一个名字只报一次', () => {
    const list: StandardPath[] = [{ path: 'agents/test/rules/', why: 'w' }];
    const hits = standardFiles(
      [file('tmp/moved.test.ts', 'agents/test/rules/old.test.ts'), file('agents/test/rules/x.ts')],
      list,
    );
    expect(hits.map((h) => h.file)).toEqual(['agents/test/rules/old.test.ts', 'agents/test/rules/x.ts']);
    expect(
      standardFiles([file('agents/test/rules/x.ts'), file('agents/test/rules/x.ts')], list),
    ).toHaveLength(1);
  });

  it('什么都没碰：空数组（调用方分得清「没碰到」和「清单读不出」，后者是 parseStandardPaths 返回字符串）', () => {
    expect(standardFiles([file('README.md')], real())).toEqual([]);
    expect(standardFiles([], real())).toEqual([]);
  });
});
