// SessionFeed 的行为：假 fetch + 假 sleep，不碰网络和真时钟。对应旧坑 G4（断线续传、resync、不重不漏）。
import { describe, expect, it } from 'vitest';
import { SessionFeed } from './feed';
import type { FeedEvent, FeedState } from './types';

const E = (id: number): FeedEvent => ({
  id,
  seq: id,
  type: 'worker.progress.reported',
  payload: { summary: `s${id}` },
  createdAt: '2026-10-31T00:00:00.000Z',
});

const frame = (e: FeedEvent) =>
  `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, payload: e.payload, createdAt: e.createdAt })}\n\n`;

function history(events: FeedEvent[], head: number, hasMore = false): Response {
  return new Response(JSON.stringify({ events, head, hasMore }), { status: 200 });
}

/** 一条 SSE 响应：吐出 chunks 后，close=true 就结束流，否则一直挂着直到被取消。 */
function sse(chunks: string[], close: boolean, signal?: AbortSignal | null): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (close) c.close();
      else signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Call {
  url: string;
  lastEventId: string | null;
}

/** 按脚本一个个回；脚本用完后 SSE 一律挂着、历史一律失败（防止测试里死循环）。 */
function script(steps: ((c: Call, signal?: AbortSignal | null) => Response | Error)[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const c = { url: String(input), lastEventId: headers.get('last-event-id') };
    calls.push(c);
    const step = steps[i++];
    if (!step) {
      if (c.url.endsWith('/events')) return sse([], false, init?.signal);
      throw new Error('脚本用完');
    }
    const r = step(c, init?.signal);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const sleeps: number[] = [];
const fakeSleep = async (ms: number) => {
  sleeps.push(ms);
  await Promise.resolve();
};

function make(fetchImpl: typeof fetch) {
  sleeps.length = 0;
  return new SessionFeed('s1', {
    base: '/api',
    fetchImpl,
    sleep: fakeSleep,
    rng: () => 0.5,
    stableMs: 10_000_000,
    idleMs: 10_000_000,
  });
}

async function until(feed: SessionFeed, pred: (s: FeedState) => boolean): Promise<FeedState> {
  const deadline = Date.now() + 3000;
  while (!pred(feed.getSnapshot())) {
    if (Date.now() > deadline) throw new Error(`等不到：${JSON.stringify(feed.getSnapshot())}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return feed.getSnapshot();
}

const ids = (s: FeedState) => s.events.map((e) => e.id);

describe('SessionFeed', () => {
  it('先取最新一页历史，再以 head 为 Last-Event-ID 开流，实时事件并进来', async () => {
    const { fetchImpl, calls } = script([
      () => history([E(1), E(2), E(3)], 3, true),
      () => sse([frame(E(4))], false),
    ]);
    const feed = make(fetchImpl);
    feed.start();
    const s = await until(feed, (x) => x.events.length === 4);
    feed.stop();
    expect(ids(s)).toEqual([1, 2, 3, 4]);
    expect(s.hasOlder).toBe(true);
    expect(s.status).toBe('live');
    expect(calls[0]?.url).toBe('/api/sessions/s1/history?limit=200');
    expect(calls[1]?.url).toBe('/api/sessions/s1/events');
    expect(calls[1]?.lastEventId).toBe('3');
  });

  it('断线重连带已收到的最大事件号；补发里重复的不重复，新的不漏', async () => {
    const { fetchImpl, calls } = script([
      () => history([E(1)], 1),
      () => sse([frame(E(2)), frame(E(3))], true), // 收到 2、3 后连接被断
      () => sse([frame(E(3)), frame(E(4)), frame(E(5))], false), // 服务端（或代理）重复送了 3
    ]);
    const feed = make(fetchImpl);
    feed.start();
    const s = await until(feed, (x) => x.events.length === 5);
    feed.stop();
    expect(ids(s)).toEqual([1, 2, 3, 4, 5]);
    expect(calls[2]?.lastEventId).toBe('3');
    expect(sleeps.length).toBe(1); // 断了一次就等了一次
  });

  it('连不上（网络错、5xx）一直退避重试，恢复后带 Last-Event-ID 接上', async () => {
    const { fetchImpl, calls } = script([
      () => history([E(1)], 1),
      () => new TypeError('Failed to fetch'),
      () => new Response('bad gateway', { status: 502 }),
      () => sse([frame(E(2))], false),
    ]);
    const feed = make(fetchImpl);
    feed.start();
    const s = await until(feed, (x) => x.events.length === 2);
    feed.stop();
    expect(s.status).toBe('live');
    expect(sleeps.length).toBe(2);
    // 失败次数越多等得越久（rng 固定时上限翻倍）
    expect(sleeps[1] as number).toBeGreaterThan(sleeps[0] as number);
    expect(calls.map((c) => c.lastEventId)).toEqual([null, '1', '1', '1']);
  });

  it('收到 resync：清掉已有的、整页重取，之后从新的 head 续上', async () => {
    const { fetchImpl, calls } = script([
      () => history([E(1), E(2)], 2),
      () => sse([`id: 99\nevent: resync\ndata: {}\n\n`], false),
      () => history([E(98), E(99), E(100)], 100, true),
      () => sse([frame(E(101))], false),
    ]);
    const feed = make(fetchImpl);
    feed.start();
    const s = await until(feed, (x) => x.events.length === 4);
    feed.stop();
    expect(ids(s)).toEqual([98, 99, 100, 101]);
    expect(s.resyncs).toBe(1);
    expect(calls[3]?.lastEventId).toBe('100');
    // resync 后重取前先随机等一段（打散多标签页同时重取）
    expect(sleeps.length).toBe(1);
  });

  it('401、404 这类重试没用的错：停下来说原因，不重连', async () => {
    const { fetchImpl, calls } = script([() => new Response('no', { status: 401 })]);
    const feed = make(fetchImpl);
    feed.start();
    const s = await until(feed, (x) => x.status === 'failed');
    feed.stop();
    expect(s.error).toContain('登录');
    expect(s.errorStatus).toBe(401);
    expect(calls.length).toBe(1);
    expect(sleeps.length).toBe(0);
  });

  it('连上又马上被断的不算稳：失败计数继续涨，不会一直按最短间隔狂连', async () => {
    const flaps = Array.from({ length: 4 }, () => () => sse([], true));
    const { fetchImpl } = script([() => history([], 0), ...flaps, () => sse([], false)]);
    const feed = make(fetchImpl);
    feed.start();
    await until(feed, () => sleeps.length >= 4);
    feed.stop();
    const first = sleeps[0] as number;
    const last = sleeps[3] as number;
    expect(last).toBeGreaterThan(first);
  });

  it('往上翻：取比最老一条更老的一页并进来，不影响已有的', async () => {
    const { fetchImpl, calls } = script([
      () => history([E(5), E(6)], 6, true),
      () => sse([], false),
      () => history([E(3), E(4)], 6, false),
    ]);
    const feed = make(fetchImpl);
    feed.start();
    await until(feed, (x) => x.status === 'live');
    await feed.loadOlder();
    feed.stop();
    expect(ids(feed.getSnapshot())).toEqual([3, 4, 5, 6]);
    expect(feed.getSnapshot().hasOlder).toBe(false);
    expect(calls[2]?.url).toBe('/api/sessions/s1/history?before=5&limit=200');
  });
});
