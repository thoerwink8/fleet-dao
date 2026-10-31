// 新内核换只读令牌（#3811）：JWT 用现生成的 RSA 密钥签、用公钥验；换令牌的请求用假 fetch 断言。
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appJwt, appTokenSource } from '../src/github-app.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const dir = mkdtempSync(join(tmpdir(), 'gh-app-'));
const file = join(dir, 'app.json');
writeFileSync(file, JSON.stringify({ id: 4242, pem }));

type Call = { url: string; method: string; auth: string; body?: string };
function fakeApi(opts: { expiresInMs?: number; tokenStatus?: number; clock: { t: number } }) {
  const calls: Call[] = [];
  let n = 0;
  const f = (async (url: string | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: h.get('authorization') ?? '',
      body: init?.body as string,
    });
    if (String(url).endsWith('/installation')) return new Response(JSON.stringify({ id: 99 }));
    if (opts.tokenStatus) return new Response('no', { status: opts.tokenStatus });
    n += 1;
    return new Response(
      JSON.stringify({
        token: `ghs_${n}`,
        expires_at: new Date(opts.clock.t + (opts.expiresInMs ?? 3_600_000)).toISOString(),
      }),
    );
  }) as typeof fetch;
  return { f, calls };
}

describe('App JWT', () => {
  it('RS256：头、iat 往前 60 秒、exp 9 分钟、iss 是 App 号，公钥验得过', () => {
    const now = 1_700_000_000_000;
    const [h, p, s] = appJwt(4242, pem, now).split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: 4242,
    });
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('按仓换只读令牌', () => {
  it('先查安装、再换令牌；body 只带本仓和四项只读权限；用 JWT 授权', async () => {
    const clock = { t: Date.now() };
    const { f, calls } = fakeApi({ clock });
    const token = await appTokenSource({ file, fetch: f, now: () => clock.t })('o/r');
    expect(token).toBe('ghs_1');
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/o/r/installation', method: 'GET' });
    expect(calls[1]?.url).toBe('https://api.github.com/app/installations/99/access_tokens');
    expect(calls[1]?.method).toBe('POST');
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({
      repositories: ['r'],
      permissions: { issues: 'read', pull_requests: 'read', contents: 'read', metadata: 'read' },
    });
    expect(calls.every((c) => c.auth.startsWith('Bearer ') && c.auth.split('.').length === 3)).toBe(true);
  });

  it('按仓缓存；到期前 5 分钟换新', async () => {
    const clock = { t: Date.now() };
    const { f, calls } = fakeApi({ clock, expiresInMs: 3_600_000 });
    const get = appTokenSource({ file, fetch: f, now: () => clock.t });
    expect(await get('o/r')).toBe('ghs_1');
    expect(await get('o/r')).toBe('ghs_1');
    expect(calls.length).toBe(2);
    expect(await get('o/other')).toBe('ghs_2');
    expect(calls.length).toBe(4);
    clock.t += 3_600_000 - 5 * 60_000 - 1_000; // 离到期还有 5 分钟多一秒：还用旧的
    expect(await get('o/r')).toBe('ghs_1');
    clock.t += 2_000; // 不到 5 分钟了：换新
    expect(await get('o/r')).toBe('ghs_3');
  });

  it('换令牌失败报明确错误，不缓存、不当成没事', async () => {
    const clock = { t: Date.now() };
    const { f } = fakeApi({ clock, tokenStatus: 403 });
    const get = appTokenSource({ file, fetch: f, now: () => clock.t });
    await expect(get('o/r')).rejects.toThrow('换 o/r 的只读令牌：HTTP 403');
    await expect(get('o/r')).rejects.toThrow('HTTP 403');
  });

  it('仓没装 App、凭据文件读不到或缺字段都抛', async () => {
    const gone = (async () => new Response('', { status: 404 })) as typeof fetch;
    await expect(appTokenSource({ file, fetch: gone })('o/r')).rejects.toThrow(
      '查 o/r 的 App 安装：HTTP 404',
    );
    await expect(appTokenSource({ file: join(dir, 'none.json'), fetch: gone })('o/r')).rejects.toThrow(
      '读不了 GitHub App 凭据',
    );
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ id: 1 }));
    await expect(appTokenSource({ file: bad, fetch: gone })('o/r')).rejects.toThrow('缺 pem');
  });
});
