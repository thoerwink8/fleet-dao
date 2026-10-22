// 提需求页的纯判断（#2062）：菜单出哪几项、删不了写在哪、「接着这条提」缩进、批量操作分成做得了和做不了的、状态怎么写。
import { REQUEST_ACTIONS, type RequestAction, type RequestActions, type RequestRow } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import { menuFor, nestRows, planBulk, previewOf, statusView, waitingLabel } from './request-view';

function actions(allowed: Partial<Record<RequestAction, true | string>>): RequestActions {
  const out = {} as RequestActions;
  for (const a of REQUEST_ACTIONS) {
    const v = allowed[a];
    out[a] = v === true ? { allowed: true } : { allowed: false, why: v ?? `不能${a}` };
  }
  return out;
}

function row(seq: number, extra: Partial<RequestRow> = {}): RequestRow {
  return {
    seq,
    title: `需求 ${seq}`,
    status: 'discussing',
    repo: { id: 'r', slug: 'acme/orbit' },
    initiator: { id: 'me', name: '阿岚' },
    participants: [],
    lastActivityAt: '2026-10-13T10:00:00.000Z',
    pinned: false,
    unread: 0,
    waitingOnMe: null,
    idleDays: null,
    issueRefs: [],
    ...extra,
  };
}

describe('行和对话头部的菜单', () => {
  test('能删：出现「删除」，「放下」上不挂删不了的原因', () => {
    const items = menuFor(actions({ pin: true, drop: true, delete: true, rename: true }));
    expect(items.map((i) => i.action)).toEqual(['pin', 'rename', 'drop', 'delete']);
    expect(items.find((i) => i.action === 'drop')?.title).toBeUndefined();
  });

  test('删不了：菜单里没有「删除」，悬停「放下」写为什么不能删', () => {
    const why = '别人也说过话，不能删：请「放下」（写理由）';
    const items = menuFor(actions({ pin: true, drop: true, delete: why }));
    expect(items.map((i) => i.action)).not.toContain('delete');
    expect(items.find((i) => i.action === 'drop')?.title).toBe(why);
  });

  test('已结案删不了：只有「归档」，悬停写原因', () => {
    const why = '已结案的需求不能删，只能归档：它是做过的事的记录';
    const items = menuFor(actions({ unpin: true, archive: true, delete: why }));
    expect(items.map((i) => i.action)).toEqual(['unpin', 'archive']);
    expect(items.find((i) => i.action === 'archive')?.title).toBe(why);
  });

  test('只出现 actions 里能做的：待拍板、看的人不是发起人也不是拍板人，就只剩置顶', () => {
    const items = menuFor(actions({ pin: true }));
    expect(items.map((i) => i.action)).toEqual(['pin']);
  });

  test('最近删除里只有「恢复」', () => {
    expect(menuFor(actions({ restore: true })).map((i) => i.action)).toEqual(['restore']);
  });
});

describe('「接着这条提」缩进挂在原条下面', () => {
  test('新的一条排到原条后面并标成子行；原条不在这一页的照常排、不缩进', () => {
    const rows = [row(44, { continuesSeq: 31 }), row(46), row(31), row(50, { continuesSeq: 9 })];
    const nested = nestRows(rows);
    expect(nested.map((n) => [n.row.seq, n.child])).toEqual([
      [46, false],
      [31, false],
      [44, true],
      [50, false],
    ]);
  });
});

describe('批量操作', () => {
  test('批量归档：只归档能归档的，讨论中的留在选中里并写原因', () => {
    const plan = planBulk('archive', [
      { seq: 31, actions: actions({ archive: true }) },
      { seq: 46, actions: actions({ archive: '讨论中的需求不能归档：接着聊，或「放下」（写理由）' }) },
    ]);
    expect(plan.doable).toEqual([31]);
    expect(plan.blocked).toEqual([{ seq: 46, why: '讨论中的需求不能归档：接着聊，或「放下」（写理由）' }]);
  });

  test('【故意造出的失败】详情还没读到或读失败：不当成能做，留着并写明', () => {
    const plan = planBulk('delete', [{ seq: 46 }, { seq: 47, error: '连不上驾驶舱后端' }]);
    expect(plan.doable).toEqual([]);
    expect(plan.blocked).toEqual([
      { seq: 46, why: '还在读这条能不能删，稍等再点' },
      { seq: 47, why: '没读到这条能不能删：连不上驾驶舱后端' },
    ]);
  });
});

describe('列表一行的字', () => {
  test('状态：结案·做之后跟着单子走', () => {
    expect(statusView(row(1)).label).toBe('讨论中');
    expect(statusView(row(1, { status: 'pending_decision' })).status).toBe(
      'request:request:pending_decision',
    );
    const shipped = row(1, {
      status: 'closed_do',
      issueRefs: [{ repo: 'a/b', number: 8, state: 'deployed', stateAt: '2026-10-01T00:00:00.000Z' }],
    });
    expect(statusView(shipped)).toMatchObject({
      status: 'request:request:deployed',
      label: '已结案·做 · 已上线',
    });
    expect(statusView(row(1, { status: 'closed_do' })).label).toBe('已结案·做 · 等开单');
    expect(statusView(row(1, { status: 'closed_drop' })).label).toBe('已结案·不做');
  });

  test('预览前面写是谁说的；等我的写在等什么', () => {
    expect(previewOf(row(1, { lastMessage: { kind: 'commander', preview: '你要哪种？', at: 'x' } }))).toBe(
      '指挥官：你要哪种？',
    );
    expect(
      previewOf(row(1, { lastMessage: { kind: 'human', authorName: 'fxc188', preview: '按仓筛', at: 'x' } })),
    ).toBe('fxc188：按仓筛');
    expect(previewOf(row(1))).toBe('');
    expect(waitingLabel('decide')).toBe('等我拍板');
    expect(waitingLabel('unread')).toBe('有新消息');
  });
});
