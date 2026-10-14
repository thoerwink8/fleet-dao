// 本机领单（决定 0096）：POST /api/nodes/claims，本机会话心跳同一个通行证；不成的回 409 / 404 带原因，没接库回 503。
import { NODE_REPORT_HEADER } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { LocalClaimsPort } from '../src/local-claims.ts';
import { nodeKeyHash } from '../src/node-report.ts';
import { harness } from './harness.ts';

const TOKEN = 'token-of-founder-pc-0123456789abcdefghijk';
const KEYS = { 'founder-pc': nodeKeyHash(TOKEN) };

function port(reply: Awaited<ReturnType<LocalClaimsPort['apply']>>) {
  const seen: Parameters<LocalClaimsPort['apply']>[0][] = [];
  const p: LocalClaimsPort = {
    async apply(input) {
      seen.push(input);
      return reply;
    },
  };
  return { p, seen };
}

function post(
  h: ReturnType<typeof harness>,
  body: unknown,
  headers: Record<string, string> = { [NODE_REPORT_HEADER]: TOKEN },
) {
  return h.cockpit.request('/api/nodes/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const CLAIM = { action: 'claim', repo: 'acme/app', issue: 42, title: '加验证码' };

describe('POST /api/nodes/claims', () => {
  it('对上通行证的收下：环境编号取钥匙的，不信载荷；回租约', async () => {
    const { p, seen } = port({
      ok: true,
      taskId: 't1',
      state: 'running',
      executor: 'local',
      leaseUntil: '2026-10-14T14:00:00.000Z',
    });
    const h = harness({ config: { nodeKeys: KEYS }, localClaims: p });
    const res = await post(h, CLAIM);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      executor: 'local',
      leaseUntil: '2026-10-14T14:00:00.000Z',
    });
    expect(seen[0]).toMatchObject({ nodeId: 'founder-pc', request: CLAIM });
  });

  it('【故意造出的失败】引擎在做：409 带原因；仓不归法国管：404', async () => {
    const busy = harness({
      config: { nodeKeys: KEYS },
      localClaims: port({ ok: false, code: 'engine_has_it', why: '法国引擎手上有这张单' }).p,
    });
    const r1 = await post(busy, CLAIM);
    expect(r1.status).toBe(409);
    expect(await codeOf(r1)).toBe('engine_has_it');
    const unknown = harness({
      config: { nodeKeys: KEYS },
      localClaims: port({ ok: false, code: 'unknown_repo', why: '不是法国管的仓' }).p,
    });
    expect((await post(unknown, CLAIM)).status).toBe(404);
  });

  it('【故意造出的失败】没带通行证 401；多带字段 400；没接库 503，都不调登记', async () => {
    const { p, seen } = port({
      ok: true,
      taskId: 't1',
      state: 'running',
      executor: 'local',
      leaseUntil: null,
    });
    const h = harness({ config: { nodeKeys: KEYS }, localClaims: p });
    expect((await post(h, CLAIM, {})).status).toBe(401);
    expect((await post(h, { ...CLAIM, token: 'x' })).status).toBe(400);
    expect(seen).toEqual([]);
    const bare = harness({ config: { nodeKeys: KEYS } });
    const res = await post(bare, CLAIM);
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('local_claims_not_wired');
  });
});
