// 全程模式的开关值（#2823，设置 engine.flowMode）：three / split:<0-100> / full，没设过按 three，认不出按 three 并报出原因。
import { describe, expect, it } from 'vitest';
import {
  FLOW_MODE_SETTING,
  FLOW_SOURCES,
  FlowAssignmentExistsError,
  flowModeLabel,
  parseFlowModeSetting,
  readFlowModeSetting,
  VERIFY_REJECT_CLASSES,
} from '../src/flow-mode.ts';
import { SETTING_SCHEMAS } from '../src/web-api.ts';

describe('parseFlowModeSetting', () => {
  it('三种写法都认', () => {
    expect(parseFlowModeSetting('three')).toEqual({ ok: true, setting: { kind: 'three' } });
    expect(parseFlowModeSetting('full')).toEqual({ ok: true, setting: { kind: 'full' } });
    expect(parseFlowModeSetting('split:50')).toEqual({ ok: true, setting: { kind: 'split', percent: 50 } });
    expect(parseFlowModeSetting('split:0')).toEqual({ ok: true, setting: { kind: 'split', percent: 0 } });
    expect(parseFlowModeSetting('split:100')).toEqual({ ok: true, setting: { kind: 'split', percent: 100 } });
  });

  it('别的写法一律不认，并写明为什么', () => {
    for (const raw of [
      '',
      'Three',
      ' full',
      'split',
      'split:',
      'split:101',
      'split:-1',
      'split:5.5',
      'split:05',
      'split:abc',
      'half',
      'full ',
    ]) {
      const r = parseFlowModeSetting(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.problem, raw).toContain('认不出');
    }
  });
});

describe('readFlowModeSetting（读设置那一行的值）', () => {
  it('没设过：按 three，状态写 never_set，不算认不出', () => {
    for (const raw of [undefined, null]) {
      expect(readFlowModeSetting(raw)).toEqual({ setting: { kind: 'three' }, state: 'never_set' });
    }
  });

  it('设了认得出的值', () => {
    expect(readFlowModeSetting('split:30')).toEqual({
      setting: { kind: 'split', percent: 30 },
      state: 'set',
    });
    expect(readFlowModeSetting('full')).toEqual({ setting: { kind: 'full' }, state: 'set' });
  });

  it('认不出（写错的字符串、不是字符串）：按 three，状态 unrecognized，带原因，不悄悄吞', () => {
    for (const raw of ['half', 'split:200', 5, true, { a: 1 }]) {
      const r = readFlowModeSetting(raw);
      expect(r.setting, String(raw)).toEqual({ kind: 'three' });
      expect(r.state, String(raw)).toBe('unrecognized');
      expect(r.state === 'unrecognized' ? r.problem : '', String(raw)).toContain('认不出');
    }
  });
});

describe('flowModeLabel', () => {
  it('给人看的一句', () => {
    expect(flowModeLabel({ kind: 'three' })).toContain('三步');
    expect(flowModeLabel({ kind: 'full' })).toContain('全程');
    expect(flowModeLabel({ kind: 'split', percent: 40 })).toContain('40%');
  });
});

describe('设置表里的 engine.flowMode', () => {
  it('键名和形状：只收认得出的字符串', () => {
    expect(FLOW_MODE_SETTING).toBe('engine.flowMode');
    const schema = SETTING_SCHEMAS['engine.flowMode'];
    expect(schema.safeParse('three').success).toBe(true);
    expect(schema.safeParse('split:50').success).toBe(true);
    expect(schema.safeParse('full').success).toBe(true);
    expect(schema.safeParse('split:101').success).toBe(false);
    expect(schema.safeParse('half').success).toBe(false);
    expect(schema.safeParse(1).success).toBe(false);
  });
});

describe('取值名单', () => {
  it('来源和冷验收拒绝分类', () => {
    expect([...FLOW_SOURCES]).toEqual(['label', 'hash', 'ineligible']);
    expect([...VERIFY_REJECT_CLASSES]).toEqual([
      'real_defect',
      'verifier_false_reject',
      'incomplete_spec',
      'infra',
    ]);
  });

  it('同一张单写第二次的错有自己的类型', () => {
    const e = new FlowAssignmentExistsError('t1');
    expect(e).toBeInstanceOf(Error);
    expect(e.taskId).toBe('t1');
    expect(e.message).toContain('t1');
  });
});
