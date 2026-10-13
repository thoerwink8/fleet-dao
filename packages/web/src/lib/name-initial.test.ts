import { describe, expect, test } from 'vitest';
import { nameInitial as initial } from './format';

describe('头像上的字', () => {
  test('中文名取最后一个字：「创始人甲」「创始人乙」分得清', () => {
    expect(initial('创始人甲')).toBe('甲');
    expect(initial('创始人乙')).toBe('乙');
    expect(initial('阿岚')).toBe('岚');
  });

  test('英文名、账号取首字母大写；空名字写问号', () => {
    expect(initial('fxc188')).toBe('F');
    expect(initial('  ')).toBe('?');
  });
});
