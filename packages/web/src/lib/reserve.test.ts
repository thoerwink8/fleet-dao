// 设置页留量线输入和存值互转（#194 方案 4.8）：认不出的输入明确报错，不当成不限；这里没有任何具体数值的默认。
import { QUOTA_RESERVE_SEED_ACTOR } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import { parseReserveInput, reserveInputText, reserveKindsFor, reserveSource } from './reserve';

describe('parseReserveInput', () => {
  test('留空 = 未配置；「不限」= 明确不限（null）；百分数 → 比例，去掉浮点尾巴', () => {
    expect(parseReserveInput('')).toEqual({ ok: true, value: undefined });
    expect(parseReserveInput('  ')).toEqual({ ok: true, value: undefined });
    expect(parseReserveInput('不限')).toEqual({ ok: true, value: null });
    expect(parseReserveInput('70')).toEqual({ ok: true, value: 0.7 });
    expect(parseReserveInput('80%')).toEqual({ ok: true, value: 0.8 });
    expect(parseReserveInput('0')).toEqual({ ok: true, value: 0 });
    expect(parseReserveInput('100')).toEqual({ ok: true, value: 1 });
    expect(parseReserveInput('33.5')).toEqual({ ok: true, value: 0.335 });
  });

  test('【故意造出失败】负数、大于 100、不是数字：报错，不当成不限也不当成 0', () => {
    for (const bad of ['-1', '101', 'abc', '7o', 'NaN', 'Infinity']) {
      const r = parseReserveInput(bad);
      expect(r.ok, bad).toBe(false);
    }
  });
});

describe('存值 ↔ 输入框', () => {
  test('往返不变；没写 = 空', () => {
    for (const v of [0.7, 0.8, 0.335, 0, 1]) {
      const text = reserveInputText(v);
      expect(parseReserveInput(text)).toEqual({ ok: true, value: v });
    }
    expect(reserveInputText(undefined)).toBe('');
    expect(reserveInputText(null)).toBe('不限');
  });

  test('池界面上列哪几种窗口：读到的 + 存值里写了的，固定顺序，没有凭空多出来的默认', () => {
    expect(reserveKindsFor([], {})).toEqual([]);
    expect(reserveKindsFor(['7d', '5h'], {})).toEqual(['5h', '7d']);
    expect(reserveKindsFor(['5h'], { month_usd: 0.9, '7d': null })).toEqual(['5h', '7d', 'month_usd']);
  });
});

describe('reserveSource：这一项现在是谁定的', () => {
  test('没有这一项 / 版本 0 = 库里没有（种子没装上）；种子装的；人改过', () => {
    expect(reserveSource(undefined)).toEqual({ kind: 'missing' });
    expect(reserveSource({ version: 0 })).toEqual({ kind: 'missing' });
    expect(reserveSource({ version: 1, updatedBy: QUOTA_RESERVE_SEED_ACTOR })).toEqual({ kind: 'seed' });
    expect(reserveSource({ version: 2, updatedBy: 'u-1' })).toEqual({ kind: 'edited', by: 'u-1' });
    expect(reserveSource({ version: 3 })).toEqual({ kind: 'edited', by: undefined });
  });
});
