// e2e 隔离集（e2e/support/quarantine.ts，决定 0093）：按 E2E_QUARANTINE 挑用例的式子，对着 Playwright 拼出来的整串标题匹配。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  QUARANTINE_FILE,
  quarantineFilter,
  quarantineGrep,
  readQuarantine,
} from '../e2e/support/quarantine.ts';

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

  test('08-backend-down「用着用着后端断了」已移出隔离集：主线 e2e 照跑，不再单跑隔离集', () => {
    const raw = JSON.parse(readFileSync(QUARANTINE_FILE, 'utf8')) as {
      tests: { file: string; title: string }[];
    };
    const title =
      '用着用着后端断了：这一页写「没读成」和原因、有重试，不是空白也不是 0；后端好了点重试数据回来';
    const entry = raw.tests.find((t) => t.file === '08-backend-down.e2e.ts' && t.title === title);
    expect(entry, '根子修好了，隔离集里不留这条').toBeUndefined();
    // 用例还在 spec 里，标题一字不差，主线才能对上跑
    const spec = readFileSync(join(QUARANTINE_FILE, '..', 'specs', '08-backend-down.e2e.ts'), 'utf8');
    expect(spec).toContain(`test('${title}'`);

    const it = full('08-backend-down.e2e.ts', '后端不可用', title);
    const skip = quarantineFilter('skip');
    const only = quarantineFilter('only');
    expect(skip.grepInvert, 'ci 的 e2e（挡发版那一步）不再跳过它').toBeUndefined();
    expect(only.grep?.test(it), 'e2e-quarantine.yml 不再单跑它').toBe(false);
  });

  test('【故意造出的失败】文件格式不对：报错，不当成空的', () => {
    expect(() => readQuarantine('[]')).toThrow('{ "tests": [...] }');
    expect(() => readQuarantine('{"tests":[{"file":"a.e2e.ts"}]}')).toThrow('第 1 条');
  });
});
