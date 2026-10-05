import { describe, expect, test } from 'vitest';
import type { Me } from '../api/types';
import { isMine, taskTone } from './status';

describe('颜色只表达状态', () => {
  test('等人回答的需求是「等你」色', () => {
    expect(taskTone({ state: 'asking' })).toBe('human');
  });
});

describe('只看我提的', () => {
  const me: Me = {
    user: { id: 'u-lan', displayName: '阿岚', role: 'founder' },
    csrfToken: 't',
    env: { name: '测试机' },
  };

  test('提出人填的是用户编号或名字都认', () => {
    expect(isMine('u-lan', me)).toBe(true);
    expect(isMine('阿岚', me)).toBe(true);
  });

  test('别人的、没登录时都不算', () => {
    expect(isMine('u-zhou', me)).toBe(false);
    expect(isMine('u-lan', undefined)).toBe(false);
  });
});
