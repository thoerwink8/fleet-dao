// 演示版读可见范围：链接有效、作废、过期、读到的是单页回落、没连上、默认范围没发布，各走哪条路。
import { DEMO_STRICT_DEFAULT, type DemoScope } from '@fleet-dao/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import { resolveScope, sha256Hex, tokenFrom } from './scope';

const TOKEN = 'A'.repeat(43);
const NOW = new Date('2026-09-25T08:00:00Z');
const BASE = '/demo/scopes/';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = () =>
  new Response('<!doctype html><title>x</title>', { headers: { 'content-type': 'text/html' } });

/** 假的静态文件服务：路径 → 回什么；没列的回 404。记下每次请求的参数。 */
function server(files: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const f = files[u];
    return f ? f() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const LINK: DemoScope = {
  v: 1,
  modules: ['board', 'task', 'quota'],
  detail: 'titles',
  expiresAt: '2026-10-01T00:00:00Z',
};
const DEFAULT: DemoScope = { v: 1, modules: ['board', 'dispatch'], detail: 'status' };

describe('口令从地址里取', () => {
  test('?k= 或 #k=，样子不对的不认', () => {
    expect(tokenFrom(`?k=${TOKEN}`, '')).toBe(TOKEN);
    expect(tokenFrom('', `#k=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFrom('?k=short', '')).toBeNull();
    expect(tokenFrom('?k=../../etc/passwd', '')).toBeNull();
    expect(tokenFrom('', '')).toBeNull();
  });
});

describe('定下这次按哪份范围', () => {
  const defaultUrl = `${BASE}default.json`;
  let linkUrl = '';
  beforeAll(async () => {
    linkUrl = `${BASE}${await sha256Hex(TOKEN)}.json`;
  });

  test('链接有效：按链接的范围；不带任何凭据、不用缓存', async () => {
    const s = server({ [linkUrl]: () => json(LINK), [defaultUrl]: () => json(DEFAULT) });
    const r = await resolveScope({ token: TOKEN, base: BASE, now: NOW, fetch: s.fetchFn });
    expect(r).toEqual({ scope: LINK, source: 'link' });
    expect(s.calls[0]?.init?.credentials).toBe('omit');
    expect(s.calls[0]?.init?.cache).toBe('no-store');
  });

  test('链接作废了（文件撤了）：按默认范围，并说明原因', async () => {
    const s = server({ [defaultUrl]: () => json(DEFAULT) });
    const r = await resolveScope({ token: TOKEN, base: BASE, now: NOW, fetch: s.fetchFn });
    expect(r.source).toBe('default');
    expect(r.scope).toEqual(DEFAULT);
    expect(r.notice).toMatch(/作废/);
  });

  test('门面把查不到的路径回落成了单页（200 + HTML）：也算作废，不当成读坏了', async () => {
    const s = server({ [linkUrl]: html, [defaultUrl]: () => json(DEFAULT) });
    const r = await resolveScope({ token: TOKEN, base: BASE, now: NOW, fetch: s.fetchFn });
    expect(r.notice).toMatch(/作废/);
  });

  test('链接过期了：文件还在也不认（防游客改时钟之外，还防后端没来得及撤）', async () => {
    const s = server({
      [linkUrl]: () => json({ ...LINK, expiresAt: '2026-09-25T07:59:59Z' }),
      [defaultUrl]: () => json(DEFAULT),
    });
    const r = await resolveScope({ token: TOKEN, base: BASE, now: NOW, fetch: s.fetchFn });
    expect(r.source).toBe('default');
    expect(r.notice).toMatch(/过期/);
  });

  test('范围文件内容不合约定、或者没连上：照实说没读到，退回默认范围', async () => {
    const bad = server({
      [linkUrl]: () => json({ v: 1, modules: ['secrets'], detail: 'all' }),
      [defaultUrl]: () => json(DEFAULT),
    });
    const r1 = await resolveScope({ token: TOKEN, base: BASE, now: NOW, fetch: bad.fetchFn });
    expect(r1.notice).toMatch(/没读到（内容不合约定）/);
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const r2 = await resolveScope({ token: TOKEN, base: BASE, now: NOW, fetch: down });
    expect(r2.notice).toMatch(/没读到（Failed to fetch）/);
    expect(r2.source).toBe('builtin');
    expect(r2.scope).toEqual(DEMO_STRICT_DEFAULT);
  });

  test('不带链接、默认范围也没发布：用内置的最严范围，不打扰游客', async () => {
    const r = await resolveScope({ token: null, base: BASE, now: NOW, fetch: server({}).fetchFn });
    expect(r).toEqual({ scope: DEMO_STRICT_DEFAULT, source: 'builtin' });
    expect(DEMO_STRICT_DEFAULT).toEqual({ v: 1, modules: ['board'], detail: 'status' });
  });

  test('不带链接、默认范围发布了：按默认范围', async () => {
    const r = await resolveScope({
      token: null,
      base: BASE,
      now: NOW,
      fetch: server({ [defaultUrl]: () => json(DEFAULT) }).fetchFn,
    });
    expect(r).toEqual({ scope: DEFAULT, source: 'default' });
  });
});
