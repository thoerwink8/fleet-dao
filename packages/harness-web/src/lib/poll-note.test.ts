import { describe, expect, it } from 'vitest';
import { pollNote } from './poll-note';

describe('轮询报错', () => {
  it('最新一次成功就清掉，失败才写上', () => {
    expect(pollNote(2, 2, '没登录：缺本机令牌')).toBe('没登录：缺本机令牌');
    expect(pollNote(2, 2, null)).toBe('');
  });

  it('更早的失败回包不改已经成功清掉的报错', () => {
    expect(pollNote(2, 1, '没登录：缺本机令牌')).toBeUndefined();
    expect(pollNote(2, 1, null)).toBeUndefined();
  });
});
