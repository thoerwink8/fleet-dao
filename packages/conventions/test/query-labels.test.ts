import { describe, expect, it } from 'vitest';
import { queryAxisLabels } from '../src/labels.ts';

describe('查询轴继承不改变执行准入', () => {
  it('冲突轴不猜，仍继承另一条有效轴并明报', () => {
    const warnings: string[] = [];
    expect(queryAxisLabels(['域:api', '域:engine', '性质:bug'], (message) => warnings.push(message))).toEqual(
      ['性质:bug'],
    );
    expect(warnings).toEqual([expect.stringContaining('域」冲突')]);
  });
  it('同轴有未知值时保留唯一有效值并提示未知值，不猜另一个标签', () => {
    const warnings: string[] = [];
    expect(
      queryAxisLabels(['域:unknown', '域:api', '性质:bug'], (message) => warnings.push(message)),
    ).toEqual(['域:api', '性质:bug']);
    expect(warnings).toEqual([expect.stringContaining('有未知值（未知：域:unknown）')]);
  });
  it('旧单无轴和未知值明报，返回可用标签、不抛错', () => {
    const warnings: string[] = [];
    expect(queryAxisLabels(undefined, (message) => warnings.push(message))).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(queryAxisLabels(['域:unknown', '性质:perf'], (message) => warnings.push(message))).toEqual([
      '性质:perf',
    ]);
    expect(warnings.at(-1)).toContain('未知：域:unknown');
  });
});
