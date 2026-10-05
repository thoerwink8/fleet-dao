// 钉住通用段里「什么时候停下来问我」那条边界的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 2026-10-01 上午的断链：指挥官把两件不碰人闸的事（两份重复 PR 挑哪份合、一条被误推的远程分支要不要清）写进了「要我拍的」，
// 创始人的回复直接点出来：「这些都是认为需要我拍而不是你自动做，汇报给我吗？」——他把每件都过了一遍手，不在就全停在那儿。
// 通用段原文本来就写着「其余你自己定，回复里带一句理由」，但没人从反面钉过它，于是默认滑向了「拿不准就问」。
// 下面这几条钉住这条边界：四类之外是默认的那一边，不许写成选项来问；问了、答过的同类事，往后只报不再问。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 通用段的原件（2026-10-05 从仓根 AGENTS.md 挪出来）
const AGENTS = readFileSync(fileURLToPath(new URL('../../shared-rules.md', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** 通用段里必须写着的几条，缺了哪条就列出哪条。 */
const ASK_SCOPE_RULES: Record<string, RegExp> = {
  四类之外自己定: /其余你自己定、接着做、事后用一行报结果和理由/,
  四类之外不写成选择题: /不写成选择题/,
  判不准是否碰四类就问: /判不准碰不碰四类就问/,
  问了答过的只报不再问: /同类事我答过一次，往后照办、只报不问/,
  报进度分两段不混编号: /报进度分两段、各自编号/,
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

  it('【故意造出的失败】退回「拿不准就问」的旧样子：查得出来', () => {
    // 只留「只有四类」那半句，反面那半句（其余自己定、不写成选择题、答过的只报不问）拿掉。
    const cut = AGENTS.replace(/其余你自己定、接着做[^\n]*只报不问。/, '');
    expect(cut).not.toBe(AGENTS);
    expect(missing(ASK_SCOPE_RULES, cut)).toEqual([
      '四类之外自己定',
      '四类之外不写成选择题',
      '判不准是否碰四类就问',
      '问了答过的只报不再问',
    ]);
  });

  it('【故意造出的失败】把「报进度分两段」那条去掉：查得出来', () => {
    const cut = AGENTS.replace(/- 报进度分两段、各自编号[^\n]*\n/, '');
    expect(cut).not.toBe(AGENTS);
    expect(missing(ASK_SCOPE_RULES, cut)).toEqual(['报进度分两段不混编号']);
  });
});
