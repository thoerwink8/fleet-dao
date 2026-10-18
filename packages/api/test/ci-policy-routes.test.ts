// 设置页 CI 模式：每个项目读回来默认强制，切换和操作记录同一笔，本来就是这个模式不重记。
import {
  AuditResponse,
  CI_POLICY_SET,
  RepoCiPolicyResponse,
  UpdateRepoCiPolicyResponse,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { attachPolicyBridge } from './ci-policy-helper.ts';
import { harness as baseHarness, errorCode, IDS, viaBearer, write } from './harness.ts';

function harness() {
  const h = baseHarness();
  attachPolicyBridge(h);
  return h;
}

const READ = '/api/repos/ci-policy';
const put = (repoId: string) => `/api/repos/${repoId}/ci-policy`;

async function state(h: ReturnType<typeof harness>, cookie: string) {
  const res = await h.cockpit.request(READ, { headers: { cookie } });
  expect(res.status).toBe(200);
  return RepoCiPolicyResponse.parse(await res.json()).repos;
}

describe('GET /api/repos/ci-policy', () => {
  it('已有的仓都是强制 CI，还没有切换记录', async () => {
    const h = harness();
    const s = await h.login();
    const repos = await state(h, s.cookie);
    expect(repos.length).toBeGreaterThan(0);
    expect(repos.every((r) => r.mode === 'force' && r.recent.length === 0)).toBe(true);
    expect(repos.find((r) => r.repoId === IDS.repo)).toMatchObject({
      owner: 'example',
      name: 'canary',
      mode: 'force',
    });
  });

  it('【故意造出的失败】没登录：401，不泄漏项目', async () => {
    const h = harness();
    const res = await h.cockpit.request(READ);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/repos/:repoId/ci-policy', () => {
  it('改成不强制：读回来是不强制，操作记录写谁、从强制到不强制', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(put(IDS.repo), write('PUT', s, { mode: 'off' }));
    expect(res.status).toBe(200);
    const body = UpdateRepoCiPolicyResponse.parse(await res.json());
    expect(body).toMatchObject({ repoId: IDS.repo, mode: 'off', changed: true });
    expect(body.recent).toEqual([expect.objectContaining({ actor: '创始人甲', from: 'force', to: 'off' })]);
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.ciPolicy).toBe('off');

    const row = (await state(h, s.cookie)).find((r) => r.repoId === IDS.repo);
    expect(row).toMatchObject({ mode: 'off' });
    expect(row?.recent[0]).toMatchObject({ actor: '创始人甲', from: 'force', to: 'off' });

    const audit = AuditResponse.parse(
      await (
        await h.cockpit.request(`/api/audit?target=repo:${IDS.repo}`, { headers: { cookie: s.cookie } })
      ).json(),
    );
    expect(audit.items.map((a) => [a.action, a.actor.kind, a.via])).toEqual([
      [CI_POLICY_SET, 'user', 'cockpit'],
    ]);
    expect(audit.items[0]?.before).toEqual({ ciPolicy: 'force' });
    expect(audit.items[0]?.after).toEqual({ ciPolicy: 'off' });
  });

  it('已经是不强制再改成不强制：changed=false，不多记一条', async () => {
    const h = harness();
    const s = await h.login();
    await h.cockpit.request(put(IDS.repo), write('PUT', s, { mode: 'off' }));
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const again = UpdateRepoCiPolicyResponse.parse(
      await (await h.cockpit.request(put(IDS.repo), write('PUT', s, { mode: 'off' }))).json(),
    );
    expect(again).toMatchObject({ mode: 'off', changed: false });
    expect(again.recent).toHaveLength(1);
    expect(h.store.data.audit.filter((a) => a.target === `repo:${IDS.repo}`).map((a) => a.action)).toEqual([
      CI_POLICY_SET,
    ]);
  });

  it('不强制再改回强制：记录两条，新的在前', async () => {
    const h = harness();
    const s = await h.login();
    await h.cockpit.request(put(IDS.repo), write('PUT', s, { mode: 'off' }));
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const body = UpdateRepoCiPolicyResponse.parse(
      await (await h.cockpit.request(put(IDS.repo), write('PUT', s, { mode: 'force' }))).json(),
    );
    expect(body).toMatchObject({ mode: 'force', changed: true });
    expect(body.recent.map((r) => [r.from, r.to])).toEqual([
      ['off', 'force'],
      ['force', 'off'],
    ]);
    const row = (await state(h, s.cookie)).find((r) => r.repoId === IDS.repo);
    expect(row?.recent.map((r) => r.to)).toEqual(['force', 'off']);
  });

  it('【故意造出的失败】没登录：401，模式一点没动', async () => {
    const h = harness();
    const res = await h.cockpit.request(put(IDS.repo), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'off' }),
    });
    expect(res.status).toBe(401);
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.ciPolicy).toBeUndefined();
  });

  it('【故意造出的失败】项目不存在：404 repo_not_found，不记操作记录', async () => {
    const h = harness();
    const s = await h.login();
    const before = h.store.data.audit.length;
    const res = await h.cockpit.request(put('no-such-repo'), write('PUT', s, { mode: 'off' }));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('repo_not_found');
    expect(h.store.data.audit.length).toBe(before);
  });

  it('【故意造出的失败】请求体不对：400，模式不改', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(put(IDS.repo), write('PUT', s, { mode: 'sometimes' }));
    expect(res.status).toBe(400);
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.ciPolicy).toBeUndefined();
  });

  it('【故意造出的失败】带 Authorization 令牌不能改 CI 模式：401，模式一点没动', async () => {
    const h = harness();
    const res = await h.cockpit.request(put(IDS.repo), viaBearer('PUT', { mode: 'off' }));
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('bearer_not_allowed');
    expect(h.store.data.repos.find((r) => r.id === IDS.repo)?.ciPolicy).toBeUndefined();
  });
});
