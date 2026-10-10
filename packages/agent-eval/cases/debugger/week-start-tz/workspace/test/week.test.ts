import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weekStart } from '../src/week.ts';

test('UTC 周三 → 本周一', () => {
  assert.equal(weekStart(new Date('2026-03-04T12:00:00Z'), 'UTC'), '2026-03-02');
});

test('周一当天还是它自己', () => {
  assert.equal(weekStart(new Date('2026-03-02T10:00:00Z'), 'UTC'), '2026-03-02');
});

test('东京：UTC 还是周日深夜，东京已经是周一早上', () => {
  assert.equal(weekStart(new Date('2026-03-01T23:30:00Z'), 'Asia/Tokyo'), '2026-03-02');
});
