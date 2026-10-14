// e2e 隔离集（e2e/support/quarantine.ts，决定 0093）：按 E2E_QUARANTINE 挑用例的式子，对着 Playwright 拼出来的整串标题匹配。
import { describe, expect, test } from 'vitest';
import { quarantineFilter, quarantineGrep, readQuarantine } from '../e2e/support/quarantine.ts';

// Playwright 给 grep 的是「项目名 文件路径 describe… 标题」用空格拼起来的整串
const full = (file: string, describe: string, title: string) =>
  ` desktop-1920 specs/${file} ${describe} ${title}`;

describe('quarantineGrep', () => {
  const re = quarantineGrep([
    { file: '07c-nodes.e2e.ts', title: '失联：钟快进 10 分钟（横幅写「失联 10 分钟」）' },
    { file: '12-intake.e2e.ts', title: '新提一条 → 删除' },
  ]);

  test('文件和标题都对上才算；标题里的括号、问号等原样匹配', () => {
    expect(
      re?.test(full('07c-nodes.e2e.ts', '看板多机', '失联：钟快进 10 分钟（横幅写「失联 10 分钟」）')),
    ).toBe(true);
    expect(re?.test(full('12-intake.e2e.ts', '提需求', '新提一条 → 删除'))).toBe(true);
  });

  test('同名标题在别的文件、标题只是前缀相同：不算', () => {
    expect(
      re?.test(full('12-intake.e2e.ts', '提需求', '失联：钟快进 10 分钟（横幅写「失联 10 分钟」）')),
    ).toBe(false);
    expect(re?.test(full('12-intake.e2e.ts', '提需求', '新提一条 → 删除 → 恢复'))).toBe(false);
  });

  test('隔离集空：不过滤', () => {
    expect(quarantineGrep([])).toBeUndefined();
  });
});

describe('quarantineFilter：E2E_QUARANTINE', () => {
  test('不设全跑；skip、only 读仓里的 quarantine.json；别的值报错', () => {
    expect(quarantineFilter(undefined)).toEqual({});
    expect(quarantineFilter('')).toEqual({});
    const list = readQuarantine();
    const skip = quarantineFilter('skip');
    const only = quarantineFilter('only');
    if (list.length === 0) {
      expect(skip).toEqual({});
      // 隔离集空时 only 一条也不跑
      expect(only.grep?.test(full('01-login.e2e.ts', '登录', '任何一条'))).toBe(false);
    } else {
      expect(skip.grepInvert).toBeInstanceOf(RegExp);
      expect(only.grep).toBeInstanceOf(RegExp);
    }
    expect(() => quarantineFilter('all')).toThrow('只能是 skip 或 only');
  });

  test('【故意造出的失败】文件格式不对：报错，不当成空的', () => {
    expect(() => readQuarantine('[]')).toThrow('{ "tests": [...] }');
    expect(() => readQuarantine('{"tests":[{"file":"a.e2e.ts"}]}')).toThrow('第 1 条');
  });
});
