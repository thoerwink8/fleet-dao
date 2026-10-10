import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes } from '../src/bytes.ts';

test('GB 边界也换算，但 GB 封顶', () => {
  assert.equal(formatBytes(1024 ** 3 - 1), '1.0 GB');
  assert.equal(formatBytes(2048 * 1024 ** 3), '2048.0 GB');
});

test('不该进位的别进位', () => {
  assert.equal(formatBytes(1024 * 1024 - 1024), '1023.0 KB');
  assert.equal(formatBytes(1048575 - 100), '1023.9 KB');
});
