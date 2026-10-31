// 接口层（#3775）对照 specs/3770-harness-rewrite/旧坑验收用例.md：SEC2（MCP 工具越权）、SEC3（SSE 令牌泄漏）、G4（SSE 续传）。
import { events, sessionTokens } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appendToSession, sessionStream } from '../src/events.ts';
import { createHarnessApi, type HarnessApi } from '../src/server.ts';
import { issueToken, revokeToken, verifyToken } from '../src/tokens.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(() => t.close());

const apis: HarnessApi[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const a of apis.splice(0)) await a.close();
});

async function start(opts: { shadow?: boolean; replayCap?: number } = {}): Promise<{ base: string }> {
  const api = createHarnessApi({ db: t.db, pollMs: 30, heartbeatMs: 10_000, ...opts });
  apis.push(api);
  return { base: `http://127.0.0.1:${await api.listen()}` };
}

async function mcpClient(base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { 'X-Fleet-Session-Token': token } },
  });
  // SDK 类型和本仓 exactOptionalPropertyTypes 对不上，在这里收口。
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  clients.push(client);
  return client;
}

/** 调一个工具；被拒（抛错或 isError）返回 null，成功返回解析后的结果。 */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown | null> {
  try {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    if (r.isError) return null;
    return JSON.parse(r.content[0]?.text ?? 'null');
  } catch {
    return null;
  }
}

const order = {
  task: 'fix',
  expected: 'tests green',
  must_do: 'add a test',
  must_not: 'touch infra',
  context: 'repo x',
  stop_when: 'done',
};

interface Sse {
  status: number;
  frames: { id?: string; event?: string; data?: string }[];
  closed: Promise<void>;
  cancel(): void;
  waitFor(n: number): Promise<void>;
}

/** 开一条 SSE，攒帧。 */
async function openSse(
  base: string,
  session: string,
  headers: Record<string, string>,
  query = '',
): Promise<Sse> {
  const ac = new AbortController();
  const res = await fetch(`${base}/sessions/${session}/events${query}`, { headers, signal: ac.signal });
  const frames: Sse['frames'] = [];
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i = buf.indexOf('\n\n');
          while (i >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const f: Sse['frames'][number] = {};
            for (const line of raw.split('\n')) {
              if (line.startsWith('id: ')) f.id = line.slice(4);
              else if (line.startsWith('event: ')) f.event = line.slice(7);
              else if (line.startsWith('data: ')) f.data = line.slice(6);
            }
            if (raw.startsWith(':')) {
              i = buf.indexOf('\n\n');
              continue;
            }
            frames.push(f);
            i = buf.indexOf('\n\n');
          }
        }
      } catch {
        // 被取消
      }
      resolveClosed();
    })();
  } else {
    await res.text();
    resolveClosed();
  }
  return {
    status: res.status,
    frames,
    closed,
    cancel: () => ac.abort(),
    async waitFor(n) {
      const deadline = Date.now() + 5000;
      while (frames.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(frames.length).toBeGreaterThanOrEqual(n);
    },
  };
}

const progress = (session: string, n: number) =>
  appendToSession(t.db, session, 'worker.progress.reported', { summary: `p${n}` });

describe('令牌', () => {
  it('库里只存哈希，核验通过，撤销后核验失败', async () => {
    const issued = await issueToken(t.db, 'tok-a', 'commander');
    const rows = await t.db.select().from(sessionTokens).where(eq(sessionTokens.id, issued.tokenId));
    expect(rows[0]?.tokenHash).toBeDefined();
    expect(rows[0]?.tokenHash).not.toBe(issued.token);
    expect(JSON.stringify(rows)).not.toContain(issued.token);
    expect(await verifyToken(t.db, issued.token)).toEqual({
      tokenId: issued.tokenId,
      sessionId: 'tok-a',
      role: 'commander',
    });
    expect(await verifyToken(t.db, `${issued.token}x`)).toBeNull();
    expect(await verifyToken(t.db, undefined)).toBeNull();
    expect(await revokeToken(t.db, issued.tokenId)).toBe(true);
    expect(await revokeToken(t.db, issued.tokenId)).toBe(false);
    expect(await verifyToken(t.db, issued.token)).toBeNull();
  });
});

describe('SEC2：MCP 工具越权', () => {
  it('指挥官能派工，工人看不到也调不了 spawn_worker', async () => {
    const { base } = await start();
    const cmd = await issueToken(t.db, 'sec2-cmd', 'commander');
    const wrk = await issueToken(t.db, 'sec2-wrk', 'worker');
    const cc = await mcpClient(base, cmd.token);
    const wc = await mcpClient(base, wrk.token);

    const cmdTools = (await cc.listTools()).tools.map((x) => x.name).sort();
    expect(cmdTools).toEqual(['get_task', 'list_tasks', 'spawn_worker', 'stop_worker']);
    const wrkTools = (await wc.listTools()).tools.map((x) => x.name).sort();
    expect(wrkTools).toEqual(['report_progress', 'submit_result']);

    expect(await call(wc, 'spawn_worker', order)).toBeNull();
    expect(await call(wc, 'stop_worker', { task_id: 'x', reason: 'r' })).toBeNull();
    expect(await call(cc, 'report_progress', { summary: 's' })).toBeNull();
    const spawned = (await call(cc, 'spawn_worker', order)) as { taskId: string };
    expect(spawned.taskId).toBeTruthy();

    // 工人那条流里没有派工事件
    const wrkEvents = await t.db
      .select()
      .from(events)
      .where(eq(events.streamId, sessionStream('sec2-wrk')));
    expect(wrkEvents.map((e) => e.type)).not.toContain('worker.spawn.requested');
  });

  it('令牌只绑一个会话：A 的令牌写只落 A 的流，读不了 B 的 SSE', async () => {
    const { base } = await start();
    const a = await issueToken(t.db, 'sec2-A', 'commander');
    await issueToken(t.db, 'sec2-B', 'commander');
    const ca = await mcpClient(base, a.token);
    await call(ca, 'spawn_worker', order);
    const inA = await t.db
      .select()
      .from(events)
      .where(eq(events.streamId, sessionStream('sec2-A')));
    const inB = await t.db
      .select()
      .from(events)
      .where(eq(events.streamId, sessionStream('sec2-B')));
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(0);
    // 工具没有会话号参数：指挥官 A 查不到别的会话的任务
    const tasks = (await call(ca, 'list_tasks', {})) as { tasks: unknown[] };
    expect(tasks.tasks).toHaveLength(1);

    const sse = await openSse(base, 'sec2-B', { 'X-Fleet-Session-Token': a.token });
    expect(sse.status).toBe(403);
  });

  it('撤销的令牌和乱写的令牌都被拒', async () => {
    const { base } = await start();
    const x = await issueToken(t.db, 'sec2-rev', 'commander');
    await revokeToken(t.db, x.tokenId);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'X-Fleet-Session-Token': x.token, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const none = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(none.status).toBe(401);
    await expect(mcpClient(base, x.token)).rejects.toThrow();
  });

  it('spawn_worker 缺任何一项在 schema 层就拒，并且不落事件', async () => {
    const { base } = await start();
    const cmd = await issueToken(t.db, 'sec2-schema', 'commander');
    const cc = await mcpClient(base, cmd.token);
    for (const key of Object.keys(order)) {
      const partial: Record<string, unknown> = { ...order };
      delete partial[key];
      expect(await call(cc, 'spawn_worker', partial)).toBeNull();
    }
    expect(await call(cc, 'spawn_worker', { ...order, stop_when: '' })).toBeNull();
    const rows = await t.db
      .select()
      .from(events)
      .where(eq(events.streamId, sessionStream('sec2-schema')));
    expect(rows).toHaveLength(0);
  });

  it('派工、查、停、工人报进度和交结果都落事件', async () => {
    const { base } = await start();
    const cmd = await issueToken(t.db, 'sec2-flow', 'commander');
    const cc = await mcpClient(base, cmd.token);
    const { taskId } = (await call(cc, 'spawn_worker', order)) as { taskId: string };
    const got = (await call(cc, 'get_task', { task_id: taskId })) as { found: boolean };
    expect(got.found).toBe(true);
    expect(await call(cc, 'stop_worker', { task_id: taskId, reason: 'enough' })).toMatchObject({
      stopped: true,
    });
    expect(await call(cc, 'stop_worker', { task_id: 'nope', reason: 'r' })).toMatchObject({ stopped: false });

    const wrk = await issueToken(t.db, 'sec2-flow-w', 'worker');
    const wc = await mcpClient(base, wrk.token);
    await call(wc, 'report_progress', { summary: 'half', percent: 50 });
    await call(wc, 'submit_result', { status: 'done', summary: 'ok' });
    const types = (
      await t.db
        .select()
        .from(events)
        .where(eq(events.streamId, sessionStream('sec2-flow-w')))
    ).map((e) => e.type);
    expect(types).toEqual(['worker.progress.reported', 'worker.result.submitted']);
  });
});

describe('影子模式', () => {
  it('会引起外部写的工具不注册，只读和记账的还在', async () => {
    const { base } = await start({ shadow: true });
    const cmd = await issueToken(t.db, 'shadow-cmd', 'commander');
    const cc = await mcpClient(base, cmd.token);
    const names = (await cc.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual(['get_task', 'list_tasks']);
    expect(await call(cc, 'spawn_worker', order)).toBeNull();
  });
});

describe('SEC3：SSE 令牌', () => {
  it('网址里带令牌被拒（哪怕令牌是对的），请求头和 cookie 都行', async () => {
    const { base } = await start();
    const s = await issueToken(t.db, 'sec3-q', 'commander');
    for (const q of [`?token=${s.token}`, `?access_token=${s.token}`, `?x=1&Session_Token=${s.token}`]) {
      const sse = await openSse(base, 'sec3-q', {}, q);
      expect(sse.status).toBe(400);
    }
    const byHeader = await openSse(base, 'sec3-q', { 'X-Fleet-Session-Token': s.token });
    expect(byHeader.status).toBe(200);
    byHeader.cancel();
    const byCookie = await openSse(base, 'sec3-q', { cookie: `fleet_session_token=${s.token}` });
    expect(byCookie.status).toBe(200);
    byCookie.cancel();
    expect((await openSse(base, 'sec3-q', {})).status).toBe(401);
  });

  it('令牌撤销后开着的连接被关掉', async () => {
    const { base } = await start();
    const s = await issueToken(t.db, 'sec3-rev', 'commander');
    const sse = await openSse(base, 'sec3-rev', { 'X-Fleet-Session-Token': s.token });
    expect(sse.status).toBe(200);
    await progress('sec3-rev', 1);
    await sse.waitFor(2); // ready + 一条事件
    await revokeToken(t.db, s.tokenId);
    await Promise.race([
      sse.closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error('撤销后连接没断')), 3000)),
    ]);
  });
});

describe('G4：SSE 续传', () => {
  it('带 Last-Event-ID 只补更新的，不重复，之后的新事件也收得到', async () => {
    const { base } = await start();
    const s = await issueToken(t.db, 'g4-resume', 'worker');
    const evs = [];
    for (let i = 1; i <= 5; i++) evs.push(await progress('g4-resume', i));
    const sse = await openSse(base, 'g4-resume', {
      'X-Fleet-Session-Token': s.token,
      'Last-Event-ID': String(evs[2]?.id),
    });
    await sse.waitFor(2);
    expect(sse.frames.map((f) => f.id)).toEqual([String(evs[3]?.id), String(evs[4]?.id)]);
    const late = await progress('g4-resume', 6);
    await sse.waitFor(3);
    expect(sse.frames.map((f) => f.id)).toEqual([String(evs[3]?.id), String(evs[4]?.id), String(late.id)]);
    expect(sse.frames[0]?.event).toBe('worker.progress.reported');
    expect(JSON.parse(sse.frames[0]?.data ?? '{}').payload.summary).toBe('p4');
    sse.cancel();
  });

  it('落后超过重放上限发 resync，不补发，之后只收新的', async () => {
    const { base } = await start({ replayCap: 3 });
    const s = await issueToken(t.db, 'g4-gap', 'worker');
    const first = await progress('g4-gap', 1);
    for (let i = 2; i <= 6; i++) await progress('g4-gap', i);
    const sse = await openSse(base, 'g4-gap', {
      'X-Fleet-Session-Token': s.token,
      'Last-Event-ID': String(first.id - 1),
    });
    await sse.waitFor(1);
    expect(sse.frames[0]?.event).toBe('resync');
    const late = await progress('g4-gap', 7);
    await sse.waitFor(2);
    expect(sse.frames.map((f) => f.event)).toEqual(['resync', 'worker.progress.reported']);
    expect(sse.frames[1]?.id).toBe(String(late.id));
    sse.cancel();
  });

  it('刚好在上限内照常补发；看不懂的 Last-Event-ID 发 resync', async () => {
    const { base } = await start({ replayCap: 3 });
    const s = await issueToken(t.db, 'g4-edge', 'worker');
    const e1 = await progress('g4-edge', 1);
    await progress('g4-edge', 2);
    await progress('g4-edge', 3);
    const ok = await openSse(base, 'g4-edge', {
      'X-Fleet-Session-Token': s.token,
      'Last-Event-ID': String(e1.id - 1),
    });
    await ok.waitFor(3);
    expect(ok.frames.every((f) => f.event === 'worker.progress.reported')).toBe(true);
    ok.cancel();
    const bad = await openSse(base, 'g4-edge', {
      'X-Fleet-Session-Token': s.token,
      'Last-Event-ID': 'abc.9',
    });
    await bad.waitFor(1);
    expect(bad.frames[0]?.event).toBe('resync');
    bad.cancel();
  });
});

describe('历史页（驾驶舱首屏和 resync 重取，#3781）', () => {
  async function getHistory(base: string, session: string, token: string | null, query = '') {
    const res = await fetch(`${base}/sessions/${session}/history${query}`, {
      headers: token ? { 'X-Fleet-Session-Token': token } : {},
    });
    const text = await res.text();
    const body = (res.status === 200 ? JSON.parse(text) : null) as {
      events: { id: number }[];
      head: number;
      hasMore: boolean;
    };
    return { status: res.status, body };
  }

  it('不给游标是最新一页（升序），before 往前翻，after 往后翻，head 是最新事件号', async () => {
    const { base } = await start();
    const s = await issueToken(t.db, 'h-page', 'worker');
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) ids.push((await progress('h-page', i)).id);
    const tail = await getHistory(base, 'h-page', s.token, '?limit=2');
    expect(tail.body.events.map((e: { id: number }) => e.id)).toEqual(ids.slice(3));
    expect(tail.body.hasMore).toBe(true);
    expect(tail.body.head).toBe(ids[4]);
    const older = await getHistory(base, 'h-page', s.token, `?limit=2&before=${ids[3]}`);
    expect(older.body.events.map((e: { id: number }) => e.id)).toEqual(ids.slice(1, 3));
    expect(older.body.hasMore).toBe(true);
    const oldest = await getHistory(base, 'h-page', s.token, `?limit=2&before=${ids[1]}`);
    expect(oldest.body.events.map((e: { id: number }) => e.id)).toEqual(ids.slice(0, 1));
    expect(oldest.body.hasMore).toBe(false);
    const newer = await getHistory(base, 'h-page', s.token, `?limit=3&after=${ids[1]}`);
    expect(newer.body.events.map((e: { id: number }) => e.id)).toEqual(ids.slice(2));
    expect(newer.body.hasMore).toBe(false);
  });

  it('空会话返回空页和 head 0；令牌错、跨会话、网址带令牌、坏游标都被拒', async () => {
    const { base } = await start();
    const s = await issueToken(t.db, 'h-empty', 'worker');
    const empty = await getHistory(base, 'h-empty', s.token);
    expect(empty.body).toEqual({ events: [], head: 0, hasMore: false });
    expect((await getHistory(base, 'h-empty', null)).status).toBe(401);
    expect((await getHistory(base, 'h-other', s.token)).status).toBe(403);
    expect((await getHistory(base, 'h-empty', s.token, `?access_token=${s.token}`)).status).toBe(400);
    expect((await getHistory(base, 'h-empty', s.token, '?before=x')).status).toBe(400);
    expect((await getHistory(base, 'h-empty', s.token, '?before=1&after=1')).status).toBe(400);
  });
});
