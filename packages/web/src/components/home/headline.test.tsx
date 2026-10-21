// 流水线这一行的说法：在走 / 卡在某一步、谁在修多久 / 还没人接 / 没查成。
import { expect, test } from 'vitest';
import { pipelineOf } from './headline';

const NOW = Date.parse('2026-10-17T03:00:00.000Z');
const TWO_HOURS_AGO = '2026-10-17T01:00:00.000Z';

test('在走', () => {
  expect(pipelineOf({ pipeline: { state: 'moving' }, now: NOW })).toEqual({
    kind: 'moving',
    level: 'success',
    text: '在走',
  });
});

test('卡在某一步，谁在修多久', () => {
  const line = pipelineOf({
    pipeline: { state: 'stuck', step: '合并', who: '法国引擎', since: TWO_HOURS_AGO },
    now: NOW,
  });
  expect(line.text).toBe('卡在合并，法国引擎在修 2 小时');
  expect(line.level).toBe('error');
});

test('卡着但还没人接：不编谁、不编多久', () => {
  expect(
    pipelineOf({ pipeline: { state: 'stuck', step: '合并', who: null, since: null }, now: NOW }).text,
  ).toBe('卡在合并，还没人接');
});

test('有人在修但没记多久：照实写多久没记', () => {
  expect(
    pipelineOf({ pipeline: { state: 'stuck', step: '合并', who: '指挥官会话', since: null }, now: NOW }).text,
  ).toBe('卡在合并，指挥官会话在修，多久没记');
});

test('流水线没给：写没查成，不写成在走', () => {
  const line = pipelineOf({ pipeline: undefined, now: NOW });
  expect(line.text).toBe('没查成');
  expect(line.level).toBe('warning');
});
