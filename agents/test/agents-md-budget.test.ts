// 规矩的字数预算：通用段（agents/shared-rules.md，同步进每台机器各家 AI 的全局说明）和仓根 AGENTS.md 的本仓段，
// 每次会话都会整份读进上下文，越长越限制模型（创始人 2026-10-03：「内容好像太多了……提示词写的多限制你」）。
// 它从 2026-09-27 的约 6000 字涨到约 11000 字，根子是「每次出事只补一条、从不删」：同一件事在 AGENTS.md、design、ops、技能里各写一份。
// 超了这条会红。要加规矩，先做三件事再回来看预算：① 这条规矩在别处（design、ops、技能、决定记录）是不是已经有了——有就只留一句指针；
// ② 命令参数、路径清单、历史沿革（「某日拍了什么」）挪进 docs/，规矩里只留判据；③ 同一个文件里有没有说同一件事的两处，并成一处。
// 实在要涨，改这里的数字要写清为什么（改这个文件不算改标准，但请在 PR 里说明）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
/** 通用段的原件（2026-10-05 从仓根 AGENTS.md 挪出来：留在那里，在本仓干活的会话全局说明读一遍、AGENTS.md 又读一遍） */
const SHARED = read('../shared-rules.md');
const AGENTS = read('../../AGENTS.md');

/**
 * 通用段（推给所有仓）上限。2026-10-05 创始人选定精简版（「都按照你推荐的在做」，约 13:20）：4597 字砍到约 2080 字，
 * 只留模型自己猜不到的事（他怎么听怎么看、四类人闸、底线、机器和账号的事实），「怎么做」的细则挪去技能说明和决定记录。
 * 上限跟着压到 2300：以前每次出事补一条、上限跟着涨（4100 → 4400 → 4600 → 4700），涨回去的路在这里堵住。
 * 2026-10-06 创始人「都按照你推荐」再砍一刀：问法、开单参数、截图口径这些细则挪出通用段，上限压到 2000。
 * 要加一条，先删一条，或者把它写成钩子、测试。
 */
const GENERAL_MAX = 2000;
/** 本仓段上限：同日减脂后约 4200 字。 */
const REPO_MAX = 4600;

function general(text: string): string {
  const start = text.indexOf('通用段 开始');
  const end = text.indexOf('通用段 结束');
  if (start < 0 || end < start) throw new Error('agents/shared-rules.md 里认不出通用段标记，预算没法算');
  return text.slice(start, end);
}

function repoPart(text: string): string {
  const at = text.indexOf('## 本仓（fleet-dao）');
  if (at < 0) throw new Error('AGENTS.md 里认不出「## 本仓」标题，预算没法算');
  return text.slice(at);
}

describe('规矩字数预算（防膨胀）', () => {
  it('通用段不超上限：要加先看有没有别处已有、能不能只留指针', () => {
    const n = general(SHARED).length;
    expect(n, `通用段 ${n} 字，上限 ${GENERAL_MAX}`).toBeLessThanOrEqual(GENERAL_MAX);
  });

  it('本仓段不超上限：命令参数、历史沿革挪进 docs/', () => {
    const n = repoPart(AGENTS).length;
    expect(n, `本仓段 ${n} 字，上限 ${REPO_MAX}`).toBeLessThanOrEqual(REPO_MAX);
  });

  it('仓根 AGENTS.md 不再带通用段：带了就是每次多读一整份', () => {
    expect(AGENTS).not.toContain('fleet-dao:通用段 开始');
    expect(AGENTS).not.toContain('fleet-dao:通用段 结束');
  });

  it('【故意造出的失败】塞一大段进去：两条都拦得住；认不出标记、标题时明确报错，不当成 0 字', () => {
    const fat = '- 多出来的一条规矩。'.repeat(500);
    const bloated = SHARED.replace(
      '<!-- fleet-dao:通用段 结束 -->',
      `${fat}\n<!-- fleet-dao:通用段 结束 -->`,
    );
    expect(general(bloated).length).toBeGreaterThan(GENERAL_MAX);
    expect(repoPart(`${AGENTS}${fat}`).length).toBeGreaterThan(REPO_MAX);
    expect(() => general('# 没有标记的文件')).toThrow(/认不出通用段标记/);
    expect(() => repoPart('# 没有本仓标题的文件')).toThrow(/认不出「## 本仓」标题/);
  });
});
