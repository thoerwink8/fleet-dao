// PR 正文的栏（pr-columns.ts）：claim-status.ts 判挂了哪张单、引擎认 PR 上写的认领号（#348）都靠它（#444 起合并闸
// 不再用它判挂没挂单）。linkedIssue 的边界表在 pr-labels.test.ts（原来就在那儿，认法搬到这里后照旧从 pr-labels
// 导出）；这里管认领号。
import { describe, expect, it } from 'vitest';
import { linkedIssue, PR_COLUMNS, prClaimId } from '../src/pr-columns.ts';
import { linkedIssue as fromLabels } from '../src/pr-labels.ts';

const ID = '0f0e0d0c-0000-4000-8000-00000000000a';

describe('PR 正文「认领」栏的认领号（#348）', () => {
  it('加粗、不加粗、列表里都认；大写的转成小写', () => {
    expect(prClaimId(`**认领**：${ID}`)).toBe(ID);
    expect(prClaimId(`认领：${ID.toUpperCase()}`)).toBe(ID);
    expect(prClaimId(`- **认领：** \`${ID}\`（本机/w1）`)).toBe(ID);
  });

  it('【故意造出的失败】没有这一栏、只留着模板提示、只写了前 8 位、写在别的栏里：都认不出，不拿半截号去比', () => {
    expect(prClaimId('**需求**：#12')).toBeUndefined();
    expect(prClaimId('**认领**：<!-- 写认领号整串 -->\n**档位**：CI 绿就合')).toBeUndefined();
    expect(prClaimId('**认领**：0f0e0d0c')).toBeUndefined();
    expect(prClaimId(`**需求**：#12 ${ID}\n**认领**：无`)).toBeUndefined();
    expect(prClaimId(`**认领**：x${ID}0`)).toBeUndefined();
  });

  it('模板里有「认领」这一栏，排在「需求」后面（引擎开的 PR 写「引擎」）', () => {
    expect(PR_COLUMNS.indexOf('认领')).toBe(PR_COLUMNS.indexOf('需求') + 1);
  });

  it('认挂了哪张单只有一份：pr-labels 导出的就是这里的', () => {
    expect(fromLabels).toBe(linkedIssue);
    expect(linkedIssue(`**需求**：#12\n**认领**：${ID}`, '')).toBe(12);
  });
});
