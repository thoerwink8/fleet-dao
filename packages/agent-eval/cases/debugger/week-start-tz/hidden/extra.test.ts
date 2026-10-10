import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weekStart } from '../src/week.ts';

test('洛杉矶：夏令时当天，UTC 已是周一、本地还是周日深夜', () => {
  assert.equal(weekStart(new Date('2026-03-09T06:30:00Z'), 'America/Los_Angeles'), '2026-03-02');
});

test('夏令时切换那一周内的周一不受影响', () => {
  assert.equal(weekStart(new Date('2026-03-12T12:00:00Z'), 'America/Los_Angeles'), '2026-03-09');
});

test('檀香山：UTC 已是周一凌晨，本地还是周日', () => {
  assert.equal(weekStart(new Date('2026-03-02T03:00:00Z'), 'Pacific/Honolulu'), '2026-02-23');
});

test('跨年、跨月', () => {
  assert.equal(weekStart(new Date('2026-01-01T00:30:00Z'), 'Pacific/Auckland'), '2025-12-29');
  assert.equal(weekStart(new Date('2026-05-31T22:00:00Z'), 'Europe/Berlin'), '2026-06-01');
});
