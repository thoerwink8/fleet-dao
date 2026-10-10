import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TtlCache } from '../src/ttl-cache.ts';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('存取和不存在', () => {
  const c = new TtlCache<string, number>({ max: 2, ttlMs: 1000, now: clock().now });
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('zzz'), undefined);
  assert.equal(c.has('a'), true);
});

test('超过 max 淘汰最久没用的；get 算用过', () => {
  const c = new TtlCache<string, number>({ max: 2, ttlMs: 1000, now: clock().now });
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});

test('过期正好在 ttlMs 那一刻：差 1ms 还在，到点就没了', () => {
  const k = clock();
  const c = new TtlCache<string, number>({ max: 2, ttlMs: 1000, now: k.now });
  c.set('a', 1);
  k.advance(999);
  assert.equal(c.get('a'), 1);
  k.advance(1);
  assert.equal(c.get('a'), undefined);
});

test('get 不续期；覆盖 set 续期并算最近用过', () => {
  const k = clock();
  const c = new TtlCache<string, number>({ max: 2, ttlMs: 1000, now: k.now });
  c.set('a', 1);
  k.advance(600);
  c.get('a');
  k.advance(400);
  assert.equal(c.get('a'), undefined);
  c.set('b', 1);
  k.advance(600);
  c.set('b', 2);
  k.advance(600);
  assert.equal(c.get('b'), 2);
});

test('size 不算已过期的；delete 返回有没有删到', () => {
  const k = clock();
  const c = new TtlCache<string, number>({ max: 5, ttlMs: 100, now: k.now });
  c.set('a', 1);
  c.set('b', 2);
  k.advance(100);
  c.set('c', 3);
  assert.equal(c.size, 1);
  assert.equal(c.delete('c'), true);
  assert.equal(c.delete('c'), false);
});

test('过期的占着位置也不挤掉没过期的', () => {
  const k = clock();
  const c = new TtlCache<string, number>({ max: 2, ttlMs: 100, now: k.now });
  c.set('a', 1);
  k.advance(50);
  c.set('b', 2);
  k.advance(60);
  c.set('c', 3);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
});

test('max 或 ttlMs 不是正整数抛 RangeError', () => {
  assert.throws(() => new TtlCache({ max: 0, ttlMs: 1 }), RangeError);
  assert.throws(() => new TtlCache({ max: 1, ttlMs: 0 }), RangeError);
});
