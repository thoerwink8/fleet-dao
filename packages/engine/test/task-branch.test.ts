// 任务分支名的两份判法（引擎工作流用的 task-branch.ts、合并闸用的 conventions 的 flow-branch.ts）必须一致：
// 引擎起的分支，闸一定认得出是引擎的；闸认作引擎的，引擎一定会这么起。改一边不改另一边当场红。
import { FLOW_BRANCH_PATTERN, isFlowBranch } from '@fleet-dao/conventions';
import { describe, expect, it } from 'vitest';
import { isTaskBranch, taskBranch } from '../src/task-branch.ts';

const RUN_KEYS = [
  '0fb4e587-64fb-4c7e-a007-7ead18d2041a',
  'ABCDEF12-0000-0000-0000-000000000000',
  '12345678abcdef',
  'a'.repeat(32),
];

const NEAR_MISSES = [
  'fleet/12-t1a2b3c4', // 少一位
  'fleet/12-t1a2b3c4de', // 多一位
  'fleet/12-tXYZ12345', // 不是十六进制
  'fleet/12-T1A2B3C4D', // 大写前缀
  'fleet/x-t1a2b3c4d', // 单号不是数字
  'fleet/-t1a2b3c4d', // 没有单号
  'feat/fleet/12-t1a2b3c4d', // 多一层前缀
  'fleet/12-t1a2b3c4d/extra', // 多一层后缀
  'fleet/12-t1a2b3c4d ', // 尾巴上有空格
  'fleet/12-1a2b3c4d', // 没有 t
  'main',
  '',
];

describe('任务分支名的两份判法一致', () => {
  it('引擎起的分支名：两边都认（执行编号带不带横线、大小写都一样处理）', () => {
    for (const [i, key] of RUN_KEYS.entries()) {
      const name = taskBranch(100 + i, key);
      expect(isTaskBranch(name), name).toBe(true);
      expect(isFlowBranch(name), name).toBe(true);
    }
  });

  it('【故意造出的失败】差一点点的名字：两边都不认——认错了就是引擎的 PR 没验收也能合，或者人手的 PR 被卡在「还没验」', () => {
    for (const name of NEAR_MISSES) {
      expect(isTaskBranch(name), name).toBe(false);
      expect(isFlowBranch(name), name).toBe(false);
    }
  });

  it('两边的正则是同一个（来源一份，另一份抄的）', () => {
    expect(FLOW_BRANCH_PATTERN.source).toBe(/^fleet\/\d+-t[0-9a-f]{8}$/.source);
  });

  it('【故意造出的失败】起不出合规分支名的执行编号（前 8 位不是十六进制、不够 8 位）：当场报错，不起一个合并闸认不出的名字', () => {
    for (const bad of ['zzzzzzzz-0000', 'abc', '', 'ghijklmn']) {
      expect(() => taskBranch(7, bad), bad).toThrow(/起不出合规的任务分支名/);
    }
  });
});
