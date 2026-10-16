// @vitest-environment happy-dom
// 顶部一句话：在走 / 卡在某一步、谁在修多久 / 有 N 件要你定。
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Headline, headlineOf } from './headline';

afterEach(cleanup);

const NOW = Date.parse('2026-10-17T03:00:00.000Z');
const TWO_HOURS_AGO = '2026-10-17T01:00:00.000Z';

test('在走', () => {
  expect(headlineOf({ decisions: 0, pipeline: { state: 'moving' }, now: NOW }).text).toBe('流水线在走');
  render(<Headline decisions={0} pipeline={{ state: 'moving' }} now={NOW} />);
  expect(document.querySelector('[data-home-headline="moving"]')?.textContent).toBe('流水线在走');
});

test('卡在某一步，谁在修多久', () => {
  const text = headlineOf({
    decisions: 0,
    pipeline: { state: 'stuck', step: '合并', who: '法国引擎', since: TWO_HOURS_AGO },
    now: NOW,
  }).text;
  expect(text).toBe('卡在合并，法国引擎在修 2 小时');
  render(
    <Headline
      decisions={0}
      pipeline={{ state: 'stuck', step: '合并', who: '法国引擎', since: TWO_HOURS_AGO }}
      now={NOW}
    />,
  );
  expect(document.querySelector('[data-home-headline="stuck"]')?.textContent).toBe(
    '卡在合并，法国引擎在修 2 小时',
  );
});

test('有 N 件要你定：比卡住优先', () => {
  const text = headlineOf({
    decisions: 4,
    pipeline: { state: 'stuck', step: '合并', who: '法国引擎', since: TWO_HOURS_AGO },
    now: NOW,
  }).text;
  expect(text).toBe('有 4 件要你定');
  render(
    <Headline
      decisions={4}
      pipeline={{ state: 'stuck', step: '合并', who: '法国引擎', since: TWO_HOURS_AGO }}
      now={NOW}
    />,
  );
  expect(document.querySelector('[data-home-headline="decisions"]')?.textContent).toBe('有 4 件要你定');
});

test('卡着但还没人接：不编谁、不编多久', () => {
  expect(
    headlineOf({
      decisions: 0,
      pipeline: { state: 'stuck', step: '合并', who: null, since: null },
      now: NOW,
    }).text,
  ).toBe('卡在合并，还没人接');
});

test('流水线没给：写没查成，不写成在走', () => {
  expect(headlineOf({ decisions: 0, pipeline: undefined, now: NOW }).text).toBe('流水线没查成');
});
