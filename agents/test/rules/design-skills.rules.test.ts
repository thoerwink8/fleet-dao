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
