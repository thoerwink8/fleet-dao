// 钉住通用段里「什么时候停下来问我」那条边界的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 2026-10-01 上午的断链：指挥官把两件不碰人闸的事（两份重复 PR 挑哪份合、一条被误推的远程分支要不要清）写进了「要我拍的」，
// 创始人的回复直接点出来：「这些都是认为需要我拍而不是你自动做，汇报给我吗？」——他把每件都过了一遍手，不在就全停在那儿。
// 通用段原文本来就写着「其余你自己定，回复里带一句理由」，但没人从反面钉过它，于是默认滑向了「拿不准就问」。
// 下面这几条钉住这条边界：四类之外是默认的那一边，不许写成选项来问；问了、答过的同类事，往后只报不再问。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENTS = readFileSync(fileURLToPath(new URL('../../../AGENTS.md', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** 通用段里必须写着的几条，缺了哪条就列出哪条。 */
const ASK_SCOPE_RULES: Record<string, RegExp> = {
  四类之外自己定: /其余你自己定，回复里带一句理由/,
  其余是默认那边不是兜底: /\*\*「其余」是默认的那一边，不是兜底\*\*/,
  判不准是否碰四类时按碰算: /判不准\*\*是不是\*\*碰四类时按碰算（问）/,
  判明不碰却问同样是错: /却为了「省得你怪我没问」而问，同样是错/,
  问了答过的只报不再问: /同类事已经问过一次、我也答过的，往后照那次办、只报不问了/,
  报进度分两段不混编号: /\*\*要你拍的和你只要知道的，分成两段，各用各的编号\*\*/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

describe('规矩：什么时候停下来问我（2026-10-01 补边界）', () => {
  it('通用段里这几条都在', () => {
    expect(missing(ASK_SCOPE_RULES, AGENTS)).toEqual([]);
  });

  it('四类还是那四类，没被这次改动放宽或收紧', () => {
    expect(AGENTS).toMatch(/只有四类：对外发布[\s\S]{0,80}花钱[\s\S]{0,80}删数据；改标准/);
  });

  it('【故意造出的失败】退回改之前那句：查得出来', () => {
    // 改之前只有「其余你自己定，回复里带一句理由」这半句，反面那半句（不许写成选项来问）没有。
    const cut = AGENTS.replace(
      /其余你自己定，回复里带一句理由。\*\*「其余」是默认的那一边[\s\S]*?就是这条的一个例子）。/,
      '其余你自己定，回复里带一句理由。',
    );
    expect(cut).not.toBe(AGENTS);
    expect(missing(ASK_SCOPE_RULES, cut)).toEqual(
      expect.arrayContaining([
        '其余是默认那边不是兜底',
        '判不准是否碰四类时按碰算',
        '判明不碰却问同样是错',
        '问了答过的只报不再问',
      ]),
    );
  });

  it('【故意造出的失败】把「报进度分两段」那句去掉：查得出来', () => {
    const cut = AGENTS.replace(
      /\*\*要你拍的和你只要知道的，分成两段，各用各的编号\*\*[\s\S]*?不要拿同一串编号把「需要你选」和「告诉你一声」混在一起。/,
      '',
    );
    expect(cut).not.toBe(AGENTS);
    expect(missing(ASK_SCOPE_RULES, cut)).toEqual(['报进度分两段不混编号']);
  });
});
