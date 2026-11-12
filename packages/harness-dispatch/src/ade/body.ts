// 本机 ADE 写请求的 JSON 体。上限 64KB，必须是 application/json。
import type { IncomingMessage } from 'node:http';
import { AdeError } from './service.ts';

export const MAX_BODY = 64 * 1024;

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.toLowerCase().startsWith('application/json')) throw new AdeError('要 application/json', 415);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    n += buf.length;
    if (n > MAX_BODY) throw new AdeError('请求体太大', 413);
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new AdeError('请求体要是对象', 400);
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AdeError) throw err;
    throw new AdeError('请求体不是 JSON', 400);
  }
}
