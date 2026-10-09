// 用户级子代理定义（#1393）：只装 SUBAGENT_TARGET 列了名字的（haiku55.md），~/.claude/agents/ 里别的文件不碰；
// 内容不一样先备份再覆盖、报出来；从名单里去掉的，清单里记着才撤；读不到、写不进都明确报出来，不当成没事。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { manifestPath, readManifest } from '../src/manifest.ts';
import { exitCode } from '../src/report.ts';
import { applySubagents, checkSubagents } from '../src/subagents.ts';
import { type AgentId, SUBAGENT_TARGET } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  expectKind,
  get,
  kinds,
  makeRepo,
  PLATFORM,
  put,
  SUBAGENT_FILES,
  SUBAGENT_MD,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const KEY = '~/.claude/agents/haiku55.md';
/** 机器上手写的、不归同步管的（把内置子代理钉到别名模型的那种） */
const HANDWRITTEN = '---\nname: Explore\nmodel: haiku\n---\n手写的，别碰\n';

function machine(
  subagents: Record<string, string> | null = SUBAGENT_FILES,
  installed: AgentId[] = ['claude'],
) {
  const home = tempDir('home');
  const repo = makeRepo({}, undefined, undefined, undefined, subagents);
  const ctx = ctxFor(home, installed);
  const manifest = () => readManifest(manifestPath(home, PLATFORM));
  let runs = 0;
  return {
    home,
    // 每次写用一个新的备份目录（时间往后挪一秒），和真跑一样
    apply: () =>
      applySubagents(
        ctx,
        sources(repo),
        manifest(),
        new Backups(home, PLATFORM, new Date(Date.UTC(2026, 9, 9, 12, 0, runs++))),
      ),
    check: () => checkSubagents(ctx, sources(repo), manifest()),
    manifest,
  };
}

/** 备份根目录下所有备份过的 haiku55.md 的内容 */
function backedUp(home: string): string[] {
  const root = join(home, '.fleet-dao', 'backups');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((stamp) => join(root, stamp, '.claude', 'agents', 'haiku55.md'))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8'));
}

describe('名单', () => {
  it('只同步 haiku55.md 这一份，装到 Claude Code 的用户级子代理目录', () => {
    expect(SUBAGENT_TARGET.files).toEqual(['haiku55.md']);
    expect(SUBAGENT_TARGET.dir).toEqual({ win32: '.claude\\agents', linux: '.claude/agents' });
    expect(SUBAGENT_TARGET.readers).toEqual(['claude']);
  });
});

describe('装', () => {
  it('没有就装上、记进清单；查判一致', () => {
    const m = machine();
    const before = m.check();
    expectKind(before, KEY, 'missing');
    expect(exitCode(before)).toBe(1);
    const first = m.apply();
    expectKind(first, KEY, 'changed');
    expect(get(m.home, '.claude/agents/haiku55.md')).toBe(SUBAGENT_MD);
    expect(m.manifest()).toMatchObject({
      ok: true,
      value: { subagents: { '.claude/agents': ['haiku55.md'] } },
    });
    const after = m.check();
    expectKind(after, KEY, 'ok');
    expect(exitCode(after)).toBe(0);
  });

  it('已是最新：第二遍零改动、不留备份；机器上原有的一份内容一样的，不覆盖、记进清单', () => {
    const m = machine();
    put(m.home, '.claude/agents/haiku55.md', SUBAGENT_MD);
    const first = m.apply();
    expectKind(first, KEY, 'ok');
    expect(m.manifest()).toMatchObject({
      ok: true,
      value: { subagents: { '.claude/agents': ['haiku55.md'] } },
    });
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
    expect(existsSync(join(m.home, '.fleet-dao', 'backups'))).toBe(false);
  });

  it('被手改过：查判漂移、说清从第几行起；写时先整份备份再换成仓里的，报出备份在哪', () => {
    const m = machine();
    m.apply();
    const edited = SUBAGENT_MD.replace('model: claude-haiku-5-5', 'model: haiku');
    put(m.home, '.claude/agents/haiku55.md', edited);
    const drift = m.check();
    expectKind(drift, KEY, 'drift');
    expect(drift.find((l) => l.key === KEY)?.text).toContain('第 4 行起');
    const fixed = m.apply();
    expectKind(fixed, KEY, 'changed');
    expect(fixed.find((l) => l.key === KEY)?.text).toContain('原文件已备份到');
    expect(backedUp(m.home)).toEqual([edited]);
    expect(get(m.home, '.claude/agents/haiku55.md')).toBe(SUBAGENT_MD);
    expectKind(m.check(), KEY, 'ok');
  });

  it('不是本脚本装的同名文件、内容不一样：一样先备份再覆盖（这一份归仓里管）', () => {
    const m = machine();
    put(m.home, '.claude/agents/haiku55.md', '---\nname: haiku55\nmodel: haiku\n---\n手建的旧版\n');
    expectKind(m.apply(), KEY, 'changed');
    expect(backedUp(m.home)).toEqual(['---\nname: haiku55\nmodel: haiku\n---\n手建的旧版\n']);
    expect(get(m.home, '.claude/agents/haiku55.md')).toBe(SUBAGENT_MD);
  });
});

describe('别的不碰', () => {
  it('~/.claude/agents/ 里不在名单上的文件不动、不删、不记进清单；仓里 agents/subagents/ 下没列名字的也不装', () => {
    const m = machine({ ...SUBAGENT_FILES, 'fleet-scout.md': '---\nname: fleet-scout\n---\n本仓项目级的\n' });
    put(m.home, '.claude/agents/Explore.md', HANDWRITTEN);
    put(m.home, '.claude/agents/Plan.md', HANDWRITTEN);
    const lines = m.apply();
    expect(lines.map((l) => l.key)).toEqual([KEY]);
    expect(get(m.home, '.claude/agents/Explore.md')).toBe(HANDWRITTEN);
    expect(get(m.home, '.claude/agents/Plan.md')).toBe(HANDWRITTEN);
    expect(existsSync(join(m.home, '.claude', 'agents', 'fleet-scout.md'))).toBe(false);
    expect(readdirSync(join(m.home, '.claude', 'agents')).sort()).toEqual([
      'Explore.md',
      'Plan.md',
      'haiku55.md',
    ]);
    expect(m.manifest()).toMatchObject({
      ok: true,
      value: { subagents: { '.claude/agents': ['haiku55.md'] } },
    });
    expect(m.check().map((l) => l.key)).toEqual([KEY]);
  });

  it('从名单里去掉的：清单里记着才撤（先备份）；同目录手写的照样不碰', () => {
    const m = machine();
    put(m.home, '.claude/agents/old55.md', '旧的同步装的\n');
    put(m.home, '.claude/agents/Explore.md', HANDWRITTEN);
    put(
      m.home,
      '.fleet-dao/agents-sync.json',
      JSON.stringify({ skills: {}, subagents: { '.claude/agents': ['haiku55.md', 'old55.md'] } }),
    );
    expectKind(m.check(), '~/.claude/agents/old55.md', 'drift');
    const lines = m.apply();
    expectKind(lines, '~/.claude/agents/old55.md', 'changed');
    expect(existsSync(join(m.home, '.claude', 'agents', 'old55.md'))).toBe(false);
    expect(get(m.home, '.claude/agents/Explore.md')).toBe(HANDWRITTEN);
    expect(m.manifest()).toMatchObject({
      ok: true,
      value: { subagents: { '.claude/agents': ['haiku55.md'] } },
    });
    expect(exitCode(m.check())).toBe(0);
  });

  it('没装 Claude Code：跳过，不建目录', () => {
    const m = machine(SUBAGENT_FILES, ['codex']);
    expectKind(m.apply(), '~/.claude/agents', 'skip');
    expect(existsSync(join(m.home, '.claude'))).toBe(false);
  });
});

describe('读不到、写不进：明确报出来', () => {
  it('仓里没有 agents/subagents/haiku55.md：查是没查成，写是没做成，一个字不写', () => {
    const m = machine(null);
    const checked = m.check();
    expect(kinds(checked, 'agents/subagents')).toEqual(['unknown']);
    expect(checked[0]?.text).toContain('仓里没有 agents/subagents/haiku55.md');
    expect(exitCode(checked)).toBe(2);
    expect(kinds(m.apply(), 'agents/subagents')).toEqual(['failed']);
    expect(existsSync(join(m.home, '.claude'))).toBe(false);
  });

  it('仓里那份的 name 和文件名对不上：不装（装上去就是另一个名字，派 haiku55 派不到）', () => {
    const m = machine({ 'haiku55.md': SUBAGENT_MD.replace('name: haiku55', 'name: haiku') });
    const checked = m.check();
    expect(checked[0]?.text).toContain('name 是「haiku」，和文件名对不上');
    expect(kinds(m.apply(), 'agents/subagents')).toEqual(['failed']);
    expect(existsSync(join(m.home, '.claude'))).toBe(false);
  });

  it('清单坏了：查是没查成，写一个不动', () => {
    const m = machine();
    put(m.home, '.fleet-dao/agents-sync.json', '{ 坏了');
    put(m.home, '.claude/agents/haiku55.md', '清单坏了时不许动我\n');
    expect(m.check().map((l) => l.kind)).toEqual(['unknown']);
    expect(m.apply().map((l) => l.kind)).toEqual(['failed']);
    expect(get(m.home, '.claude/agents/haiku55.md')).toBe('清单坏了时不许动我\n');
  });

  it('清单里子代理那一项形状不对、名字带路径：读不懂，不顺着名字删到目录外面', () => {
    for (const subagents of [[], { '.claude/agents': ['../../.ssh/id_test'] }, { '.claude/agents': [1] }]) {
      const file = put(tempDir('m'), 'agents-sync.json', JSON.stringify({ skills: {}, subagents }));
      expect(readManifest(file).ok, JSON.stringify(subagents)).toBe(false);
    }
  });

  it('【故意造出的失败】~/.claude/agents 是个文件、目录写不进：没做成、退出码 1，那个文件原样留着', () => {
    const m = machine();
    put(m.home, '.claude/agents', '占了目录位置的文件\n');
    const lines = m.apply();
    expectKind(lines, KEY, 'failed');
    expect(lines.find((l) => l.key === KEY)?.text).toContain('没做成');
    expect(exitCode(lines)).toBe(1);
    expect(get(m.home, '.claude/agents')).toBe('占了目录位置的文件\n');
    expect(exitCode(m.check())).not.toBe(0);
  });
});
