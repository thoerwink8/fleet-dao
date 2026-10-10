import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const rules = readFileSync(new URL('../rules/pr-rules.md', import.meta.url), 'utf8');

test('规矩写明一个 PR 最多 3 轮', () => {
  assert.ok(rules.includes('一个 PR 最多 3 轮'));
});

test('超过 3 轮按交接处理', () => {
  assert.ok(rules.includes('超过 3 轮没合进去的 PR'));
});

test('交接要写清卡在哪', () => {
  assert.match(rules, /写清卡在哪/);
});

test('同一个测试连续失败的上限没有被误改', () => {
  assert.ok(rules.includes('连续失败不超过 3 次'));
});
