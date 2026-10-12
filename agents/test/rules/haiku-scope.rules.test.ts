// 钉住决定 0086「子代理给 Haiku 5.5 的活放宽」（创始人 2026-10-12：「我其实是想追求性价比和快，一些很简单的东西都交给 Haiku
// 吧。因为现在 Haiku 5.5 的能力很强，你最好去查一下它的最新能力，而不是去参考原来的 Haiku 4.5」「可以对haiku5.5做测试呀，
// 看一看它的效果怎么样，你也可以做一个判断」，#1960）。
// 改标准：改这个文件要创始人同意（packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 钉五处：
// 1. 通用段「我的机器与模型」那一行：Haiku 的 effort 至少 medium，没跑核对就报完也算不过。
// 2. 放心给 Haiku 的新增两类（结构化抽取测到 40 条再多拆批、测试输出分诊），和窄改动编码给 Haiku 的三条（有机器核对、
//    effort 不低于 medium、范围写死）三条同时满足才给：技能「派活」、参考页、决定 0086 写着，fleet-fixer 两份定义写三条；
//    缺一条就红。
// 3. 仍升 Sonnet 的五类（含 low 档的活）、护栏（证据、抽查、连败 2 次或没跑核对就说完成当次升、失败记到 #1960、effort 不传
//    low）、「怎么算放宽过头」和复查日 2026-11-12：技能、参考页、决定 0086 写着。
// 4. Haiku 档子代理（.claude/agents/ 和 agents/subagents/ 两份里 model 是 claude-haiku-5-5 的，加 haiku55）的 effort
//    只许 medium、high、xhigh、max；参考页两张表里 Haiku 那几行的 effort 一样。
// 5. 决定 0086：两句原话照贴、依据带官方链接、三种来源分开标、自测结果和局限、复现命令。
// 只按文字读，不跨包 import（agents 是单独的 TypeScript 项目）。认不出要找的那一节、那一行就明确报错，不当成没毛病。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string): string => readFileSync(`${ROOT}${rel}`, 'utf8').replace(/\r\n/g, '\n');

const SHARED = read('agents/shared-rules.md');
const SKILL = read('agents/skills/commander/SKILL.md');
const GUIDE = read('agents/skills/commander/references/子代理选模型.md');
const DECISION_FILE = 'docs/decisions/0086-haiku55-wider-scope.md';
const DECISION = existsSync(`${ROOT}${DECISION_FILE}`) ? read(DECISION_FILE) : '';

const HAIKU = 'claude-haiku-5-5';
/** Haiku 档允许的 effort：low 在长提示下会提前收工、跳过核对（决定 0086 依据） */
const EFFORT_OK = ['medium', 'high', 'xhigh', 'max'];

/** 一段 Markdown 里某个二级标题下面的内容（到下一个二级标题为止）；认不出标题就抛 */
function section(text: string, title: string, where: string): string {
  const at = text.indexOf(`\n## ${title}`);
  if (at === -1) throw new Error(`${where} 里认不出「## ${title}」标题`);
  const rest = text.slice(at + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

/** 通用段「我的机器与模型」里写子代理档位的那一行；认不出明确报错 */
function tierLine(text: string): string {
  const start = text.indexOf('\n## 我的机器与模型\n');
  const end = text.indexOf('<!-- fleet-dao:通用段 结束 -->');
  if (start < 0 || end < start)
    throw new Error('agents/shared-rules.md 通用段里认不出「## 我的机器与模型」一节');
  const line = text
    .slice(start, end)
    .split('\n')
    .find((l) => l.includes('子代理'));
  if (line === undefined) throw new Error('「我的机器与模型」一节里没有写子代理的那一行');
  return line;
}

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

/** 通用段那一行要加的两半 */
const SHARED_RULES: Record<string, RegExp> = {
  effort至少medium: /Haiku 的 effort 至少 medium/,
  没跑核对就报完算不过: /没跑核对就报完也算不过/,
};

/** 0086 新放给 Haiku 的两类：抽取有上限（自测只测到 40 条），分诊 */
const HAIKU_NEW: Record<string, RegExp> = {
  结构化抽取到40条再多拆批: /结构化抽取（已测到 40 条，再多的先拆批）/,
  测试输出分诊: /测试输出分诊/,
};

/** 窄改动编码给 Haiku 的三条，加「三条同时满足」：缺一不可 */
const NARROW: Record<string, RegExp> = {
  机器核对: /有机器核对（点名的测试、类型检查或 lint 过了才算数）/,
  effort不低于medium: /effort 不低于 medium/,
  范围写死: /范围写死（点名文件和函数）/,
  三条同时满足: /三条同时满足/,
};

/** 仍升 Sonnet 的五类 */
const STILL_SONNET: Record<string, RegExp> = {
  长链多文件编码: /长链多文件编码/,
  没有机器核对的活: /没有机器核对的活/,
  归因下结论: /归因下结论/,
  长规矩清单: /必须一条不漏又没有脚本逐条核的长规矩清单/,
  low档的活: /low 档的活/,
};

/** 护栏 */
const GUARDS: Record<string, RegExp> = {
  每条带证据: /每条结论带证据（`文件:行` 或命令原始输出行）/,
  动手前抽查: /动手前抽查/,
  连败2次当次升: /连败 2 次/,
  没跑核对就说完成当次升: /没跑核对就说完成[^\n]*当次升 Sonnet/,
  失败记到单上: /在 #1960 留一条失败记录/,
  effort不传low: /`effort` 也不传 low/,
};

/** 复查 */
const REVIEW: Record<string, RegExp> = {
  怎么算放宽过头: /怎么算放宽过头/,
  复查日: /2026-11-12/,
};

/** 决定 0086 另要写着的 */
const DECISION_RULES: Record<string, RegExp> = {
  原话照贴:
    /我其实是想追求性价比和快，一些很简单的东西都交给 Haiku 吧。因为现在 Haiku 5\.5 的能力很强，你最好去查一下它的最新能力，而不是去参考原来的 Haiku 4\.5/,
  官方链接: /https:\/\/www\.anthropic\.com\/claude-haiku-5-5/,
  标官方: /【官方】/,
  标社区: /【社区】/,
  标我们自己测的: /【我们自己测的】/,
  第二句原话照贴: /可以对haiku5\.5做测试呀，看一看它的效果怎么样，你也可以做一个判断/,
  自测结果: /Haiku 27\/28 过，Sonnet 14\/14 过/,
  自测局限_没测长链: /没测长链多文件编码/,
  自测局限_没测low: /没测 low 档/,
  自测复现命令: /`node _tmp\/haiku-eval\/grade-all\.mjs`/,
  取代0035: /取代：决定 0035/,
};

const DIRS = ['.claude/agents/', 'agents/subagents/'];

interface Def {
  file: string;
  fm: Record<string, string>;
}

/** 认 frontmatter（一行一个 key: value）；认不出明确报错 */
function parseDef(file: string, text: string): Def {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${file}：认不出 frontmatter`);
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined) fm[kv[1]] = (kv[2] ?? '').trim();
  }
  return { file, fm };
}

const defTexts: Record<string, string> = Object.fromEntries(
  DIRS.flatMap((dir) =>
    readdirSync(`${ROOT}${dir}`)
      .filter((f) => f.endsWith('.md'))
      .map((f) => [`${dir}${f}`, read(`${dir}${f}`)]),
  ),
);

/** 一份定义若是 Haiku 档，它的 effort 毛病；不是 Haiku 档返回空 */
function effortProblems(file: string, text: string): string[] {
  const { fm } = parseDef(file, text);
  if (fm.model !== HAIKU) return [];
  if (fm.effort === undefined) return [`${file}：Haiku 档没写 effort`];
  if (!EFFORT_OK.includes(fm.effort))
    return [`${file}：Haiku 档 effort 是「${fm.effort}」，只许 ${EFFORT_OK.join('、')}`];
  return [];
}

/** 参考页里 Haiku 那几行表格的 effort 毛病（effort 是第三列）；一行都没认出来明确报错 */
function tableEffortProblems(guide: string): string[] {
  const rows = guide.split('\n').filter((l) => l.startsWith('| ') && /\| Haiku 5\.5/.test(l));
  if (rows.length === 0) throw new Error('参考页里认不出 Haiku 5.5 的表格行');
  const out: string[] = [];
  for (const row of rows) {
    const effort = (row.split('|')[3] ?? '').trim();
    if (!EFFORT_OK.includes(effort))
      out.push(`参考页「${(row.split('|')[1] ?? '').trim()}」那行 effort 是「${effort}」`);
  }
  return out;
}

const SKILL_DISPATCH = section(SKILL, '派活', 'agents/skills/commander/SKILL.md');
const GUIDE_SCOPE = section(
  GUIDE,
  'Haiku 5.5 的划线（决定 0086）',
  'agents/skills/commander/references/子代理选模型.md',
);

describe('规矩：子代理给 Haiku 5.5 的活放宽，窄改动编码三条缺一不可，带护栏和复查（决定 0086）', () => {
  it('通用段那一行：Haiku 的 effort 至少 medium、没跑核对就报完也算不过', () => {
    expect(missing(SHARED_RULES, tierLine(SHARED))).toEqual([]);
  });

  it('新放给 Haiku 的两类（抽取到 40 条再多拆批、测试输出分诊）：技能「派活」、参考页、决定 0086 都写着', () => {
    expect(missing(HAIKU_NEW, SKILL_DISPATCH), 'SKILL.md「派活」').toEqual([]);
    expect(missing(HAIKU_NEW, GUIDE_SCOPE), '参考页').toEqual([]);
    expect(missing(HAIKU_NEW, DECISION), DECISION_FILE).toEqual([]);
  });

  it('窄改动编码三条：技能「派活」、参考页、决定 0086、fleet-fixer 两份定义的 description 都写全', () => {
    expect(missing(NARROW, SKILL_DISPATCH), 'SKILL.md「派活」').toEqual([]);
    expect(missing(NARROW, GUIDE_SCOPE), '参考页').toEqual([]);
    expect(missing(NARROW, DECISION), DECISION_FILE).toEqual([]);
    for (const dir of DIRS) {
      const file = `${dir}fleet-fixer.md`;
      const text = defTexts[file];
      if (text === undefined) throw new Error(`${file} 不存在`);
      expect(missing(NARROW, parseDef(file, text).fm.description ?? ''), file).toEqual([]);
    }
  });

  it('仍升 Sonnet 的五类、护栏、怎么算放宽过头和复查日：技能、参考页、决定 0086 都写着', () => {
    for (const [where, text] of [
      ['SKILL.md「派活」', SKILL_DISPATCH],
      ['参考页', GUIDE_SCOPE],
      [DECISION_FILE, DECISION],
    ] as const) {
      expect(missing(STILL_SONNET, text), where).toEqual([]);
      expect(missing(GUARDS, text), where).toEqual([]);
      expect(missing(REVIEW, text), where).toEqual([]);
    }
  });

  it('决定 0086：两句原话照贴、官方链接、三种来源分开标、自测结果和局限、复现命令、取代 0035', () => {
    expect(existsSync(`${ROOT}${DECISION_FILE}`), `${DECISION_FILE} 不存在`).toBe(true);
    expect(missing(DECISION_RULES, DECISION)).toEqual([]);
    expect(GUIDE_SCOPE).toMatch(/Haiku 5\.5 medium 27\/28 过/);
  });

  it('Haiku 档子代理（两份副本加 haiku55）的 effort 只许 medium 以上；参考页两张表里 Haiku 那几行也是', () => {
    const haikuDefs = Object.entries(defTexts).filter(([f, t]) => parseDef(f, t).fm.model === HAIKU);
    // 两份副本各 6 个 Haiku 档，加 agents/subagents/haiku55.md
    expect(haikuDefs.map(([f]) => f)).toContain('agents/subagents/haiku55.md');
    expect(haikuDefs.length).toBe(13);
    expect(haikuDefs.flatMap(([f, t]) => effortProblems(f, t))).toEqual([]);
    expect(tableEffortProblems(GUIDE)).toEqual([]);
  });

  it('【故意造出的失败】拿掉「必须有机器核对」那条，或拿掉三条里任何一条、「三条同时满足」：各自查得出来', () => {
    for (const [label, re] of Object.entries(NARROW)) {
      const cut = SKILL_DISPATCH.replace(new RegExp(re.source, 'g'), '');
      expect(cut, `技能里找不到「${label}」，这条失败造不出来`).not.toBe(SKILL_DISPATCH);
      expect(missing(NARROW, cut), label).toEqual([label]);
    }
    const file = 'agents/subagents/fleet-fixer.md';
    const desc = parseDef(file, defTexts[file] ?? '').fm.description ?? '';
    const noCheck = desc.replace('有机器核对（点名的测试、类型检查或 lint 过了才算数）', '');
    expect(noCheck, 'fleet-fixer 的 description 里找不到机器核对那条').not.toBe(desc);
    expect(missing(NARROW, noCheck)).toEqual(['机器核对']);
  });

  it('【故意造出的失败】通用段拿掉 effort 那半句、仍升 Sonnet 少一类、护栏少一条、复查日删掉：各自查得出来', () => {
    const line = tierLine(SHARED);
    const noEffort = line.replace('Haiku 的 effort 至少 medium', '');
    expect(noEffort).not.toBe(line);
    expect(missing(SHARED_RULES, noEffort)).toEqual(['effort至少medium']);
    const noLow = GUIDE_SCOPE.replaceAll('low 档的活', '');
    expect(noLow).not.toBe(GUIDE_SCOPE);
    expect(missing(STILL_SONNET, noLow)).toEqual(['low档的活']);
    const noCap = SKILL_DISPATCH.replaceAll('结构化抽取（已测到 40 条，再多的先拆批）', '结构化抽取');
    expect(noCap, '技能里找不到抽取上限那一句，这条失败造不出来').not.toBe(SKILL_DISPATCH);
    expect(missing(HAIKU_NEW, noCap)).toEqual(['结构化抽取到40条再多拆批']);
    const noStreak = SKILL_DISPATCH.replaceAll('连败 2 次', '');
    expect(noStreak).not.toBe(SKILL_DISPATCH);
    expect(missing(GUARDS, noStreak)).toEqual(['连败2次当次升']);
    const noLedger = DECISION.replaceAll('在 #1960 留一条失败记录', '');
    expect(noLedger).not.toBe(DECISION);
    expect(missing(GUARDS, noLedger)).toEqual(['失败记到单上']);
    const noDate = SKILL_DISPATCH.replaceAll('2026-11-12', '');
    expect(noDate).not.toBe(SKILL_DISPATCH);
    expect(missing(REVIEW, noDate)).toEqual(['复查日']);
  });

  it('【故意造出的失败】fleet-scout 的 effort 改回 low、haiku55 删掉 effort、参考页表里写回 low：都查得出来', () => {
    const scout = '.claude/agents/fleet-scout.md';
    const st = defTexts[scout] ?? '';
    const low = st.replace(/^effort: .*$/m, 'effort: low');
    expect(low).not.toBe(st);
    expect(effortProblems(scout, low)).toEqual([
      `${scout}：Haiku 档 effort 是「low」，只许 medium、high、xhigh、max`,
    ]);
    const h55 = 'agents/subagents/haiku55.md';
    const ht = defTexts[h55] ?? '';
    const noEffort = ht.replace(/^effort: .*\n/m, '');
    expect(noEffort, 'haiku55 里找不到 effort 那一行，这条失败造不出来').not.toBe(ht);
    expect(effortProblems(h55, noEffort)).toEqual([`${h55}：Haiku 档没写 effort`]);
    const sonnet = st
      .replace(/^model: .*$/m, 'model: claude-sonnet-5-5')
      .replace(/^effort: .*$/m, 'effort: low');
    expect(effortProblems(scout, sonnet), '不是 Haiku 档的不管 effort').toEqual([]);
    const lowRow = GUIDE.replace(/(\| `fleet-scout` \| Haiku 5\.5 \| )medium/, '$1low');
    expect(lowRow, '参考页里找不到 fleet-scout 那一行，这条失败造不出来').not.toBe(GUIDE);
    expect(tableEffortProblems(lowRow)).toEqual(['参考页「`fleet-scout`」那行 effort 是「low」']);
  });

  it('【故意造出的失败】认不出那一节、那一行、frontmatter、表格：明确报错，不当成没毛病', () => {
    expect(() => section('# 空', '派活', 'x.md')).toThrow(/认不出「## 派活」/);
    expect(() => tierLine('# 没有通用段')).toThrow(/认不出「## 我的机器与模型」/);
    expect(() => parseDef('x.md', '没有 frontmatter')).toThrow(/认不出 frontmatter/);
    expect(() => tableEffortProblems('# 没有表')).toThrow(/认不出 Haiku 5\.5 的表格行/);
  });
});
