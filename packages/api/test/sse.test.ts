import { ChangeEventSchema } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { errorCode, harness, write } from './harness.ts';

/** 从 SSE 流里一直读，直到出现 want（或超时）。 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  want: string,
  buffer = { text: '' },
) {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 2_000;
  while (!buffer.text.includes(want)) {
    if (Date.now() > deadline) throw new Error(`等不到 ${want}，已收到：${buffer.text}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`流提前结束，已收到：${buffer.text}`);
    buffer.text += decoder.decode(value, { stream: true });
  }
  return buffer;
}

function lastData(text: string, event: string): unknown {
  const block = text
    .split('\n\n')
    .filter((b) => b.startsWith(`event: ${event}\n`))
    .at(-1);
  return JSON.parse(
    block
      ?.split('\n')
      .find((l) => l.startsWith('data: '))
      ?.slice(6) ?? 'null',
  );
}

describe('实时推送（SSE）', () => {
  it('先发 ready；数据库一变推 change（表名 + 主键）；断过线推 resync；断开后退订', async () => {
    const h = harness();
    const { cookie } = await h.login();
    let subscribers = 0;
    const original = h.changes.subscribe;
    h.changes.subscribe = (listener) => {
      subscribers += 1;
      const off = original(listener);
      return () => {
        subscribers -= 1;
        off();
      };
    };

    const res = await h.cockpit.request('/api/events', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    if (!res.body) throw new Error('没有响应体');
    const reader = res.body.getReader();
    const buf = await readUntil(reader, 'event: ready');
    expect(subscribers).toBe(1);

    h.changes.publish({ type: 'change', table: 'tasks', id: 'task-12' });
    await readUntil(reader, 'event: change', buf);
    expect(ChangeEventSchema.parse(lastData(buf.text, 'change'))).toEqual({ table: 'tasks', id: 'task-12' });

    h.changes.publish({ type: 'resync' });
    await readUntil(reader, 'event: resync', buf);

    await reader.cancel();
    for (let i = 0; i < 50 && subscribers > 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(subscribers).toBe(0);
  });

  it('驾驶舱里的写操作经数据库变化推给所有打开的页面', async () => {
    const h = harness();
    const session = await h.login();
    const res = await h.cockpit.request('/api/events', { headers: { cookie: session.cookie } });
    if (!res.body) throw new Error('没有响应体');
    const reader = res.body.getReader();
    const buf = await readUntil(reader, 'event: ready');
    await h.cockpit.request('/api/routing/channels/ch-cursor', write('PATCH', session, { enabled: false }));
    await readUntil(reader, '"table":"channels"', buf);
    await reader.cancel();
  });

  it('没登录不给连', async () => {
    const h = harness();
    expect(await errorCode(await h.cockpit.request('/api/events'))).toBe('unauthenticated');
  });
});
