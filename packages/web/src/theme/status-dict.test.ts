// 状态字典的闸（方案第三节「机器守」）：同一中文只有一个等级、等级合法、unknown 存在、toStatus 认不出时的行为。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DOMAINS,
  dotTokenOf,
  LEVELS,
  resetUnknownStatus,
  STATUS_DICT,
  STATUS_KEYS,
  statusEntry,
  toStatus,
  UNKNOWN_STATUS,
  unknownStatusCount,
} from './status-dict';

const all = DOMAINS.flatMap((d) =>
  Object.entries(STATUS_DICT[d] as Record<string, { label: string; level: string; emphasis?: true }>).map(
    ([key, v]) => ({
      status: `${d}:${key}`,
      ...v,
    }),
  ),
);

describe('状态字典', () => {
  test('9 个域、223 条', () => {
    expect(DOMAINS).toEqual([
      'task',
      'tone',
      'notification',
      'job',
      'route',
      'request',
      'release',
      'machine',
      'quota',
    ]);
    expect(all).toHaveLength(223);
  });

  test('每个 level 合法', () => {
    for (const e of all) expect(LEVELS, `${e.status} 的 level ${e.level}`).toContain(e.level);
  });

  test('同一个中文在全站只有一个 level', () => {
    const seen = new Map<string, Set<string>>();
    for (const e of all) seen.set(e.label, (seen.get(e.label) ?? new Set()).add(e.level));
    const bad = [...seen]
      .filter(([, lv]) => lv.size > 1)
      .map(([label, lv]) => `「${label}」有两个等级：${[...lv].join('、')}`);
    expect(bad).toEqual([]);
  });

  test('「开着」统一是 success', () => {
    expect(statusEntry('request:issue:open')).toEqual({ label: '开着', level: 'success' });
    expect(statusEntry('machine:master:on')).toEqual({ label: '开着', level: 'success' });
  });

  test('正常态只有强调的那几条画绿点，其余一律灰（决定 0121 第 2 条）', () => {
    const emphasizedKeys = all.filter((e) => e.emphasis === true).map((e) => e.status);
    // 只有「刚刚成功、需要强调」的一瞬：上限 4 条，多了绿点就淹掉橙红。
    expect(emphasizedKeys.length).toBeLessThanOrEqual(4);
    expect(emphasizedKeys).toEqual([
      'task:round:merged',
      'notification:repair:verified',
      'notification:answer:done',
      'notification:handling:deployed',
    ]);
    // 别的 success 全是灰点。
    const successKeys = all.filter((e) => e.level === 'success' && e.emphasis !== true);
    expect(successKeys.length).toBeGreaterThan(0);
    for (const e of successKeys) expect(dotTokenOf(e as never), `${e.status} 该画灰点`).toBe('ink-3');
    for (const k of emphasizedKeys)
      expect(dotTokenOf(statusEntry(k as never)), `${k} 该画绿点`).toBe('success');
  });

  test('emphasis 只许挂在 success 上', () => {
    for (const e of all) if (e.emphasis === true) expect(e.level).toBe('success');
  });

  test('unknown 存在：灰「未知」', () => {
    expect(UNKNOWN_STATUS).toEqual({ label: '未知', level: 'default' });
    expect(statusEntry('unknown')).toEqual(UNKNOWN_STATUS);
    expect(STATUS_KEYS).toContain('unknown');
  });

  test('键都是 域:键 的形状，没有重复', () => {
    expect(new Set(STATUS_KEYS).size).toBe(STATUS_KEYS.length);
    for (const k of STATUS_KEYS)
      expect(k === 'unknown' || DOMAINS.some((d) => k.startsWith(`${d}:`))).toBe(true);
  });
});

describe('toStatus', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetUnknownStatus();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test('认得的值换成字典键，不警告', () => {
    expect(toStatus('task', 'running')).toBe('task:running');
    expect(toStatus('task', 'segment:timeout')).toBe('task:segment:timeout');
    expect(warn).not.toHaveBeenCalled();
    expect(unknownStatusCount()).toBe(0);
  });

  test('认不出的返回 unknown，同一个值只警告一次，计数每次加一', () => {
    expect(toStatus('task', 'brand_new_state')).toBe('unknown');
    expect(toStatus('task', 'brand_new_state')).toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('task:brand_new_state');
    expect(unknownStatusCount()).toBe(2);
  });

  test('空值、别的域的键都认不出', () => {
    expect(toStatus('route', null)).toBe('unknown');
    expect(toStatus('route', undefined)).toBe('unknown');
    expect(toStatus('route', 'running')).toBe('unknown');
  });
});
