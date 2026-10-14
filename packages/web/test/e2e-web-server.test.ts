// e2e 的前端门面（e2e/support/web-server.ts）：照线上 nginx 的 try_files 伺候打包产物，/api、/auth 转后端。
// 真起一个门面和一个假后端，走一遍：静态文件、回落 index.html、跑出目录的路径不给、/api 原样转发（Host、Origin 不改）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fileFor, proxied, startWebServer, type WebServer } from '../e2e/support/web-server.ts';

let dist: string;
let web: WebServer;
let backend: Server;
let seen: { url: string; headers: IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'e2e-web-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>壳</title>');
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dist, 'sw.js'), '// sw');
  backend = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => backend.listen(0, '127.0.0.1', () => ok()));
  web = await startWebServer(dist, (backend.address() as AddressInfo).port);
});

afterAll(() => {
  web.close();
  backend.close();
  rmSync(dist, { recursive: true, force: true });
});

describe('门面', () => {
  test('静态文件按扩展名给类型；不存在的页面路径回落 index.html（单页应用）', async () => {
    const base = `http://localhost:${web.port}`;
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toBe('console.log(1)');
    for (const path of ['/', '/quota', '/tasks/abc?x=1', '/routing?tab=efforts']) {
      const page = await fetch(`${base}${path}`);
      expect(page.status, path).toBe(200);
      expect(await page.text(), path).toContain('<title>壳</title>');
    }
  });

  test('/api、/auth 原样转给后端：路径、查询串、Host、Origin 都不改', async () => {
    seen = [];
    const base = `http://localhost:${web.port}`;
    const res = await fetch(`${base}/api/settings/x?y=1`, {
      method: 'PUT',
      headers: { origin: base, 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    await fetch(`${base}/auth/config`);
    expect(seen.map((s) => s.url)).toEqual(['/api/settings/x?y=1', '/auth/config']);
    expect(seen[0]?.headers.host).toBe(`localhost:${web.port}`);
    expect(seen[0]?.headers.origin).toBe(base);
  });

  test('不是 GET、HEAD 的非接口请求回 405', async () => {
    const res = await fetch(`http://localhost:${web.port}/quota`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('fileFor：只认产物目录里的文件', () => {
  test('文件给路径；目录、不存在、跑出目录、解不开的回 undefined', () => {
    expect(fileFor(dist, '/assets/app.js')).toBe(join(dist, 'assets', 'app.js'));
    expect(fileFor(dist, '/sw.js?v=2')).toBe(join(dist, 'sw.js'));
    expect(fileFor(dist, '/assets')).toBeUndefined();
    expect(fileFor(dist, '/nope.js')).toBeUndefined();
    expect(fileFor(dist, '/../package.json')).toBeUndefined();
    expect(fileFor(dist, '/%2e%2e/%2e%2e/x')).toBeUndefined();
    expect(fileFor(dist, '/%E0%A4%A')).toBeUndefined();
  });

  test('proxied：/api、/auth 和它们下面的才转，前缀相同的页面路径不转', () => {
    expect(proxied('/api/me')).toBe(true);
    expect(proxied('/auth/password/login')).toBe(true);
    expect(proxied('/api')).toBe(true);
    expect(proxied('/apis')).toBe(false);
    expect(proxied('/authors')).toBe(false);
    expect(proxied('/')).toBe(false);
  });
});

test('产物目录里没有 index.html：起门面就报，不起一个空站', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'e2e-web-empty-'));
  try {
    await expect(startWebServer(empty, 1)).rejects.toThrow('前端没打包');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
