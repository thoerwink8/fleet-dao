// 额度留量线（#194 方案 4.8）的判法：线只来自库里的设置（代码里没有默认值）、设置读不到 / 认不出、读数到线 / 缺窗口 / 读不到。
// 每条读不到、认不出的路径都故意造一次失败。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateReserve,
  QUOTA_RESERVE_SETTING,
  QuotaReserveSettingSchema,
  RESERVE_NOT_LOADED,
  ReserveInputError,
  type ReserveReading,
  reserveHitText,
  reserveSettingProblem,
  resolvePoolReserve,
  SETTING_SCHEMAS,
  usedRatioOf,
} from '../src/index.ts';

const reading = (over: Partial<ReserveReading> = {}): ReserveReading => ({
  label: '7d',
  window: '7d',
  scope: null,
  state: 'ok',
  used: 0.5,
  resetsAt: '2026-10-08T00:00:00.000Z',
  ...over,
});

describe('线只来自库里的设置', () => {
  it('设置里这个池写了线就用它；没写的池 = 不限（空线表）；null 的窗口 = 不限', () => {
    const setting = { 'claude-solo': { '7d': 0.5, '5h': null }, cursor: { points: 0.9 } };
    expect(resolvePoolReserve(setting, { poolId: 'claude-solo' })).toEqual({
      ok: true,
      lines: { '7d': 0.5 },
    });
    expect(resolvePoolReserve(setting, { poolId: 'cursor' })).toEqual({ ok: true, lines: { points: 0.9 } });
    expect(resolvePoolReserve(setting, { poolId: 'other' })).toEqual({ ok: true, lines: {} });
    expect(resolvePoolReserve({}, { poolId: 'claude-solo' })).toEqual({ ok: true, lines: {} });
  });

  it('线 0 和 1 都收（0 = 一点都不让引擎用）', () => {
    expect(resolvePoolReserve({ p: { '5h': 0, '7d': 1 } }, { poolId: 'p' })).toEqual({
      ok: true,
      lines: { '5h': 0, '7d': 1 },
    });
  });

  it('【故意造出失败】库里没有这一行（种子没装上，undefined）：明确失败，不当成不限', () => {
    const r = resolvePoolReserve(undefined, { poolId: 'claude-solo' });
    expect(r).toEqual({ ok: false, why: RESERVE_NOT_LOADED });
    expect(RESERVE_NOT_LOADED).toContain('没装进库');
    expect(reserveSettingProblem(undefined)).toBe(RESERVE_NOT_LOADED);
  });

  it('【故意造出失败】线是负数、大于 1、字符串、NaN、未知窗口名：这个池明确失败，不当成不限', () => {
    for (const bad of [-0.1, 1.5, '0.7', Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = resolvePoolReserve({ p: { '7d': bad } }, { poolId: 'p' });
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(r.why).toContain('p 的留量线认不出');
    }
    expect(resolvePoolReserve({ p: { weekly: 0.5 } }, { poolId: 'p' }).ok).toBe(false);
  });

  it('【故意造出失败】只有一个池的那一项坏了：只有它失败，别的池照常', () => {
    const setting = { bad: { '7d': 5 }, good: { '7d': 0.4 } };
    expect(resolvePoolReserve(setting, { poolId: 'bad' }).ok).toBe(false);
    expect(resolvePoolReserve(setting, { poolId: 'good' })).toEqual({ ok: true, lines: { '7d': 0.4 } });
  });

  it('【故意造出失败】整份不是对象（被人直接改库）：所有池都失败，原因带上原值', () => {
    for (const bad of [null, 'on', 7, true, ['x']]) {
      const r = resolvePoolReserve(bad, { poolId: 'p' });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.why).toContain(QUOTA_RESERVE_SETTING);
      expect(reserveSettingProblem(bad)).not.toBeNull();
    }
    expect(reserveSettingProblem({ p: { '7d': 0.5 } })).toBeNull();
  });

  it('驾驶舱改设置的校验：同一份规则，坏值被拒收', () => {
    const schema = SETTING_SCHEMAS['engine.quotaReserve'];
    expect(schema.safeParse({ p: { '5h': 0.8, '7d': null } }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    for (const bad of [
      { p: { '5h': -1 } },
      { p: { '5h': 2 } },
      { p: { '5h': 'x' } },
      { p: { nope: 0.5 } },
      [],
      5,
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(QuotaReserveSettingSchema).toBe(schema);
  });
});

describe('代码里不留具体数值的默认（创始人 2026-10-05：不写死，驾驶舱可配置）', () => {
  /** 递归读 src 下的 .ts / .tsx 源码（不含测试）。 */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sources(p);
      return /\.tsx?$/.test(name) ? [p] : [];
    });
  }

  it('【检查】shared / engine / api / web / db 的源码里没有「{窗口: 0.8 / 0.7}」那组默认，也没有 DEFAULT_RESERVE_LINES 这个常量', () => {
    const root = join(import.meta.dirname, '..', '..');
    const files = ['shared', 'engine', 'api', 'web', 'db'].flatMap((pkg) => sources(join(root, pkg, 'src')));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return (
        /DEFAULT_RESERVE_LINES|DEFAULT_QUOTA_RESERVE/.test(text) ||
        /['"]?(5h|7d|7d_model)['"]?\s*:\s*0?\.(8|7)\b/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });
});

describe('读数对着线', () => {
  it('没到线：没有命中也没有未知', () => {
    expect(evaluateReserve({ '7d': 0.7 }, [reading({ used: 0.69 })])).toEqual({ hits: [], unknown: [] });
  });

  it('正好到线算到线（0.7 对 0.7，浮点误差不漏）；超线更算', () => {
    expect(evaluateReserve({ '7d': 0.7 }, [reading({ used: 0.7 })]).hits).toHaveLength(1);
    expect(evaluateReserve({ '7d': 0.7 }, [reading({ used: 0.1 + 0.6 })]).hits).toHaveLength(1);
    const v = evaluateReserve({ '7d': 0.7 }, [reading({ used: 0.75 })]);
    expect(v.hits[0]).toMatchObject({ window: '7d', used: 0.75, line: 0.7 });
    expect(reserveHitText(v.hits[0] as never)).toBe('周额度用了 75%，到了留量线 70%');
  });

  it('用满（exhausted）的窗口，读数没给比例也算到线', () => {
    const v = evaluateReserve({ '5h': 0.8 }, [
      reading({ label: '5h', window: '5h', state: 'exhausted', used: null }),
    ]);
    expect(v.hits).toHaveLength(1);
    expect(reserveHitText(v.hits[0] as never)).toBe('5 小时额度已用满，到了留量线 80%');
  });

  it('旧读数（stale）已经超线算数（周窗只升不降）；旧读数没超线不算到线', () => {
    expect(evaluateReserve({ '7d': 0.7 }, [reading({ state: 'stale', used: 0.8 })]).hits).toHaveLength(1);
    expect(evaluateReserve({ '7d': 0.7 }, [reading({ state: 'stale', used: 0.2 })]).hits).toHaveLength(0);
  });

  it('同一种窗口有几条（模型分组周窗）：任何一条到线就算', () => {
    const v = evaluateReserve({ '7d_model': 0.7 }, [
      reading({ label: '7d_claude', window: '7d_model', scope: 'claude', used: 0.3 }),
      reading({ label: '7d_fable', window: '7d_model', scope: 'fable', used: 0.9 }),
    ]);
    expect(v.hits.map((h) => h.label)).toEqual(['7d_fable']);
  });

  it('【故意造出失败】读数里没有配了线的那个窗口：列进 unknown，不当成没到线也不当成到线', () => {
    const v = evaluateReserve({ '7d': 0.7, '5h': 0.8 }, [reading({ label: '5h', window: '5h', used: 0.1 })]);
    expect(v.hits).toEqual([]);
    expect(v.unknown).toEqual([{ window: '7d', line: 0.7, why: '读数里没有这个窗口' }]);
  });

  it('【故意造出失败】读数没给已用多少 / 已用比例不是数 / 负数 / 已过清零时刻：unknown，写明原因', () => {
    const cases: [Partial<ReserveReading>, string][] = [
      [{ used: null }, '读数没给已用多少'],
      [{ used: Number.NaN }, '已用比例认不出'],
      [{ used: -0.2 }, '已用比例认不出'],
      [{ state: 'reset' }, '已过清零时刻'],
    ];
    for (const [over, why] of cases) {
      const v = evaluateReserve({ '7d': 0.7 }, [reading(over)]);
      expect(v.hits, why).toEqual([]);
      expect(v.unknown[0]?.why, why).toContain(why);
    }
  });

  it('【故意造出失败】线本身不合法（调用方没经过设置校验直接塞）：抛，不当成不限', () => {
    for (const bad of [-1, 1.2, Number.NaN]) {
      expect(() => evaluateReserve({ '7d': bad }, [reading()])).toThrow(ReserveInputError);
    }
  });

  it('没配线 = 空线表：永远没有命中', () => {
    expect(evaluateReserve({}, [reading({ used: 5 })])).toEqual({ hits: [], unknown: [] });
  });
});

describe('usedRatioOf', () => {
  it('上游给了百分比用百分比；否则 used / limit；都算不出是 null', () => {
    expect(usedRatioOf({ utilization: 0.4, used: 9, limit: 10 })).toBe(0.4);
    expect(usedRatioOf({ used: 9, limit: 10 })).toBe(0.9);
    expect(usedRatioOf({ used: 9, limit: 0 })).toBeNull();
    expect(usedRatioOf({ used: 9 })).toBeNull();
    expect(usedRatioOf({})).toBeNull();
  });
});
