// 驾驶舱口（#3818）：浏览器带旧驾驶舱的登录 Cookie 只读会话。安全条目对应 #3818 设计第四节：
// 网址带令牌、无 Cookie / 签名错 / 过期 / 别的用途、非创始人、版本号对不上、撤销即断、会话令牌不认、非法会话号、无 CORS、字节里无令牌头名。
import { events } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COCKPIT_COOKIE,
  COCKPIT_KEEP_ALIVE_MS,
  type CockpitApi,
  createCockpitApi,
  signSessionCookie,
  TAIL_EVENTS,
} from '../src/cockpit.ts';
import { appendToSession } from '../src/events.ts';
import { issueToken } from '../src/tokens.ts';

const SECRET = 'test-secret-0123456789abcdef-test';
const FOUNDER = '00000000-0000-4000-8000-000000000001';
const PARTNER = '00000000-0000-4000-8000-000000000002';
const OFF = '00000000-0000-4000-8000-000000000003';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  // 旧库的 public.users：这里只建驾驶舱口读的那几列
  await t.pg.exec(`
    create table public.users (
      id uuid primary key, role text not null, active boolean not null default true,
      session_version integer not null default 0
    );
    insert into public.users (id, role, active, session_version) values
      ('${FOUNDER}', 'founder', true, 0),
      ('${PARTNER}', 'collaborator', true, 0),
      ('${OFF}', 'founder', false, 0);
  `);
}, 60_000);
afterAll(() => t.close());

const apis: CockpitApi[] = [];
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close();
  await t.pg.exec(`update public.users set session_version = 0 where id = '${FOUNDER}'`);
  await t.pg.exec(`update public.users set active = true where id = '${FOUNDER}'`);
  await t.pg.exec(
    'truncate fleet2.events, fleet2.projection_checkpoints, fleet2.stream_heads restart identity',
  );
});

async function start(): Promise<{ base: string; api: CockpitApi }> {
  const api = createCockpitApi({ db: t.db, sessionSecret: SECRET, pollMs: 30, heartbeatMs: 10_000 });
  apis.push(api);
  return { base: `http://127.0.0.1:${await api.listen()}`, api };
}

const now = () => Math.floor(Date.now() / 1000);
function cookieFor(
  uid = FOUNDER,
  extra: Partial<{ iat: number; exp: number; v: number; secret: string; purpose: string }> = {},
): string {
  const value = signSessionCookie(
    extra.secret ?? SECRET,
    { uid, sid: 'sid-1', iat: now(), exp: extra.exp ?? now() + 3600, m: 'password', v: extra.v ?? 0 },
    extra.purpose,
  );
  return `${COCKPIT_COOKIE}=${value}`;
}
const auth = (cookie = cookieFor()) => ({ cookie });

describe('固定向量：Cookie 格式和旧驾驶舱 packages/api 一致', () => {
  it('同一把密钥、同一份声明签出同样的字节（向量由旧 signPayload 生成）', () => {
    expect(
      signSessionCookie(SECRET, {
        uid: FOUNDER,
        sid: 'sid-fixed-0001',
        iat: 1_700_000_000,
        exp: 1_700_001_000,
        m: 'password',
        v: 3,
      }),
    ).toBe(
      'eyJ1aWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJzaWQiOiJzaWQtZml4ZWQtMDAwMSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAxMDAwLCJtIjoicGFzc3dvcmQiLCJ2IjozfQ.SYQh9-AG4-IRnvv19uvj3TUD8TLOVeO1acgwfqwrI58',
    );
  });
});

describe('SEC：网址带令牌', () => {
  it('?token= 等名字带 token 的参数一律 400，哪个路径都一样', async () => {
    const { base } = await start();
    for (const q of ['?token=x', '?access_token=x', '?Token=x', '?limit=3&sessionToken=x']) {
      expect((await fetch(`${base}/next/api/sessions${q}`, { headers: auth() })).status).toBe(400);
      expect((await fetch(`${base}/next/api/sessions/s1/events${q}`, { headers: auth() })).status).toBe(400);
      expect((await fetch(`${base}/next/api/sessions${q}`)).status).toBe(400);
    }
  });
});

describe('SEC：Cookie 验证', () => {
  it('没有 Cookie、签名错、过期、拿别的用途签的值冒充、别的密钥签的，都是 401', async () => {
    const { base } = await start();
    const get = (h: Record<string, string>) => fetch(`${base}/next/api/sessions`, { headers: h });
    expect((await get({})).status).toBe(401);
    expect((await get({ cookie: `${COCKPIT_COOKIE}=garbage` })).status).toBe(401);
    expect((await get({ cookie: `${cookieFor()}x` })).status).toBe(401);
    expect((await get(auth(cookieFor(FOUNDER, { exp: now() - 10 })))).status).toBe(401);
    // 飞书登录暂存（OAuth）用同一把密钥、别的 purpose 签的，不能冒充会话
    expect((await get(auth(cookieFor(FOUNDER, { purpose: 'fleet-oauth/v1' })))).status).toBe(401);
    expect((await get(auth(cookieFor(FOUNDER, { secret: 'another-secret-0123456789abcdef' })))).status).toBe(
      401,
    );
    // 不是 uuid 的用户号：不进库，直接 401
    expect((await get(auth(cookieFor('1; drop table users')))).status).toBe(401);
    expect((await get(auth())).status).toBe(200);
  });

  it('用户不在用或不是创始人，403', async () => {
    const { base } = await start();
    const get = (uid: string) => fetch(`${base}/next/api/sessions`, { headers: auth(cookieFor(uid)) });
    expect((await get(PARTNER)).status).toBe(403);
    expect((await get(OFF)).status).toBe(403);
    expect((await get('00000000-0000-4000-8000-0000000000ff')).status).toBe(403);
  });

  it('签发时的版本和 users.session_version 对不上（退出或改过密码），401', async () => {
    const { base } = await start();
    await t.pg.exec(`update public.users set session_version = 1 where id = '${FOUNDER}'`);
    expect(
      (await fetch(`${base}/next/api/sessions`, { headers: auth(cookieFor(FOUNDER, { v: 0 })) })).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/next/api/sessions`, { headers: auth(cookieFor(FOUNDER, { v: 1 })) })).status,
    ).toBe(200);
  });
});

describe('SEC：撤销即断', () => {
  async function openStream(
    base: string,
  ): Promise<{ status: number; closed: Promise<void>; cancel(): void }> {
    const ac = new AbortController();
    const res = await fetch(`${base}/next/api/sessions/rev-1/events`, { headers: auth(), signal: ac.signal });
    let done: () => void = () => {};
    const closed = new Promise<void>((r) => {
      done = r;
    });
    if (res.body) {
      const reader = res.body.getReader();
      void (async () => {
        try {
          for (;;) if ((await reader.read()).done) break;
        } catch {
          // 被取消
        }
        done();
      })();
    } else done();
    return { status: res.status, closed, cancel: () => ac.abort() };
  }
  const within = async (p: Promise<void>, ms: number): Promise<boolean> =>
    Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  it('bump session_version 之后，开着的 SSE 在一个周期内断开', async () => {
    const { base } = await start();
    const s = await openStream(base);
    expect(s.status).toBe(200);
    expect(await within(s.closed, 200)).toBe(false);
    await t.pg.exec(`update public.users set session_version = session_version + 1 where id = '${FOUNDER}'`);
    expect(await within(s.closed, 2000)).toBe(true);
    s.cancel();
  });

  it('从白名单拿掉（active=false）之后，开着的 SSE 在一个周期内断开', async () => {
    const { base } = await start();
    const s = await openStream(base);
    expect(s.status).toBe(200);
    await t.pg.exec(`update public.users set active = false where id = '${FOUNDER}'`);
    expect(await within(s.closed, 2000)).toBe(true);
    s.cancel();
  });
});

describe('SEC：只认登录 Cookie，不认会话令牌', () => {
  it('worker / commander 令牌（请求头或 cookie）打驾驶舱口，401；/mcp 是 404', async () => {
    const { base } = await start();
    for (const role of ['worker', 'commander'] as const) {
      const tok = await issueToken(t.db, 'sec-tok', role);
      for (const path of [
        '/next/api/sessions',
        '/next/api/sessions/sec-tok/history',
        '/next/api/sessions/sec-tok/events',
      ]) {
        // 只带令牌：401
        expect(
          (await fetch(`${base}${path}`, { headers: { 'x-fleet-session-token': tok.token } })).status,
        ).toBe(401);
        expect(
          (await fetch(`${base}${path}`, { headers: { cookie: `fleet_session_token=${tok.token}` } })).status,
        ).toBe(401);
        // 登录 Cookie 对，但同时带了令牌：也 401，这个口不收令牌
        expect(
          (await fetch(`${base}${path}`, { headers: { ...auth(), 'x-fleet-session-token': tok.token } }))
            .status,
        ).toBe(401);
        expect(
          (
            await fetch(`${base}${path}`, {
              headers: { cookie: `${cookieFor()}; fleet_session_token=${tok.token}` },
            })
          ).status,
        ).toBe(401);
      }
      const mcp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'x-fleet-session-token': tok.token, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(mcp.status).toBe(404);
      expect((await fetch(`${base}/mcp`, { method: 'POST', headers: auth(), body: '{}' })).status).toBe(404);
    }
    expect(
      (await fetch(`${base}/next/api/sessions`, { headers: { ...auth(), authorization: 'Bearer x' } }))
        .status,
    ).toBe(401);
  });
});

describe('SEC：路径和方法', () => {
  it('非法会话号（带 /、..、超长、控制字符）回 404', async () => {
    const { base } = await start();
    const bad = ['a%2Fb', '..', '%2e%2e', 'a%2F..%2Fb', 'x'.repeat(200), 'a%00b', 'a%20b', '%2E%2E%2Fetc'];
    for (const id of bad) {
      for (const tail of ['history', 'events']) {
        const r = await fetch(`${base}/next/api/sessions/${id}/${tail}`, { headers: auth() });
        expect(r.status, `${id}/${tail}`).toBe(404);
      }
    }
    expect((await fetch(`${base}/next/api/other`, { headers: auth() })).status).toBe(404);
    expect((await fetch(`${base}/sessions/x/events`, { headers: auth() })).status).toBe(404);
  });

  it('只收 GET', async () => {
    const { base } = await start();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await fetch(`${base}/next/api/sessions`, { method, headers: auth(), body: '{}' })).status).toBe(
        405,
      );
    }
  });

  it('不回 CORS 头，预检也不放行', async () => {
    const { base } = await start();
    const origin = { origin: 'https://evil.example' };
    const rs = await Promise.all([
      fetch(`${base}/next/api/sessions`, { headers: { ...auth(), ...origin } }),
      fetch(`${base}/next/api/sessions`, { headers: origin }),
      fetch(`${base}/next/api/sessions/x/history`, { headers: { ...auth(), ...origin } }),
      fetch(`${base}/nope`, { headers: origin }),
      fetch(`${base}/next/api/sessions`, {
        method: 'OPTIONS',
        headers: { ...origin, 'access-control-request-method': 'GET' },
      }),
    ]);
    for (const r of rs) {
      expect([...r.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
      await r.text();
    }
    expect(rs[0]?.headers.get('cache-control')).toBe('no-store');
  });

  it('服务端空闲连接保持 6 分钟，比 nginx 的 5 分钟长', async () => {
    const { api } = await start();
    expect(COCKPIT_KEEP_ALIVE_MS).toBe(360_000);
    expect(api.server.keepAliveTimeout).toBe(360_000);
    expect(api.server.headersTimeout).toBeGreaterThan(360_000);
  });
});

async function seed(session: string, n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      (await appendToSession(t.db, session, 'worker.progress.reported', { summary: `${session}-${i}` })).id,
    );
  }
  return ids;
}

interface ListBody {
  sessions: {
    id: string;
    eventCount: number;
    lastEventId: number;
    lastAt: string;
    lastType: string;
    lastPayload: unknown;
    tail: Record<string, unknown>[];
  }[];
  nextBefore: number | null;
}

describe('会话列表', () => {
  it('按最后事件倒序；新事件把会话顶到最前', async () => {
    const { base } = await start();
    await seed('a', 2);
    await seed('b', 1);
    await seed('c', 3);
    const first = (await (await fetch(`${base}/next/api/sessions`, { headers: auth() })).json()) as ListBody;
    expect(first.sessions.map((s) => s.id)).toEqual(['c', 'b', 'a']);
    expect(first.sessions[0]).toMatchObject({
      eventCount: 3,
      lastType: 'worker.progress.reported',
      lastPayload: { summary: 'c-2' },
    });
    expect(first.nextBefore).toBeNull();
    await seed('a', 1);
    const second = (await (await fetch(`${base}/next/api/sessions`, { headers: auth() })).json()) as ListBody;
    expect(second.sessions.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(second.sessions[0]?.eventCount).toBe(3);
  });

  it('每个会话带近期事件的瘦身版（判工人状态用）：最旧在前、封顶 TAIL_EVENTS、不带大文本', async () => {
    const { base } = await start();
    await seed('long', TAIL_EVENTS + 6);
    await appendToSession(t.db, 'long', 'worker.settled', {
      exitCode: 143,
      killed: 'stop-requested',
      spawnError: null,
      stderrTail: 'x'.repeat(5000),
    });
    await appendToSession(t.db, 'long', 'handback.recorded', {
      final: true,
      outcome: 'dead',
      verdict: 'unknown',
      reasons: ['不会出现在 tail 里'],
    });
    await appendToSession(t.db, 'short', 'worker.spawned', { deadline: '2026-10-31T12:00:00Z', model: 'm' });
    const body = (await (await fetch(`${base}/next/api/sessions`, { headers: auth() })).json()) as ListBody;
    const short = body.sessions.find((s) => s.id === 'short');
    expect(short?.tail).toEqual([{ type: 'worker.spawned', deadline: '2026-10-31T12:00:00Z' }]);
    const long = body.sessions.find((s) => s.id === 'long');
    expect(long?.tail).toHaveLength(TAIL_EVENTS);
    expect(long?.tail.at(-1)).toEqual({ type: 'handback.recorded', final: true, outcome: 'dead' });
    expect(long?.tail.at(-2)).toEqual({ type: 'worker.settled', exitCode: 143, killed: 'stop-requested' });
    expect(JSON.stringify(long?.tail)).not.toContain('xxxx');
  });

  it('只列会话流，不列工人流；游标分页不重不漏', async () => {
    const { base } = await start();
    for (let i = 0; i < 7; i++) await seed(`s${i}`, 1);
    await t.db
      .insert(events)
      .values({ streamId: 'worker:w1', seq: 1, type: 'worker.spawned', schemaVersion: 1, payload: {} });
    const seen: string[] = [];
    let before: number | null = null;
    for (let page = 0; page < 10; page++) {
      const q: string = `limit=3${before === null ? '' : `&before=${before}`}`;
      const body = (await (
        await fetch(`${base}/next/api/sessions?${q}`, { headers: auth() })
      ).json()) as ListBody;
      expect(body.sessions.length).toBeLessThanOrEqual(3);
      seen.push(...body.sessions.map((s) => s.id));
      before = body.nextBefore;
      if (before === null) break;
    }
    expect(seen).toEqual(['s6', 's5', 's4', 's3', 's2', 's1', 's0']);
  });

  it('limit 默认 30、上限 100；不合法的参数 400', async () => {
    const { base } = await start();
    for (const q of ['limit=0', 'limit=-1', 'limit=abc', 'limit=101', 'before=x', 'before=-3', 'limit=1.5']) {
      expect((await fetch(`${base}/next/api/sessions?${q}`, { headers: auth() })).status, q).toBe(400);
    }
    for (let i = 0; i < 32; i++) await seed(`p${i}`, 1);
    const body = (await (await fetch(`${base}/next/api/sessions`, { headers: auth() })).json()) as ListBody;
    expect(body.sessions).toHaveLength(30);
    expect(body.nextBefore).toBe(body.sessions[29]?.lastEventId);
  });
});

describe('历史页和 SSE', () => {
  it('历史页和令牌口同一份实现：最新一页、head、hasMore', async () => {
    const { base } = await start();
    const ids = await seed('h1', 5);
    const r = await fetch(`${base}/next/api/sessions/h1/history?limit=2`, { headers: auth() });
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as { events: { id: number }[]; head: number; hasMore: boolean };
    expect(body.events.map((e) => e.id)).toEqual(ids.slice(3));
    expect(body.head).toBe(ids[4]);
    expect(body.hasMore).toBe(true);
    expect((await fetch(`${base}/next/api/sessions/h1/history?before=x`, { headers: auth() })).status).toBe(
      400,
    );
  });

  async function readFrames(res: Response, want: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('没有 body');
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (buf.match(/\n\n/g) ?? []).length < want) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    await reader.cancel();
    return buf;
  }

  it('SSE：ready 之后推新事件；带 Last-Event-ID 只补更新的', async () => {
    const { base } = await start();
    const ids = await seed('e1', 3);
    const live = await fetch(`${base}/next/api/sessions/e1/events`, { headers: auth() });
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toContain('text/event-stream');
    setTimeout(() => void seed('e1', 1), 100);
    const text = await readFrames(live, 3); // : connected、ready、一条新事件
    expect(text).toContain('event: ready');
    expect(text).toContain('event: worker.progress.reported');
    const resumed = await fetch(`${base}/next/api/sessions/e1/events`, {
      headers: { ...auth(), 'last-event-id': String(ids[0]) },
    });
    const text2 = await readFrames(resumed, 3);
    expect(text2).toContain(`id: ${ids[1]}`);
    expect(text2).toContain(`id: ${ids[2]}`);
    expect(text2).not.toContain(`id: ${ids[0]}\n`);
  });

  it('JSON 和 SSE 的字节里没有令牌头名', async () => {
    const { base } = await start();
    await seed('leak', 2);
    const list = await (await fetch(`${base}/next/api/sessions`, { headers: auth() })).text();
    const hist = await (await fetch(`${base}/next/api/sessions/leak/history`, { headers: auth() })).text();
    const sse = await readFrames(
      await fetch(`${base}/next/api/sessions/leak/events`, { headers: { ...auth(), 'last-event-id': '0' } }),
      3,
    );
    for (const body of [list, hist, sse]) expect(body.toLowerCase()).not.toContain('x-fleet-session-token');
  });
});

describe('cockpit 不改 stream_heads 以外的东西', () => {
  it('读列表只推进投影，不写 events', async () => {
    const { base } = await start();
    await seed('ro', 2);
    const before = (await t.pg.query<{ n: number }>('select count(*)::int n from fleet2.events')).rows[0]?.n;
    await fetch(`${base}/next/api/sessions`, { headers: auth() }).then((r) => r.text());
    const after = (await t.pg.query<{ n: number }>('select count(*)::int n from fleet2.events')).rows[0]?.n;
    expect(after).toBe(before);
  });
});
