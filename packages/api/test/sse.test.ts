import { ChangeEventSchema } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { createChangeHub } from '../src/changes.ts';
import { createSseRelay } from '../src/sse.ts';
import {
  errorCode,
  sseEvents as events,
  harness,
  IDS,
  openEvents as open,
  readUntil,
  viaBearer,
} from './harness.ts';

describe('实时推送（SSE）', () => {
  it('先发 ready；数据库一变推 change（表名 + 主键）；断过线推 resync；每条带 id；断开后退订', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const { res, reader } = await open(h, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const buf = await readUntil(reader, 'event: ready');
    expect(h.relay.connections()).toBe(1);

    h.changes.publish({ type: 'change', table: 'tasks', id: IDS.task12 });
    await readUntil(reader, 'event: change', buf);
    h.changes.publish({ type: 'resync' });
    await readUntil(reader, 'event: resync', buf);
    const got = events(buf.text);
    expect(got.map((e) => e.event)).toEqual(['ready', 'change', 'resync']);
    expect(ChangeEventSchema.parse(JSON.parse(got[1]?.data ?? 'null'))).toEqual({
      table: 'tasks',
      id: IDS.task12,
    });
    expect(got.every((e) => e.id !== undefined)).toBe(true);

    await reader.cancel();
    for (let i = 0; i < 50 && h.relay.connections() > 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(h.relay.connections()).toBe(0);
  });

  it('停机收场（endAll，#2186）：开着的 SSE 流读到结尾、连接数归零；之后再连上来的也立刻收', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const { reader } = await open(h, cookie);
    await readUntil(reader, 'event: ready');
    expect(h.relay.connections()).toBe(1);

    h.relay.endAll();
    // 流要真结束（done），不是只退订：不结束的话 server.close 等不到这条连接，排空照样等满上限
    let ended = false;
    for (let i = 0; i < 50 && !ended; i++) ended = (await reader.read()).done;
    expect(ended).toBe(true);
    expect(h.relay.connections()).toBe(0);

    const late = await open(h, cookie);
    let lateEnded = false;
    for (let i = 0; i < 50 && !lateEnded; i++) lateEnded = (await late.reader.read()).done;
    expect(lateEnded).toBe(true);
    expect(h.relay.connections()).toBe(0);
  });

  it('浏览器断线重连（带 Last-Event-ID）：补发断开期间的变化，按顺序、不重复，不再发 ready', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const first = await open(h, cookie);
    const buf = await readUntil(first.reader, 'event: ready');
    h.changes.publish({ type: 'change', table: 'tasks', id: 'a' });
    await readUntil(first.reader, '"id":"a"', buf);
    const lastSeen = events(buf.text).at(-1)?.id;
    await first.reader.cancel();

    // 断开期间来了两条变化。
    h.changes.publish({ type: 'change', table: 'subtasks', id: 'b' });
    h.changes.publish({ type: 'change', table: 'asks', id: 'c' });

    const second = await open(h, cookie, lastSeen);
    const buf2 = await readUntil(second.reader, '"id":"c"');
    h.changes.publish({ type: 'change', table: 'tasks', id: 'd' });
    await readUntil(second.reader, '"id":"d"', buf2);
    const got = events(buf2.text);
    expect(got.map((e) => [e.event, JSON.parse(e.data ?? '{}').id])).toEqual([
      ['change', 'b'],
      ['change', 'c'],
      ['change', 'd'],
    ]);
    await second.reader.cancel();
  });

  it('补不全（id 不是本进程这一轮的、或已挤出缓冲）：先发 resync，让前端全量重拉', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const stale = await open(h, cookie, 'someOtherBoot.42');
    const buf = await readUntil(stale.reader, 'event: resync');
    expect(events(buf.text).map((e) => e.event)).toEqual(['resync']);
    await stale.reader.cancel();

    const relay = createSseRelay(createChangeHub(), { bufferSize: 2 });
    expect(relay.since(relay.latestId())).toEqual([]);
    const hub = createChangeHub();
    const small = createSseRelay(hub, { bufferSize: 2 });
    const start = small.latestId();
    for (const id of ['1', '2', '3']) hub.publish({ type: 'change', table: 'tasks', id });
    expect(small.since(start)).toBeNull();
    expect(small.since(small.latestId())).toEqual([]);
  });

  it('机器资源（#1973）：一连上先给最近一回，之后每读成一回推一条 resources；不带 id（不进补发、不顶掉 Last-Event-ID）', async () => {
    const h = harness();
    const make = (percent: number) => ({
      at: new Date().toISOString(),
      everyMs: 5000,
      memory: { state: 'ok' as const, totalMb: 1000, availableMb: 400 },
      cpu: { state: 'ok' as const, percent, cores: 2 },
      sessions: { state: 'unread' as const, why: '这台没有 /sys/fs/cgroup/fleet.slice/fleet-agents.slice' },
    });
    const listeners = new Set<(r: ReturnType<typeof make>) => void>();
    h.deps.hostResources = {
      current: async () => make(10),
      latest: () => make(10),
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      start: () => () => {},
    };
    const { cookie } = await h.login();
    const { reader } = await open(h, cookie);
    const buf = await readUntil(reader, 'event: resources');
    for (const l of listeners) l(make(55));
    await readUntil(reader, '"percent":55', buf);
    const got = events(buf.text).filter((e) => e.event === 'resources');
    expect(got.map((e) => JSON.parse(e.data ?? '{}').cpu.percent)).toEqual([10, 55]);
    expect(got.every((e) => e.id === undefined)).toBe(true);
    await reader.cancel();
    for (let i = 0; i < 50 && listeners.size > 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(listeners.size).toBe(0);
  });

  it('没登录不给连；带 Authorization 令牌也不给连', async () => {
    const h = harness();
    expect(await errorCode(await h.cockpit.request('/api/events'))).toBe('unauthenticated');
    const res = await h.cockpit.request('/api/events', viaBearer('GET'));
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('bearer_not_allowed');
  });
});
