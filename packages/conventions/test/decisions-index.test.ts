import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDecisionsIndex,
  GENERATE_COMMAND,
  generateDecisionsIndex,
  INDEX_PATH,
  readDecisions,
} from '../src/decisions-index.ts';
import { fsRepo } from '../src/repo.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function doc(n: string, extra: string[] = [], status = '生效'): string {
  return [
    `# ${n} 标题${n}`,
    '',
    '- 日期：2026-10-01（北京时间）',
    `- 索引状态：${status}`,
    ...extra,
    '',
    '## 正文',
    '',
    '- 日期：不是头部',
  ].join('\n');
}

describe('决定索引生成', () => {
  const files = {
    'docs/decisions/0001-a.md': doc('0001', ['- 被取代：0002（第 3 条）'], '历史'),
    'docs/decisions/0002-b.md': doc('0002'),
    'docs/decisions/README.md': '',
  };

  it('按头部生成：分节、被取代看得出来', () => {
    const { text, problems } = generateDecisionsIndex(memRepo(files));
    expect(problems).toEqual([]);
    expect(text).toContain('| [0002](0002-b.md) | 标题0002 | 2026-10-01 | 生效 | — |');
    expect(text).toContain('| [0001](0001-a.md) | 标题0001 | 2026-10-01 | 历史 | 0002（第 3 条） |');
    expect((text ?? '').indexOf('0002-b.md')).toBeLessThan((text ?? '').indexOf('0001-a.md'));
  });

  it('生成结果和仓里文件一致才过；不一致提示跑哪条命令', () => {
    const text = generateDecisionsIndex(memRepo(files)).text ?? '';
    expect(checkDecisionsIndex(memRepo({ ...files, [INDEX_PATH]: text }))).toEqual([]);
    const stale = checkDecisionsIndex(memRepo({ ...files, [INDEX_PATH]: `${text}手改` }));
    expect(stale[0]?.text).toContain(GENERATE_COMMAND);
  });

  it('头部缺状态、值不对、被取代指向不存在的编号都报', () => {
    const bad = memRepo({
      'docs/decisions/0001-a.md': '# 0001 甲\n\n- 日期：2026-10-01\n\n## 正文\n',
      'docs/decisions/0002-b.md': doc('0002', [], '采纳'),
      'docs/decisions/0003-c.md': doc('0003', ['- 被取代：0099']),
      'docs/decisions/0004-d.md': doc('0004', ['- 被取代：0004']),
    });
    const texts = readDecisions(bad).problems.map((p) => p.text);
    expect(texts.some((t) => t.includes('0001-a.md') && t.includes('索引状态'))).toBe(true);
    expect(texts.some((t) => t.includes('0002-b.md') && t.includes('采纳'))).toBe(true);
    expect(texts.some((t) => t.includes('0099'))).toBe(true);
    expect(texts.some((t) => t.includes('不能写自己'))).toBe(true);
  });

  it('读不到目录是没查成，不当成一致', () => {
    const p = checkDecisionsIndex(memRepo({}));
    expect(p[0]?.notQueried).toBe(true);
  });

  it('真仓：docs/decisions/README.md 和各份头部生成的一致', () => {
    const problems = checkDecisionsIndex(fsRepo(ROOT));
    expect(problems.map((p) => p.text)).toEqual([]);
  });

  it('真仓：0034 第 8 条被 0094 取代，索引里看得出来', () => {
    const readme = fsRepo(ROOT).read(INDEX_PATH) ?? '';
    expect(readme).toMatch(/\| \[0034\].*0094（第 8 条）/);
  });
});
