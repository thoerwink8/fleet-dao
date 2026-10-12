// 用户级子代理定义（#1393、决定 0087）：只装 SUBAGENT_TARGET 列了名字的三份（agents/subagents/ 下的 Explore.md、
// general-purpose.md、Plan.md，同名压住 Claude Code 内置的），~/.claude/agents/ 里别的文件不碰；同名的（Mirasim 设置页写的覆盖、
// 手写的）内容不一样先备份再覆盖、报出来；从名单里去掉的（上一版的 fleet-*、haiku55），清单里记着才撤（先备份）；
// 读不到、名单写错、写不进都明确报出来，不当成没事。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { manifestPath, readManifest } from '../src/manifest.ts';
import { exitCode } from '../src/report.ts';
import { applySubagents, checkSubagents } from '../src/subagents.ts';
import { SUBAGENTS_DIR } from '../src/sync.ts';
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
  subagentMd,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const KEY = '~/.claude/agents/Explore.md';
/** 名单里每份的文件名（三个角色），装到家里同名 */
const NAMES = [...SUBAGENT_TARGET.files];
const KEYS = NAMES.map((n) => `~/.claude/agents/${n}`);
/** 清单里记的名字（写清单时排好序） */
const SORTED = [...NAMES].sort();
/** 仓里这几份的原文（helpers 造的假内容），按家里的文件名 */
const SRC = (name: string) => subagentMd(name.replace(/\.md$/, ''));
/** Mirasim 设置页「覆盖…」写的那种同名文件（内置描述、别名 sonnet、后台跑；本机 2026-10-05 那 6 份就是这个样子） */
const MIRASIM_EXPLORE =
  '---\nname: Explore\ndescription: Fast read-only codebase search; no edits.\nmodel: sonnet\nbackground: true\n---\n';
/** 机器上手写的、不在名单里的（Mirasim 写的别的内置覆盖、自己加的） */
const HANDWRITTEN = '---\nname: claude-code-guide\nmodel: sonnet\n---\n手写的，别碰\n';

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

/** 备份根目录下所有备份过的某个文件（默认 Explore.md）的内容 */
function backedUp(home: string, name = 'Explore.md'): string[] {
  const root = join(home, '.fleet-dao', 'backups');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((stamp) => join(root, stamp, '.claude', 'agents', name))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8'));
}

describe('名单', () => {
  it('同步 agents/subagents/ 下的三个角色 Explore、general-purpose、Plan，装到 Claude Code 的用户级子代理目录', () => {
    expect(SUBAGENT_TARGET.files).toEqual(['Explore.md', 'general-purpose.md', 'Plan.md']);
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
    for (const k of KEYS) expectKind(first, k, 'changed');
    expect(get(m.home, '.claude/agents/Explore.md')).toBe(SUBAGENT_MD);
    for (const n of NAMES) expect(get(m.home, `.claude/agents/${n}`), n).toBe(SRC(n));
    expect(m.manifest()).toMatchObject({
      ok: true,
      value: { subagents: { '.claude/agents': SORTED } },
    });
    const after = m.check();
    for (const k of KEYS) expectKind(after, k, 'ok');
    expect(exitCode(after)).toBe(0);
  });

  it('已是最新：第二遍零改动、不留备份；机器上原有的一份内容一样的，不覆盖、记进清单', () => {
    const m = machine();
    put(m.home, '.claude/agents/Explore.md', SUBAGENT_MD);
    const first = m.apply();
    expectKind(first, KEY, 'ok');
    expect(m.manifest()).toMatchObject({
      ok: true,
      value: { subagents: { '.claude/agents': SORTED } },
    });
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
    expect(existsSync(join(m.home, '.fleet-dao', 'backups'))).toBe(false);
  });

  it('被手改过：查判漂移、说清从第几行起；写时先整份备份再换成仓里的，报出备份在哪', () => {
    const m = machine();
    m.apply();
    const edited = SUBAGENT_MD.replace('model: claude-haiku-5-5', 'model: haiku');
    put(m.home, '.claude/agents/Explore.md', edited);
    const drift = m.check();
    expectKind(drift, KEY, 'drift');
    expect(drift.find((l) => l.key === KEY)?.text).toContain('第 4 行起');
    const fixed = m.apply();
    expectKind(fixed, KEY, 'changed');
    expect(fixed.find((l) => l.key === KEY)?.text).toContain('原文件已备份到');
    expect(backedUp(m.home)).toEqual([edited]);
    expect(get(m.home, '.claude/agents/Explore.md')).toBe(SUBAGENT_MD);
    expectKind(m.check(), KEY, 'ok');
  });

  it('Mirasim 设置页写的同名覆盖（别名 sonnet）：不是本脚本装的也先整份备份再换成仓里的（这三份归仓里管，决定 0087）', () => {
    const m = machine();
    put(m.home, '.claude/agents/Explore.md', MIRASIM_EXPLORE);
    expectKind(m.check(), KEY, 'drift');
    expectKind(m.apply(), KEY, 'changed');
    expect(backedUp(m.home)).toEqual([MIRASIM_EXPLORE]);
    expect(get(m.home, '.claude/agents/Explore.md')).toBe(SUBAGENT_MD);
  });
});

describe('别的不碰', () => {
  it('~/.claude/agents/ 里不在名单上的文件不动、不删、不记进清单；仓里没列名字的也不装', () => {
    const m = machine({
      ...SUBAGENT_FILES,
      'agents/subagents/other55.md': subagentMd('other55'),
    });
    put(m.home, '.claude/agents/claude-code-guide.md', HANDWRITTEN);
    const lines = m.apply();
    expect(lines.map((l) => l.key)).toEqual(KEYS);
    expect(get(m.home, '.claude/agents/claude-code-guide.md')).toBe(HANDWRITTEN);
    expect(existsSync(join(m.home, '.claude', 'agents', 'other55.md'))).toBe(false);
    expect(readdirSync(join(m.home, '.claude', 'agents')).sort()).toEqual(
      ['claude-code-guide.md', ...NAMES].sort(),
    );
    expect(m.manifest()).toMatchObject({
      ok: true,
      value: { subagents: { '.claude/agents': SORTED } },
    });
    expect(m.check().map((l) => l.key)).toEqual(KEYS);
  });

  it('从名单里去掉的（上一版的 fleet-*、haiku55）：清单里记着才撤（先备份）；同目录手写的照样不碰', () => {
    const m = machine();
    put(m.home, '.claude/agents/fleet-scout.md', subagentMd('fleet-scout'));
    put(m.home, '.claude/agents/haiku55.md', subagentMd('haiku55'));
    put(m.home, '.claude/agents/claude-code-guide.md', HANDWRITTEN);
    put(
      m.home,
      '.fleet-dao/agents-sync.json',
      JSON.stringify({ skills: {}, subagents: { '.claude/agents': ['fleet-scout.md', 'haiku55.md'] } }),
    );
    expectKind(m.check(), '~/.claude/agents/fleet-scout.md', 'drift');
    expectKind(m.check(), '~/.claude/agents/haiku55.md', 'drift');
    const lines = m.apply();
    for (const old of ['fleet-scout.md', 'haiku55.md']) {
      expectKind(lines, `~/.claude/agents/${old}`, 'changed');
      expect(existsSync(join(m.home, '.claude', 'agents', old)), old).toBe(false);
      expect(backedUp(m.home, old), old).toEqual([subagentMd(old.replace(/\.md$/, ''))]);
    }
    expect(get(m.home, '.claude/agents/claude-code-guide.md')).toBe(HANDWRITTEN);
    expect(m.manifest()).toMatchObject({
      ok: true,
      value: { subagents: { '.claude/agents': SORTED } },
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
  it('仓里没有 agents/subagents/Explore.md：查是没查成，写是没做成，一个字不写', () => {
    const m = machine(null);
    const checked = m.check();
    expect(kinds(checked, SUBAGENTS_DIR)).toEqual(['unknown']);
    expect(checked[0]?.text).toContain('仓里没有 agents/subagents/Explore.md');
    expect(exitCode(checked)).toBe(2);
    expect(kinds(m.apply(), SUBAGENTS_DIR)).toEqual(['failed']);
    expect(existsSync(join(m.home, '.claude'))).toBe(false);
  });

  it('仓里少了一份（检出不全）：整段没查成、一个不装，不少装（少装会让清单把它当成撤了）', () => {
    const { 'agents/subagents/Plan.md': _gone, ...rest } = SUBAGENT_FILES;
    const m = machine(rest);
    const checked = m.check();
    expect(kinds(checked, SUBAGENTS_DIR)).toEqual(['unknown']);
    expect(checked[0]?.text).toContain('仓里没有 agents/subagents/Plan.md');
    expect(kinds(m.apply(), SUBAGENTS_DIR)).toEqual(['failed']);
    expect(existsSync(join(m.home, '.claude'))).toBe(false);
  });

  it('【故意造出的失败】名单里同一个文件名列了两遍、或写成带目录的路径：整段没查成、一个不装', () => {
    const target = SUBAGENT_TARGET as { files: readonly string[] };
    const orig = target.files;
    try {
      for (const [files, why] of [
        [[...orig, 'Plan.md'], 'Plan.md 列了两遍'],
        [[...orig.slice(1), '.claude/agents/Explore.md'], '带了目录'],
      ] as const) {
        target.files = files;
        const m = machine();
        const checked = m.check();
        expect(kinds(checked, SUBAGENTS_DIR), why).toEqual(['unknown']);
        expect(checked[0]?.text).toContain(why);
        expect(kinds(m.apply(), SUBAGENTS_DIR)).toEqual(['failed']);
        expect(existsSync(join(m.home, '.claude'))).toBe(false);
      }
    } finally {
      target.files = orig;
    }
  });

  it('仓里那份的 name 和文件名对不上（含大小写）：不装（装上去就是另一个名字，压不住内置的）', () => {
    const m = machine({
      ...SUBAGENT_FILES,
      'agents/subagents/Explore.md': SUBAGENT_MD.replace('name: Explore', 'name: explore'),
    });
    const checked = m.check();
    expect(checked[0]?.text).toContain('name 是「explore」，和文件名对不上');
    expect(kinds(m.apply(), SUBAGENTS_DIR)).toEqual(['failed']);
    expect(existsSync(join(m.home, '.claude'))).toBe(false);
    const gp = machine({
      ...SUBAGENT_FILES,
      'agents/subagents/general-purpose.md': subagentMd('general-purpose').replace(
        'name: general-purpose',
        'name: general',
      ),
    });
    expect(gp.check()[0]?.text).toContain('agents/subagents/general-purpose.md 的 name 是「general」');
  });

  it('清单坏了：查是没查成，写一个不动', () => {
    const m = machine();
    put(m.home, '.fleet-dao/agents-sync.json', '{ 坏了');
    put(m.home, '.claude/agents/Explore.md', '清单坏了时不许动我\n');
    expect(m.check().map((l) => l.kind)).toEqual(['unknown']);
    expect(m.apply().map((l) => l.kind)).toEqual(['failed']);
    expect(get(m.home, '.claude/agents/Explore.md')).toBe('清单坏了时不许动我\n');
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
