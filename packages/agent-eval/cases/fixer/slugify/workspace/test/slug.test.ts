import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slug.ts';

test('小写、空格变 -', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('连续的标点和空格只留一个 -', () => {
  assert.equal(slugify('Hello,   World!!'), 'hello-world');
});

test('头尾不留 -', () => {
  assert.equal(slugify('  --Hello World--  '), 'hello-world');
});

test('重音符号去掉', () => {
  assert.equal(slugify('Café Münster'), 'cafe-munster');
});

test('什么都不剩返回 untitled', () => {
  assert.equal(slugify('___'), 'untitled');
  assert.equal(slugify(''), 'untitled');
});
