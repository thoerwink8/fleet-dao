// 钉住设计类技能规矩的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 2026-09-29 一个现场运维工具的导入页照 best-practice-first 六步重做完，每一关都过了，宽屏只用上半屏的毛病照样漏到用户眼前：
// 对照只对了流程、草图是文字的、验收不看版面、用户点头的是分块。下面这几条是为堵这条断链加的，技能说明改写时不能悄悄丢掉。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url));
const read = (name: string) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

/** best-practice-first 里必须写着的规矩：一条一行，缺了哪条就列出哪条。 */
const BEST_PRACTICE_RULES: Record<string, RegExp> = {
  在用户评判的那一层和精度上设计验收: /用户在哪一层、什么精度上评判，就在那一层、那个精度上设计、拍板和验收/,
  分层找对照: /分层找对照，一层都不许空着[\s\S]{0,200}信息架构[\s\S]{0,80}版面[\s\S]{0,80}视觉/,
  草图精度够拍那一层: /草图的精度要够拍它要拍的那一层[\s\S]{0,200}版面、视觉：必须是目标尺寸下的真实画面/,
  点头只算那一层: /拍了哪一层，就只算那一层拍过/,
  界面另验版面三问:
    /界面另验版面[\s\S]{0,300}屏幕用满了没有[\s\S]{0,200}一眼可见[\s\S]{0,200}最显眼的是不是下一步/,
  能写成检查的挂在必经那一步: /能写成检查的写成检查，挂在每次改动都要过的那一步[\s\S]{0,120}故意造出失败/,
  关卡看不见的错不算过: /关卡看不见的错，关卡不算过/,
};

/** grill-ai 里必须写着的规矩。 */
const GRILL_AI_RULES: Record<string, RegExp> = {
  五问: /动手前先过这五问[\s\S]{0,60}第 5 问在报「做好了」「用户同意了」之前也要再过一遍/,
  证据看不见错: /\*\*证据看不见错\*\*[\s\S]{0,200}它显得出来吗[\s\S]{0,120}用户点头的是哪一层/,
  判制度按逐条照做拦不拦得住: /假设我逐条照做了现有规矩的每一步，这次的错拦得住吗/,
  判例写过症状不算规矩: /哪怕判例里写过同样的症状[\s\S]{0,120}不在动作必经的那一步触发就不算规矩/,
  只记判例不算修: /只多记一条判例、一条记忆不算修/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

const BEST = read('best-practice-first');
const GRILL = read('grill-ai');

describe('规矩：设计在用户评判的那一层、那个精度上做和验（2026-09-29 导入页断链）', () => {
  it('best-practice-first 里这几条都在', () => {
    expect(missing(BEST_PRACTICE_RULES, BEST)).toEqual([]);
  });

  it('grill-ai 里这几条都在', () => {
    expect(missing(GRILL_AI_RULES, GRILL)).toEqual([]);
  });

  it('【故意造出的失败】把第 6 步「界面另验版面」删掉、把草图精度退回「先给草图或草案」：查得出缺了哪几条', () => {
    const cut = BEST.replace(/- \*\*界面另验版面\*\*[\s\S]*?(?=\n- 能写成检查的)/, '').replace(
      /6\. \*\*先给草图或草案再写代码[\s\S]*?(?=\n\n### 5\.)/,
      '6. 界面和接口先给草图或草案，再写代码。',
    );
    expect(cut).not.toBe(BEST);
    expect(missing(BEST_PRACTICE_RULES, cut)).toEqual(
      expect.arrayContaining(['界面另验版面三问', '草图精度够拍那一层', '点头只算那一层']),
    );
  });

  it('【故意造出的失败】判制度退回「规矩本来就有，是我没认出来」的旧判法：查得出来', () => {
    const cut = GRILL.replace(
      /4\. \*\*判制度\*\*[\s\S]*?(?=\n\n## 收尾)/,
      '4. **判制度**：这次偏差是制度缺失，还是执行失守？\n   - 执行失守（规矩本来就有，是我没认出来）⇒ 记成判例，不改规矩。\n   - 确属制度缺失 ⇒ 才提议改规矩。',
    );
    expect(cut).not.toBe(GRILL);
    expect(missing(GRILL_AI_RULES, cut)).toEqual(
      expect.arrayContaining(['判制度按逐条照做拦不拦得住', '判例写过症状不算规矩', '只记判例不算修']),
    );
  });
});

/**
 * 钉住通用段里「进度要落盘」这条（改标准：改这个文件要创始人同意，standard-paths.json）。
 *
 * 2026-10-01 的断链：一个仓里四五个 AI 会话并行干了一整天，进度全在各自的对话里。
 * 对话会断、会被总结、会换机器（那天正赶上节前下电、要换机接手），
 * 下一个 AI 拿到手只剩一份代码，不知道上一轮做到哪、哪条验证过、哪条只是「看着过了」。
 * 只发在对话里、没落盘的进度，等于没写。下面这几条钉住它，通用段改写时不能悄悄丢掉。
 *
 * 2026-10-03 的断链：创始人说「全部做完、不要停」之后 86 分钟，一个会话发了 407 次调用、只合了 1 个 PR，
 * 后 44 分钟改了 71 个文件没推到远端。他只看得到每轮最后一条，无人值守又不许停，「发」只能写在对话中间，他看不到；
 * 报告要结束本轮才看得见，结束本轮会话就停了，「报进度」和「不要停」互相打架。照旧规矩逐条做，这个错照样漏得过去：
 * 没有通道、没有「多久必须落地」。后五条钉住它。
 */
const PROGRESS_RULES: Record<string, RegExp> = {
  进度文件要落盘: /进度也要落盘，不能只发在对话里/,
  给下一个AI看: /文件是给\*\*下一个 AI\*\*/,
  说清没落盘等于没写: /只发在对话里没落盘的进度，等于没写/,
  放哪要写明: /仓里没这个约定的，在仓根 `docs\/PROGRESS\.md`/,
  无人值守时同步更新: /同一时刻进度文件也更新到位/,
  发要送到我手上: /「发」要送到我手上，不是在对话中间写一句[\s\S]{0,80}我只看得到每轮最后一条/,
  通道有先后: /`deliver_artifact`[\s\S]{0,60}推送通知[\s\S]{0,60}进度文件/,
  发完接着做: /发完接着做，队列没清空、也没碰到非问我不可的人闸，就不收尾/,
  二十分钟落一次地:
    /每 20 分钟（或每 30 次工具调用，先到为准）至少做一遍[\s\S]{0,60}提交并推到远端[\s\S]{0,60}更新进度文件/,
  超时拆小: /一件事过了 20 分钟还没有能推的东西，就当场拆小/,
};

describe('规矩：进度要落盘，不能只发在对话里（2026-10-01）', () => {
  const AGENTS = readFileSync(fileURLToPath(new URL('../../../AGENTS.md', import.meta.url)), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  // commander 技能自己的「报进度」一节也要跟上：它以前写「进度就在对话里报」，
  // 和通用段「进度也要落盘」直接冲突；只改通用段、不改技能，照技能做的人又断了。
  const COMMANDER = read('commander');

  it('通用段里这几条都在', () => {
    expect(missing(PROGRESS_RULES, AGENTS)).toEqual([]);
  });

  it('commander 技能的「报进度」一节也讲了落盘，没有留「只在对话里报」的旧说法', () => {
    expect(COMMANDER).toMatch(/同时把进度落到文件/);
    expect(COMMANDER).toMatch(/对话是给现在的他看的，文件是给下一个 AI 看的/);
    expect(COMMANDER).not.toMatch(/进度就在对话里报/);
  });

  it('【故意造出的失败】把「进度也要落盘」整条删掉：查得出来', () => {
    const cut = AGENTS.replace(/- 进度也要落盘，不能只发在对话里[\s\S]*?(?=\n- 我让你无人值守推进时)/, '');
    expect(cut).not.toBe(AGENTS);
    expect(missing(PROGRESS_RULES, cut)).toEqual(
      expect.arrayContaining(['进度文件要落盘', '给下一个AI看', '放哪要写明']),
    );
  });

  it('【故意造出的失败】只留「发在对话里」，退回改之前那句：查得出来', () => {
    const cut = AGENTS.replace(
      /- 我让你无人值守推进时[\s\S]*?(?=\n\n)/,
      '- 我让你无人值守推进时，每做完一件事就发一次，只发变了的行和要我拍的，不只在最后给总报告；没新进展不刷屏。',
    );
    expect(cut).not.toBe(AGENTS);
    expect(missing(PROGRESS_RULES, cut)).toEqual([
      '无人值守时同步更新',
      '发要送到我手上',
      '通道有先后',
      '发完接着做',
      '二十分钟落一次地',
      '超时拆小',
    ]);
  });

  it('【故意造出的失败】删掉「送到我手上、发完接着做」那几句，只剩落地节奏：查得出来', () => {
    const cut = AGENTS.replace(/\*\*「发」要送到我手上[\s\S]*?(?=\*\*不许一个多小时没有东西落地\*\*)/, '');
    expect(cut).not.toBe(AGENTS);
    expect(missing(PROGRESS_RULES, cut)).toEqual(['发要送到我手上', '通道有先后', '发完接着做']);
  });

  it('【故意造出的失败】把「每 20 分钟落一次地、过了拆小」换成「每天至少推一次」：查得出来', () => {
    const cut = AGENTS.replace(/\*\*不许一个多小时没有东西落地\*\*[\s\S]*?(?=\n\n)/, '每天至少推一次。');
    expect(cut).not.toBe(AGENTS);
    expect(missing(PROGRESS_RULES, cut)).toEqual(['二十分钟落一次地', '超时拆小']);
  });

  it('【故意造出的失败】把 commander 退回「进度就在对话里报」：查得出来', () => {
    const cut = COMMANDER.replace(
      /\*\*同时把进度落到文件\*\*[\s\S]*?对话是给现在的他看的，文件是给下一个 AI 看的。/,
      '进度就在对话里报。',
    );
    expect(cut).not.toBe(COMMANDER);
    expect(cut).toMatch(/进度就在对话里报/);
  });
});
