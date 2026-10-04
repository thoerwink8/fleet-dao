// 任务简报：「改了简报外的哪些文件」的边界表。
// 简报齐不齐（checkBrief）和几份能不能同时派（checkParallel）是 Fusion 的东西，#901 审查时只有测试在用，连测试一起删了。
import { describe, expect, it } from 'vitest';
import { type Brief, outsideBrief } from '../src/brief.ts';

const good: Brief = {
  goal: '给登录加验证码过期',
  scope: '只改后端，不碰页面',
  constraints: ['不加新依赖'],
  files: ['packages/api/src/auth.ts', 'packages/api/test/'],
  acceptance: ['过期的验证码登录不了', '有一条故意造出失败的测试'],
  returnFormat: '改了哪些文件、测试结果、没做完的',
};

describe('任务简报', () => {
  it('只许改的文件：目录下的算，别处不算', () => {
    expect(
      outsideBrief(good, [
        'packages/api/src/auth.ts',
        'packages/api/test/auth.test.ts',
        'packages/api/src/db.ts',
      ]),
    ).toEqual(['packages/api/src/db.ts']);
  });

  it('【失败】一个文件都不在简报里：全部报出来，不当没事', () => {
    expect(outsideBrief(good, ['docs/design.md'])).toEqual(['docs/design.md']);
  });
});
