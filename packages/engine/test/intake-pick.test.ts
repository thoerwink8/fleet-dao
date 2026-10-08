// 拉单挑单的纯判断（jobs/intake-pick.ts，#1336）：排序、先后表、验收条信号、熔断、每小时限速。
import { describe, expect, it } from 'vitest';
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILS,
  type BreakerFacts,
  comparePick,
  decideBreaker,
  hasVisibleSignal,
  hourlyRemaining,
  MAX_STARTS_PER_HOUR,
  type PickKey,
  readOrderBook,
  serialOf,
  sortCandidates,
} from '../src/jobs/intake-pick.ts';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const key = (over: Partial<PickKey> = {}): PickKey => ({
  serial: null,
  current: false,
  tierRank: 1,
  moduleCount: 2,
  handed: false,
  failures: 0,
  createdAtMs: 1_000,
  ...over,
});

describe('comparePick · 一档一档比', () => {
  it.each([
    ['序号小的先', key({ serial: 1 }), key({ serial: 2 })],
    ['有序号的先于没排进去的', key({ serial: 9 }), key({ serial: null, current: true })],
    ['序号比当前版本重', key({ serial: 3 }), key({ serial: null, current: true, tierRank: 0 })],
    ['当前版本先', key({ current: true }), key({ current: false, tierRank: 0 })],
    ['规模档小的先', key({ tierRank: 0 }), key({ tierRank: 1 })],
    ['同档里列的路径少的先', key({ moduleCount: 1 }), key({ moduleCount: 5 })],
    ['同规模贴了交给引擎的先', key({ handed: true }), key({ handed: false })],
    ['交给引擎比失败少重', key({ handed: true, failures: 2 }), key({ handed: false, failures: 0 })],
    ['失败少的先', key({ failures: 0 }), key({ failures: 1 })],
    ['失败比开单早重', key({ failures: 0, createdAtMs: 9 }), key({ failures: 1, createdAtMs: 1 })],
    ['开单早的先', key({ createdAtMs: 1 }), key({ createdAtMs: 2 })],
  ])('%s', (_name, a, b) => {
    expect(comparePick(a, b)).toBeLessThan(0);
    expect(comparePick(b, a)).toBeGreaterThan(0);
  });

  it('全一样：相等，sortCandidates 保持原来的先后（结果可复现）', () => {
    expect(comparePick(key(), key())).toBe(0);
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect(sortCandidates(items, () => key()).map((x) => x.n)).toEqual([1, 2, 3]);
  });

  it('sortCandidates 不改原数组', () => {
    const items = [
      { n: 1, k: key({ serial: 2 }) },
      { n: 2, k: key({ serial: 1 }) },
    ];
    expect(sortCandidates(items, (x) => x.k).map((x) => x.n)).toEqual([2, 1]);
    expect(items.map((x) => x.n)).toEqual([1, 2]);
  });
});

describe('readOrderBook · 版本说明里的先后', () => {
  const desc = (nums: number[]) =>
    [
      '一句话目标',
      '<!-- fleet:order -->',
      ...nums.map((n, i) => `${i + 1}. #${n}`),
      '<!-- /fleet:order -->',
    ].join('\n');

  it('读出每个版本的序号（从 1 起）；serialOf 按单挂的版本查', () => {
    const { book, problems } = readOrderBook([{ number: 3, title: 'v1 x', description: desc([22, 21]) }]);
    expect(problems).toEqual([]);
    expect(serialOf(book, { number: 3 }, 22)).toBe(1);
    expect(serialOf(book, { number: 3 }, 21)).toBe(2);
    expect(serialOf(book, { number: 3 }, 99)).toBeNull();
    expect(serialOf(book, { number: 4 }, 22)).toBeNull(); // 另一个版本里的先后不串
    expect(serialOf(book, null, 22)).toBeNull(); // 没挂版本
  });

  it('【故意造出的失败】没有先后标记、序号乱了：这个版本不进表，原因带上版本名，不当成空表', () => {
    const { book, problems } = readOrderBook([
      { number: 3, title: 'v1 x', description: '没有标记' },
      { number: 4, title: 'v2 y', description: '<!-- fleet:order -->\n2. #5\n<!-- /fleet:order -->' },
    ]);
    expect(book.size).toBe(0);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('v1 x');
    expect(problems[1]).toContain('v2 y');
  });
});

describe('hasVisibleSignal · 只判结构', () => {
  it.each([
    ['反引号', ['`pnpm check` 通过']],
    ['路径', ['packages/engine/src 下新增文件']],
    ['文件名', ['intake.ts 里有这一道']],
    ['引号里的界面文字', ['页面上能看到「验收中」']],
    ['数字', ['每小时最多起 3 条']],
  ])('有信号：%s', (_name, lines) => {
    expect(hasVisibleSignal(lines)).toBe(true);
  });

  it('一条信号都没有：false（调用方当拿不准，只记不拦）', () => {
    expect(hasVisibleSignal(['做得好看一点', '体验更顺'])).toBe(false);
  });

  it('多条里有一条有就行', () => {
    expect(hasVisibleSignal(['体验更顺', '`docs/design.md` 第九节改了'])).toBe(true);
  });

  it('没有验收条：false', () => {
    expect(hasVisibleSignal([])).toBe(false);
  });
});

describe('decideBreaker · 失败过半停拉，冷却后一条试探', () => {
  const recent = (failed: number, done: number): BreakerFacts['recent'] => [
    ...Array.from({ length: failed }, () => ({ state: 'failed' as const })),
    ...Array.from({ length: done }, () => ({ state: 'done' as const })),
  ];
  const open = (minutesAgo: number, trial: 'running' | 'done' | 'failed' | null): BreakerFacts => ({
    open: { since: new Date(NOW.getTime() - minutesAgo * 60_000), trial },
    recent: [],
  });

  it(`正常：${BREAKER_FAILS} 条失败进入熔断（停拉）`, () => {
    const v = decideBreaker({ open: null, recent: recent(BREAKER_FAILS, 2) }, NOW);
    expect(v).toMatchObject({ allow: 0, event: 'trip' });
    expect(v.why).toContain('失败了 4 条');
  });

  it('正常：失败没到过半（3/6）不停', () => {
    expect(decideBreaker({ open: null, recent: recent(3, 3) }, NOW)).toMatchObject({
      allow: Number.POSITIVE_INFINITY,
      event: null,
    });
  });

  it('正常：只看最近 6 条，更早的失败不算', () => {
    expect(decideBreaker({ open: null, recent: [...recent(3, 3), ...recent(5, 0)] }, NOW).event).toBeNull();
  });

  it('正常：一条结束的都没有，不停', () => {
    expect(decideBreaker({ open: null, recent: [] }, NOW).allow).toBe(Number.POSITIVE_INFINITY);
  });

  it('熔断着、冷却没到：不放', () => {
    expect(decideBreaker(open(59, null), NOW)).toMatchObject({ allow: 0, event: null });
  });

  it('熔断着、冷却刚到：放 1 条试探', () => {
    expect(decideBreaker(open(BREAKER_COOLDOWN_MS / 60_000, null), NOW)).toMatchObject({
      allow: 1,
      event: null,
    });
  });

  it('试探在跑：不再放', () => {
    expect(decideBreaker(open(120, 'running'), NOW)).toMatchObject({ allow: 0, event: null });
  });

  it('试探成功：恢复，正常拉', () => {
    expect(decideBreaker(open(120, 'done'), NOW)).toMatchObject({
      allow: Number.POSITIVE_INFINITY,
      event: 'recover',
    });
  });

  it('【故意造出的失败】试探失败：不恢复，重新计冷却', () => {
    expect(decideBreaker(open(120, 'failed'), NOW)).toMatchObject({ allow: 0, event: 'retrip' });
  });
});

describe('hourlyRemaining', () => {
  it(`每小时最多 ${MAX_STARTS_PER_HOUR} 条`, () => {
    expect(MAX_STARTS_PER_HOUR).toBe(3);
    expect(hourlyRemaining(0)).toBe(3);
    expect(hourlyRemaining(2)).toBe(1);
    expect(hourlyRemaining(3)).toBe(0);
    expect(hourlyRemaining(7)).toBe(0);
    expect(hourlyRemaining(1, 5)).toBe(4);
  });
});
