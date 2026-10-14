// 需求的状态机和权限（#2049）：每个动作能不能做、为什么不能做；自动归档、搁置天数、30 天硬删的判据。
// 接口层的整条链（真库、登录会话）在 packages/api/test/requests.test.ts。
import { describe, expect, it } from 'vitest';
import {
  autoArchiveDue,
  draftMissing,
  idleDays,
  purgeDue,
  type RequestFacts,
  requestActions,
} from '../src/request-rules.ts';
import { REQUEST_ACTIONS, RequestActionsSchema } from '../src/web-api/requests.ts';

const NOW = new Date('2026-10-13T10:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000).toISOString();

const OWNER = { id: 'owner', decidesRequests: true };
const PARTNER = { id: 'partner', decidesRequests: false };
const ctx = { now: NOW, deciderAvailable: true };

function facts(over: Partial<RequestFacts> = {}): RequestFacts {
  return {
    status: 'discussing',
    initiatorId: PARTNER.id,
    deciderId: null,
    initiatorDecides: false,
    archived: false,
    deletedAt: null,
    everSubmitted: false,
    otherHumanSpoke: false,
    draftMissing: [],
    pinned: false,
    commanderRunning: false,
    ...over,
  };
}

describe('每个动作都有判词', () => {
  it('合 shared 的形状，每个动作都在，不能做的都写了原因', () => {
    const cases = [
      facts(),
      facts({ status: 'pending_decision', deciderId: OWNER.id, everSubmitted: true }),
      facts({ status: 'closed_do', deciderId: OWNER.id }),
      facts({ status: 'closed_drop', archived: true }),
      facts({ deletedAt: day(1) }),
    ];
    for (const f of cases) {
      for (const viewer of [OWNER, PARTNER]) {
        const a = requestActions(f, viewer, ctx);
        expect(RequestActionsSchema.safeParse(a).success).toBe(true);
        expect(Object.keys(a).sort()).toEqual([...REQUEST_ACTIONS].sort());
        for (const [name, v] of Object.entries(a)) {
          if (!v.allowed) expect(v.why, `${f.status} ${viewer.id} ${name}`).toMatch(/\S/);
        }
      }
    }
  });
});

describe('结案锁死', () => {
  it('已结案的不能发消息、改草稿、改名', () => {
    for (const status of ['closed_do', 'closed_drop'] as const) {
      const a = requestActions(facts({ status }), PARTNER, ctx);
      expect(a.send.allowed).toBe(false);
      expect(a.editDraft.allowed).toBe(false);
      expect(a.rename.allowed).toBe(false);
      expect(a.send.why).toContain('接着这条提');
    }
  });

  it('讨论中能发消息、改草稿、改名；待拍板能发消息，草稿锁着', () => {
    const d = requestActions(facts(), PARTNER, ctx);
    expect([d.send.allowed, d.editDraft.allowed, d.rename.allowed]).toEqual([true, true, true]);
    const p = requestActions(facts({ status: 'pending_decision', deciderId: OWNER.id }), PARTNER, ctx);
    expect([p.send.allowed, p.editDraft.allowed, p.rename.allowed]).toEqual([true, false, false]);
  });
});

describe('拍板', () => {
  const pending = facts({ status: 'pending_decision', deciderId: OWNER.id, everSubmitted: true });

  it('只有拍板人能拍；别人（包括发起人）拍被拒', () => {
    const owner = requestActions(pending, OWNER, ctx);
    expect([owner.approve.allowed, owner.reject.allowed, owner.rediscuss.allowed]).toEqual([
      true,
      true,
      true,
    ]);
    const partner = requestActions(pending, PARTNER, ctx);
    expect(partner.approve).toEqual({ allowed: false, why: '只有拍板人能拍板' });
    // 另一个也有拍板资格、但不是这条的拍板人的，同样拍不了
    expect(requestActions(pending, { id: 'third', decidesRequests: true }, ctx).approve.allowed).toBe(false);
  });

  it('合伙人发起的要提交拍板，不能自己确定；创始人发起的直接确定，不用提交', () => {
    const p = requestActions(facts(), PARTNER, ctx);
    expect(p.submit.allowed).toBe(true);
    expect(p.confirm.allowed).toBe(false);
    const o = requestActions(facts({ initiatorId: OWNER.id, initiatorDecides: true }), OWNER, ctx);
    expect(o.confirm.allowed).toBe(true);
    expect(o.submit.allowed).toBe(false);
  });

  it('草稿缺栏不能提交，写明缺哪几栏；没有拍板人也不能提交', () => {
    const missing = requestActions(facts({ draftMissing: ['场景', '怎么算做完'] }), PARTNER, ctx);
    expect(missing.submit).toEqual({ allowed: false, why: '草稿还缺：场景、怎么算做完' });
    const noDecider = requestActions(facts(), PARTNER, { now: NOW, deciderAvailable: false });
    expect(noDecider.submit.allowed).toBe(false);
    expect(noDecider.submit.why).toContain('没有能拍板的人');
  });

  it('不是发起人提交被拒', () => {
    expect(requestActions(facts(), OWNER, ctx).submit.why).toBe('只有发起人能提交拍板');
  });
});

describe('归档', () => {
  it('讨论中、待拍板不能手动归档；已结案能', () => {
    expect(requestActions(facts(), PARTNER, ctx).archive.why).toContain('讨论中的需求不能归档');
    expect(
      requestActions(facts({ status: 'pending_decision', deciderId: OWNER.id }), PARTNER, ctx).archive
        .allowed,
    ).toBe(false);
    expect(requestActions(facts({ status: 'closed_do' }), PARTNER, ctx).archive.allowed).toBe(true);
    const archived = requestActions(facts({ status: 'closed_do', archived: true }), PARTNER, ctx);
    expect([archived.archive.allowed, archived.unarchive.allowed]).toEqual([false, true]);
    // 取消归档后内容仍锁着
    expect(archived.send.allowed).toBe(false);
  });
});

describe('删除', () => {
  it('讨论中、只有发起人说过话、没提交过拍板：发起人能删', () => {
    expect(requestActions(facts(), PARTNER, ctx).delete).toEqual({ allowed: true });
  });

  it('另一个人说过话：不能删', () => {
    const v = requestActions(facts({ otherHumanSpoke: true }), PARTNER, ctx).delete;
    expect(v.allowed).toBe(false);
    expect(v.why).toContain('别人也说过话');
  });

  it('提交过拍板（被再聊聊退回讨论中）：不能删', () => {
    const v = requestActions(facts({ everSubmitted: true }), PARTNER, ctx).delete;
    expect(v.allowed).toBe(false);
    expect(v.why).toContain('提交过拍板');
  });

  it('待拍板、已结案：不能删', () => {
    expect(
      requestActions(facts({ status: 'pending_decision', deciderId: OWNER.id }), PARTNER, ctx).delete.allowed,
    ).toBe(false);
    for (const status of ['closed_do', 'closed_drop'] as const) {
      const v = requestActions(facts({ status }), PARTNER, ctx).delete;
      expect(v.allowed).toBe(false);
      expect(v.why).toContain('只能归档');
    }
  });

  it('不是发起人：不能删', () => {
    expect(requestActions(facts(), OWNER, ctx).delete).toEqual({ allowed: false, why: '只有发起人能删' });
  });

  it('指挥官会话排着队或正在回话（#2061）：本来能删的也先停，原因写「指挥官正在回话，停下后才能删」', () => {
    expect(requestActions(facts({ commanderRunning: true }), PARTNER, ctx).delete).toEqual({
      allowed: false,
      why: '指挥官正在回话，停下后才能删',
    });
    // 停下了就照常能删
    expect(requestActions(facts({ commanderRunning: false }), PARTNER, ctx).delete.allowed).toBe(true);
  });

  it('删了的：别的都不能做，发起人 30 天内能恢复，满 30 天恢复不了', () => {
    const a = requestActions(facts({ deletedAt: day(29) }), PARTNER, ctx);
    expect(a.restore.allowed).toBe(true);
    for (const name of REQUEST_ACTIONS.filter((x) => x !== 'restore')) expect(a[name].allowed).toBe(false);
    expect(requestActions(facts({ deletedAt: day(29) }), OWNER, ctx).restore.allowed).toBe(false);
    expect(requestActions(facts({ deletedAt: day(30) }), PARTNER, ctx).restore.allowed).toBe(false);
  });
});

describe('自动归档、搁置、硬删的判据', () => {
  const closed = { archivedAt: null, deletedAt: null, issueRefs: [] };

  it('已结案·不做马上归档；已结案·做，单子上线或关掉满 3 天才归档', () => {
    expect(autoArchiveDue({ ...closed, status: 'closed_drop' }, NOW)).toBe(true);
    expect(autoArchiveDue({ ...closed, status: 'closed_do' }, NOW)).toBe(false);
    const ref = (state: 'open' | 'merged' | 'deployed' | 'closed', at: string) => ({
      repo: 'o/r',
      number: 12,
      state,
      stateAt: at,
    });
    expect(
      autoArchiveDue({ ...closed, status: 'closed_do', issueRefs: [ref('deployed', day(3))] }, NOW),
    ).toBe(true);
    expect(autoArchiveDue({ ...closed, status: 'closed_do', issueRefs: [ref('closed', day(4))] }, NOW)).toBe(
      true,
    );
    expect(
      autoArchiveDue({ ...closed, status: 'closed_do', issueRefs: [ref('deployed', day(2))] }, NOW),
    ).toBe(false);
    expect(autoArchiveDue({ ...closed, status: 'closed_do', issueRefs: [ref('merged', day(10))] }, NOW)).toBe(
      false,
    );
    // 两张单，一张还开着：不归档
    expect(
      autoArchiveDue(
        { ...closed, status: 'closed_do', issueRefs: [ref('deployed', day(5)), ref('open', day(5))] },
        NOW,
      ),
    ).toBe(false);
    expect(autoArchiveDue({ ...closed, status: 'discussing' }, NOW)).toBe(false);
    expect(autoArchiveDue({ ...closed, status: 'closed_drop', archivedAt: day(1) }, NOW)).toBe(false);
  });

  it('讨论中 14 天没动静给搁置天数，不满 14 天、不在讨论中是 null', () => {
    expect(idleDays({ status: 'discussing', lastActivityAt: day(14), deletedAt: null }, NOW)).toBe(14);
    expect(idleDays({ status: 'discussing', lastActivityAt: day(13), deletedAt: null }, NOW)).toBeNull();
    expect(
      idleDays({ status: 'pending_decision', lastActivityAt: day(20), deletedAt: null }, NOW),
    ).toBeNull();
  });

  it('删了满 30 天才硬删', () => {
    expect(purgeDue(day(30), NOW)).toBe(true);
    expect(purgeDue(day(29), NOW)).toBe(false);
    expect(purgeDue(null, NOW)).toBe(false);
  });

  it('草稿缺的栏', () => {
    expect(draftMissing({ title: '标题' })).toEqual(['场景', '已知的模块', '怎么算做完']);
    expect(draftMissing({ title: '标题', scene: '场景', modules: 'api', done: ['一条'] })).toEqual([]);
    // 类别写了认不出的值算缺：拍板前就拦下，不等开单时才失败
    const full = { title: '标题', scene: '场景', modules: 'api', done: ['一条'] };
    expect(draftMissing({ ...full, kind: '文档' })).toEqual(['类别（只能是需求、缺陷、杂项）']);
    expect(draftMissing({ ...full, kind: '缺陷' })).toEqual([]);
  });
});
