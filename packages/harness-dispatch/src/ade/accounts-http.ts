// 账号和中转的 HTTP（#3925）。密钥只写进数据目录，响应里不带回。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AdeError, type AdeService } from './service.ts';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.toLowerCase().startsWith('application/json')) throw new AdeError('要 application/json', 415);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    n += buf.length;
    if (n > 64 * 1024) throw new AdeError('请求体太大', 413);
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AdeError('请求体不是 JSON', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new AdeError('请求体要是对象', 400);
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function envRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string') out[key] = item;
  return out;
}

const AGENT = '(claude|grok|codex|pi)';

export async function routeAccounts(
  ade: AdeService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (path === '/api/ade/accounts' && method === 'GET') {
    send(res, 200, await ade.accountsView());
    return true;
  }
  if (path === '/api/ade/quota' && method === 'GET') {
    send(res, 200, await ade.quotaView());
    return true;
  }
  if (path === '/api/ade/accounts' && method === 'POST') {
    const body = await readJson(req);
    send(res, 200, await ade.selectAccount(str(body.agent), str(body.tier)));
    return true;
  }
  const active = new RegExp(`^/api/ade/accounts/${AGENT}/active$`).exec(path);
  if (active && method === 'POST') {
    const body = await readJson(req);
    const id = body.id;
    send(res, 200, await ade.activateAccount(active[1] ?? '', id === null ? null : str(id)));
    return true;
  }
  const one = new RegExp(`^/api/ade/accounts/${AGENT}(?:/([^/]+))?$`).exec(path);
  if (one && method === 'POST' && !one[2]) {
    const body = await readJson(req);
    send(res, 201, await ade.createAccount(one[1] ?? '', str(body.label), envRecord(body.env)));
    return true;
  }
  if (one && method === 'DELETE' && one[2]) {
    send(res, 200, await ade.deleteAccount(one[1] ?? '', decodeURIComponent(one[2])));
    return true;
  }
  if (path === '/api/ade/relays' && method === 'POST') {
    const body = await readJson(req);
    send(
      res,
      201,
      await ade.createRelay({
        name: str(body.name),
        baseUrl: str(body.baseUrl),
        key: str(body.key),
        models: body.models,
      }),
    );
    return true;
  }
  const relay = /^\/api\/ade\/relays\/([^/]+)$/.exec(path);
  if (relay && method === 'DELETE') {
    send(res, 200, await ade.deleteRelay(decodeURIComponent(relay[1] ?? '')));
    return true;
  }
  return false;
}
