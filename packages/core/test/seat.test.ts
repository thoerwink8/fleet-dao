// 名字校验（#299 的认领账、「认领对得上」整组已在 #556 删掉，这里只剩名字判法）。
import { describe, expect, it } from 'vitest';
import { isDrillScope, MAIN_SEAT, machineProblem, seatScopeProblem, sessionProblem } from '../src/seat.ts';

describe('座位名、机器名、会话号', () => {
  it('座位只认 main 和 drill:<名字>', () => {
    expect(MAIN_SEAT).toBe('main');
    expect(seatScopeProblem('main')).toBeNull();
    expect(seatScopeProblem('drill:299')).toBeNull();
    expect(isDrillScope('drill:演练')).toBe(true);
    expect(isDrillScope('main')).toBe(false);
    for (const bad of ['', 'Main', 'drill:', 'drill:a b', 'prod'])
      expect(seatScopeProblem(bad), bad).toContain('不行');
  });

  it('机器名的写法；会话号多允许冒号', () => {
    expect(machineProblem('本机')).toBeNull();
    expect(machineProblem('a:b')).toContain('不行');
    expect(sessionProblem('agent:a9f1')).toBeNull();
    expect(sessionProblem('有 空格', '工人名')).toContain('工人名「有 空格」不行');
  });
});
