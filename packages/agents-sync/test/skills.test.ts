// skill 分发：拷进各家 skill 目录、仓里删了就撤、不是本脚本装的一律不碰。
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { manifestPath, readManifest } from '../src/manifest.ts';
import { exitCode } from '../src/report.ts';
import { applySkills, checkSkills } from '../src/sync.ts';
import type { AgentId } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  expectKind,
  get,
  kinds,
  linkDir,
  makeRepo,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const GRILL = { 'SKILL.md': '---\nname: grill-me\n---\n拷问我。\n', 'refs/more.md': '更多\n' };
const CHAIN = { 'SKILL.md': '---\nname: chain-first\n---\n先查断链。\n' };

function machine(
  skills: Record<string, Record<string, string>> | null,
  installed: AgentId[] = ['claude', 'codex'],
) {
  const home = tempDir('home');
  let repo = makeRepo(skills);
  const ctx = ctxFor(home, installed);
  const manifest = () => readManifest(manifestPath(home, PLATFORM));
  return {
    home,
    setRepo: (next: Record<string, Record<string, string>> | null) => {
      repo = makeRepo(next);
    },
    apply: () => applySkills(ctx, sources(repo), manifest()),
    check: () => checkSkills(ctx, sources(repo), manifest()),
    manifest,
  };
}

describe('装', () => {
  it('拷进装了的那几家的目录、记进清单；查判一致；第二遍零改动', () => {
    const m = machine({ 'grill-me': GRILL, 'chain-first': CHAIN });
    const first = m.apply();
    expect(first.filter((l) => l.kind === 'changed').map((l) => l.key)).toEqual([
      '~/.claude/skills/chain-first',
      '~/.claude/skills/grill-me',
      '~/.agents/skills/chain-first',
      '~/.agents/skills/grill-me',
    ]);
    expect(get(m.home, '.claude/skills/grill-me/refs/more.md')).toBe('更多\n');
    expect(get(m.home, '.agents/skills/chain-first/SKILL.md')).toBe(CHAIN['SKILL.md']);
    expect(m.manifest()).toEqual({
      ok: true,
      value: {
        skills: {
          '.agents/skills': ['chain-first', 'grill-me'],
          '.claude/skills': ['chain-first', 'grill-me'],
        },
      },
    });
    const lines = m.check();
    expectKind(lines, '~/.claude/skills', 'ok');
    expectKind(lines, '~/.agents/skills', 'ok');
    expect(exitCode(lines)).toBe(0);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });

  it('没装的那家（Antigravity）：跳过，不建它的目录', () => {
    const m = machine({ 'grill-me': GRILL }, ['claude']);
    const lines = m.apply();
    expectKind(lines, '~/.gemini/antigravity-cli/skills', 'skip');
    expectKind(lines, '~/.agents/skills', 'skip');
    expect(existsSync(join(m.home, '.gemini'))).toBe(false);
    expect(existsSync(join(m.home, '.agents'))).toBe(false);
  });

  it('装上的被人删了一个：查判缺失；再写补回来', () => {
    const m = machine({ 'grill-me': GRILL });
    m.apply();
    rmTree(join(m.home, '.agents', 'skills', 'grill-me'));
    expectKind(m.check(), '~/.agents/skills/grill-me', 'missing');
    expectKind(m.apply(), '~/.agents/skills/grill-me', 'changed');
    expect(exitCode(m.check())).toBe(0);
  });

  it('装上的被人改了：查判漂移；再写换回仓里的版本', () => {
    const m = machine({ 'grill-me': GRILL });
    m.apply();
    put(m.home, '.claude/skills/grill-me/SKILL.md', '被人改了\n');
    const lines = m.check();
    expectKind(lines, '~/.claude/skills/grill-me', 'drift');
    expect(lines.find((l) => l.key === '~/.claude/skills/grill-me')?.text).toContain('改了 SKILL.md');
    expectKind(m.apply(), '~/.claude/skills/grill-me', 'changed');
    expect(get(m.home, '.claude/skills/grill-me/SKILL.md')).toBe(GRILL['SKILL.md']);
  });

  it('只差 \\r：不算漂移', () => {
    const m = machine({ 'grill-me': GRILL });
    m.apply();
    put(m.home, '.claude/skills/grill-me/SKILL.md', GRILL['SKILL.md'].replaceAll('\n', '\r\n'));
    expectKind(m.check(), '~/.claude/skills', 'ok');
  });
});

describe('仓里删掉的 skill 被撤', () => {
  it('清单里记着、仓里没了：从每个目录撤掉，清单跟着改；别的不动', () => {
    const m = machine({ 'grill-me': GRILL, 'chain-first': CHAIN });
    m.apply();
    put(m.home, '.claude/skills/synced/some-bucket/SKILL.md', 'claude.ai 同步来的\n');
    m.setRepo({ 'grill-me': GRILL });
    expectKind(m.check(), '~/.claude/skills/chain-first', 'drift');
    const lines = m.apply();
    expectKind(lines, '~/.claude/skills/chain-first', 'changed');
    expectKind(lines, '~/.agents/skills/chain-first', 'changed');
    expect(existsSync(join(m.home, '.claude', 'skills', 'chain-first'))).toBe(false);
    expect(existsSync(join(m.home, '.agents', 'skills', 'chain-first'))).toBe(false);
    expect(readdirSync(join(m.home, '.claude', 'skills')).sort()).toEqual(['grill-me', 'synced']);
    expect(m.manifest()).toMatchObject({ ok: true, value: { skills: { '.claude/skills': ['grill-me'] } } });
    expect(exitCode(m.check())).toBe(0);
  });

  it('仓里的 agents/skills/ 整个没了：装过的照样撤', () => {
    const m = machine({ 'grill-me': GRILL });
    m.apply();
    m.setRepo(null);
    m.apply();
    expect(existsSync(join(m.home, '.claude', 'skills', 'grill-me'))).toBe(false);
    expect(kinds(m.check(), 'agents/skills')).toEqual(['skip']);
  });
});

describe('不是本脚本装的一律不碰', () => {
  it('同名的真目录（内容不同）：写不动它、报没做成；查判漂移', () => {
    const m = machine({ 'grill-me': GRILL });
    put(m.home, '.claude/skills/grill-me/SKILL.md', '别人自己的 grill-me\n');
    expectKind(m.apply(), '~/.claude/skills/grill-me', 'failed');
    expect(get(m.home, '.claude/skills/grill-me/SKILL.md')).toBe('别人自己的 grill-me\n');
    const mf = m.manifest();
    expect(mf.ok).toBe(true);
    if (mf.ok) {
      expect(mf.value.skills['.agents/skills']).toEqual(['grill-me']);
      expect(mf.value.skills['.claude/skills']).toBeUndefined();
    }
    expectKind(m.check(), '~/.claude/skills/grill-me', 'drift');
  });

  it('同名的是链接（插件、旧仓链进来的）：不动链接，也不动它指的东西', () => {
    const m = machine({ 'grill-me': GRILL });
    const plugin = tempDir('plugin');
    put(plugin, 'grill-me/SKILL.md', '插件的\n');
    linkDir(join(plugin, 'grill-me'), join(m.home, '.claude', 'skills', 'grill-me'));
    expectKind(m.apply(), '~/.claude/skills/grill-me', 'failed');
    expect(get(m.home, '.claude/skills/grill-me/SKILL.md')).toBe('插件的\n');
    expect(get(plugin, 'grill-me/SKILL.md')).toBe('插件的\n');
    expectKind(m.check(), '~/.claude/skills/grill-me', 'drift');
  });

  it('清单里没记的，仓里删了也不撤', () => {
    const m = machine({ 'grill-me': GRILL });
    put(m.home, '.claude/skills/my-own/SKILL.md', '我自己的\n');
    m.apply();
    m.setRepo({});
    m.apply();
    expect(get(m.home, '.claude/skills/my-own/SKILL.md')).toBe('我自己的\n');
    expect(existsSync(join(m.home, '.claude', 'skills', 'grill-me'))).toBe(false);
  });

  it('同名目录、内容和仓里一字不差（清单丢了的情形）：记进清单，之后归本脚本管', () => {
    const m = machine({ 'grill-me': GRILL });
    for (const [rel, content] of Object.entries(GRILL))
      put(m.home, `.claude/skills/grill-me/${rel}`, content);
    const lines = m.apply();
    expectKind(lines, '~/.claude/skills/grill-me', 'changed');
    expect(lines.find((l) => l.key === '~/.claude/skills/grill-me')?.text).toContain('记进清单');
    expect(m.manifest()).toMatchObject({ ok: true, value: { skills: { '.claude/skills': ['grill-me'] } } });
  });
});

describe('没有 skill、清单读不懂', () => {
  it('仓里没有 agents/skills/：报「没有 skill 可分发」，不算失败，也不建清单', () => {
    const m = machine(null);
    for (const lines of [m.check(), m.apply()]) {
      expect(lines).toHaveLength(1);
      expectKind(lines, 'agents/skills', 'skip');
      expect(lines[0]?.text).toContain('没有 skill 可分发');
      expect(exitCode(lines)).toBe(0);
    }
    expect(existsSync(manifestPath(m.home, PLATFORM))).toBe(false);
  });

  it('清单不是 JSON：查判没查成（退出码 2），写一个 skill 都不动——不当成空清单', () => {
    const m = machine({ 'grill-me': GRILL });
    put(m.home, '.fleet-dao/agents-sync.json', '{ 坏了');
    put(m.home, '.claude/skills/grill-me/SKILL.md', '清单坏了时不许动我\n');
    const checked = m.check();
    expect(checked.map((l) => l.kind)).toEqual(['unknown']);
    expect(exitCode(checked)).toBe(2);
    const applied = m.apply();
    expect(applied.map((l) => l.kind)).toEqual(['failed']);
    expect(get(m.home, '.claude/skills/grill-me/SKILL.md')).toBe('清单坏了时不许动我\n');
    expect(existsSync(join(m.home, '.agents', 'skills'))).toBe(false);
  });

  it('清单形状不对（skills 不是对象、名字不是字符串）：一样读不懂', () => {
    const file = put(tempDir('m'), 'agents-sync.json', JSON.stringify({ skills: { '.claude/skills': [1] } }));
    expect(readManifest(file).ok).toBe(false);
    const file2 = put(tempDir('m'), 'agents-sync.json', JSON.stringify({ skills: [] }));
    expect(readManifest(file2).ok).toBe(false);
  });
});

/** 测试里删装上的目录：用 node 自带的，不借被测代码的 removeEntry */
function rmTree(p: string): void {
  rmSync(p, { recursive: true, force: true });
}
