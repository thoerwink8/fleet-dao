// 提需求接口（#2049）：真库（PGlite）+ 真登录会话走一遍。创始人甲是拍板人（users.decides_requests），创始人乙是合伙人。
// 钉住：身份只取登录会话（请求里写别人的编号没用）、状态机、不合法动作 409 + 中文原因、能不能删的每种情况、列表三处和搜索、
// 详情里每个动作的能不能、只能给已导入的项目建、没接上时列表写原因不冒充空。
import { auditLog, requestMessages, requests, sweepRequests, users } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import {
  type RequestDetailResponse,
  RequestDetailResponse as RequestDetailSchema,
  RequestIssueOpeningResponse,
  RequestListResponse,
} from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgRequests } from '../src/request-store-pg.ts';
import { cookieNames, csrfTokenFor, signSessionClaims } from '../src/session.ts';
import { nowSeconds } from '../src/tokens.ts';
import { errorCode, harness, IDS, PUBLIC_ORIGIN, pgHarness, write } from './harness.ts';
import { fakeIssues } from './request-fakes.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

type H = Awaited<ReturnType<typeof pgHarness>>;
type S = { cookie: string; csrf: string };
let current: H | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

const DAY = 24 * 60 * 60_000;

/** 给某个用户发一张会话 Cookie（和 fleet-api session-mint 同一个签法）。 */
function sessionFor(h: H, uid: string): S {
  const iat = nowSeconds(h.clock.now);
  const sid = `sid-${uid.slice(-4)}`;
  const value = signSessionClaims(h.config, { uid, sid, iat, exp: iat + 60 * 24 * 3600, m: 'test', v: 0 });
  return { cookie: `${cookieNames(h.config).session}=${value}`, csrf: csrfTokenFor(h.config, sid) };
}

async function setup() {
  current = await pgHarness(t);
  const h = current;
  // 确定开单、同意做现在会在 GitHub 上开单（#2060）：这里换成假的机器人，开单细节在 request-issue-flow.test.ts
  h.deps.requests = pgRequests(t.db, h.deps.now, { issues: fakeIssues().port, cockpitUrl: PUBLIC_ORIGIN });
  await t.db.update(users).set({ decidesRequests: true }).where(eq(users.id, IDS.founderA));
  return { h, a: sessionFor(h, IDS.founderA), b: sessionFor(h, IDS.founderB) };
}

async function json(res: Response): Promise<RequestDetailResponse> {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return RequestDetailSchema.parse(await res.json());
}

const create = (h: H, s: S, body: Record<string, unknown> = {}) =>
  h.cockpit.request(
    '/api/requests',
    write('POST', s, { repoId: IDS.repo, body: '想要一个导出按钮', ...body }),
  );
const say = (h: H, s: S, seq: number, body: Record<string, unknown>) =>
  h.cockpit.request(`/api/requests/${seq}/messages`, write('POST', s, body));
const act = (h: H, s: S, seq: number, body: Record<string, unknown>) =>
  h.cockpit.request(`/api/requests/${seq}/actions`, write('POST', s, body));
const draft = (h: H, s: S, seq: number, body: Record<string, unknown>) =>
  h.cockpit.request(`/api/requests/${seq}/draft`, write('PUT', s, body));
const get = async (h: H, s: S, seq: number) =>
  json(await h.cockpit.request(`/api/requests/${seq}`, { headers: { cookie: s.cookie } }));
const list = async (h: H, s: S, query = '') => {
  const res = await h.cockpit.request(`/api/requests${query}`, { headers: { cookie: s.cookie } });
  expect(res.status).toBe(200);
  return RequestListResponse.parse(await res.json());
};

async function expect409(res: Response, why: string | RegExp) {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.message).toMatch(why);
}

/** 填齐草稿（场景、模块、怎么算做完），回新版本号。 */
async function fillDraft(h: H, s: S, seq: number, baseVersion: number) {
  const d = await json(
    await draft(h, s, seq, {
      baseVersion,
      patch: { scene: '导出要给财务', modules: 'packages/web', done: ['页面上有导出按钮'] },
    }),
  );
  return d.request.draftVersion;
}

/** 合伙人（乙）提一条，填齐草稿，提交拍板。 */
async function pendingFromPartner(h: H, a: S, b: S) {
  const d = await json(await create(h, b));
  const seq = d.request.seq;
  const v = await fillDraft(h, b, seq, d.request.draftVersion);
  const submitted = await json(await act(h, b, seq, { action: 'submit', draftVersion: v }));
  expect(submitted.request.status).toBe('pending_decision');
  expect(submitted.request.decider?.id).toBe(IDS.founderA);
  void a;
  return { seq, version: v };
}

describe('身份只取登录会话', () => {
  it('建需求、发消息：请求里写别人当发起人、说话人都没用', async () => {
    const { h, a, b } = await setup();
    const d = await json(
      await create(h, b, { initiatorId: IDS.founderA, authorId: IDS.founderA, deciderId: IDS.founderB }),
    );
    expect(d.request.initiator.id).toBe(IDS.founderB);
    expect(d.messages[0]?.author?.id).toBe(IDS.founderB);
    const after = await json(
      await say(h, a, d.request.seq, { body: '我觉得可以', authorId: IDS.founderB, kind: 'commander' }),
    );
    const last = after.messages.at(-1);
    expect(last?.author?.id).toBe(IDS.founderA);
    expect(last?.kind).toBe('human');
    const rows = await t.db.select().from(requestMessages);
    expect(rows.map((m) => m.authorId)).toEqual([IDS.founderB, IDS.founderA]);
  });

  it('提交拍板时拍板人由 users 表定，请求里写的拍板人没用', async () => {
    const { h, b } = await setup();
    const d = await json(await create(h, b));
    const v = await fillDraft(h, b, d.request.seq, d.request.draftVersion);
    const s = await json(
      await act(h, b, d.request.seq, { action: 'submit', draftVersion: v, deciderId: IDS.founderB }),
    );
    expect(s.request.decider?.id).toBe(IDS.founderA);
  });

  it('没登录 401', async () => {
    const { h } = await setup();
    const res = await h.cockpit.request('/api/requests');
    expect(res.status).toBe(401);
  });
});

describe('建需求', () => {
  it('只能给已导入的项目建：没有的项目 404，库里不多一行', async () => {
    const { h, a } = await setup();
    const res = await create(h, a, { repoId: 'a0000000-0000-4000-8000-0000000000ff' });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('repo_not_found');
    expect(await t.db.select().from(requests)).toEqual([]);
  });

  it('建成：讨论中、第一句话是原话、标题取第一句开头、留操作记录', async () => {
    const { h, a } = await setup();
    const res = await create(h, a);
    expect(res.status).toBe(201);
    const d = await json(res);
    expect(d.request).toMatchObject({
      seq: 1,
      status: 'discussing',
      title: '想要一个导出按钮',
      draftVersion: 1,
    });
    expect(d.messages).toHaveLength(1);
    expect(d.request.needsDecision).toBe(false);
    expect((await t.db.select().from(auditLog)).map((x) => x.action)).toContain('request.create');
  });
});

describe('状态机', () => {
  it('合伙人提交 → 创始人同意做 → 已结案；结案后发消息、改草稿都被拒（409 + 中文原因）', async () => {
    const { h, a, b } = await setup();
    const { seq, version } = await pendingFromPartner(h, a, b);
    const done = await json(await act(h, a, seq, { action: 'approve', draftVersion: version }));
    expect(done.request.status).toBe('closed_do');
    expect(done.actions.send.allowed).toBe(false);

    await expect409(await say(h, b, seq, { body: '再加一条' }), /已结案/);
    await expect409(await draft(h, a, seq, { baseVersion: version, patch: { scene: '改' } }), /已结案/);
    await expect409(await act(h, b, seq, { action: 'rename', title: '新名字' }), /已结案/);
  });

  it('不是拍板人拍板被拒：发起人（合伙人）自己点同意 409', async () => {
    const { h, a, b } = await setup();
    const { seq, version } = await pendingFromPartner(h, a, b);
    await expect409(await act(h, b, seq, { action: 'approve', draftVersion: version }), '只有拍板人能拍板');
    expect((await get(h, a, seq)).request.status).toBe('pending_decision');
  });

  it('拍板带的版本不是最新：409，不结案', async () => {
    const { h, a, b } = await setup();
    const { seq, version } = await pendingFromPartner(h, a, b);
    await expect409(await act(h, a, seq, { action: 'approve', draftVersion: version - 1 }), /第 \d+ 版/);
  });

  it('再聊聊回到讨论中；不做（写理由）结案并马上归档', async () => {
    const { h, a, b } = await setup();
    const { seq } = await pendingFromPartner(h, a, b);
    expect((await json(await act(h, a, seq, { action: 'rediscuss', note: '范围太大' }))).request.status).toBe(
      'discussing',
    );
    const again = await get(h, b, seq);
    await json(await act(h, b, seq, { action: 'submit', draftVersion: again.request.draftVersion }));
    const rejected = await json(await act(h, a, seq, { action: 'reject', reason: '先不做' }));
    expect(rejected.request).toMatchObject({ status: 'closed_drop', closeReason: '先不做' });
    expect(rejected.request.archivedAt).toBeDefined();
  });

  it('创始人自己发起的「确定」一步结案；合伙人不能「确定」', async () => {
    const { h, a, b } = await setup();
    const mine = await json(await create(h, a));
    const v = await fillDraft(h, a, mine.request.seq, 1);
    const done = await json(await act(h, a, mine.request.seq, { action: 'confirm', draftVersion: v }));
    expect(done.request).toMatchObject({ status: 'closed_do', decider: { id: IDS.founderA } });

    const theirs = await json(await create(h, b));
    const v2 = await fillDraft(h, b, theirs.request.seq, 1);
    await expect409(
      await act(h, b, theirs.request.seq, { action: 'confirm', draftVersion: v2 }),
      /要创始人拍板/,
    );
  });

  it('草稿每改一次版本加 1，改过的栏标成人改过；版本对不上 409', async () => {
    const { h, a } = await setup();
    const d = await json(await create(h, a));
    const one = await json(await draft(h, a, d.request.seq, { baseVersion: 1, patch: { scene: '场景' } }));
    expect(one.request.draftVersion).toBe(2);
    expect(one.request.humanEdited).toEqual(['scene']);
    const two = await json(await draft(h, a, d.request.seq, { baseVersion: 2, patch: { want: '要什么' } }));
    expect(two.request.draftVersion).toBe(3);
    expect(two.request.humanEdited.sort()).toEqual(['scene', 'want']);
    await expect409(await draft(h, a, d.request.seq, { baseVersion: 2, patch: { want: '旧版' } }), /第 3 版/);
  });

  it('开单查询：没开过 state=none，同意做后这一版是 opened 带单号；不带版本号 400、没这条 404', async () => {
    const { h, a, b } = await setup();
    const { seq, version } = await pendingFromPartner(h, a, b);
    const opening = async (q: string) =>
      h.cockpit.request(`/api/requests/${seq}/issue-opening${q}`, { headers: { cookie: a.cookie } });
    const before = await opening(`?draftVersion=${version}`);
    expect(before.status).toBe(200);
    expect(RequestIssueOpeningResponse.parse(await before.json()).state).toBe('none');

    await json(await act(h, a, seq, { action: 'approve', draftVersion: version }));
    const after = await opening(`?draftVersion=${version}`);
    expect(after.status).toBe(200);
    const body = RequestIssueOpeningResponse.parse(await after.json());
    expect(body.state).toBe('opened');
    expect(body.issue?.number).toBeGreaterThan(0);

    expect((await opening('')).status).toBe(400);
    const missing = await h.cockpit.request(`/api/requests/9999/issue-opening?draftVersion=1`, {
      headers: { cookie: a.cookie },
    });
    expect(missing.status).toBe(404);
  });

  it('讨论中能改名，改的是草稿标题', async () => {
    const { h, a } = await setup();
    const d = await json(await create(h, a));
    const r = await json(await act(h, a, d.request.seq, { action: 'rename', title: '导出财务报表' }));
    expect(r.request.title).toBe('导出财务报表');
    expect(r.request.draft.title).toBe('导出财务报表');
  });
});

describe('归档', () => {
  it('讨论中不能手动归档；已结案能归档、能取消归档，取消后内容仍锁着', async () => {
    const { h, a } = await setup();
    const d = await json(await create(h, a));
    const seq = d.request.seq;
    await expect409(await act(h, a, seq, { action: 'archive' }), /讨论中的需求不能归档/);
    const v = await fillDraft(h, a, seq, 1);
    await json(await act(h, a, seq, { action: 'confirm', draftVersion: v }));
    expect((await json(await act(h, a, seq, { action: 'archive' }))).request.archivedAt).toBeDefined();
    expect((await list(h, a, '?view=archived')).items.map((r) => r.seq)).toEqual([seq]);
    const back = await json(await act(h, a, seq, { action: 'unarchive' }));
    expect(back.request.archivedAt).toBeUndefined();
    expect(back.actions.send.allowed).toBe(false);
  });
});

describe('删除', () => {
  it('讨论中、只有发起人说过话、没提交过拍板：发起人能删，进「最近删除」，能恢复', async () => {
    const { h, b } = await setup();
    const d = await json(await create(h, b));
    const seq = d.request.seq;
    expect(d.actions.delete).toEqual({ allowed: true });
    const gone = await json(await act(h, b, seq, { action: 'delete' }));
    expect(gone.request.deletedAt).toBeDefined();
    expect(gone.request.purgeAt).toBeDefined();
    expect((await list(h, b)).items).toEqual([]);
    const deleted = await list(h, b, '?view=deleted');
    expect(deleted.items.map((r) => r.seq)).toEqual([seq]);
    expect(deleted.counts.deleted).toBe(1);
    const back = await json(await act(h, b, seq, { action: 'restore' }));
    expect(back.request.deletedAt).toBeUndefined();
  });

  it('另一个人说过话：不能删', async () => {
    const { h, a, b } = await setup();
    const d = await json(await create(h, b));
    await json(await say(h, a, d.request.seq, { body: '我补一句' }));
    expect((await get(h, b, d.request.seq)).actions.delete.allowed).toBe(false);
    await expect409(await act(h, b, d.request.seq, { action: 'delete' }), /别人也说过话/);
  });

  it('提交过拍板（被再聊聊退回讨论中）：不能删', async () => {
    const { h, a, b } = await setup();
    const { seq } = await pendingFromPartner(h, a, b);
    await json(await act(h, a, seq, { action: 'rediscuss' }));
    await expect409(await act(h, b, seq, { action: 'delete' }), /提交过拍板/);
  });

  it('已结案：不能删，只能归档', async () => {
    const { h, a } = await setup();
    const d = await json(await create(h, a));
    const v = await fillDraft(h, a, d.request.seq, 1);
    await json(await act(h, a, d.request.seq, { action: 'confirm', draftVersion: v }));
    await expect409(await act(h, a, d.request.seq, { action: 'delete' }), /只能归档/);
  });

  it('不是发起人删：被拒，库里没删', async () => {
    const { h, a, b } = await setup();
    const d = await json(await create(h, b));
    await expect409(await act(h, a, d.request.seq, { action: 'delete' }), '只有发起人能删');
    const [row] = await t.db.select().from(requests);
    expect(row?.deletedAt).toBeNull();
  });
});

describe('列表、搜索、置顶、等我的', () => {
  it('等我的 / 全部 / 我发起的；按标题、原话、单号搜（#12 能搜到）', async () => {
    const { h, a, b } = await setup();
    const { seq: pending } = await pendingFromPartner(h, a, b);
    const mine = (await json(await create(h, a, { body: '报表要能按月筛', title: '月度筛选' }))).request.seq;

    const all = await list(h, a);
    expect(all.items.map((r) => r.seq).sort()).toEqual([pending, mine].sort());
    const todo = await list(h, a, '?filter=todo');
    expect(todo.items.find((r) => r.seq === pending)?.waitingOnMe).toBe('decide');
    expect((await list(h, a, '?filter=mine')).items.map((r) => r.seq)).toEqual([mine]);
    expect(all.counts).toMatchObject({ all: 2, mine: 1 });

    expect((await list(h, a, `?q=${encodeURIComponent('月度')}`)).items.map((r) => r.seq)).toEqual([mine]);
    expect((await list(h, a, `?q=${encodeURIComponent('按月筛')}`)).items.map((r) => r.seq)).toEqual([mine]);
    await t.db
      .update(requests)
      .set({
        issueRefs: [{ repo: 'example/canary', number: 12, state: 'open', stateAt: new Date().toISOString() }],
      })
      .where(eq(requests.seq, pending));
    expect((await list(h, a, `?q=${encodeURIComponent('#12')}`)).items.map((r) => r.seq)).toEqual([pending]);
  });

  it('置顶每人各自：甲置顶的排在甲的最前，乙那边不受影响', async () => {
    const { h, a, b } = await setup();
    const first = (await json(await create(h, a, { body: '第一条' }))).request.seq;
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const second = (await json(await create(h, a, { body: '第二条' }))).request.seq;
    expect((await list(h, a)).items.map((r) => r.seq)).toEqual([second, first]);
    await json(await act(h, a, first, { action: 'pin' }));
    expect((await list(h, a)).items.map((r) => r.seq)).toEqual([first, second]);
    const forB = await list(h, b);
    expect(forB.items.map((r) => r.seq)).toEqual([second, first]);
    expect(forB.items.every((r) => !r.pinned)).toBe(true);
  });

  it('讨论中 14 天没动静：搁置天数', async () => {
    const { h, a } = await setup();
    const seq = (await json(await create(h, a))).request.seq;
    h.clock.now = new Date(h.clock.now.getTime() + 15 * DAY);
    expect((await get(h, a, seq)).request.idleDays).toBe(15);
  });

  it('未读：别人说了算未读，标读到后清零', async () => {
    const { h, a, b } = await setup();
    const d = await json(await create(h, b));
    const after = await json(await say(h, b, d.request.seq, { body: '再补一句' }));
    expect((await list(h, a)).items[0]?.unread).toBe(2);
    expect((await list(h, b)).items[0]?.unread).toBe(0);
    const last = after.messages.at(-1)?.id ?? 0;
    const res = await h.cockpit.request(
      `/api/requests/${d.request.seq}/read`,
      write('POST', a, { messageId: last }),
    );
    expect(res.status).toBe(200);
    expect((await list(h, a)).items[0]?.unread).toBe(0);
  });
});

describe('详情里每个动作的能不能', () => {
  it('合伙人看自己刚提的：能删、能提交（草稿齐了）、不能拍板、不能归档，不能的都写了原因', async () => {
    const { h, a, b } = await setup();
    const d = await json(await create(h, b));
    await fillDraft(h, b, d.request.seq, 1);
    const view = await get(h, b, d.request.seq);
    expect(view.actions.delete.allowed).toBe(true);
    expect(view.actions.submit.allowed).toBe(true);
    expect(view.actions.approve).toEqual({ allowed: false, why: '还没提交拍板' });
    expect(view.actions.archive.allowed).toBe(false);
    expect(view.request.needsDecision).toBe(true);
    // 创始人看这一条：不能删（不是发起人），能放下
    const forA = await get(h, a, d.request.seq);
    expect(forA.actions.delete).toEqual({ allowed: false, why: '只有发起人能删' });
    expect(forA.actions.drop.allowed).toBe(true);
  });
});

describe('讨论中闲置满 3 天收口，收口的能重开', () => {
  it('满 3 天收口并写原因（闲置几天、最后一句是谁说的）；不满 3 天不动；收口后不能发消息', async () => {
    const { h, a, b } = await setup();
    const young = (await json(await create(h, a, { body: '还在聊' }))).request.seq;
    const stale = (await json(await create(h, b, { body: '想要一个导出按钮' }))).request.seq;
    await json(await say(h, a, stale, { body: '我补一句' }));
    const at = h.clock.now.getTime();
    await t.db
      .update(requests)
      .set({ lastActivityAt: new Date(at - 3 * DAY) })
      .where(eq(requests.seq, stale));
    await t.db
      .update(requests)
      .set({ lastActivityAt: new Date(at - 2 * DAY) })
      .where(eq(requests.seq, young));

    const swept = await sweepRequests(t.db, h.clock.now);
    expect(swept.idleClosed).toEqual([stale]);

    const closed = await get(h, a, stale);
    expect(closed.request.status).toBe('idle_closed');
    expect(closed.request.closeReason).toBe('闲置 3 天没动静，自动收口；最后一句是创始人甲说的');
    expect(closed.request.archivedAt).toBeDefined();
    expect(closed.actions.reopen.allowed).toBe(true);
    expect(closed.actions.send.allowed).toBe(false);
    expect((await get(h, a, young)).request.status).toBe('discussing');
    expect((await list(h, a)).items.map((r) => r.seq)).not.toContain(stale);
    expect((await list(h, a, '?view=archived')).items.map((r) => r.seq)).toContain(stale);
    await expect409(await say(h, b, stale, { body: '再补一句' }), /已收口/);
    await expect409(await act(h, a, young, { action: 'reopen' }), /只有收口/);
  });

  it('收口的重开后回到讨论中，能接着发消息', async () => {
    const { h, a, b } = await setup();
    const stale = (await json(await create(h, b, { body: '想要一个导出按钮' }))).request.seq;
    await t.db
      .update(requests)
      .set({ lastActivityAt: new Date(h.clock.now.getTime() - 3 * DAY) })
      .where(eq(requests.seq, stale));
    await sweepRequests(t.db, h.clock.now);

    const back = await json(await act(h, a, stale, { action: 'reopen' }));
    expect(back.request.status).toBe('discussing');
    expect(back.request.closeReason).toBeUndefined();
    expect(back.request.archivedAt).toBeUndefined();
    expect(back.request.closedAt).toBeUndefined();
    expect(back.actions.reopen.allowed).toBe(false);
    expect(back.actions.send.allowed).toBe(true);
    expect(back.messages.at(-1)?.body).toContain('重开了这条需求');
    expect((await list(h, b)).items.map((r) => r.seq)).toContain(stale);
    const said = await json(await say(h, b, stale, { body: '接着聊' }));
    expect(said.request.status).toBe('discussing');
    expect(said.messages.at(-1)?.body).toBe('接着聊');
  });
});

describe('没接上需求表（内存版）', () => {
  it('列表回 200 + 原因，不冒充空；写回 503', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request('/api/requests', { headers: { cookie: s.cookie } });
    expect(res.status).toBe(200);
    expect(RequestListResponse.parse(await res.json()).unavailable).toMatch(/没接上需求表/);
    const w = await h.cockpit.request(
      '/api/requests',
      write('POST', s, { repoId: IDS.repo, body: '一句话' }),
    );
    expect(w.status).toBe(503);
  });
});
