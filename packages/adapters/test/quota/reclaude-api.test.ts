// reclaude 开放接口的原样读数（readers/reclaude-api.ts，#194）：带回包头 Date / Age、每个组织一个账号；
// 读不到、认不出一律 ok: false 带原因，不当成「额度没用」或「账号可用」。用假的 fetch，不出网。
import { describe, expect, it } from 'vitest';
import { type ReclaudeApiIo, readReclaudeApi } from '../../src/quota/index.ts';
import { blockNetwork, fixtureJson } from './helpers.ts';

blockNetwork();

const NOW = new Date('2026-10-04T12:00:00.000Z');
const KEY = `rck_${'a'.repeat(24)}`;
const cfg = { keyFile: '~/.reclaude-key' };

type Routes = Record<string, () => Response | Promise<Response>>;

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function io(routes: Routes, over: Partial<ReclaudeApiIo> = {}): ReclaudeApiIo {
  return {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      const path = new URL(String(url)).pathname;
      const route = routes[path];
      if (!route) throw new Error(`假接口没配 ${path}`);
      return route();
    }) as typeof fetch,
    readFile: async () => `${KEY}\n`,
    homeDir: '/home/t',
    now: () => NOW,
    timeoutMs: 5_000,
    ...over,
  };
}

const quotaBody = fixtureJson('reclaude-carpool-quota-2026-09-25.json');
const orgsBody = fixtureJson('reclaude-orgs-2026-09-25.json');

describe('读成', () => {
  it('额度、回包头 Date/Age、账号清单（编号换成占位，不带组织编号）', async () => {
    const r = await readReclaudeApi(
      io({
        '/api/v1/carpool/quota': () => json(quotaBody, { date: 'Sun, 04 Oct 2026 12:00:01 GMT', age: '7' }),
        '/api/v1/orgs': () => json(orgsBody),
      }),
      cfg,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requestedAt).toEqual(NOW);
    expect(r.serverDate).toEqual(new Date('2026-10-04T12:00:01.000Z'));
    expect(r.ageSeconds).toBe(7);
    expect(r.quota).toMatchObject({ limitUsd: 80, status: 'active' });
    expect(r.quota?.usedUsd).toBeCloseTo(9.38, 1);
    expect(r.quota?.resetsAt).toEqual(new Date(1790379000338));
    expect(r.orgs).toMatchObject({ ok: true });
    if (!r.orgs.ok) return;
    expect(r.orgs.accounts.map((a) => [a.id, a.kind, a.hasAssignedAccount])).toEqual([
      ['solo-1', 'solo', true],
      ['carpool-1', 'carpool', true],
    ]);
    expect(JSON.stringify(r)).not.toContain('2222');
    expect(JSON.stringify(r)).not.toContain('3333');
  });

  it('没带 Date / Age 头：给 null（不是 0）', async () => {
    const r = await readReclaudeApi(
      io({ '/api/v1/carpool/quota': () => json(quotaBody), '/api/v1/orgs': () => json(orgsBody) }),
      cfg,
    );
    expect(r.ok && [r.serverDate, r.ageSeconds]).toEqual([null, null]);
  });

  it('enabled: false：额度给 null（上游说没设上限），不当成 0 或满', async () => {
    const r = await readReclaudeApi(
      io({
        '/api/v1/carpool/quota': () => json({ enabled: false }),
        '/api/v1/orgs': () => json(orgsBody),
      }),
      cfg,
    );
    expect(r.ok && r.quota).toBeNull();
  });

  it('账号数量不固定：两个拼车组织、两个独享都列出来，序号各自数', async () => {
    const org = (type: string, assigned: unknown = true) => ({
      id: Math.floor(Math.random() * 1e6),
      type,
      has_assigned_account: assigned,
      subscription_expires_at: 1800231668449,
    });
    const r = await readReclaudeApi(
      io({
        '/api/v1/carpool/quota': () => json(quotaBody),
        '/api/v1/orgs': () =>
          json({
            items: [org('team'), org('team', false), org('personal'), org('personal'), org('enterprise')],
          }),
      }),
      cfg,
    );
    expect(r.ok && r.orgs.ok && r.orgs.accounts.map((a) => `${a.id}:${a.hasAssignedAccount}`)).toEqual([
      'carpool-1:true',
      'carpool-2:false',
      'solo-1:true',
      'solo-2:true',
      'other-1:true',
    ]);
  });

  it('组织的 has_assigned_account 不是布尔：null（读不到状态），不当成 true', async () => {
    const r = await readReclaudeApi(
      io({
        '/api/v1/carpool/quota': () => json(quotaBody),
        '/api/v1/orgs': () => json({ items: [{ type: 'team', has_assigned_account: 'yes' }] }),
      }),
      cfg,
    );
    expect(r.ok && r.orgs.ok && r.orgs.accounts[0]?.hasAssignedAccount).toBeNull();
  });
});

describe('【故意造出失败】读不到、认不出：ok: false，不冒充没事', () => {
  const quotaOk = () => json(quotaBody);
  const orgsOk = () => json(orgsBody);

  it('Key 文件读不到 / 不像 Key：auth', async () => {
    const gone = await readReclaudeApi(
      io({}, { readFile: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })) }),
      cfg,
    );
    expect(gone).toMatchObject({ ok: false, code: 'auth' });
    const bad = await readReclaudeApi(io({}, { readFile: async () => 'hello' }), cfg);
    expect(bad).toMatchObject({ ok: false, code: 'auth' });
  });

  it('401 / 403：auth；429：throttled；503：http', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'throttled'],
      [503, 'http'],
    ] as const) {
      const r = await readReclaudeApi(
        io({ '/api/v1/carpool/quota': () => json({}, {}, status), '/api/v1/orgs': orgsOk }),
        cfg,
      );
      expect(r).toMatchObject({ ok: false, code });
    }
  });

  it('网断、超时：network', async () => {
    const down = await readReclaudeApi(
      io(
        {},
        {
          fetch: (async () => {
            throw new Error('ECONNRESET');
          }) as typeof fetch,
        },
      ),
      cfg,
    );
    expect(down).toMatchObject({ ok: false, code: 'network' });
    const slow = await readReclaudeApi(
      io(
        {},
        {
          timeoutMs: 20,
          fetch: ((_: unknown, init?: RequestInit) =>
            new Promise((_res, rej) => {
              init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
            })) as typeof fetch,
        },
      ),
      cfg,
    );
    expect(slow).toMatchObject({ ok: false, code: 'network' });
    expect(!slow.ok && slow.why).toContain('超时');
  });

  it('回包不是 JSON / 缺 enabled / 金额不是数：bad_response', async () => {
    const notJson = await readReclaudeApi(
      io({ '/api/v1/carpool/quota': () => new Response('<html>', { status: 200 }), '/api/v1/orgs': orgsOk }),
      cfg,
    );
    expect(notJson).toMatchObject({ ok: false, code: 'bad_response' });
    const noEnabled = await readReclaudeApi(
      io({ '/api/v1/carpool/quota': () => json({ quota_usd: '80' }), '/api/v1/orgs': orgsOk }),
      cfg,
    );
    expect(noEnabled).toMatchObject({ ok: false, code: 'bad_response' });
    const nan = await readReclaudeApi(
      io({
        '/api/v1/carpool/quota': () => json({ enabled: true, quota_usd: '80', used_usd: 'n/a' }),
        '/api/v1/orgs': orgsOk,
      }),
      cfg,
    );
    expect(nan).toMatchObject({ ok: false, code: 'bad_response' });
    expect(!nan.ok && nan.why).toContain('金额认不出');
  });

  it('额度读成、组织接口没读成（503 / 认不出）：额度照给，orgs 标没读成并带原因，不当成「没有组织」', async () => {
    const down = await readReclaudeApi(
      io({ '/api/v1/carpool/quota': quotaOk, '/api/v1/orgs': () => json({}, {}, 503) }),
      cfg,
    );
    expect(down.ok && down.orgs).toMatchObject({ ok: false, code: 'http' });
    const weird = await readReclaudeApi(
      io({ '/api/v1/carpool/quota': quotaOk, '/api/v1/orgs': () => json({ items: 'x' }) }),
      cfg,
    );
    expect(weird.ok && weird.orgs).toMatchObject({ ok: false, code: 'bad_response' });
  });

  it('组织接口说 Key 不认（同一把 Key）：整次判 auth', async () => {
    const r = await readReclaudeApi(
      io({ '/api/v1/carpool/quota': quotaOk, '/api/v1/orgs': () => json({}, {}, 401) }),
      cfg,
    );
    expect(r).toMatchObject({ ok: false, code: 'auth' });
  });
});
