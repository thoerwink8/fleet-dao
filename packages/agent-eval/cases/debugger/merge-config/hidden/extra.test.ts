import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/defaults.ts';
import { mergeConfig } from '../src/merge.ts';

test('mergeConfig 不改 base', () => {
  const base = { a: 1, nested: { x: 1, y: { z: 1 } } };
  const snapshot = structuredClone(base);
  mergeConfig(base, { nested: { x: 2, y: { z: 9 } } });
  assert.deepEqual(base, snapshot);
});

test('mergeConfig 的结果不和 base 共用嵌套对象', () => {
  const base = { nested: { x: 1 }, keep: { k: 1 } };
  const out = mergeConfig(base, { nested: { x: 2 } });
  assert.notEqual(out.nested, base.nested);
  out.nested.x = 99;
  assert.equal(base.nested.x, 1);
});

test('数组整个替换', () => {
  assert.deepEqual(mergeConfig({ tags: ['a', 'b'] }, { tags: ['c'] }).tags, ['c']);
});

test('出厂默认值怎么调都不变', () => {
  mergeConfig(DEFAULTS, { limits: { cpu: 64 }, retries: 9 });
  assert.deepEqual(DEFAULTS, { retries: 3, limits: { cpu: 2, memMb: 512 }, tags: ['base'] });
});
