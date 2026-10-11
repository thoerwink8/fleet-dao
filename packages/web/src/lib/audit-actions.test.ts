// 操作记录事件名的中文对照表（#1821）。
import { GROOM_ACTION, ROUTE_PROBE_ACTION } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import { AUDIT_ACTION_TEXT, describeAction, targetHref } from './audit-actions';

describe('describeAction', () => {
  test('routing.probe.done 翻成中文；表里没有的原样返回并标没翻译', () => {
    // 把 routing.probe.done 删出表，或没收录的也返回 translated: true，这一条会红。
    expect(describeAction('routing.probe.done')).toEqual({ text: '探针探完', translated: true });
    expect(describeAction('routing.probe.start')).toEqual({ text: '探针开始探', translated: true });
    expect(describeAction('zzz.never.heard')).toEqual({ text: 'zzz.never.heard', translated: false });
    // 原型链上的名字不算收录
    expect(describeAction('constructor').translated).toBe(false);
  });

  test('引擎、整理、探针这几组事件名都有对照，译文都是非空的一句话', () => {
    for (const a of [...Object.values(ROUTE_PROBE_ACTION), ...Object.values(GROOM_ACTION)]) {
      expect(AUDIT_ACTION_TEXT[a], a).toBeTruthy();
    }
    for (const [k, v] of Object.entries(AUDIT_ACTION_TEXT)) {
      expect(v.trim(), k).not.toBe('');
      expect(v, k).not.toBe(k);
    }
  });
});

describe('targetHref', () => {
  test('单和路由能点进去，认不出的没有地址', () => {
    expect(targetHref('task:t-12')).toBe('/tasks/t-12');
    expect(targetHref('route:r-ca-opus')).toBe('/routing');
    expect(targetHref('routing:probe')).toBe('/routing');
    expect(targetHref('cockpit')).toBeNull();
    expect(targetHref('jev:q1')).toBeNull();
  });
});
