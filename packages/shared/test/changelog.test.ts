// 「这一段还没写」怎么判（isPlaceholderSection）：Unreleased 段（splitChangelog 的 hasContent，发起脚本拿它决定发不发）
// 和某一版正文（release.yml 建 release 前）同用这一份。只认整行占位，不按「含不含」判。
import { describe, expect, it } from 'vitest';
import { isPlaceholderSection, splitChangelog, UNRELEASED_HEADING } from '../src/changelog.ts';

const withUnreleased = (section: string) => `# Changelog\n\n${UNRELEASED_HEADING}\n\n${section}\n`;

describe('isPlaceholderSection：只剩占位才算没写', () => {
  it('整段是一个占位词、或每行都是占位词 → 占位', () => {
    expect(isPlaceholderSection('还没有')).toBe(true);
    expect(isPlaceholderSection('  还没有  \n')).toBe(true);
    expect(isPlaceholderSection('还没有\n\n无\n没有内容')).toBe(true);
  });

  it('空段不算占位（是不是空由调用方另判）', () => {
    expect(isPlaceholderSection('')).toBe(false);
    expect(isPlaceholderSection('\n  \n')).toBe(false);
  });

  it('有一行是真内容就不算占位', () => {
    expect(isPlaceholderSection('还没有\n- 加了发布收尾')).toBe(false);
  });
});

describe('splitChangelog 的 hasContent：Unreleased 里写了真内容就算有', () => {
  // 【故意造出的失败】原先按「含不含占位词」判：带「无」「还没有」字样的真内容全被当成空的，
  // 「无人值守」这个词在这个仓的更新日志里几乎一定会出现：只含它的段落不能被当成「还没写」。
  it.each([
    ['带「无」', '- 加了无人值守推进'],
    ['带「还没有」', '- 补上以前还没有的发布收尾'],
    ['带「没有内容」', '- 修了空单子显示「没有内容」的那一页'],
  ])('%s的真内容 → 有内容', (_name, line) => {
    const r = splitChangelog(withUnreleased(line));
    expect(r.hasContent).toBe(true);
    expect(r.section).toBe(line);
  });

  it('只写了占位「还没有」、或几行占位 → 没内容', () => {
    expect(splitChangelog(withUnreleased('还没有')).hasContent).toBe(false);
    expect(splitChangelog(withUnreleased('还没有\n无')).hasContent).toBe(false);
  });

  it('什么都没写 → 没内容', () => {
    expect(splitChangelog(withUnreleased('')).hasContent).toBe(false);
  });
});
