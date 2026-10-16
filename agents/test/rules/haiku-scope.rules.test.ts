// 钉住「简单的活降到 Haiku 5.5」的护栏（决定 0102）：窄改动编码给 Haiku 的三条缺一不可，Haiku 档子代理的模型和 effort。
// 改标准：改这个文件要创始人同意（packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 为什么钉指挥官技能里的这三条（决定 0089 第 4 条「只核对某句话在不在的测试删掉」的例外，0102 写明）：三条是放宽的护栏，
// 少了任何一条（尤其「机器核对」）Haiku 改错了没人发现，整个放宽的前提就没了；钉的是「恰好三条、各管一件」这个结构，
// 不钉措辞，三条里换说法不红。
// 钉这几处：
// 1. agents/skills/commander/SKILL.md 里写着给工人传 model: "haiku" 的那一段，下面紧跟的编号条目恰好三条，
//    分别管：窄（改动范围）、机器核对（派前定好的测试或命令）、规矩写全（规则和边界写进交代）。多一条、少一条、
//    两条管同一件、哪条拿掉都红。
// 2. Haiku 档的两个角色：斥候 Explore 钉 claude-haiku-5-5；它和窄改动时降到 Haiku 的工人 general-purpose，effort 都不低于
//    medium（官方提示指南：low 档加长提示会提前收工、没跑核对就说改完）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8').replace(/\r\n/g, '\n');

const SKILL = read('agents/skills/commander/SKILL.md');
const DEFS = {
  Explore: read('agents/subagents/Explore.md'),
  'general-purpose': read('agents/subagents/general-purpose.md'),
};

/** 窄改动编码的三条各管什么：名字、怎么认。一条条目只许认成其中一件 */
const CONDITIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ['窄', /窄/],
  ['机器核对', /机器核对/],
  ['规矩写全', /写全/],
];

/** 从 SKILL.md 里找给工人传 model: "haiku" 的那一行，取它下面紧跟的编号条目（缩进的 `1. …`）；找不到明确报错 */
function narrowItems(text: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes('model: "haiku"') && l.includes('缺一不可'));
  if (at < 0) throw new Error('SKILL.md 里找不到写着 model: "haiku" 和「缺一不可」的那一行');
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^\s+\d+\.\s+(.*)$/.exec(line);
    if (!m) break;
    items.push(m[1] ?? '');
  }
  return items;
}

/** 三条的毛病；空数组才算对 */
function narrowProblems(items: readonly string[]): string[] {
  const out: string[] = [];
  if (items.length !== CONDITIONS.length)
    out.push(`窄改动编码的条目是 ${items.length} 条，该是恰好 ${CONDITIONS.length} 条`);
  for (const [name, re] of CONDITIONS) {
    const hits = items.filter((t) => re.test(t));
    if (hits.length === 0) out.push(`缺「${name}」那一条`);
    if (hits.length > 1) out.push(`「${name}」写在了 ${hits.length} 条里`);
  }
  for (const t of items) {
    const kinds = CONDITIONS.filter(([, re]) => re.test(t)).map(([n]) => n);
    if (kinds.length > 1) out.push(`一条管了几件（${kinds.join('、')}）：${t}`);
  }
  return out;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const frontmatter = (text: string, key: string) =>
  new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '')?.[1]?.trim();

/** Haiku 档角色的毛病；空数组才算对 */
function tierProblems(defs: Record<string, string>): string[] {
  const out: string[] = [];
  const explore = defs.Explore ?? '';
  if (frontmatter(explore, 'model') !== 'claude-haiku-5-5')
    out.push(`Explore 的 model 是「${frontmatter(explore, 'model') ?? '没写'}」，该是 claude-haiku-5-5`);
  for (const [name, text] of Object.entries(defs)) {
    const effort = frontmatter(text, 'effort');
    if (effort === undefined || EFFORTS.indexOf(effort) < EFFORTS.indexOf('medium'))
      out.push(`${name} 的 effort 是「${effort ?? '没写'}」，Haiku 档不许低于 medium`);
  }
  return out;
}

/**
 * 工人的档位（创始人 2026-10-16 19:24 更正，决定 0102「创始人确认」一节）：工人默认 Sonnet、effort medium，
 * 描述里写着窄改动编码可降 Haiku；规矩里不许出现「本机工人默认 Opus」（被撤回的决定 0103 的说法）。
 * 线性读 SKILL.md、shared-rules.md、两份子代理定义，毛病空数组才算对。
 */
function workerProblems(defs: Record<string, string>, rules: Record<string, string>): string[] {
  const out: string[] = [];
  const worker = defs['general-purpose'] ?? '';
  if (frontmatter(worker, 'model') !== 'claude-sonnet-5-5')
    out.push(
      `工人 general-purpose 的 model 是「${frontmatter(worker, 'model') ?? '没写'}」，该是 claude-sonnet-5-5`,
    );
  if (frontmatter(worker, 'effort') !== 'medium')
    out.push(`工人 general-purpose 的 effort 是「${frontmatter(worker, 'effort') ?? '没写'}」，该是 medium`);
  const description = frontmatter(worker, 'description') ?? '';
  if (!/窄改动/.test(description) || !/haiku/i.test(description))
    out.push('工人 general-purpose 的描述里没写「窄改动……可传 haiku 降档」');
  for (const [file, text] of Object.entries(rules)) {
    if (/本机工人默认\s*Opus/.test(text)) out.push(`${file} 里有「本机工人默认 Opus」（决定 0103 已撤回）`);
  }
  return out;
}

describe('规矩：简单的活降到 Haiku 5.5，窄改动编码三条缺一不可，effort 不低于 medium', () => {
  it('工人是 claude-sonnet-5-5、effort medium，描述写着窄改动降 Haiku；规矩里没有「本机工人默认 Opus」', () => {
    const rules = {
      'agents/skills/commander/SKILL.md': SKILL,
      'agents/shared-rules.md': read('agents/shared-rules.md'),
    };
    expect(workerProblems(DEFS, rules)).toEqual([]);
  });

  it('【故意造出的失败】工人换成 Opus、effort 改 high、描述删了降档、规矩写回「本机工人默认 Opus」：都查得出来', () => {
    const worker = DEFS['general-purpose'];
    const opus = worker
      .replace(/^model:.*$/m, 'model: claude-opus-5-5')
      .replace(/^effort:.*$/m, 'effort: high');
    expect(opus).not.toBe(worker);
    expect(workerProblems({ ...DEFS, 'general-purpose': opus }, {})).toHaveLength(2);
    const noDesc = worker.replace(/^description:.*$/m, 'description: 工人（Sonnet 5.5，可写）');
    expect(workerProblems({ ...DEFS, 'general-purpose': noDesc }, {})).toHaveLength(1);
    expect(workerProblems(DEFS, { 'x.md': '本机工人默认 Opus、照一轮做完' })).toHaveLength(1);
  });

  it('指挥官技能里窄改动编码恰好三条：窄、机器核对、规矩写全', () => {
    expect(narrowProblems(narrowItems(SKILL))).toEqual([]);
  });

  it('Haiku 档：Explore 钉 claude-haiku-5-5；Explore 和降档的 general-purpose 的 effort 都不低于 medium', () => {
    expect(tierProblems(DEFS)).toEqual([]);
  });

  it('【故意造出的失败】拿掉「机器核对」那条：查得出来', () => {
    const items = narrowItems(SKILL);
    const without = items.filter((t) => !/机器核对/.test(t));
    expect(without.length, 'SKILL.md 里没有「机器核对」那条，这条失败造不出来').toBe(items.length - 1);
    expect(narrowProblems(without)).toContain('缺「机器核对」那一条');
    // 整段文字里删掉那一行，也要红
    const line = SKILL.split('\n').find((l) => /^\s+\d+\.\s/.test(l) && /机器核对/.test(l));
    expect(line).toBeDefined();
    expect(narrowProblems(narrowItems(SKILL.replace(`${line}\n`, '')))).not.toEqual([]);
  });

  it('【故意造出的失败】多一条、两条管同一件、一条管几件、整段没了：都查得出来', () => {
    const items = narrowItems(SKILL);
    expect(narrowProblems([...items, '再加一条：跑得快'])).not.toEqual([]);
    expect(narrowProblems([items[0] ?? '', items[0] ?? '', items[2] ?? ''])).not.toEqual([]);
    expect(narrowProblems(['窄、机器核对、规矩写全都要'])).not.toEqual([]);
    expect(() => narrowItems(SKILL.replaceAll('缺一不可', ''))).toThrow(/找不到/);
  });

  it('【故意造出的失败】effort 写成 low、没写，Explore 换成别名或旧版：都查得出来', () => {
    const low = DEFS.Explore.replace(/^effort:.*$/m, 'effort: low');
    expect(low).not.toBe(DEFS.Explore);
    expect(tierProblems({ ...DEFS, Explore: low })).toHaveLength(1);
    const gone = DEFS['general-purpose'].replace(/^effort:.*\n/m, '');
    expect(gone).not.toBe(DEFS['general-purpose']);
    expect(tierProblems({ ...DEFS, 'general-purpose': gone })).toHaveLength(1);
    for (const bad of ['haiku', 'claude-haiku-4-5']) {
      const text = DEFS.Explore.replace(/^model:.*$/m, `model: ${bad}`);
      expect(tierProblems({ ...DEFS, Explore: text }), bad).toHaveLength(1);
    }
  });
});
