// 设置页「让 AI 接活」开关的接口：读每个项目现在开还是关，开、关各记一条操作记录，和命令行 fleet-api dispatch 同一个写入口。
// 故意造出的失败：没登录 401、项目不存在 404、请求体不对 400、飞书网关通行证不能调（403）。
import {
  AUTO_DISPATCH_DISABLE,
  AUTO_DISPATCH_ENABLE,
  AuditResponse,
  RepoDispatchResponse,
  UpdateRepoDispatchResponse,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { errorCode, harness, IDS, viaGateway, write } from './harness.ts';

const READ = '/api/repos/dispatch';
const put = (repoId: string) => `/api/repos/${repoId}/dispatch`;

async function state(h: ReturnType<typeof harness>, cookie: string) {
  const res = await h.cockpit.request(READ, { headers: { cookie } });
  expect(res.status).toBe(200);
  return RepoDispatchResponse.parse(await res.json()).repos;
}

describe('GET /api/repos/dispatch', () => {
  it('每个项目一行，开关原来关着：on=false、没有 since', async () => {
    const h = harness();
    const s = await h.login();
    const repos = await state(h, s.cookie);
    expect(repos.length).toBeGreaterThan(0);
    const row = repos.find((r) => r.repoId === IDS.repo);
    expect(row).toMatchObject({ owner: 'example', name: 'canary', on: false });
    expect(row?.since).toBeUndefined();
  });

  it('【故意造出的失败】没登录：401，不泄漏项目', async () => {
    const h = harness();
    const res = await h.cockpit.request(READ);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/repos/:repoId/dispatch', () => {
  it('开：库里开关打开、读回有 since、记一条开启的操作记录（操作人是登录的人）', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(put(IDS.repo), write('PUT', s, { on: true }));
    expect(res.status).toBe(200);
    const body = UpdateRepoDispatchResponse.parse(await res.json());
    expect(body).toMatchObject({ repoId: IDS.repo, on: true, changed: true });
    expect(body.since).toBeDefined();
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.autoDispatchSince).toBe(body.since);

    const row = (await state(h, s.cookie)).find((r) => r.repoId === IDS.repo);
    expect(row).toMatchObject({ on: true, since: body.since });

    const audit = AuditResponse.parse(
      await (
        await h.cockpit.request(`/api/audit?target=repo:${IDS.repo}`, { headers: { cookie: s.cookie } })
      ).json(),
    );
    expect(audit.items.map((a) => [a.action, a.actor.kind, a.via])).toEqual([
      [AUTO_DISPATCH_ENABLE, 'user', 'cockpit'],
    ]);
    expect(audit.items[0]?.before).toEqual({ autoDispatchSince: null });
    expect(audit.items[0]?.after).toEqual({ autoDispatchSince: body.since });
  });

  it('开着再开：changed=false、时刻不重设、不多记一条', async () => {
    const h = harness();
    const s = await h.login();
    const first = UpdateRepoDispatchResponse.parse(
      await (await h.cockpit.request(put(IDS.repo), write('PUT', s, { on: true }))).json(),
    );
    h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
    const again = UpdateRepoDispatchResponse.parse(
      await (await h.cockpit.request(put(IDS.repo), write('PUT', s, { on: true }))).json(),
    );
    expect(again).toMatchObject({ on: true, changed: false, since: first.since });
    const audits = h.store.data.audit.filter((a) => a.target === `repo:${IDS.repo}`);
    expect(audits.map((a) => a.action)).toEqual([AUTO_DISPATCH_ENABLE]);
  });

  it('关：开关回到关、记一条关闭的操作记录，写了的原因原样进记录', async () => {
    const h = harness();
    const s = await h.login();
    await h.cockpit.request(put(IDS.repo), write('PUT', s, { on: true }));
    const res = await h.cockpit.request(
      put(IDS.repo),
      write('PUT', s, { on: false, reason: '先停一下看 PR' }),
    );
    const body = UpdateRepoDispatchResponse.parse(await res.json());
    expect(body).toMatchObject({ on: false, changed: true });
    expect(body.since).toBeUndefined();
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.autoDispatchSince).toBeUndefined();
    const last = h.store.data.audit.filter((a) => a.target === `repo:${IDS.repo}`).at(-1);
    expect(last).toMatchObject({ action: AUTO_DISPATCH_DISABLE, reason: '先停一下看 PR' });
  });

  it('关着再关：changed=false、不记', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(put(IDS.repo), write('PUT', s, { on: false }));
    expect(UpdateRepoDispatchResponse.parse(await res.json())).toMatchObject({ on: false, changed: false });
    expect(h.store.data.audit.filter((a) => a.target === `repo:${IDS.repo}`)).toEqual([]);
  });

  it('【故意造出的失败】没登录：401，库里一点没动', async () => {
    const h = harness();
    const res = await h.cockpit.request(put(IDS.repo), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true }),
    });
    expect(res.status).toBe(401);
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.autoDispatchSince).toBeUndefined();
  });

  it('【故意造出的失败】项目不存在：404 repo_not_found，不记操作记录', async () => {
    const h = harness();
    const s = await h.login();
    const before = h.store.data.audit.length;
    const res = await h.cockpit.request(put('no-such-repo'), write('PUT', s, { on: true }));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('repo_not_found');
    expect(h.store.data.audit.length).toBe(before);
  });

  it('【故意造出的失败】请求体不对（on 不是布尔）：400，库里一点没动', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(put(IDS.repo), write('PUT', s, { on: 'yes' }));
    expect(res.status).toBe(400);
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.autoDispatchSince).toBeUndefined();
  });

  it('【故意造出的失败】飞书网关通行证不能开关接活：403，库里一点没动', async () => {
    const h = harness();
    const res = await h.cockpit.request(put(IDS.repo), viaGateway('PUT', 'ou_dev_founder_a', { on: true }));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('gateway_route_not_allowed');
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.autoDispatchSince).toBeUndefined();
  });

  it('【故意造出的失败】原因超长（操作记录写不下）：400，开关不改', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(
      put(IDS.repo),
      write('PUT', s, { on: true, reason: 'x'.repeat(501) }),
    );
    expect(res.status).toBe(400);
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.autoDispatchSince).toBeUndefined();
  });
});
