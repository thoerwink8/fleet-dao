// 钉住本机子代理的档（决定 0103，部分取代 0102）：工人默认 Opus、照一轮做完来交代，不按难易降档；只读的斥候照旧 Haiku。
// 改标准：改这个文件要创始人同意（packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 钉这几处：
// 1. 工人 general-purpose 的定义：model 是 claude-opus-5-5、effort 是 high，描述里不再有「可传 haiku 降档」。
// 2. 斥候 Explore 照旧钉 claude-haiku-5-5，effort 不低于 medium（官方提示指南：low 档会提前收工、没跑核对就说完）。
// 3. 指挥官技能、通用段、工人定义里不再有 0102 那套说法：「窄改动编码给工人传 model: "haiku"」「降到 Haiku」「工人默认 Sonnet」。
//    这是决定 0089 第 4 条（只核对某句话在不在的测试删掉）的例外，0103 写明：这几句是被收回的旧规矩，留一句就会照它派。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8').replace(/\r\n/g, '\n');

const TEXTS: Record<string, string> = {
  'agents/skills/commander/SKILL.md': read('agents/skills/commander/SKILL.md'),
  'agents/shared-rules.md': read('agents/shared-rules.md'),
  'agents/subagents/general-purpose.md': read('agents/subagents/general-purpose.md'),
};
const DEFS = {
  Explore: read('agents/subagents/Explore.md'),
  'general-purpose': read('agents/subagents/general-purpose.md'),
};

/** 收回了的说法：名字、怎么认 */
const RETIRED: ReadonlyArray<readonly [string, RegExp]> = [
  ['给工人传 model: "haiku"', /model:\s*"haiku"/],
  ['降到 Haiku / haiku 降档', /降到\s*Haiku|haiku\s*降档/i],
  ['窄改动编码派 Haiku', /窄改动[^。\n]{0,40}Haiku/i],
  ['工人默认 Sonnet', /工人[^。\n]{0,12}Sonnet|Sonnet[^。\n]{0,6}(是|当)?工人/],
];

/** 文本里还留着的收回说法；空数组才算对 */
function retiredProblems(texts: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(texts))
    for (const [name, re] of RETIRED) if (re.test(text)) out.push(`${file}：还有「${name}」的说法`);
  return out;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const frontmatter = (text: string, key: string) =>
  new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '')?.[1]?.trim();

/** 两个角色的档的毛病；空数组才算对 */
function tierProblems(defs: Record<string, string>): string[] {
  const out: string[] = [];
  const worker = defs['general-purpose'] ?? '';
  if (frontmatter(worker, 'model') !== 'claude-opus-5-5')
    out.push(
      `general-purpose 的 model 是「${frontmatter(worker, 'model') ?? '没写'}」，该是 claude-opus-5-5`,
    );
  if (frontmatter(worker, 'effort') !== 'high')
    out.push(`general-purpose 的 effort 是「${frontmatter(worker, 'effort') ?? '没写'}」，该是 high`);
  const scout = defs.Explore ?? '';
  if (frontmatter(scout, 'model') !== 'claude-haiku-5-5')
    out.push(`Explore 的 model 是「${frontmatter(scout, 'model') ?? '没写'}」，该是 claude-haiku-5-5`);
  const effort = frontmatter(scout, 'effort');
  if (effort === undefined || EFFORTS.indexOf(effort) < EFFORTS.indexOf('medium'))
    out.push(`Explore 的 effort 是「${effort ?? '没写'}」，Haiku 档不许低于 medium`);
  return out;
}

describe('规矩：本机工人默认 Opus、一轮做完，不按难易降档；斥候照旧 Haiku', () => {
  it('工人定义 claude-opus-5-5、effort high；斥候 claude-haiku-5-5、effort 不低于 medium', () => {
    expect(tierProblems(DEFS)).toEqual([]);
  });

  it('技能、通用段、工人定义里不再有「窄改动降 Haiku」「工人默认 Sonnet」的说法', () => {
    expect(retiredProblems(TEXTS)).toEqual([]);
  });

  it('【故意造出的失败】工人改回 Sonnet、effort 改回 medium、没写，斥候换成别名或 low：都查得出来', () => {
    const worker = DEFS['general-purpose'];
    const sonnet = worker.replace(/^model:.*$/m, 'model: claude-sonnet-5-5');
    expect(sonnet).not.toBe(worker);
    expect(tierProblems({ ...DEFS, 'general-purpose': sonnet })).toHaveLength(1);
    const medium = worker.replace(/^effort:.*$/m, 'effort: medium');
    expect(medium).not.toBe(worker);
    expect(tierProblems({ ...DEFS, 'general-purpose': medium })).toHaveLength(1);
    expect(tierProblems({ ...DEFS, 'general-purpose': worker.replace(/^model:.*\n/m, '') })).toHaveLength(1);
    for (const bad of ['haiku', 'claude-haiku-4-5']) {
      const text = DEFS.Explore.replace(/^model:.*$/m, `model: ${bad}`);
      expect(tierProblems({ ...DEFS, Explore: text }), bad).toHaveLength(1);
    }
    expect(
      tierProblems({ ...DEFS, Explore: DEFS.Explore.replace(/^effort:.*$/m, 'effort: low') }),
    ).toHaveLength(1);
  });

  it('【故意造出的失败】把 0102 的旧句子放回技能、通用段或工人定义：逐句查得出来', () => {
    const old = [
      '  - 窄改动编码给工人传 `model: "haiku"`，下面三条缺一不可',
      '窄改动编码在改动窄、派前定好机器核对、规矩写全三条都满足时，工人传 `model: "haiku"` 降档。',
      '窄改动、派前定好机器核对、规矩写全的编码可传 haiku 降档。',
      '- 简单的活降到 Haiku 5.5 省钱',
      '`general-purpose` 工人（Sonnet 5.5，可写）',
      '默认不传 `model`，工人默认 Sonnet，难的才升档',
    ];
    for (const file of Object.keys(TEXTS)) {
      for (const line of old) {
        const texts = { ...TEXTS, [file]: `${TEXTS[file]}\n${line}\n` };
        expect(retiredProblems(texts), `${file} ← ${line}`).not.toEqual([]);
      }
    }
  });
});
