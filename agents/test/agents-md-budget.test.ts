// AGENTS.md 的字数预算：每次会话都会把它整份读进上下文，越长越限制模型（创始人 2026-10-03：「内容好像太多了……提示词写的多限制你」）。
// 它从 2026-09-27 的约 6000 字涨到约 11000 字，根子是「每次出事只补一条、从不删」：同一件事在 AGENTS.md、design、ops、技能里各写一份。
// 超了这条会红。要加规矩，先做三件事再回来看预算：① 这条规矩在别处（design、ops、技能、决定记录）是不是已经有了——有就只留一句指针；
// ② 命令参数、路径清单、历史沿革（「某日拍了什么」）挪进 docs/，AGENTS.md 只留判据；③ 同一个文件里有没有说同一件事的两处，并成一处。
// 实在要涨，改这里的数字要写清为什么（改这个文件不算改标准，但请在 PR 里说明）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEXT = readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** 通用段（推给所有仓）上限：2026-10-03 减脂后约 3970 字，留一点余量。 */
const GENERAL_MAX = 4100;
/** 本仓段上限：同日减脂后约 4200 字。 */
const REPO_MAX = 4600;

function sections(text: string): { general: string; repo: string } {
  const start = text.indexOf('通用段 开始');
  const end = text.indexOf('通用段 结束');
  const repoAt = text.indexOf('## 本仓（fleet-dao）');
  if (start < 0 || end < 0 || repoAt < 0)
    throw new Error('AGENTS.md 里认不出通用段标记或「## 本仓」标题，预算没法算');
  return { general: text.slice(start, end), repo: text.slice(repoAt) };
}

describe('AGENTS.md 字数预算（防膨胀）', () => {
  const { general, repo } = sections(TEXT);

  it('通用段不超上限：要加先看有没有别处已有、能不能只留指针', () => {
    expect(general.length, `通用段 ${general.length} 字，上限 ${GENERAL_MAX}`).toBeLessThanOrEqual(
      GENERAL_MAX,
    );
  });

  it('本仓段不超上限：命令参数、历史沿革挪进 docs/', () => {
    expect(repo.length, `本仓段 ${repo.length} 字，上限 ${REPO_MAX}`).toBeLessThanOrEqual(REPO_MAX);
  });

  it('【故意造出的失败】塞一大段进去：两条都拦得住；认不出标记时明确报错，不当成 0 字', () => {
    const fat = '- 多出来的一条规矩。'.repeat(500);
    const bloated = TEXT.replace('<!-- fleet-dao:通用段 结束 -->', `${fat}\n<!-- fleet-dao:通用段 结束 -->`);
    expect(sections(bloated).general.length).toBeGreaterThan(GENERAL_MAX);
    expect(sections(`${TEXT}${fat}`).repo.length).toBeGreaterThan(REPO_MAX);
    expect(() => sections('# 没有标记的文件')).toThrow(/认不出通用段标记/);
  });
});
