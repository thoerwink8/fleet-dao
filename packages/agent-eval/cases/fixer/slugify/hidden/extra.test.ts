import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slug.ts';

test('数字保留，下划线算分隔', () => {
  assert.equal(slugify('v2_release  Notes 2026'), 'v2-release-notes-2026');
});

test('整段重音和全是符号', () => {
  assert.equal(slugify('Ünïcödé Åpp'), 'unicode-app');
  assert.equal(slugify('!!!'), 'untitled');
});
