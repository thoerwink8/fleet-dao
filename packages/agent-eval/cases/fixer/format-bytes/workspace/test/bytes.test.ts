import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes } from '../src/bytes.ts';

test('B 是整数', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('KB 保留一位小数', () => {
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('GB 是最大的单位', () => {
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
});

test('四舍五入进到 1024 要换成下一个单位', () => {
  assert.equal(formatBytes(1024 * 1024 - 1), '1.0 MB');
});

test('负数抛 RangeError', () => {
  assert.throws(() => formatBytes(-1), RangeError);
});
