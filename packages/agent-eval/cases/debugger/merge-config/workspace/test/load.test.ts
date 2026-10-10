import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/load.ts';

test('不覆盖就是出厂默认值', () => {
  assert.deepEqual(loadConfig(), { retries: 3, limits: { cpu: 2, memMb: 512 }, tags: ['base'] });
});

test('覆盖一层里的一个键，别的键保留', () => {
  const c = loadConfig({ limits: { cpu: 8 } });
  assert.equal(c.limits.cpu, 8);
  assert.equal(c.limits.memMb, 512);
});

test('上一次的覆盖不会留到下一次', () => {
  loadConfig({ limits: { cpu: 8 } });
  assert.equal(loadConfig().limits.cpu, 2);
});
