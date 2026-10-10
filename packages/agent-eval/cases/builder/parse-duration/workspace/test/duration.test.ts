import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration } from '../src/duration.ts';

test('formatDuration：从大到小、为 0 的单位不写', () => {
  assert.equal(formatDuration(5_400_000), '1h30m');
  assert.equal(formatDuration(90_061_001), '1d1h1m1s1ms');
});

test('formatDuration：0 写成 0ms', () => {
  assert.equal(formatDuration(0), '0ms');
});

test('formatDuration：负数抛 RangeError', () => {
  assert.throws(() => formatDuration(-1), RangeError);
});
