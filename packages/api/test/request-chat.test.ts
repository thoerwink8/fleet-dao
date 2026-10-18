// 提需求的指挥官会话（#2061）：真库（PGlite）+ 真登录会话。会话本身不起（引擎那头在 packages/engine/test/intake-chat.test.ts），
// 这里钉住后端：该不该排一轮（@ 判断）、限额和引擎关着时回「指挥官暂停了：原因」且人话照存、详情给出会话在跑、
// 会话在跑时删除不可用（A 片的删除判定）、换模型只能选「提需求」用途里配了的（Fable 要创始人配进去才出现）并出分隔线、
// 让别家挑错和意见卡、草稿带「要人拍」时确定前先挑错、SSE 推会话状态。
import {
  families,
  models,
  requestChats,
  requestMessages,
  requests,
  routingPurposeModels,
  settings,
  users,
} from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import {
  ENGINE_MASTER_SETTING,
  type IntakeChatLimits,
  type RequestDetailResponse,
  RequestDetailResponse as RequestDetailSchema,
} from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgRequestChat } from '../src/request-chat-pg.ts';
import { pgRequests } from '../src/request-store-pg.ts';
import { cookieNames, csrfTokenFor, signSessionClaims } from '../src/session.ts';
import { nowSeconds } from '../src/tokens.ts';
import { IDS, PUBLIC_ORIGIN, pgHarness, write } from './harness.ts';
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

function sessionFor(h: H, uid: string): S {
  const iat = nowSeconds(h.clock.now);
  const sid = `sid-${uid.slice(-4)}`;
  const value = signSessionClaims(h.config, { uid, sid, iat, exp: iat + 60 * 24 * 3600, m: 'test', v: 0 });
  return { cookie: `${cookieNames(h.config).session}=${value}`, csrf: csrfTokenFor(h.config, sid) };
}

const LIMITS: IntakeChatLimits = { maxActivePerUser: 3, maxTurns: 40, idleMinutes: 30 };

async function setup(opts: { limits?: IntakeChatLimits; engineOn?: boolean; purpose?: string[] } = {}) {
  current = await pgHarness(t);
  const h = current;
  const limits = opts.limits ?? LIMITS;
  // 确定开单会在 GitHub 上开单（B 片 #2060）：换成假的机器人
  h.deps.requests = pgRequests(t.db, h.deps.now, {
    limits,
    issues: fakeIssues().port,
    cockpitUrl: PUBLIC_ORIGIN,
  });
  h.deps.requestChat = pgRequestChat(t.db, h.deps.now, { limits });
  await t.db.update(users).set({ decidesRequests: true }).where(eq(users.id, IDS.founderA));
  await t.db.insert(families).values({ id: 'fam-c', displayName: 'C', vendor: 'v' }).onConflictDoNothing();
  await t.db.insert(families).values({ id: 'fam-g', displayName: 'G', vendor: 'v' }).onConflictDoNothing();
  await t.db
    .insert(models)
    .values([
      { id: 'chat-sonnet', family: 'fam-c', displayName: 'Chat Sonnet' },
      { id: 'chat-gpt', family: 'fam-g', displayName: 'Chat GPT' },
      { id: 'claude-fable-9', family: 'fam-c', displayName: 'Claude Fable 9' },
    ])
    .onConflictDoNothing();
  const purpose = opts.purpose ?? ['chat-sonnet', 'chat-gpt'];
  if (purpose.length > 0) {
    await t.db
      .insert(routingPurposeModels)
      .values(purpose.map((modelId, position) => ({ purpose: 'intake-chat' as const, modelId, position })));
  }
  await t.db
    .insert(settings)
    .values({ key: ENGINE_MASTER_SETTING, value: opts.engineOn ?? true, updatedBy: 'test' })
    .onConflictDoUpdate({ target: settings.key, set: { value: opts.engineOn ?? true } });
  return { h, a: sessionFor(h, IDS.founderA), b: sessionFor(h, IDS.founderB) };
}

async function json(res: Response): Promise<RequestDetailResponse> {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return RequestDetailSchema.parse(await res.json());
}

async function expect409(res: Response, why: string | RegExp) {
  expect(res.status, await res.clone().text()).toBe(409);
  const body = (await res.json()) as { error: { message: string } };
  expect(body.error.message).toMatch(why);
}

const create = (h: H, s: S, body = '想要一个导出按钮') =>
  h.cockpit.request('/api/requests', write('POST', s, { repoId: IDS.repo, body }));
const say = (h: H, s: S, seq: number, body: Record<string, unknown>) =>
  h.cockpit.request(`/api/requests/${seq}/messages`, write('POST', s, body));
const post = (h: H, s: S, path: string, body: unknown = {}) =>
  h.cockpit.request(`/api/requests/${path}`, write('POST', s, body));
const get = async (h: H, s: S, seq: number) =>
  json(await h.cockpit.request(`/api/requests/${seq}`, { headers: { cookie: s.cookie } }));

/** 引擎回完这一轮（不起会话：直接把会话放回 idle，会话活着）。 */
async function engineDone(seq: number, workdir: string | null = '/w/x') {
  const [r] = await t.db.select().from(requests).where(eq(requests.seq, seq));
  if (!r) throw new Error('没有这条');
  await t.db
    .update(requestChats)
    .set({ state: 'idle', job: null, workdir, sessionId: workdir ? 's' : null, turns: 1 })
    .where(eq(requestChats.requestId, r.id));
}

describe('@ 判断：指挥官什么时候接', () => {
  it('建需求的第一句：只有一个人在聊，排上一轮；详情给出会话在跑', async () => {
    const { h, b } = await setup();
    const d = await json(await create(h, b));
    expect(d.commander).toMatchObject({
      state: 'queued',
      running: true,
      job: 'reply',
      turns: 0,
      maxTurns: 40,
    });
  });

  it('两个人都说过话：不 @ 不接（不写暂停）；@指挥官（字段或正文）接；点「让指挥官接着问」也接', async () => {
    const { h, a, b } = await setup();
    const seq = (await json(await create(h, b))).request.seq;
    await engineDone(seq);
    const quiet = await json(await say(h, a, seq, { body: '我补一句' }));
    expect(quiet.commander.state).toBe('idle');
    expect(quiet.messages.filter((m) => m.kind === 'system')).toEqual([]);

    const tagged = await json(await say(h, b, seq, { body: '你怎么看', mentionCommander: true }));
    expect(tagged.commander.state).toBe('queued');
    await engineDone(seq);
    const inText = await json(await say(h, a, seq, { body: '@指挥官 接着问' }));
    expect(inText.commander.state).toBe('queued');
    await engineDone(seq);
    const nudged = await json(await post(h, a, `${seq}/commander/nudge`));
    expect(nudged.commander.state).toBe('queued');
  });
});

describe('限额、引擎关着：回「指挥官暂停了：原因」，人话照存', () => {
  it('同一个人另有 1 条在聊（限额调成 1）：新的一条第一句照存，写暂停消息，详情带原因', async () => {
    const { h, b } = await setup({ limits: { maxActivePerUser: 1, maxTurns: 40, idleMinutes: 30 } });
    const first = (await json(await create(h, b))).request.seq;
    await engineDone(first);
    const d = await json(await create(h, b, '另一件事'));
    expect(d.messages[0]).toMatchObject({ kind: 'human', body: '另一件事' });
    const paused = d.messages.find((m) => m.kind === 'system');
    expect(paused?.body).toMatch(/^指挥官暂停了：你已经有 1 条/);
    expect(paused?.card).toMatchObject({ type: 'paused' });
    expect(d.commander).toMatchObject({ state: 'idle', running: false });
    expect(d.commander.pausedWhy).toMatch(/^指挥官暂停了：/);
  });

  it('每条轮数满了（调成 2 轮）：点「让指挥官接着问」409，原因写上限', async () => {
    const { h, b } = await setup({ limits: { maxActivePerUser: 3, maxTurns: 2, idleMinutes: 30 } });
    const seq = (await json(await create(h, b))).request.seq;
    await engineDone(seq);
    await t.db.update(requestChats).set({ turns: 2 });
    await expect409(await post(h, b, `${seq}/commander/nudge`), /^指挥官暂停了：这条已经聊了 2 轮/);
  });

  it('引擎总开关关着（额度熔断也是关着）：第一句照存，暂停消息写引擎关着', async () => {
    const { h, b } = await setup({ engineOn: false });
    const d = await json(await create(h, b));
    expect(d.messages.map((m) => m.kind)).toEqual(['human', 'system']);
    expect(d.messages[1]?.body).toMatch(
      /^指挥官暂停了：引擎总开关关着（北京时间 \d\d-\d\d \d\d:\d\d 关上的），起不了指挥官/,
    );
    // 暂停是接着自己那句当场回的：列表上不算未读、不挂「等我」
    const res = await h.cockpit.request('/api/requests?view=active&filter=all', {
      headers: { cookie: b.cookie },
    });
    const row = (
      (await res.json()) as { items: { seq: number; unread: number; waiting: unknown }[] }
    ).items.find((r) => r.seq === d.request.seq);
    expect(row?.unread).toBe(0);
    expect(row?.waiting).toBeUndefined();
  });

  it('【故意造出的失败】「提需求」用途一个模型都没配：不排，原因写没配；详情的可选模型写原因不冒充空', async () => {
    const { h, b } = await setup({ purpose: [] });
    const d = await json(await create(h, b));
    expect(d.messages[1]?.body).toContain('intake-chat');
    expect(d.commander.models).toEqual([]);
    expect(d.commander.modelsUnavailable).toContain('没配模型');
  });
});

describe('会话在跑时删不了（接进 A 片的删除判定）', () => {
  it('排着队：删除不可用，原因「指挥官正在回话，停下后才能删」；点停下后能删', async () => {
    const { h, b } = await setup();
    const d = await json(await create(h, b));
    expect(d.actions.delete).toEqual({ allowed: false, why: '指挥官正在回话，停下后才能删' });
    await expect409(
      await post(h, b, `${d.request.seq}/actions`, { action: 'delete' }),
      '指挥官正在回话，停下后才能删',
    );
    const stopped = await json(await post(h, b, `${d.request.seq}/commander/stop`));
    expect(stopped.commander.running).toBe(false);
    expect(stopped.actions.delete.allowed).toBe(true);
  });

  it('正在跑：停下只是叫引擎停（stop_requested_at），引擎停完前照样删不了', async () => {
    const { h, b } = await setup();
    const seq = (await json(await create(h, b))).request.seq;
    await t.db.update(requestChats).set({ state: 'running' });
    const d = await json(await post(h, b, `${seq}/commander/stop`));
    expect(d.commander.running).toBe(true);
    expect(d.actions.delete.allowed).toBe(false);
    const [chat] = await t.db.select().from(requestChats);
    expect(chat?.stopRequestedAt).not.toBeNull();
  });
});

describe('换模型：只能选「提需求」用途里配了的', () => {
  it('Fable 没配进用途：不在可选里，点名换也 409；创始人配进去以后才出现、才能换', async () => {
    const { h, b } = await setup();
    const seq = (await json(await create(h, b))).request.seq;
    await engineDone(seq);
    const before = await get(h, b, seq);
    expect(before.commander.models.map((m) => m.id)).toEqual(['chat-sonnet', 'chat-gpt']);
    expect(before.commander.defaultModel).toEqual({ id: 'chat-sonnet', name: 'Chat Sonnet' });
    expect(before.commander.model).toBeNull();
    const put = (modelId: string | null) =>
      h.cockpit.request(`/api/requests/${seq}/commander/model`, write('PUT', b, { modelId }));
    await expect409(await put('claude-fable-9'), '不在「提需求」用途里');

    await t.db
      .insert(routingPurposeModels)
      .values({ purpose: 'intake-chat', modelId: 'claude-fable-9', position: 2 });
    const after = await get(h, b, seq);
    expect(after.commander.models.map((m) => m.id)).toContain('claude-fable-9');
    const switched = await json(await put('claude-fable-9'));
    expect(switched.commander.model).toEqual({ id: 'claude-fable-9', name: 'Claude Fable 9' });
  });

  it('换模型：出一条分隔线消息，会话清掉（下一句按存档重起）；在跑时不让换', async () => {
    const { h, b } = await setup();
    const seq = (await json(await create(h, b))).request.seq;
    const put = (modelId: string | null) =>
      h.cockpit.request(`/api/requests/${seq}/commander/model`, write('PUT', b, { modelId }));
    await expect409(await put('chat-gpt'), '指挥官正在回话');
    await engineDone(seq);
    const d = await json(await put('chat-gpt'));
    const divider = d.messages.at(-1);
    expect(divider?.card).toEqual({ type: 'model_switch', from: null, to: 'chat-gpt' });
    expect(divider?.body).toContain('Chat GPT');
    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject({ sessionId: null, routeId: null });
  });
});

describe('让别家挑错', () => {
  it('手动点：排一次挑错；意见卡每条能标采用或不用', async () => {
    const { h, b } = await setup();
    const seq = (await json(await create(h, b))).request.seq;
    await engineDone(seq);
    const d = await json(await post(h, b, `${seq}/review`));
    expect(d.commander).toMatchObject({ state: 'queued', job: 'review' });
    // 引擎回来了：一张意见卡
    const [r] = await t.db.select().from(requests).where(eq(requests.seq, seq));
    const [m] = await t.db
      .insert(requestMessages)
      .values({
        requestId: r?.id ?? '',
        kind: 'review',
        body: '别家挑了 2 条',
        card: {
          type: 'review',
          draftVersion: 1,
          model: 'chat-gpt',
          items: [
            { text: '缺回退', verdict: null },
            { text: '验收条看不见', verdict: null },
          ],
        },
        createdAt: new Date(),
      })
      .returning();
    await engineDone(seq);
    const marked = await json(await post(h, b, `${seq}/review/${m?.id}`, { index: 1, verdict: 'adopt' }));
    expect(marked.messages.find((x) => x.id === m?.id)?.card).toMatchObject({
      items: [{ verdict: null }, { verdict: 'adopt' }],
    });
    const bad = await post(h, b, `${seq}/review/${m?.id}`, { index: 5, verdict: 'reject' });
    expect(bad.status).toBe(400);
  });

  it('草稿带「要人拍」：确定前没有这一版的别家意见就排一次挑错、409；有了照常确定', async () => {
    const { h, a } = await setup();
    const d = await json(await create(h, a));
    const seq = d.request.seq;
    await engineDone(seq);
    const filled = await json(
      await h.cockpit.request(
        `/api/requests/${seq}/draft`,
        write('PUT', a, {
          baseVersion: d.request.draftVersion,
          patch: { scene: 's', modules: 'm\n域: api\n性质: process', done: ['看得见'], needsHuman: '碰发布' },
        }),
      ),
    );
    const v = filled.request.draftVersion;
    await expect409(
      await post(h, a, `${seq}/actions`, { action: 'confirm', draftVersion: v }),
      '确定前先让别家挑一遍错',
    );
    expect((await get(h, a, seq)).commander).toMatchObject({ state: 'queued', job: 'review' });
    const [r] = await t.db.select().from(requests).where(eq(requests.seq, seq));
    await t.db.insert(requestMessages).values({
      requestId: r?.id ?? '',
      kind: 'review',
      body: '别家挑了 1 条',
      card: { type: 'review', draftVersion: v, model: 'chat-gpt', items: [{ text: 'x', verdict: null }] },
      createdAt: new Date(),
    });
    await engineDone(seq);
    const ok = await json(await post(h, a, `${seq}/actions`, { action: 'confirm', draftVersion: v }));
    expect(ok.request.status).toBe('closed_do');
  });
});

describe('回话的流（SSE）', () => {
  it('一连上推 commander：状态、「正在读代码……」、写到哪了', async () => {
    const { h, b } = await setup();
    const seq = (await json(await create(h, b))).request.seq;
    await t.db.update(requestChats).set({ state: 'running', phase: 'reading_code', streamText: '我先看看' });
    const res = await h.cockpit.request(`/api/requests/${seq}/commander/stream`, {
      headers: { cookie: b.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();
    const text = new TextDecoder().decode(chunk?.value);
    expect(text).toContain('event: commander');
    expect(text).toContain('正在读代码……');
    expect(text).toContain('我先看看');
  });

  it('【故意造出的失败】没接上指挥官会话的后端：按钮接口 503 写明，不当成排上了', async () => {
    const { h, b } = await setup();
    const seq = (await json(await create(h, b))).request.seq;
    h.deps.requestChat = undefined;
    const res = await post(h, b, `${seq}/commander/nudge`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('没接上指挥官会话');
  });
});
