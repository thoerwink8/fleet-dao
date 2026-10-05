// 名字校验（#299 的认领账、「认领对得上」整组已在 #556 删掉，座位名校验 #901 删掉，这里只剩机器名和会话号）。
import { describe, expect, it } from 'vitest';
import { machineProblem, sessionProblem } from '../src/names.ts';

describe('机器名、会话号', () => {
  it('机器名的写法；会话号多允许冒号', () => {
    expect(machineProblem('本机')).toBeNull();
    expect(machineProblem('a:b')).toContain('不行');
    expect(machineProblem('')).toContain('不行');
    expect(sessionProblem('agent:a9f1')).toBeNull();
    expect(sessionProblem('有 空格', '工人名')).toContain('工人名「有 空格」不行');
  });
});
