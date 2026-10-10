import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Counter } from '../src/counter.ts';

test('Counter 从 1 开始加', () => {
  const c = new Counter();
  assert.equal(c.next(), 1);
  assert.equal(c.next(), 2);
});
