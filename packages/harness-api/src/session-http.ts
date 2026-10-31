// 会话历史页和 SSE 的实现，令牌口（server.ts）和驾驶舱口（cockpit.ts）共用：
// 这里不认任何凭据，「现在还准不准看」由调用方传一个函数进来，SSE 每个周期问一次。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Db, PAGE_MAX } from '@fleet-dao/harness-store';
import { gapExceeds, latestSessionEventId, readSessionAfter, readSessionHistory } from './events.ts';

export function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
}

export interface SseOptions {
  db: Db;
  replayCap: number;
  pollMs: number;
  heartbeatMs: number;
  /** 开着的连接：关服务时一起收。 */
  open: Set<() => void>;
}

/** 返回 false 表示不准看了，连接最晚下一个周期关掉。抛错按不准算。 */
export type StillAllowed = () => Promise<boolean>;

export async function serveSse(
  o: SseOptions,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  stillAllowed: StillAllowed,
): Promise<void> {
  const { db, replayCap, pollMs, heartbeatMs, open } = o;
  const header = req.headers['last-event-id'];
  const lastRaw = Array.isArray(header) ? header[0] : header;
  let cursor = 0;
  let resync = false;
  if (lastRaw === undefined || lastRaw === '') {
    cursor = await latestSessionEventId(db, sessionId);
  } else if (!/^\d{1,15}$/.test(lastRaw)) {
    resync = true;
    cursor = await latestSessionEventId(db, sessionId);
  } else {
    cursor = Number(lastRaw);
    if (await gapExceeds(db, sessionId, cursor, replayCap)) {
      resync = true;
      cursor = await latestSessionEventId(db, sessionId);
    }
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // 带 Last-Event-ID 续传时没有新事件就不会有第一个字节：先写一行注释，响应头才会真的送出去（经代理也一样），
  // 客户端才知道连上了。注释行不是事件，客户端忽略。
  res.write(': connected\n\n');
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    open.delete(finish);
    res.end();
  };
  open.add(finish);
  res.on('close', () => {
    closed = true;
    if (timer) clearTimeout(timer);
    open.delete(finish);
  });
  if (resync) res.write(`id: ${cursor}\nevent: resync\ndata: {}\n\n`);
  else if (lastRaw === undefined || lastRaw === '') res.write(`id: ${cursor}\nevent: ready\ndata: {}\n\n`);
  let lastWrite = Date.now();
  const tick = async (): Promise<void> => {
    try {
      // 凭据撤销后最晚下一次 tick 就断。
      if (!(await stillAllowed())) return finish();
      for (;;) {
        const page = await readSessionAfter(db, sessionId, cursor, PAGE_MAX);
        for (const ev of page) {
          if (closed) return;
          res.write(
            `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify({ seq: ev.seq, payload: ev.payload, createdAt: ev.createdAt })}\n\n`,
          );
          cursor = ev.id;
          lastWrite = Date.now();
        }
        if (page.length < PAGE_MAX) break;
      }
      if (!closed && Date.now() - lastWrite >= heartbeatMs) {
        res.write(': ping\n\n');
        lastWrite = Date.now();
      }
    } catch {
      return finish();
    }
    if (!closed) timer = setTimeout(() => void tick(), pollMs);
  };
  void tick();
}

/** GET /sessions/<号>/history?before=&after=&limit=：只读历史页，驾驶舱首屏和 resync 后整页重取用。 */
export async function serveHistory(db: Db, url: URL, res: ServerResponse, sessionId: string): Promise<void> {
  const num = (name: string): number | undefined | null => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  };
  const before = num('before');
  const after = num('after');
  const limit = num('limit');
  if (before === null || after === null || limit === null)
    return reply(res, 400, '游标和 limit 要是非负整数');
  if (before !== undefined && after !== undefined) return reply(res, 400, 'before 和 after 不能同时给');
  const page = await readSessionHistory(db, sessionId, {
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  res
    .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    .end(JSON.stringify(page));
}
