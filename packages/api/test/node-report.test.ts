// 接收方（node-report.ts + node-views.ts）：对公网新开的写口，每条拒绝的路都真发一遍请求，看库里有没有被写进去。
// 故意造出的失败：没带头 401、假通行证 401、A 的钥匙写不了 B、超大载荷 413、坏 schema 400、未来时间 400、
// 登录门后面的接口不认通行证、没配钥匙 503、20 秒内再推 429。
import {
  NODE_REPORT_HEADER,
  NODE_REPORT_MAX_BYTES,
  NODE_REPORT_SCHEMA_VERSION,
  NodeDetailResponseSchema,
  NodesResponseSchema,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { nodeIdForToken, nodeKeyHash } from '../src/node-report.ts';
import { type Harness, harness, T0 } from './harness.ts';
import { sampleSnapshot } from './node-snapshot-fixture.ts';

const TOKEN_A = 'token-of-env-a-0123456789abcdefghijklmn';
const TOKEN_B = 'token-of-env-b-0123456789abcdefghijklmn';
const KEYS = { local: nodeKeyHash(TOKEN_A), other: nodeKeyHash(TOKEN_B) };
const MIN = 60_000;

function report(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: NODE_REPORT_SCHEMA_VERSION,
    reportedAt: T0.toISOString(),
    ...sampleSnapshot(),
    ...over,
  };
}

function setup(keys: Record<string, string> = KEYS) {
  return harness({ config: { nodeKeys: keys } });
}

function post(
  h: Harness,
  body: unknown,
  headers: Record<string, string> = { [NODE_REPORT_HEADER]: TOKEN_A },
) {
  return h.cockpit.request('/api/nodes/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const stored = (h: Harness) => h.store.listNodeReports();
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('认通行证', () => {
  it('对上的收下：node_id 是对上的那把钥匙的编号；环境名取自载荷，只用来显示', async () => {
    const h = setup();
    const res = await post(h, report());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, receivedAt: T0.toISOString() });
    const rows = await stored(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeId: 'local', displayName: '本机', receivedAt: T0.toISOString() });
  });

  it('【故意造出的失败】没带头：401，库里什么都没写', async () => {
    const h = setup();
    const res = await post(h, report(), {});
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('node_token_missing');
    expect(await stored(h)).toEqual([]);
  });

  it('【故意造出的失败】假通行证（含空的、过长的、把哈希当通行证）：401，库里什么都没写，日志不记通行证', async () => {
    const h = setup();
    const fakes = ['fake-token-fake-token-fake-token-fake-token', '', ' ', 'x'.repeat(5000), KEYS.local];
    for (const fake of fakes) {
      const res = await post(h, report(), { [NODE_REPORT_HEADER]: fake });
      expect(res.status, fake.slice(0, 20)).toBe(401);
    }
    expect(await stored(h)).toEqual([]);
    expect(JSON.stringify(h.logs)).not.toContain('fake-token');
  });

  it('【故意造出的失败】A 的钥匙写不了 B：载荷、查询串、别的头里写 B 也一样记在 A 名下，B 一行没动', async () => {
    const h = setup();
    const res = await h.cockpit.request('/api/nodes/report?node=other&nodeId=other', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [NODE_REPORT_HEADER]: TOKEN_A,
        'X-Fleet-Node-Id': 'other',
      },
      body: JSON.stringify({ ...report(), nodeId: 'other', node_id: 'other' }),
    });
    expect(res.status).toBe(200);
    expect((await stored(h)).map((r) => r.nodeId)).toEqual(['local']);
    // B 自己的钥匙才写得了 B
    h.clock.now = new Date(T0.getTime() + MIN);
    expect((await post(h, report(), { [NODE_REPORT_HEADER]: TOKEN_B })).status).toBe(200);
    expect((await stored(h)).map((r) => r.nodeId)).toEqual(['local', 'other']);
  });

  it('只认专用的头：Cookie（登录过的）、Authorization 都不行', async () => {
    const h = setup();
    const s = await h.login();
    const withCookie = await post(h, report(), { cookie: s.cookie, 'x-csrf-token': s.csrf });
    expect(withCookie.status).toBe(401);
    const bearer = await post(h, report(), { authorization: `Bearer ${TOKEN_A}` });
    expect(bearer.status).toBe(401);
    expect(await stored(h)).toEqual([]);
  });

  it('【故意造出的失败】没配 FLEET_NODE_KEYS：503 写明原因（不是 401），什么都不收', async () => {
    const h = setup({});
    const res = await post(h, report());
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('node_keys_not_wired');
    expect(await stored(h)).toEqual([]);
  });

  it('nodeIdForToken：每把都比；空的、过长的认不出', () => {
    expect(nodeIdForToken(KEYS, TOKEN_A)).toBe('local');
    expect(nodeIdForToken(KEYS, TOKEN_B)).toBe('other');
    expect(nodeIdForToken(KEYS, 'nope')).toBeNull();
    expect(nodeIdForToken(KEYS, '')).toBeNull();
    expect(nodeIdForToken(KEYS, 'x'.repeat(257))).toBeNull();
    expect(nodeIdForToken({}, TOKEN_A)).toBeNull();
  });
});

describe('载荷', () => {
  it('【故意造出的失败】超过 256KB：413，库里什么都没写', async () => {
    const h = setup();
    const res = await post(h, report({ padding: 'x'.repeat(NODE_REPORT_MAX_BYTES + 10) }));
    expect(res.status).toBe(413);
    expect(await stored(h)).toEqual([]);
  });

  it('没带通行证的大请求先挨 401（不读请求体）', async () => {
    const h = setup();
    const res = await post(h, report({ padding: 'x'.repeat(NODE_REPORT_MAX_BYTES + 10) }), {});
    expect(res.status).toBe(401);
  });

  it('【故意造出的失败】坏 schema、不认识的版本、不是 JSON：400，库里什么都没写', async () => {
    const h = setup();
    const bad: unknown[] = [
      {},
      report({ home: { nope: true } }),
      report({ schemaVersion: 2 }),
      report({ reportedAt: 'yesterday' }),
      'not json at all',
    ];
    for (const body of bad) {
      // 失败的不占 20 秒的槽位：同一时刻连着发，也都是 400，不是 429
      const res = await post(h, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(await stored(h)).toEqual([]);
  });

  it('【故意造出的失败】reportedAt 比收的钟快 5 分钟以上：400；快 4 分钟收', async () => {
    const h = setup();
    const future = new Date(T0.getTime() + 5 * MIN + 1000).toISOString();
    const res = await post(h, report({ reportedAt: future }));
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('reported_at_in_future');
    expect(await stored(h)).toEqual([]);
    const ok = await post(h, report({ reportedAt: new Date(T0.getTime() + 4 * MIN).toISOString() }));
    expect(ok.status).toBe(200);
  });
});

describe('同一个环境 20 秒内只收一次', () => {
  it('第二次 429 带 Retry-After，库里还是第一份；过了 20 秒再收；别的环境不受影响', async () => {
    const h = setup();
    expect((await post(h, report())).status).toBe(200);
    h.clock.now = new Date(T0.getTime() + 10_000);
    const again = await post(h, report({ reportedAt: h.clock.now.toISOString() }));
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).toBe('10');
    expect((await stored(h))[0]?.reportedAt).toBe(T0.toISOString());
    expect((await post(h, report(), { [NODE_REPORT_HEADER]: TOKEN_B })).status).toBe(200);
    h.clock.now = new Date(T0.getTime() + 20_000);
    expect((await post(h, report({ reportedAt: h.clock.now.toISOString() }))).status).toBe(200);
  });

  it('没收成的不占槽位：坏的那份回 400 之后，好的马上能收', async () => {
    const h = setup();
    expect((await post(h, { nope: 1 })).status).toBe(400);
    expect((await post(h, report())).status).toBe(200);
  });

  it('并发的两份只放一份', async () => {
    const h = setup();
    const [a, b] = await Promise.all([post(h, report()), post(h, report())]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
  });
});

describe('登录门后面的读口', () => {
  it('【故意造出的失败】专用通行证不能读：GET /api/nodes、/api/nodes/:id 带它也是 401', async () => {
    const h = setup();
    await post(h, report());
    for (const path of ['/api/nodes', '/api/nodes/local']) {
      const withHeader = await h.cockpit.request(path, { headers: { [NODE_REPORT_HEADER]: TOKEN_A } });
      expect(withHeader.status, path).toBe(401);
      const asBearer = await h.cockpit.request(path, { headers: { authorization: `Bearer ${TOKEN_A}` } });
      expect(asBearer.status, path).toBe(401);
    }
  });

  it('登录后：本台加每个远程环境；配了钥匙没推过的是 never；超过 3 分钟没收到是 stale', async () => {
    const h = setup();
    const s = await h.login();
    await post(h, report());
    const read = async () => {
      const res = await h.cockpit.request('/api/nodes', { headers: { cookie: s.cookie } });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        self: { name: string | null; engine: { state: string } };
        nodes: Record<string, unknown>[];
      };
    };
    const first = await read();
    expect(NodesResponseSchema.safeParse(first).success).toBe(true);
    expect(first.self.name).toBe('测试机');
    expect(first.nodes).toEqual([
      expect.objectContaining({
        id: 'local',
        name: '本机',
        freshness: 'fresh',
        receivedAt: T0.toISOString(),
      }),
      { id: 'other', name: 'other', freshness: 'never' },
    ]);
    h.clock.now = new Date(T0.getTime() + 4 * MIN);
    const later = await read();
    expect(later.nodes.map((n) => [n.id, n.freshness])).toEqual([
      ['local', 'stale'],
      ['other', 'never'],
    ]);
  });

  it('GET /api/nodes/:id：给存着的快照加新鲜度；没推过的 404 写明白；没这个环境 404', async () => {
    const h = setup();
    const s = await h.login();
    await post(h, report({ codeSha: 'a0006685f092154f90b462cc74e8872d32e5' }));
    const ok = await h.cockpit.request('/api/nodes/local', { headers: { cookie: s.cookie } });
    expect(ok.status).toBe(200);
    const body: unknown = await ok.json();
    expect(NodeDetailResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      id: 'local',
      name: '本机',
      freshness: 'fresh',
      codeSha: 'a0006685f092154f90b462cc74e8872d32e5',
      home: { health: { engine: { state: 'on' } } },
      env: { name: { name: '本机' } },
    });
    const never = await h.cockpit.request('/api/nodes/other', { headers: { cookie: s.cookie } });
    expect(never.status).toBe(404);
    expect(await codeOf(never)).toBe('node_never_reported');
    for (const id of ['ghost', 'Bad_Id']) {
      const res = await h.cockpit.request(`/api/nodes/${id}`, { headers: { cookie: s.cookie } });
      expect(res.status, id).toBe(404);
      expect(await codeOf(res), id).toBe('node_not_found');
    }
  });

  it('没登录读不了', async () => {
    const h = setup();
    expect((await h.cockpit.request('/api/nodes')).status).toBe(401);
  });
});
