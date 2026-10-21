import { describe, expect, test } from 'vitest';
import { isRead, mapRead, readFail, readOk, UNREAD_TEXT } from './read';

describe('Read<T>', () => {
  test('读成了带值，没读成带原因', () => {
    expect(readOk(3)).toEqual({ ok: true, value: 3 });
    expect(readFail('超时')).toEqual({ ok: false, reason: '超时' });
  });

  test('isRead 认 Read，不把普通对象、数字、null 当成 Read', () => {
    expect(isRead(readOk('x'))).toBe(true);
    expect(isRead(readFail('x'))).toBe(true);
    expect(isRead<unknown>({ value: 1 })).toBe(false);
    expect(isRead<unknown>({ ok: 'yes' })).toBe(false);
    expect(isRead<unknown>(5)).toBe(false);
    expect(isRead<unknown>(null)).toBe(false);
  });

  test('mapRead 读成了换值，没读成原样带回原因', () => {
    expect(mapRead(readOk(2), (n) => n * 10)).toEqual({ ok: true, value: 20 });
    const bad = readFail<number>('断了');
    expect(mapRead(bad, (n) => n * 10)).toBe(bad);
  });

  test('没读到的字', () => {
    expect(UNREAD_TEXT).toBe('没读到');
  });
});
