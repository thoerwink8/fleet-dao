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
  viaGateway,
  write,
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

  it('写库引起的变化推给打开的页面（例：回答追问，asks 表会发通知）', async () => {
    const h = harness();
    const session = await h.login();
    const askId = 'a1000000-0000-4000-8000-000000000001';
    h.store.data.asks.push({
      id: askId,
      taskId: IDS.task12,
      question: '几位？',
      options: [],
      askedAt: h.clock.now.toISOString(),
    });
    const { reader } = await open(h, session.cookie);
    const buf = await readUntil(reader, 'event: ready');
    await h.cockpit.request(`/api/asks/${askId}/answer`, write('POST', session, { answer: '6 位' }));
    await readUntil(reader, `{"table":"asks","id":"${askId}"}`, buf);
    await reader.cancel();
  });

  it('没登录不给连；飞书网关的通行证也不给连（网关只能调约定里那几条，推送走长轮询待推送）', async () => {
    const h = harness();
    expect(await errorCode(await h.cockpit.request('/api/events'))).toBe('unauthenticated');
    const res = await h.cockpit.request('/api/events', viaGateway('GET', 'ou_dev_founder_a'));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('gateway_route_not_allowed');
  });
});
