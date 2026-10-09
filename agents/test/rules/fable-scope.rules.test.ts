// 钉住通用段「我的机器与模型」里 Fable 那条的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 2026-10-03 #669 把「Fable 不用」改成永久；10-04 决定 0017 收窄成「机器派的会话、子代理、VPS 上的会话永不用，只在本机主对话里由他自己选」；
// 2026-10-08 决定 0033（母单 #1354 第三片，创始人「2.进，然后我自己选择要不要在哪个环节配置」）取代 0017 第 1、3 条：
// Fable 进目录，引擎按路由派的会话、VPS 上的会话只用得到创始人本人在驾驶舱配进用途的 Fable，AI 不替他配；
// 第 2 条的「子代理永不用 Fable」、第 4 条（本机主对话里由他自己选）照旧；第 2 条的「只用 Sonnet 或 Opus」被决定 0034
// （创始人 2026-10-09 00:09 授权「改成最具有性价比的调整方案……全程你拍板」）换成按性价比分 Haiku 5.5、Sonnet 5.5、Opus 5.5 三档。
// 下面钉住这几样：通用段改写时不能悄悄丢掉哪一样，也不能悄悄退回 0017 的「机器派的会话永不用」「子代理只用 Sonnet 或 Opus」
// 或 #669 的「一律不用」。三档的细则（升级、核对实际 id、档位表、决定 0035 的 haiku55 和级联）钉在 subagent-model.rules.test.ts。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// 通用段的原件（2026-10-05 从仓根 AGENTS.md 挪出来）
const AGENTS = read('../../shared-rules.md');
const COMMANDER = read('../../skills/commander/SKILL.md');

/** 通用段「我的机器与模型」一节里写 Fable 的那一行。认不出这一节、这一节里没有 Fable，都明确报错，不当成空行放过。 */
function fableLine(text: string): string {
  const start = text.indexOf('\n## 我的机器与模型\n');
  const end = text.indexOf('<!-- fleet-dao:通用段 结束 -->');
  if (start < 0 || end < start)
    throw new Error('agents/shared-rules.md 通用段里认不出「## 我的机器与模型」一节');
  const line = text
    .slice(start, end)
    .split('\n')
    .find((l) => l.includes('Fable'));
  if (line === undefined) throw new Error('「我的机器与模型」一节里没有写 Fable 的那一行');
  return line;
}

/**
 * 通用段那一行里必须写着的几样，缺了哪样就列出哪样。
 * 「永不用」只认和 Fable 在同一小句里（「；」「。」为界）、写在它前面的子代理、工人。
 */
const FABLE_RULES: Record<string, RegExp> = {
  子代理和工人永不用: /子代理、工人永不用 Fable/,
  子代理分三档: /子代理按性价比分 Haiku 5\.5、Sonnet 5\.5、Opus 5\.5 三档/,
  引擎按路由派的会话只用配进用途的Fable: /引擎按路由派的会话[^；。]*只用我在驾驶舱配进用途的 Fable/,
  VPS上的会话只用配进用途的Fable: /VPS 上的会话只用我在驾驶舱配进用途的 Fable/,
  AI不替我配: /AI 不替我配/,
  本机主对话由我自己选: /本机主对话里 Fable 由我自己选/,
};

/**
 * 旧说法，这一行里不许再有：0017 第 1、3 条「机器派的会话 / VPS 上的会话永不用 Fable」（0033 取代）；
 * 0017 第 2 条的「子代理只用 Sonnet 或 Opus」（0034 取代，留着就和三档打架）。
 */
const FORBIDDEN: Record<string, RegExp> = {
  机器派的会话永不用: /机器派的会话[^；。]*永不用 Fable/,
  VPS上的会话永不用: /VPS 上的会话[^；。]*永不用 Fable/,
  子代理只用Sonnet或Opus: /子代理只用 Sonnet 或 Opus/,
};

/** 指挥官技能里派子代理那条必须写着的：不写模型、或用 fork，子代理就跟着主会话用上 Fable。 */
const COMMANDER_RULES: Record<string, RegExp> = {
  子代理分三档: /派 Claude 子代理按性价比分三档[^\n]*Haiku 5\.5[^\n]*Sonnet 5\.5[^\n]*Opus 5\.5/,
  // 决定 0035：别名 haiku 在本机指向 Haiku 4.5，Haiku 5.5 改走 subagent_type: "haiku55"、不传 model
  派子代理写明模型:
    /`model` 写明 `"sonnet"` 或 `"opus"`；Haiku 5\.5 写 `subagent_type: "haiku55"`、不传 `model`/,
  说清不写会跟主会话同一个模型: /不写就跟主会话同一个模型/,
  说清fork写了也不管用: /`fork`[^\n]*总跟主会话同一个模型[^\n]*写了 `model` 也不管用/,
  指向决定0017: /`docs\/decisions\/0017-fable-only-in-founder-main-session\.md`/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

function present(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name);
}

describe('规矩：Fable 进目录，只有创始人本人配进用途才用得到（决定 0033，取代 0017 第 1、3 条）', () => {
  it('通用段 Fable 那一行这几样都在', () => {
    expect(missing(FABLE_RULES, fableLine(AGENTS))).toEqual([]);
  });

  it('旧说法（机器派的会话 / VPS 上的会话永不用 Fable、子代理只用 Sonnet 或 Opus）不在了', () => {
    expect(present(FORBIDDEN, fableLine(AGENTS))).toEqual([]);
  });

  it('同一行里 GPT 不做界面那半句没被这次改动带掉', () => {
    expect(fableLine(AGENTS)).toMatch(/^- GPT 系不做界面类的活（包括审界面）；/);
  });

  it('指挥官技能里派子代理按三档选、写明模型、说清不写的后果', () => {
    expect(missing(COMMANDER_RULES, COMMANDER)).toEqual([]);
  });

  it('【故意造出的失败】退回 #669 那句（一律不用、不分场合）：查得出来', () => {
    const old = AGENTS.replace(
      fableLine(AGENTS),
      '- GPT 系不做界面类的活（包括审界面）；Fable 不用（创始人 2026-10-03 拍，永久，不挂版本号）。',
    );
    expect(old).not.toBe(AGENTS);
    expect(missing(FABLE_RULES, fableLine(old))).toEqual(Object.keys(FABLE_RULES));
  });

  it('【故意造出的失败】退回 0017 那句（机器派的会话、VPS 上的会话永不用 Fable，只在本机主对话里由我自己选）：缺的和不许有的都查得出来', () => {
    const old = AGENTS.replace(
      fableLine(AGENTS),
      '- GPT 系不做界面类的活（包括审界面）；机器派的会话（引擎、工人、路由）、子代理、VPS 上的会话永不用 Fable，子代理只用 Sonnet 或 Opus（优先 Sonnet）；Fable 只在我本机的主对话里由我自己选。',
    );
    expect(old).not.toBe(AGENTS);
    const line = fableLine(old);
    expect(missing(FABLE_RULES, line)).toEqual([
      '子代理和工人永不用',
      '子代理分三档',
      '引擎按路由派的会话只用配进用途的Fable',
      'VPS上的会话只用配进用途的Fable',
      'AI不替我配',
      '本机主对话由我自己选',
    ]);
    expect(present(FORBIDDEN, line)).toEqual([
      '机器派的会话永不用',
      'VPS上的会话永不用',
      '子代理只用Sonnet或Opus',
    ]);
  });

  it('【故意造出的失败】退回 0033 那句（子代理只用 Sonnet 或 Opus，优先 Sonnet）：缺三档、旧说法查得出来', () => {
    const line = fableLine(AGENTS);
    const old = line.replace(/；子代理按性价比分[^；]*；/, '，子代理只用 Sonnet 或 Opus（优先 Sonnet）；');
    expect(old, '那一行里找不到三档那一小句，这条失败造不出来').not.toBe(line);
    expect(missing(FABLE_RULES, old)).toEqual(['子代理分三档']);
    expect(present(FORBIDDEN, old)).toEqual(['子代理只用Sonnet或Opus']);
  });

  it('【故意造出的失败】把通用段里「子代理、工人永不用 Fable」整句删掉：查得出来', () => {
    const cut = AGENTS.replace('子代理、工人永不用 Fable；', '');
    expect(cut, '通用段里找不到那一句，这条失败造不出来').not.toBe(AGENTS);
    expect(missing(FABLE_RULES, fableLine(cut))).toEqual(['子代理和工人永不用']);
  });

  it('【故意造出的失败】拿掉其中一样（子代理工人、三档、引擎按路由派的、VPS、AI 不替我配、主对话由我自己选）：各自查得出来', () => {
    const line = fableLine(AGENTS);
    const cuts: [from: string, to: string, rule: string][] = [
      ['子代理、工人永不用 Fable；', '工人永不用 Fable；', '子代理和工人永不用'],
      ['Haiku 5.5、', '', '子代理分三档'],
      ['引擎按路由派的会话、', '', '引擎按路由派的会话只用配进用途的Fable'],
      ['、VPS 上的会话', '', 'VPS上的会话只用配进用途的Fable'],
      ['，AI 不替我配', '', 'AI不替我配'],
      ['本机主对话里 Fable 由我自己选', '本机主对话里 Fable 由 AI 选', '本机主对话由我自己选'],
    ];
    for (const [from, to, rule] of cuts) {
      const cut = line.replace(from, to);
      expect(cut, `那一行里找不到「${from}」，这条失败造不出来`).not.toBe(line);
      expect(missing(FABLE_RULES, cut), `拿掉「${from}」`).toEqual([rule]);
    }
  });

  it('【故意造出的失败】「永不用」改成「少用」：子代理工人那一样查得出来', () => {
    const line = fableLine(AGENTS);
    const soft = line.replace('永不用 Fable', '少用 Fable');
    expect(soft).not.toBe(line);
    expect(missing(FABLE_RULES, soft)).toEqual(['子代理和工人永不用']);
  });

  it('【故意造出的失败】指挥官技能不写子代理的模型（改之前那样）：查得出来', () => {
    const cut = COMMANDER.replace(/\n- \*\*子代理的模型\*\*[^\n]*/, '');
    expect(cut).not.toBe(COMMANDER);
    expect(missing(COMMANDER_RULES, cut)).toEqual(Object.keys(COMMANDER_RULES));
  });

  it('【故意造出的失败】认不出那一节、那一节里没有 Fable：明确报错，不当成空行算过', () => {
    expect(() => fableLine('# 没有通用段的文件')).toThrow(/认不出「## 我的机器与模型」一节/);
    const noFable = AGENTS.replace(fableLine(AGENTS), '- GPT 系不做界面类的活（包括审界面）。');
    expect(() => fableLine(noFable)).toThrow(/没有写 Fable 的那一行/);
  });
});
