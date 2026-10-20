// 机器通行证入库（#3388）：认人同时认库和旧环境变量（同编号库为准），作废立刻 401，库读失败 503；
// GET /api/nodes/claims 只认机器通行证，返回只有仓、单号、claimedBy、leaseUntil 四个字段。
import { NODE_REPORT_HEADER, parseNodeClaimsResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { CliDeps } from '../src/cli.ts';
import { main, NODE_KEY_NEW, NODE_KEY_REVOKE } from '../src/cli.ts';
import type { LocalClaimsPort } from '../src/local-claims.ts';
import { mergeNodeKeys } from '../src/node-keys.ts';
import { nodeKeyHash } from '../src/node-report.ts';
import { type Harness, harness } from './harness.ts';

const TOKEN_ENV = 'token-from-env-0123456789abcdefghijklmnopq';
const TOKEN_DB = 'token-from-db-0123456789abcdefghijklmnopqr';
const AUDIT = (action: string, target: string) => ({
  actor: { kind: 'ops' as const, id: 'ops:node-key' },
  action,
  target,
  via: 'ops' as const,
  ok: true,
});

const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const get = (h: Harness, headers: Record<string, string> = {}) =>
  h.cockpit.request('/api/nodes/claims', { method: 'GET', headers });
const withToken = (token: string) => ({ [NODE_REPORT_HEADER]: token });
const sessionsPost = (h: Harness, token: string) =>
  h.cockpit.request('/api/nodes/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...withToken(token) },
    body: JSON.stringify({ action: 'renew', repo: 'acme/app', issue: 1 }),
  });

async function addKey(h: Harness, nodeId: string, token: string) {
  await h.store.createNodeKey(
    { nodeId, tokenHash: nodeKeyHash(token), displayName: nodeId },
    AUDIT(NODE_KEY_NEW, `node:${nodeId}`),
  );
}

const claimsPort = (rows: Awaited<ReturnType<LocalClaimsPort['list']>>): LocalClaimsPort => ({
  async apply() {
    return { ok: true, taskId: 't', state: 'running', executor: 'local', leaseUntil: null };
  },
  async list() {
    return rows;
  },
});

describe('认人：库 + 旧环境变量', () => {
  it('发钥匙写库不动环境配置：库里的通行证马上被认，旧环境变量照认', async () => {
    const h = harness({
      config: { nodeKeys: { legacy: nodeKeyHash(TOKEN_ENV) } },
      localClaims: claimsPort([]),
    });
    await addKey(h, 'founder-pc', TOKEN_DB);
    expect(h.config.nodeKeys).toEqual({ legacy: nodeKeyHash(TOKEN_ENV) }); // 配置没动
    expect((await get(h, withToken(TOKEN_DB))).status).toBe(200);
    expect((await get(h, withToken(TOKEN_ENV))).status).toBe(200);
  });

  it('【故意造出的失败】作废后立刻 401（下一个请求就拒），其它的不受影响', async () => {
    const h = harness({ localClaims: claimsPort([]) });
    await addKey(h, 'founder-pc', TOKEN_DB);
    await addKey(h, 'wsl-2', TOKEN_ENV);
    expect((await get(h, withToken(TOKEN_DB))).status).toBe(200);
    expect(await h.store.revokeNodeKey('founder-pc', AUDIT(NODE_KEY_REVOKE, 'node:founder-pc'))).toBe(
      'revoked',
    );
    const res = await get(h, withToken(TOKEN_DB));
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('node_token_invalid');
    expect((await get(h, withToken(TOKEN_ENV))).status).toBe(200);
  });

  it('同编号库为准：库里作废了，环境变量里同编号的旧哈希也不再认；库里换了新的，旧的环境哈希不认', async () => {
    const h = harness({
      config: { nodeKeys: { a: nodeKeyHash(TOKEN_ENV) } },
      localClaims: claimsPort([]),
    });
    await addKey(h, 'a', TOKEN_DB);
    expect((await get(h, withToken(TOKEN_DB))).status).toBe(200);
    expect((await get(h, withToken(TOKEN_ENV))).status).toBe(401); // 库里的盖过环境变量
    await h.store.revokeNodeKey('a', AUDIT(NODE_KEY_REVOKE, 'node:a'));
    expect((await get(h, withToken(TOKEN_DB))).status).toBe(401);
    expect((await get(h, withToken(TOKEN_ENV))).status).toBe(401); // 作废的行遮住旧配置
  });

  it('【故意造出的失败】库读失败：503 node_keys_unreadable，不放行也不回 401（环境变量里有的钥匙也不放）', async () => {
    const h = harness({
      config: { nodeKeys: { legacy: nodeKeyHash(TOKEN_ENV) } },
      localClaims: claimsPort([
        { repo: 'acme/app', issue: 1, claimedBy: 'x', leaseUntil: '2026-10-20T05:00:00.000Z' },
      ]),
    });
    h.store.listNodeKeys = async () => {
      throw new Error('库连不上');
    };
    for (const token of [TOKEN_ENV, 'fake-token-fake-token-fake-token-fake']) {
      const res = await get(h, withToken(token));
      expect(res.status).toBe(503);
      expect(await codeOf(res)).toBe('node_keys_unreadable');
      expect((await sessionsPost(h, token)).status).toBe(503);
    }
  });

  it('库和环境变量都没有：503 node_keys_not_wired（假通行证检查照旧）', async () => {
    const h = harness({ localClaims: claimsPort([]) });
    const res = await get(h, withToken('x'));
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('node_keys_not_wired');
  });

  it('mergeNodeKeys：纯函数，库盖环境，作废抹掉', () => {
    expect(
      mergeNodeKeys({ a: 'h-env-a', b: 'h-env-b' }, [
        { nodeId: 'a', tokenHash: 'h-db-a' },
        { nodeId: 'b', tokenHash: 'h-db-b', revokedAt: 'x' },
        { nodeId: 'c', tokenHash: 'h-db-c' },
      ]),
    ).toEqual({ a: 'h-db-a', c: 'h-db-c' });
  });

  it('端到端：fleet-api node-key new --json 发的明文，接收方马上认；revoke 后马上拒', async () => {
    const h = harness({ localClaims: claimsPort([]) });
    const out: string[] = [];
    const deps: CliDeps = {
      env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
      out: (t) => out.push(t),
      err: () => {},
      now: () => new Date(),
      openStore: async () => ({ store: h.store, close: async () => {} }),
    };
    expect(await main(['node-key', 'new', 'founder-pc', '--json'], deps)).toBe(0);
    const { token } = JSON.parse(out[0] as string) as { token: string };
    expect((await get(h, withToken(token))).status).toBe(200);
    expect(await main(['node-key', 'revoke', 'founder-pc'], deps)).toBe(0);
    expect((await get(h, withToken(token))).status).toBe(401);
  });
});

describe('GET /api/nodes/claims', () => {
  const ROWS = [
    { repo: 'Acme/App', issue: 7, claimedBy: 'founder-pc', leaseUntil: '2026-10-20T05:00:00.000Z' },
    { repo: 'acme/web', issue: 9, claimedBy: 'wsl-2', leaseUntil: '2026-10-20T06:00:00.000Z' },
  ];

  it('机器通行证读到所有未到期的本机租约，每行只有仓、单号、claimedBy、leaseUntil 四个字段（仓名原样）', async () => {
    const h = harness({
      config: { nodeKeys: { 'founder-pc': nodeKeyHash(TOKEN_ENV) } },
      localClaims: claimsPort(
        // 端口多给的字段也不会漏出去
        ROWS.map((r) => ({ ...r, taskId: 't-secret', title: '内部标题' })) as never,
      ),
    });
    const res = await get(h, withToken(TOKEN_ENV));
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ claims: ROWS });
    for (const row of (body as { claims: object[] }).claims) {
      expect(Object.keys(row).sort()).toEqual(['claimedBy', 'issue', 'leaseUntil', 'repo']);
    }
    expect(parseNodeClaimsResponse(body).claims).toHaveLength(2);
  });

  it('【故意造出的失败】没带通行证 401、错通行证 401、浏览器登录态和 Bearer 都不认；都不碰读口', async () => {
    let called = 0;
    const port = claimsPort(ROWS);
    const h = harness({
      config: { nodeKeys: { 'founder-pc': nodeKeyHash(TOKEN_ENV) } },
      localClaims: {
        ...port,
        async list(i) {
          called += 1;
          return port.list(i);
        },
      },
    });
    const none = await get(h);
    expect(none.status).toBe(401);
    expect(await codeOf(none)).toBe('node_token_missing');
    const wrong = await get(h, withToken('fake-token-fake-token-fake-token-fake'));
    expect(wrong.status).toBe(401);
    expect(await codeOf(wrong)).toBe('node_token_invalid');
    const s = await h.login();
    expect((await get(h, { cookie: s.cookie })).status).toBe(401);
    expect((await get(h, { authorization: `Bearer ${TOKEN_ENV}` })).status).toBe(401);
    expect(called).toBe(0);
  });

  it('【故意造出的失败】读租约失败：503 local_claims_unreadable，不拿空列表冒充；没接库也是 503', async () => {
    const h = harness({
      config: { nodeKeys: { 'founder-pc': nodeKeyHash(TOKEN_ENV) } },
      localClaims: {
        ...claimsPort([]),
        async list() {
          throw new Error('库连不上');
        },
      },
    });
    const res = await get(h, withToken(TOKEN_ENV));
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('local_claims_unreadable');
    const bare = harness({ config: { nodeKeys: { 'founder-pc': nodeKeyHash(TOKEN_ENV) } } });
    const r2 = await get(bare, withToken(TOKEN_ENV));
    expect(r2.status).toBe(503);
    expect(await codeOf(r2)).toBe('local_claims_not_wired');
  });
});
