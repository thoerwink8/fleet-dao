// 本机单口服务（#3858）：只听 127.0.0.1、无令牌的请求一律被拒、一次性登录码、令牌文件权限、Host 头防重绑、静态页。
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCockpitApi } from '../src/cockpit.ts';
import { appendToSession } from '../src/events.ts';
import {
  createLocalGateway,
  ensureLocalToken,
  LOCAL_COOKIE,
  LOCAL_TOKEN_HEADER,
  type LocalGateway,
  type LocalStatus,
  localAuthorize,
} from '../src/local.ts';

let t: TestDb;
let tmp: string;
beforeAll(async () => {
  t = await createTestDb();
  tmp = mkdtempSync(join(tmpdir(), 'fleet2-local-'));
}, 60_000);
afterAll(async () => {
  await t.close();
  rmSync(tmp, { recursive: true, force: true });
});

const STATUS: LocalStatus = {
  profile: 'local',
  version: '0.0.0',
  listen: '127.0.0.1:0',
  dataDir: 'x',
  isolation: { level: 'weak', facts: ['同一个用户'] },
  externalWrites: { github: false, egressGateway: false },
  hosts: [{ id: 'local', kind: 'local', label: '本机', isolation: 'weak' }],
  settings: [],
};

const gateways: LocalGateway[] = [];
afterEach(async () => {
  for (const g of gateways.splice(0)) await g.close();
});

const TOKEN = 'a'.repeat(64);

async function start(distDir?: string): Promise<{ base: string; g: LocalGateway }> {
  const cockpit = createCockpitApi({
    db: t.db,
    authorize: localAuthorize(TOKEN),
    apiPrefix: '/api',
    pollMs: 30,
  });
  const g = createLocalGateway({
    cockpit,
    token: TOKEN,
    status: () => STATUS,
    ...(distDir ? { distDir } : {}),
  });
  gateways.push(g);
  const port = await g.listen(0);
  return { base: `http://127.0.0.1:${port}`, g };
}

describe('只听回环', () => {
  it('监听地址是 127.0.0.1，不是 0.0.0.0 也不是 ::', async () => {
    const { g } = await start();
    const addr = g.server.address();
    expect(addr && typeof addr === 'object' ? addr.address : null).toBe('127.0.0.1');
  });
});

describe('无令牌的请求被拒', () => {
  it.each([
    '/api/sessions',
    '/api/sessions/s1/history',
    '/api/sessions/s1/events',
    '/api/work/batches',
    '/api/local/status',
  ])('%s 没令牌 401', async (path) => {
    const { base } = await start();
    const res = await fetch(base + path);
    expect(res.status).toBe(401);
  });

  it('令牌错了 401（请求头和 Cookie 两条路都是）', async () => {
    const { base } = await start();
    expect(
      (await fetch(`${base}/api/sessions`, { headers: { [LOCAL_TOKEN_HEADER]: 'b'.repeat(64) } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/api/sessions`, { headers: { cookie: `${LOCAL_COOKIE}=${'b'.repeat(64)}` } }))
        .status,
    ).toBe(401);
  });

  it('令牌对了能读；Cookie 和请求头都行', async () => {
    const { base } = await start();
    await appendToSession(t.db, 'local-demo', 'session.turn.started', { role: 'user', text: 'hi' } as never);
    const a = await fetch(`${base}/api/sessions`, { headers: { [LOCAL_TOKEN_HEADER]: TOKEN } });
    expect(a.status).toBe(200);
    const body = (await a.json()) as { sessions: { id: string }[] };
    expect(body.sessions.map((s) => s.id)).toContain('local-demo');
    const b = await fetch(`${base}/api/local/status`, { headers: { cookie: `${LOCAL_COOKIE}=${TOKEN}` } });
    expect(b.status).toBe(200);
    expect(((await b.json()) as LocalStatus).isolation.level).toBe('weak');
  });

  it('令牌放网址里一律 400', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/sessions?token=${TOKEN}`, {
      headers: { [LOCAL_TOKEN_HEADER]: TOKEN },
    });
    expect(res.status).toBe(400);
  });
});

describe('登录', () => {
  it('一次性登录码换 Cookie，用过就废', async () => {
    const { base, g } = await start();
    const code = g.issueLoginCode();
    const first = await fetch(`${base}/local-login?code=${code}`, { redirect: 'manual' });
    expect(first.status).toBe(302);
    const cookie = first.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${LOCAL_COOKIE}=${TOKEN}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect((await fetch(`${base}/local-login?code=${code}`, { redirect: 'manual' })).status).toBe(401);
  });

  it('乱写的登录码 401', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/local-login?code=nope`, { redirect: 'manual' })).status).toBe(401);
  });

  it('粘贴令牌登录：对的 204 带 Cookie，错的 401', async () => {
    const { base } = await start();
    const post = (token: string) =>
      fetch(`${base}/api/local/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    const ok = await post(TOKEN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('set-cookie')).toContain(`${LOCAL_COOKIE}=${TOKEN}`);
    expect((await post('x'.repeat(64))).status).toBe(401);
  });
});

describe('Host 头防重绑', () => {
  it('Host 不是回环名 421，回环名放行', async () => {
    const { base } = await start();
    // fetch 不让改 Host，用 node:http 发
    const { request } = await import('node:http');
    const hit = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const url = new URL(base);
        const req = request({ host: '127.0.0.1', port: url.port, path: '/', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await hit('evil.example')).toBe(421);
    expect(await hit('evil.example:80')).toBe(421);
    expect(await hit(`localhost:${new URL(base).port}`)).toBe(404); // 没配页面目录：404 不是 421
  });
});

describe('静态页', () => {
  it('放页面目录里的文件，前端路由回首页，越界路径和缺的资源文件不放', async () => {
    const dist = join(tmp, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(join(dist, 'assets', 'a.js'), 'console.log(1)');
    writeFileSync(join(tmp, 'secret.txt'), 'secret');
    const { base } = await start(dist);
    const idx = await fetch(`${base}/`);
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain('<title>t</title>');
    expect((await fetch(`${base}/assets/a.js`)).headers.get('content-type')).toContain('javascript');
    expect(await (await fetch(`${base}/hosts`)).text()).toContain('<title>t</title>');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2Fsecret.txt`)).status).not.toBe(200);
    expect(await (await fetch(`${base}/..%2Fsecret.txt`)).text()).not.toContain('secret');
  });
});

describe('存活探针 /health（桌面外壳等它通了才开窗口，#3870）', () => {
  it('不带令牌回 200 和 {"ok":true}，不泄露别的；只收 GET（Host 头防重绑在它前面，上一组已测）', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
  });
});

// Windows 的收紧动作（icacls）在装配档案里，真跑在 harness-dispatch 的测试里；这里只验本包的行为
const winStub = async () => {};

describe('令牌文件', () => {
  it('没有就生成 64 位十六进制，再读是同一个；只有本用户读得了（posix 看 0600）', async () => {
    const file = join(tmp, 'tok', 'local-token');
    const a = await ensureLocalToken(file, winStub);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await ensureLocalToken(file, winStub)).toBe(a);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('文件内容坏了就重新生成，不信任旧内容', async () => {
    const file = join(tmp, 'tok2', 'local-token');
    mkdirSync(join(tmp, 'tok2'), { recursive: true });
    writeFileSync(file, 'short');
    expect(await ensureLocalToken(file, winStub)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.skipIf(process.platform !== 'win32')('Windows 上没给收紧函数就拒绝，不假装收紧了', async () => {
    await expect(ensureLocalToken(join(tmp, 'tok3', 'local-token'))).rejects.toThrow(/restrictWindows/);
  });
});
