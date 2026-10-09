// 操作记录的前后值收成人话差异：只留有变化的字段，名字翻成中文，认不出的原样。
import { describe, expect, test } from 'vitest';
import { auditChangeLines } from './audit';

describe('auditChangeLines', () => {
  test('字段有变化：名字翻成中文，前后值写成文字', () => {
    // 改 routeId 的对照、或把布尔收成 true/false，这一条会红。
    expect(
      auditChangeLines({ routeId: 'r-ca-opus', pinned: false }, { routeId: 'r-ca-sonnet', pinned: true }),
    ).toEqual([
      { key: 'routeId', label: '路由', before: 'r-ca-opus', after: 'r-ca-sonnet' },
      { key: 'pinned', label: '钉住', before: '否', after: '是' },
    ]);
  });

  test('没变化的字段不出现，键的顺序不同也不算改过', () => {
    // 把没变的 pinned 也列出来、或把数组收成 JSON，这一条会红。
    expect(
      auditChangeLines(
        { routeIds: ['r-ca-opus', 'r-rl-kimi'], pinned: false },
        { routeIds: ['r-ca-opus', 'r-cb-opus'], pinned: false },
      ),
    ).toEqual([
      {
        key: 'routeIds',
        label: '路由列表',
        before: 'r-ca-opus、r-rl-kimi',
        after: 'r-ca-opus、r-cb-opus',
      },
    ]);
    expect(auditChangeLines({ routeId: 'r-1', pinned: false }, { pinned: false, routeId: 'r-1' })).toEqual(
      [],
    );
  });

  test('认不出的字段名原样显示，不猜', () => {
    // 给 notAKnownField 编一个中文，这一条会红。
    expect(auditChangeLines({ notAKnownField: 'a' }, { notAKnownField: 'b' })).toEqual([
      { key: 'notAKnownField', label: 'notAKnownField', before: 'a', after: 'b' },
    ]);
    expect(auditChangeLines(null, { start: '23:00' })).toEqual([
      { key: 'start', label: 'start', before: '（无）', after: '23:00' },
    ]);
  });

  test('只有改之后：缺的那边写成（无）；阶段代码翻成已有的阶段名', () => {
    // 漏掉只有一边有的字段，或把 triage 原样丢出来，这一条会红。
    expect(auditChangeLines(undefined, { stage: 'triage', routeId: 'r-ca-sonnet' })).toEqual([
      { key: 'stage', label: '阶段', before: '（无）', after: '分诊' },
      { key: 'routeId', label: '路由', before: '（无）', after: 'r-ca-sonnet' },
    ]);
    expect(auditChangeLines({ stage: 'not-a-stage' }, {})).toEqual([
      { key: 'stage', label: '阶段', before: 'not-a-stage', after: '（无）' },
    ]);
  });

  test('整段不是对象：收成一行「值」；两边一样就没有行', () => {
    // 数字设置（同时跑的会话上限）没有字段名。猜一个字段名，或把没改的也列出来，这一条会红。
    expect(auditChangeLines(6, 8)).toEqual([{ key: '', label: '值', before: '6', after: '8' }]);
    expect(auditChangeLines(6, 6)).toEqual([]);
    expect(auditChangeLines(null, null)).toEqual([]);
  });
});
