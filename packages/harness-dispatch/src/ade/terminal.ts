// 会话终端（#3927）。一个会话一条，目录用会话自己的 cwd，浏览器不能另选。
// 输出先攒着（大约 256KB），第一条 SSE 接上之后只推新的，不重放。
// 关掉页面再开不会接回：流一断（没有听的人了）就关掉这个 runId，进程退出。未做接回。
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HostdError } from '@fleet-dao/harness-runner';
import { readJson } from './body.ts';
import { AdeError, type AdeService } from './service.ts';

const BUFFER_CAP = 256 * 1024;

export interface PtyHost {
  open(opts: {
    runId: string;
    cwd: string;
    cols: number;
    rows: number;
    onData: (base64: string) => void;
    onExit: (code: number | null, signal: string | null) => void;
  }): Promise<void>;
  input(runId: string, data: string): Promise<void>;
  resize(runId: string, cols: number, rows: number): Promise<void>;
  close(runId: string): Promise<void>;
}

const bound = new WeakMap<AdeService, PtyHost | null>();

export function bindPtyHost(ade: AdeService, host: PtyHost | null): void {
  bound.set(ade, host);
}

/** 第一次真正开终端才去起 hostd。没有可执行文件时开终端回 503，内核照样能起来。 */
export function lazyPtyHost(factory: () => PtyHost | null): PtyHost {
  let inner: PtyHost | null | undefined;
  const get = (): PtyHost => {
    if (inner === undefined) inner = factory();
    if (!inner) throw new AdeError('本机没有终端（hostd 没装好）', 503);
    return inner;
  };
  return {
    open: (opts) => get().open(opts),
    input: (runId, data) => get().input(runId, data),
    resize: (runId, cols, rows) => get().resize(runId, cols, rows),
    close: (runId) => get().close(runId),
  };
}

interface Live {
  runId: string;
  buffer: string[];
  bufferedBytes: number;
  listeners: Set<ServerResponse>;
  exited: { code: number | null; signal: string | null } | null;
  closing: boolean;
  heartbeat: ReturnType<typeof setInterval> | undefined;
}

const lives = new WeakMap<AdeService, Map<string, Live>>();

function terms(ade: AdeService): Map<string, Live> {
  let map = lives.get(ade);
  if (!map) {
    map = new Map();
    lives.set(ade, map);
  }
  return map;
}

function requireHost(ade: AdeService): PtyHost {
  const host = bound.get(ade);
  if (!host) throw new AdeError('本机没有终端（hostd 没装好）', 503);
  return host;
}

function fail(err: unknown): never {
  if (err instanceof AdeError) throw err;
  if (err instanceof HostdError) {
    const status =
      err.code === 'bad_input' || err.code === 'bad_frame'
        ? 400
        : err.code === 'run_not_found'
          ? 404
          : err.code === 'spawn_failed'
            ? 503
            : 500;
    throw new AdeError(err.message, status);
  }
  throw err;
}

function size(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1000) {
    throw new AdeError(`${name} 要是 1 到 1000 的整数`, 400);
  }
  return v;
}

function makeRunId(sessionId: string): string {
  const id = `pty-${sessionId}-${randomBytes(8).toString('hex')}`;
  return id.length <= 200 ? id : id.slice(0, 200);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function pushChunk(live: Live, b64: string): void {
  if (live.listeners.size > 0) {
    const line = `event: data\ndata: ${b64}\n\n`;
    for (const listener of live.listeners) listener.write(line);
    return;
  }
  live.buffer.push(b64);
  live.bufferedBytes += Buffer.from(b64, 'base64').length;
  while (live.bufferedBytes > BUFFER_CAP && live.buffer.length > 1) {
    const drop = live.buffer.shift() ?? '';
    live.bufferedBytes -= Buffer.from(drop, 'base64').length;
  }
}

async function closeLive(ade: AdeService, sessionId: string, runId: string): Promise<void> {
  const live = terms(ade).get(sessionId);
  if (!live || live.runId !== runId || live.closing) return;
  live.closing = true;
  terms(ade).delete(sessionId);
  if (live.heartbeat) clearInterval(live.heartbeat);
  const payload = JSON.stringify(live.exited ?? { code: null, signal: null });
  for (const listener of live.listeners) {
    listener.write(`event: exit\ndata: ${payload}\n\n`);
    listener.end();
  }
  live.listeners.clear();
  try {
    await requireHost(ade).close(runId);
  } catch (err) {
    if (err instanceof HostdError && err.code === 'run_not_found') return;
    if (err instanceof AdeError && err.status === 404) return;
    throw err;
  }
}

async function openTerminal(
  ade: AdeService,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const session = await ade.getSession(sessionId);
  if (!session.cwd) throw new AdeError('这个会话没有目录', 400);
  const cols = size(body.cols, 'cols');
  const rows = size(body.rows, 'rows');
  const host = requireHost(ade);
  const prev = terms(ade).get(sessionId);
  if (prev) await closeLive(ade, sessionId, prev.runId);
  const runId = makeRunId(sessionId);
  const live: Live = {
    runId,
    buffer: [],
    bufferedBytes: 0,
    listeners: new Set(),
    exited: null,
    closing: false,
    heartbeat: undefined,
  };
  terms(ade).set(sessionId, live);
  try {
    await host.open({
      runId,
      cwd: session.cwd,
      cols,
      rows,
      onData: (b64) => {
        const cur = terms(ade).get(sessionId);
        if (!cur || cur.runId !== runId || cur.closing) return;
        pushChunk(cur, b64);
      },
      onExit: (code, signal) => {
        const cur = terms(ade).get(sessionId);
        if (!cur || cur.runId !== runId || cur.closing) return;
        cur.exited = { code, signal };
        void closeLive(ade, sessionId, runId).catch(() => {});
      },
    });
  } catch (err) {
    if (terms(ade).get(sessionId)?.runId === runId) terms(ade).delete(sessionId);
    fail(err);
  }
  return runId;
}

function streamTerminal(
  ade: AdeService,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  runId: string,
): void {
  const live = terms(ade).get(sessionId);
  if (!live || live.runId !== runId) throw new AdeError('没有这个终端', 404);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.socket?.setNoDelay(true);
  res.write(': connected\n\n');
  for (const b64 of live.buffer) res.write(`event: data\ndata: ${b64}\n\n`);
  live.buffer = [];
  live.bufferedBytes = 0;
  live.listeners.add(res);
  if (!live.heartbeat) {
    const timer = setInterval(() => {
      for (const listener of live.listeners) listener.write(': ping\n\n');
    }, 15_000);
    timer.unref();
    live.heartbeat = timer;
  }
  const drop = () => {
    live.listeners.delete(res);
    if (live.listeners.size === 0) void closeLive(ade, sessionId, runId).catch(() => {});
  };
  req.on('close', drop);
  res.on('close', drop);
}

const TERM = /^\/api\/ade\/sessions\/([^/]+)\/terminal(?:\/(input|resize|close|stream))?$/;

export async function routeTerminal(
  ade: AdeService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  const match = TERM.exec(path);
  if (!match) return false;
  const sessionId = decodeURIComponent(match[1] ?? '');
  const action = match[2] ?? '';
  const method = req.method ?? 'GET';
  if (action === 'stream') {
    if (method !== 'GET') throw new AdeError('要用 GET', 405);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const runId = url.searchParams.get('runId') ?? '';
    if (!runId) throw new AdeError('要 runId', 400);
    streamTerminal(ade, req, res, sessionId, runId);
    return true;
  }
  if (method !== 'POST') throw new AdeError('要用 POST', 405);
  const body = await readJson(req);
  if (!action) {
    sendJson(res, 200, { runId: await openTerminal(ade, sessionId, body) });
    return true;
  }
  const runId = typeof body.runId === 'string' ? body.runId : '';
  if (!runId) throw new AdeError('要 runId', 400);
  const live = terms(ade).get(sessionId);
  if (!live || live.runId !== runId) {
    if (action === 'close') {
      sendJson(res, 200, { ok: true });
      return true;
    }
    throw new AdeError('没有这个终端', 404);
  }
  const host = requireHost(ade);
  try {
    if (action === 'input') {
      await host.input(runId, typeof body.data === 'string' ? body.data : '');
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (action === 'resize') {
      await host.resize(runId, size(body.cols, 'cols'), size(body.rows, 'rows'));
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (action === 'close') {
      await closeLive(ade, sessionId, runId);
      sendJson(res, 200, { ok: true });
      return true;
    }
  } catch (err) {
    fail(err);
  }
  return false;
}
