// shownRecord：同事故回执优先级照旧；本地回执不跨事故代次；服务端明示的异代记录不滤掉。
import { describe, expect, test } from 'vitest';
import { type RepairRecord, shownRecord } from './alert-repair';

const rec = (over: Partial<RepairRecord>): RepairRecord => ({
  incident: 'incident-a',
  actionId: 'task-recover:aaa',
  kind: 'task-recover',
  requestId: '11111111-1111-4111-8111-111111111111',
  state: 'verified',
  text: '核实恢复',
  at: '2026-10-19T00:00:00.000Z',
  by: 'founder',
  ...over,
});

describe('shownRecord', () => {
  test('同事故：没本地用列表；没列表用本地；同一请求以列表为准；更晚的那条优先', () => {
    const listed = rec({ requestId: '11111111-1111-4111-8111-111111111111', state: 'verified' });
    expect(shownRecord(listed, undefined, 'incident-a')).toBe(listed);
    const localOnly = rec({ state: 'accepted', text: '刚受理' });
    expect(shownRecord(undefined, localOnly, 'incident-a')).toBe(localOnly);
    const localSame = rec({
      state: 'accepted',
      at: '2026-10-19T00:00:05.000Z',
      text: '页面上的受理',
    });
    expect(shownRecord(listed, localSame, 'incident-a')).toBe(listed);
    const older = rec({
      requestId: '22222222-2222-4222-8222-222222222222',
      state: 'failed',
      at: '2026-10-18T00:00:00.000Z',
    });
    const newer = rec({
      requestId: '33333333-3333-4333-8333-333333333333',
      state: 'accepted',
      at: '2026-10-19T01:00:00.000Z',
    });
    expect(shownRecord(older, newer, 'incident-a')).toBe(newer);
    expect(shownRecord(newer, older, 'incident-a')).toBe(newer);
  });

  test('新事故没有 last：旧事故的 verified 本地回执不显示', () => {
    const stale = rec({ incident: 'incident-a', state: 'verified', text: '上一代已修复' });
    expect(shownRecord(undefined, stale, 'new-incident')).toBeUndefined();
  });

  test('服务端明示的上一代在途/未知/待核验不滤掉，也不被这一代的本地回执盖住', () => {
    for (const state of ['executing', 'unknown', 'accepted'] as const) {
      const listed = rec({
        incident: 'incident-a',
        state,
        text: '上一代还没结',
        at: '2026-10-18T00:00:00.000Z',
        requestId: '22222222-2222-4222-8222-222222222222',
      });
      expect(shownRecord(listed, undefined, 'new-incident')).toBe(listed);
      const local = rec({
        incident: 'new-incident',
        state: 'verified',
        text: '这一代刚拿到的',
        at: '2026-10-19T03:00:00.000Z',
        requestId: '33333333-3333-4333-8333-333333333333',
      });
      expect(shownRecord(listed, local, 'new-incident')).toBe(listed);
    }
  });
});
