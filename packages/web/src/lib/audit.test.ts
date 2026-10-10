// 操作记录的前后值收成人话差异：只留有变化的字段，名字翻成中文，认不出的原样。
import { describe, expect, test } from 'vitest';
import { actorName, auditChangeLines, targetLabel } from './audit';

describe('targetLabel / actorName', () => {
  test('索引未到先显示单号', () => {
    // 只有单号、标题还没进索引：先 #1739；露 UUID 或空等标题，这一条会红。
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(targetLabel(`task:${id}`, new Map([[id, { issueNumber: 1739 }]]))).toBe('需求 #1739');
    // 索引到了再补标题。
    expect(targetLabel(`task:${id}`, new Map([[id, { issueNumber: 1739, title: '修好登录' }]]))).toBe(
      '需求 #1739 修好登录',
    );
    // 索引完全没有：也不把 UUID 摊在页面上。
    expect(targetLabel(`task:${id}`, new Map())).toBe('需求');
    expect(targetLabel(`task:${id}`, new Map())).not.toContain(id);
  });

  test('操作人代号翻译', () => {
    // engine:hourly-reconcile 仍原样、或乱编一个中文，这一条会红。
    expect(actorName({ kind: 'engine', id: 'engine:hourly-reconcile' })).toBe('引擎·每小时对账');
    // 认不出的原样保留。
    expect(actorName({ kind: 'engine', id: 'engine:not-a-known-job' })).toBe('engine:not-a-known-job');
    // 后端给了名字就用名字，不盖掉。
    expect(actorName({ kind: 'engine', id: 'engine:hourly-reconcile', name: '对账工人' })).toBe('对账工人');
  });

  test('处理了提醒时带上提醒标题', () => {
    // 有标题还写「一条提醒」，或标题索引对不上，这一条会红。
    const notes = new Map([['n-6', 'Grok 额度读数 42 分钟没更新']]);
    expect(targetLabel('notification:n-6', new Map(), notes)).toBe('提醒「Grok 额度读数 42 分钟没更新」');
    expect(targetLabel('notification:n-gone', new Map(), notes)).toBe('一条提醒');
  });
});

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

  test('路由编号换成给出的模型名，查不到或名字是空的就留原编号', () => {
    // 查得到的仍写成 r-ca-sonnet，或把查不到的 r-gone、空名字的 r-blank 改成别的字，这一条会红。
    const names = new Map<string, string>([
      ['r-ca-sonnet', 'Sonnet 5'],
      ['r-ca-opus', 'Opus 5.5'],
      ['r-blank', '  '],
    ]);
    expect(
      auditChangeLines(
        { routeId: 'r-ca-opus', routeIds: ['r-ca-opus', 'r-gone', 'r-blank'] },
        { routeId: 'r-ca-sonnet', routeIds: ['r-ca-sonnet', 'r-gone', 'r-blank'] },
        names,
      ),
    ).toEqual([
      { key: 'routeId', label: '路由', before: 'Opus 5.5', after: 'Sonnet 5' },
      {
        key: 'routeIds',
        label: '路由列表',
        before: 'Opus 5.5、r-gone、r-blank',
        after: 'Sonnet 5、r-gone、r-blank',
      },
    ]);
  });

  test('整段不是对象：收成一行「值」；两边一样就没有行', () => {
    // 数字设置（同时跑的会话上限）没有字段名。猜一个字段名，或把没改的也列出来，这一条会红。
    expect(auditChangeLines(6, 8)).toEqual([{ key: '', label: '值', before: '6', after: '8' }]);
    expect(auditChangeLines(6, 6)).toEqual([]);
    expect(auditChangeLines(null, null)).toEqual([]);
  });
});
