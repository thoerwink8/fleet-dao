// 钉住通用段里「只对这一次会话说的『怎么干』不记、换会话就失效」那条的测试（改标准：改这个文件要创始人同意，
// packages/conventions/standard-paths.json）。
// 2026-09-28 和 10-02 各踩一次：创始人对某一次会话说的「别开 subagent 和 workflow」「你独自干」被 AI 写进了进度文件和
// 临时调整表，下一个会话读到当成了规则，他只好再专门说一遍「之前定的不开不是规则，要摘掉」（决定 0013）。
// 根子在写入那一步：通用段没说「只管这一次会话怎么干的话」不算拍板。下面几条钉住这句，通用段改写时不能悄悄丢。
// 不拿关键词去拦写文件的动作：判不了「这句话只管这一次」，这是写死判断（`judge-or-code`）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// 通用段的原件（2026-10-05 从仓根 AGENTS.md 挪出来）；仓根 AGENTS.md 只剩本仓段
const RULES = read('../../shared-rules.md');
const AGENTS = read('../../../AGENTS.md');
const COMMANDER = read('../../skills/commander/SKILL.md');

/** 通用段：同步脚本整块写进各家 AI 全局说明的那一块（标记之间）。 */
function sharedBlock(text: string): string {
  const start = text.indexOf('<!-- fleet-dao:通用段 开始');
  const end = text.indexOf('<!-- fleet-dao:通用段 结束');
  if (start === -1 || end === -1 || end < start)
    throw new Error('agents/shared-rules.md 里找不到成对的通用段标记');
  return text.slice(start, end);
}

/** 通用段里必须写着的几条，缺了哪条就列出哪条。 */
const SESSION_RULES: Record<string, RegExp> = {
  只对这一次会话说的怎么干不算拍板: /我只对这一次会话说的「怎么干」[^。]{0,60}不算拍板/,
  不记进任何文件换会话就失效: /不记进任何文件，换会话就失效/,
  选项拍板照旧记: /我对选项的拍板照旧记/,
  跨会话要明说才记: /要它跨会话我会明说「以后」/,
  没说清当只管这一次: /没说清当只管这一次/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

const SHARED = sharedBlock(RULES);

describe('规矩：只对这一次会话说的「怎么干」不记（决定 0013，2026-10-03）', () => {
  it('通用段里这几条都在', () => {
    expect(missing(SESSION_RULES, SHARED)).toEqual([]);
  });

  it('写在通用段里（会同步到每台机器），不是本仓段', () => {
    // 本仓段在仓根 AGENTS.md：一条都不该在那儿（在那儿就不会同步到别的机器）
    const at = AGENTS.indexOf('## 本仓（fleet-dao）');
    expect(at, '仓根 AGENTS.md 里认不出「## 本仓」标题').toBeGreaterThanOrEqual(0);
    expect(missing(SESSION_RULES, AGENTS.slice(at))).toHaveLength(Object.keys(SESSION_RULES).length);
  });

  it('原来那条「一时情况拍的是临时调整」没被这条挤掉或改窄', () => {
    expect(SHARED).toMatch(/只因一时情况拍的（额度、断电、某台机器坏了、某人不在）是临时调整/);
  });

  it('指挥官技能说明里记决定那条跟着指回通用段', () => {
    expect(COMMANDER).toMatch(
      /只对这一次会话说的「怎么干」[^；]{0,40}不记，照通用段「我只对这一次会话说的」那条/,
    );
  });

  it('【故意造出的失败】整条删掉：每样都查得出缺', () => {
    const cut = SHARED.replace(/- 我只对这一次会话说的「怎么干」[^\n]*\n/, '');
    expect(cut).not.toBe(SHARED);
    expect(missing(SESSION_RULES, cut)).toEqual(Object.keys(SESSION_RULES));
  });

  it('【故意造出的失败】只留前半句、不说跨会话怎么办：查得出来', () => {
    const cut = SHARED.replace(/要它跨会话我会明说「以后」，没说清当只管这一次。/, '');
    expect(cut).not.toBe(SHARED);
    expect(missing(SESSION_RULES, cut)).toEqual(['跨会话要明说才记', '没说清当只管这一次']);
  });

  it('【故意造出的失败】删掉「选项拍板照旧记」：查得出来（否则会把对选项的拍板也当成不记）', () => {
    const cut = SHARED.replace('；我对选项的拍板照旧记', '');
    expect(cut).not.toBe(SHARED);
    expect(missing(SESSION_RULES, cut)).toEqual(['选项拍板照旧记']);
  });
});
