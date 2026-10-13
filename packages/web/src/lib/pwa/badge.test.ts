// 角标（#2050）：数字大于 0 调 setAppBadge，0 调 clearAppBadge，不支持静默跳过。
import { describe, expect, test, vi } from 'vitest';
import { applyAppBadge, badgeSupported } from './badge';

function fake() {
  return { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
}

describe('applyAppBadge', () => {
  test('数字大于 0 就把数字写上去', async () => {
    const t = fake();
    expect(await applyAppBadge(3, t)).toBe(true);
    expect(t.setAppBadge).toHaveBeenCalledWith(3);
    expect(t.clearAppBadge).not.toHaveBeenCalled();
  });

  test('0 清除角标，不画 0', async () => {
    const t = fake();
    expect(await applyAppBadge(0, t)).toBe(true);
    expect(t.clearAppBadge).toHaveBeenCalledTimes(1);
    expect(t.setAppBadge).not.toHaveBeenCalled();
  });

  test('负数和 NaN 也清除', async () => {
    const t = fake();
    await applyAppBadge(-2, t);
    await applyAppBadge(Number.NaN, t);
    expect(t.clearAppBadge).toHaveBeenCalledTimes(2);
    expect(t.setAppBadge).not.toHaveBeenCalled();
  });

  test('不支持（没有 setAppBadge）静默跳过，不抛错', async () => {
    expect(await applyAppBadge(5, {})).toBe(false);
    expect(await applyAppBadge(0, {})).toBe(false);
    expect(await applyAppBadge(5, undefined)).toBe(false);
  });

  test('只有 setAppBadge 没有 clearAppBadge：0 时不乱调 setAppBadge', async () => {
    const setAppBadge = vi.fn(async () => {});
    expect(await applyAppBadge(0, { setAppBadge })).toBe(false);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  test('浏览器拒绝（没装成 APP）时吞掉错误', async () => {
    const t = { setAppBadge: vi.fn(async () => Promise.reject(new Error('denied'))), clearAppBadge: vi.fn() };
    expect(await applyAppBadge(2, t)).toBe(false);
  });
});

describe('badgeSupported', () => {
  test('有 setAppBadge 才算支持', () => {
    expect(badgeSupported(fake())).toBe(true);
    expect(badgeSupported({})).toBe(false);
    expect(badgeSupported(undefined)).toBe(false);
  });
});
