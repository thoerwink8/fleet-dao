import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseDuration } from '../src/duration.ts';

test('单个和多个单位', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2d'), 172_800_000);
});

test('单位之间可以有空白', () => {
  assert.equal(parseDuration('1h 30m'), 5_400_000);
  assert.equal(parseDuration('  1d  1s '), 86_401_000);
});

test('ms 是毫秒，不是 m 加 s', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('1m1ms'), 60_001);
  assert.equal(parseDuration('1s500ms'), 1500);
});

test('顺序随意', () => {
  assert.equal(parseDuration('30m1h'), 5_400_000);
});

test('同一个单位出现两次抛 RangeError', () => {
  assert.throws(() => parseDuration('1h1h'), RangeError);
});

test('空串、没单位、认不出的单位、负数、小数都抛 RangeError，消息带 bad duration', () => {
  for (const bad of ['', '   ', '10', 'h', '1x', 'm1', '-1s', '1.5h', '1h-1m']) {
    assert.throws(
      () => parseDuration(bad),
      (e: unknown) => e instanceof RangeError && /bad duration/.test(e.message),
      bad,
    );
  }
});

test('和 formatDuration 互逆', () => {
  for (const ms of [0, 1, 999, 1000, 61_000, 3_661_001, 90_061_001]) {
    assert.equal(parseDuration(formatDuration(ms)), ms);
  }
});
