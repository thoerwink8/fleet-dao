// 设置页「让指挥官整理」按钮的两个口（母单 #1335 第 3 片，#1338）：POST 叫一次整理、GET 看今日剩余次数和最近结果。
// 点一下只记一条 groom.request 操作记录；拒的情况都明说（引擎总开关关着 409、已有一次在做 409、24 小时用满 429），
// 故意造出的失败：引擎没开 / 没连上、项目不存在、操作记录读不到，都不记成点过。
import {
  ENGINE_MASTER_SETTING,
  GROOM_ACTION,
  GROOM_MAX_PER_DAY,
  GROOM_TARGET,
  GroomNowResponse,
  GroomStatusResponse,
} from '@fleet-dao/shared';
import { IDS } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { PublicHealthError } from '../src/health.ts';
import { errorCode, harness, write } from './harness.ts';

const PATH = `/api/repos/${IDS.repo}/dispatch/groom`;
const engineOn = [{ name: 'engine', check: async () => {} }];
const engine = { kind: 'engine' as const, id: 'engine:groom' };

type H = ReturnType<typeof harness>;

async function masterOn(h: H, on = true) {
  await h.store.putSetting(
    { key: ENGINE_MASTER_SETTING, value: on, expectedVersion: 0, by: engine },
    {
      actor: engine,
      action: on ? 'engine.master.enable' : 'engine.master.disable',
      target: `setting:${ENGINE_MASTER_SETTING}`,
      via: 'engine',
      ok: true,
    },
  );
}
const repoSlug = (h: H) => {
  const r = h.store.data.repos.find((x) => x.id === IDS.repo);
  return `${r?.owner}/${r?.name}`;
};
const engineRows = async (h: H, requestId: string, slug: string, opts: { done?: boolean } = {}) => {
  await h.store.appendAudit({
    actor: engine,
    action: GROOM_ACTION.start,
    target: GROOM_TARGET,
    after: { requestId, repo: slug },
    via: 'engine',
    ok: true,
  });
  if (opts.done) {
    await h.store.appendAudit({
      actor: engine,
      action: GROOM_ACTION.done,
      target: GROOM_TARGET,
      after: {
        requestId,
        repo: slug,
        result: {
          opened: [{ number: 901, title: '新单' }],
          amended: [3],
          groomed: [3],
          suggestedClose: [],
          flagged: [],
          rejected: [],
          model: 'claude-sonnet-5-5',
          summary: '开了一张',
        },
      },
      via: 'engine',
      ok: true,
    });
  }
};

async function post(
  h: H,
  cookie: ReturnType<H['login']> extends Promise<infer S> ? S : never,
  body: unknown = {},
) {
  return h.cockpit.request(PATH, write('POST', cookie, body));
}
async function status(h: H, cookie: string) {
  const res = await h.cockpit.request(PATH, { headers: { cookie } });
  expect(res.status).toBe(200);
  return GroomStatusResponse.parse(await res.json());
}

describe('POST /api/repos/:repoId/dispatch/groom', () => {
  it('点一下：记一条 groom.request（操作人是登录的人、来源 http），读回是「排队」，今天还剩 2 次', async () => {
    const h = harness({ health: engineOn });
    await masterOn(h);
    const s = await h.login();
    const res = await post(h, s, { reason: '待办堆了' });
    expect(res.status).toBe(200);
    const body = GroomNowResponse.parse(await res.json());
    expect(body.request).toMatchObject({ state: 'queued', source: 'http', repo: repoSlug(h) });
    expect(body.remainingAfter).toBe(GROOM_MAX_PER_DAY - 1);

    const rows = h.store.data.audit.filter((a) => a.target === GROOM_TARGET);
    expect(rows.map((a) => [a.action, a.actor.kind, a.via])).toEqual([
      [GROOM_ACTION.request, 'user', 'cockpit'],
    ]);
    expect(rows[0]?.after).toEqual({ requestId: body.request.requestId, repo: repoSlug(h), source: 'http' });
    expect(rows[0]?.reason).toBe('待办堆了');

    const read = await status(h, s.cookie);
    expect(read.busy).toBe(true);
    expect(read.recent[0]).toMatchObject({ requestId: body.request.requestId, state: 'queued' });
    expect(read.quota).toMatchObject({ used: 0, remaining: 3, max: 3 });
  });

  it('引擎接手、整理完：读回 done，带开了哪几张、补了哪几张、用的模型；今日剩余次数少一次', async () => {
    const h = harness({ health: engineOn });
    await masterOn(h);
    const s = await h.login();
    const { request } = GroomNowResponse.parse(await (await post(h, s)).json());
    await engineRows(h, request.requestId, repoSlug(h), { done: true });
    const read = await status(h, s.cookie);
    expect(read.busy).toBe(false);
    expect(read.quota.used).toBe(1);
    expect(read.quota.remaining).toBe(2);
    expect(read.recent[0]).toMatchObject({
      state: 'done',
      result: { opened: [{ number: 901 }], amended: [3], model: 'claude-sonnet-5-5' },
    });
  });

  it('【故意造出的失败】引擎总开关关着：409 engine_off，说明总开关，不记成点过', async () => {
    const h = harness({ health: engineOn });
    await masterOn(h, false);
    const s = await h.login();
    const res = await post(h, s);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('engine_off');
    expect(h.store.data.audit.filter((a) => a.target === GROOM_TARGET)).toEqual([]);
  });

  it('【故意造出的失败】总开关从没设过（默认关）也拒', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    expect((await post(h, s)).status).toBe(409);
  });

  it('【故意造出的失败】已经有一次在排队 / 在做（锁被占）：409 groom_busy', async () => {
    const h = harness({ health: engineOn });
    await masterOn(h);
    const s = await h.login();
    expect((await post(h, s)).status).toBe(200);
    const again = await post(h, s);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('groom_busy');
    expect(h.store.data.audit.filter((a) => a.action === GROOM_ACTION.request)).toHaveLength(1);
  });

  it('【故意造出的失败】24 小时内这个项目已经整理 3 次：第 4 次 429 groom_daily_cap', async () => {
    const h = harness({ health: engineOn });
    await masterOn(h);
    const s = await h.login();
    for (let i = 0; i < GROOM_MAX_PER_DAY; i += 1) {
      const { request } = GroomNowResponse.parse(await (await post(h, s)).json());
      await engineRows(h, request.requestId, repoSlug(h), { done: true });
      h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    }
    const res = await post(h, s);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('groom_daily_cap');
    expect((await status(h, s.cookie)).quota.remaining).toBe(0);
  });

  it('【故意造出的失败】引擎按配置没开：409 engine_off', async () => {
    const h = harness({ config: { engineOff: true } });
    await masterOn(h);
    const s = await h.login();
    const res = await post(h, s);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('engine_off');
  });

  it('【故意造出的失败】引擎没连上：503 engine_down', async () => {
    const h = harness({
      health: [
        {
          name: 'engine',
          check: async () => {
            throw new PublicHealthError('engine_offline', '引擎不在线');
          },
        },
      ],
    });
    await masterOn(h);
    const s = await h.login();
    const res = await post(h, s);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('engine_down');
  });

  it('【故意造出的失败】没有这个项目：404，不记', async () => {
    const h = harness({ health: engineOn });
    await masterOn(h);
    const s = await h.login();
    const res = await h.cockpit.request('/api/repos/nope/dispatch/groom', write('POST', s, {}));
    expect(res.status).toBe(404);
    expect(h.store.data.audit.filter((a) => a.target === GROOM_TARGET)).toEqual([]);
  });

  it('【故意造出的失败】操作记录读不到：503 groom_unreadable，不拿空列表冒充「没点过」', async () => {
    const h = harness({ health: engineOn });
    await masterOn(h);
    const s = await h.login();
    h.store.listAudit = async () => {
      throw new Error('库连不上');
    };
    const res = await post(h, s);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('groom_unreadable');
    const read = await h.cockpit.request(PATH, { headers: { cookie: s.cookie } });
    expect(read.status).toBe(503);
  });
});
