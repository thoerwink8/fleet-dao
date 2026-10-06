// 钉住通用段「我的机器与模型」里 Fable 那条的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 2026-10-03 #669 把「Fable 不用」改成永久，字面上连创始人自己开的主对话也管；10-04 凌晨指挥官的主会话跑在他自己选的
// Fable 上，照字面算违规、去问他要不要重启。他 10-04 08:50 回：永久不用指的是机器派单（AI 自动派单用 Fable 太贵），
// 主对话开 Fable 是他自己定的。决定 0017：机器派的会话（引擎、工人、路由）、子代理、VPS 上的会话永不用 Fable，
// 子代理只用 Sonnet 或 Opus（优先 Sonnet，2026-10-05 起），Fable 只在他本机的主对话里由他自己选。下面钉住这几样：通用段改写时不能悄悄丢掉哪一样，
// 也不能悄悄退回「一律不用」。
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
 * 「永不用」那三样只认和「永不用 Fable」在同一小句里（「；」「。」为界）、写在它前面的：
 * 后面「子代理只用 Opus 或 Sonnet」里的「子代理」不算数。
 */
const FABLE_RULES: Record<string, RegExp> = {
  机器派的会话永不用: /机器派的会话（引擎、工人、路由）[^；。]*永不用 Fable/,
  子代理永不用: /子代理[^；。]*永不用 Fable/,
  VPS上的会话永不用: /VPS 上的会话[^；。]*永不用 Fable/,
  子代理只用Sonnet或Opus: /子代理只用 Sonnet 或 Opus（优先 Sonnet）/,
  只在创始人本机主对话里由他自己选: /Fable 只在我本机的主对话里由我自己选/,
};

/** 指挥官技能里派子代理那条必须写着的：不写模型、或用 fork，子代理就跟着主会话用上 Fable。 */
const COMMANDER_RULES: Record<string, RegExp> = {
  子代理只用Sonnet或Opus: /派 Claude 子代理[^\n]*只用 Sonnet 或 Opus（优先 Sonnet/,
  派子代理写明模型: /派 Claude 子代理[^\n]*一律写明 `model: "sonnet"`（或 `"opus"`）/,
  说清不写会跟主会话同一个模型: /不写就跟主会话同一个模型/,
  说清fork写了也不管用: /`fork`[^\n]*总跟主会话同一个模型[^\n]*写了 `model` 也不管用/,
  指向决定0017: /`docs\/decisions\/0017-fable-only-in-founder-main-session\.md`/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

describe('规矩：Fable 只在创始人本机的主对话里由他自己选（决定 0017，2026-10-04 收窄）', () => {
  it('通用段 Fable 那一行这几样都在', () => {
    expect(missing(FABLE_RULES, fableLine(AGENTS))).toEqual([]);
  });

  it('同一行里 GPT 不做界面那半句没被这次改动带掉', () => {
    expect(fableLine(AGENTS)).toMatch(/^- GPT 系不做界面类的活（包括审界面）；/);
  });

  it('指挥官技能里派子代理只用 Opus 或 Sonnet、写明模型', () => {
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

  it('【故意造出的失败】拿掉其中一样（路由、子代理、VPS、只用 Opus 或 Sonnet、由我自己选）：各自查得出来', () => {
    const line = fableLine(AGENTS);
    const cuts: [from: string, to: string, rule: string][] = [
      ['（引擎、工人、路由）', '（引擎、工人）', '机器派的会话永不用'],
      ['、子代理、', '、', '子代理永不用'],
      ['、VPS 上的会话', '', 'VPS上的会话永不用'],
      ['，子代理只用 Sonnet 或 Opus（优先 Sonnet）', '', '子代理只用Sonnet或Opus'],
      ['由我自己选', '由 AI 选', '只在创始人本机主对话里由他自己选'],
    ];
    for (const [from, to, rule] of cuts) {
      const cut = line.replace(from, to);
      expect(cut, `那一行里找不到「${from}」，这条失败造不出来`).not.toBe(line);
      expect(missing(FABLE_RULES, cut), `拿掉「${from}」`).toEqual([rule]);
    }
  });

  it('【故意造出的失败】「永不用」改成「少用」：三样永不用都查得出来', () => {
    const line = fableLine(AGENTS);
    const soft = line.replace('永不用 Fable', '少用 Fable');
    expect(soft).not.toBe(line);
    expect(missing(FABLE_RULES, soft)).toEqual(['机器派的会话永不用', '子代理永不用', 'VPS上的会话永不用']);
  });

  it('【故意造出的失败】指挥官技能不写子代理的模型（改之前那样）：查得出来', () => {
    const cut = COMMANDER.replace(/\n- \*\*子代理的模型\*\*：[^\n]*/, '');
    expect(cut).not.toBe(COMMANDER);
    expect(missing(COMMANDER_RULES, cut)).toEqual(Object.keys(COMMANDER_RULES));
  });

  it('【故意造出的失败】认不出那一节、那一节里没有 Fable：明确报错，不当成空行算过', () => {
    expect(() => fableLine('# 没有通用段的文件')).toThrow(/认不出「## 我的机器与模型」一节/);
    const noFable = AGENTS.replace(fableLine(AGENTS), '- GPT 系不做界面类的活（包括审界面）。');
    expect(() => fableLine(noFable)).toThrow(/没有写 Fable 的那一行/);
  });
});
