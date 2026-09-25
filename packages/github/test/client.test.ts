import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signAppJwt } from '../src/app-auth.ts';
import { loadAppCredentials } from '../src/credentials.ts';
import { GitHubError } from '../src/errors.ts';
import { testApps } from './fake-github.ts';
import { json, repo, setup } from './helpers.ts';

const get = { method: 'GET' as const, path: '/repos/acme/widgets', auth: { as: 'engine' as const, repo } };

describe('App 身份与安装令牌', () => {
  it('JWT：iat 往前拨 60 秒、9 分钟过期、iss 用 client id', () => {
    const app = testApps().engine;
    const now = new Date('2026-09-25T12:00:00Z');
    const [, payload] = signAppJwt(app, now).split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
    expect(claims).toEqual({
      iat: now.getTime() / 1000 - 60,
      exp: now.getTime() / 1000 + 540,
      iss: 'Iv1.engine',
    });
  });

  it('同时来的请求只换一次令牌；令牌只对这一个仓', async () => {
    const { gh, fake } = setup();
    await Promise.all([gh.client.request(get), gh.client.request(get), gh.client.request(get)]);
    expect(fake.tokensMinted).toBe(1);
    const mint = fake.calls('POST', /access_tokens$/)[0];
    expect(mint?.as).toBe('app:engine');
    expect(mint?.body).toEqual({ repositories: ['widgets'] });
    expect(fake.calls('GET', /^\/repos\/acme\/widgets$/).map((r) => r.as)).toEqual([
      'engine',
      'engine',
      'engine',
    ]);
  });

  it('剩不到 10 分钟就提前重换，长任务不会跑到一半 401', async () => {
    const { gh, fake, clock } = setup();
    await gh.client.request(get);
    clock.advance(49 * 60_000);
    await gh.client.request(get);
    expect(fake.tokensMinted).toBe(1);
    clock.advance(2 * 60_000);
    await gh.client.request(get);
    expect(fake.tokensMinted).toBe(2);
  });

  it('401：作废这枚令牌、重换一次再试', async () => {
    const { gh, fake } = setup();
    await gh.client.request(get);
    let rejected = 0;
    fake.before.push((req) => {
      if (req.path === '/repos/acme/widgets' && rejected === 0) {
        rejected += 1;
        return json(401, { message: 'Bad credentials' });
      }
      return undefined;
    });
    const res = await gh.client.request(get);
    expect(res.status).toBe(200);
    expect(fake.tokensMinted).toBe(2);
  });

  it('一直 401：报 AUTH_FAILED，不无限重试', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      req.path === '/repos/acme/widgets' ? json(401, { message: 'Bad credentials' }) : undefined,
    );
    await expect(gh.client.request(get)).rejects.toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    expect(fake.calls('GET', /^\/repos\/acme\/widgets$/)).toHaveLength(2);
  });

  it('A7：机器人没装到这个仓，报「没装到」，不报「仓不存在」或「认证失败」', async () => {
    const { gh, fake } = setup();
    fake.installed.agent = false;
    const err = await gh.client.request({ ...get, auth: { as: 'agent', repo } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ code: 'NOT_INSTALLED' });
    expect((err as Error).message).toContain('没装到 acme/widgets');
  });

  it('A7：普通接口的 404 也写明「或 App 没装到 / 没权限」', async () => {
    const { gh } = setup();
    const err = await gh.client
      .request({ ...get, path: '/repos/acme/widgets/pulls/999' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect((err as Error).message).toContain('App 没装到 acme/widgets / 没有权限');
  });

  it('403 带上 GitHub 说的「这个接口要什么权限」', async () => {
    const { gh, fake } = setup();
    fake.before.push(() =>
      json(
        403,
        { message: 'Resource not accessible by integration' },
        { 'x-accepted-github-permissions': 'administration=read' },
      ),
    );
    await expect(gh.client.request({ ...get, auth: { as: 'app', role: 'engine' } })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('administration=read'),
    });
  });
});

describe('限流（F1）', () => {
  it('次级限流按 retry-after 等，之后别的请求也先停', async () => {
    const { gh, fake, sleeps } = setup();
    await gh.client.request(get);
    let hit = false;
    fake.before.push((req) => {
      if (req.method === 'GET' && req.path === '/repos/acme/widgets' && !hit) {
        hit = true;
        return json(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '7' });
      }
      return undefined;
    });
    expect((await gh.client.request(get)).status).toBe(200);
    expect(sleeps).toContain(7000);
  });

  it('次级限流没给头：至少等 60 秒；再撞就翻倍，超过原地等的上限交给上层排期（不拿主配额余额证明「没限流」）', async () => {
    const { gh, fake, sleeps, clock } = setup();
    await gh.client.request(get);
    let n = 0;
    fake.before.push((req) => {
      if (req.path === '/repos/acme/widgets' && n < 2) {
        n += 1;
        return json(429, { message: 'secondary rate limit' }, { 'x-ratelimit-remaining': '4975' });
      }
      return undefined;
    });
    await expect(gh.client.request(get)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      details: { retryAfterSeconds: 120 },
    });
    expect(sleeps.filter((s) => s >= 60_000)).toEqual([60_000]);
    // 限流期间别的请求也先停：要停的时间超过上限，当场报可重试，不干等
    await expect(gh.client.request(get)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(fake.calls('GET', /^\/repos\/acme\/widgets$/)).toHaveLength(3);
    clock.advance(120_000);
    expect((await gh.client.request(get)).status).toBe(200);
  });

  it('主配额用完：等到 x-ratelimit-reset', async () => {
    const { gh, fake, sleeps, clock } = setup();
    await gh.client.request(get);
    const reset = Math.floor(clock.now().getTime() / 1000) + 30;
    let hit = false;
    fake.before.push((req) => {
      if (req.path === '/repos/acme/widgets' && !hit) {
        hit = true;
        return json(
          403,
          { message: 'API rate limit exceeded' },
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        );
      }
      return undefined;
    });
    await gh.client.request(get);
    expect(sleeps).toContain(31_000);
  });

  it('要等太久：不干等，抛可重试的 RATE_LIMITED 并带上要等几秒', async () => {
    const { gh, fake } = setup();
    fake.before.push(() => json(403, { message: 'secondary rate limit' }, { 'retry-after': '3600' }));
    await expect(gh.client.request({ ...get, auth: { as: 'app', role: 'engine' } })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      details: { retryAfterSeconds: 3600 },
    });
  });
});

describe('写请求', () => {
  it('全局串行、间隔至少 1 秒', async () => {
    const { gh, fake, sleeps } = setup();
    const issue = fake.addIssue();
    const patch = (body: string) =>
      gh.client.request({
        method: 'PATCH',
        path: `/repos/acme/widgets/issues/${issue.number}`,
        auth: { as: 'engine', repo },
        body: { body },
      });
    await Promise.all([patch('a'), patch('b'), patch('c')]);
    expect(sleeps.filter((s) => s === 1000)).toHaveLength(2);
    expect(issue.body).toBe('c');
  });

  it('POST 断在回执上：不自动重试（可能已经写成），报 AMBIGUOUS_WRITE', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    fake.dropAfter.push((req) => req.method === 'POST' && req.path.endsWith('/comments'));
    const err = await gh.client
      .request({
        method: 'POST',
        path: `/repos/acme/widgets/issues/${issue.number}/comments`,
        auth: { as: 'engine', repo },
        body: { body: 'x' },
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'AMBIGUOUS_WRITE', retryable: true, maybeLanded: true });
    expect(issue.comments).toHaveLength(1);
    expect(fake.calls('POST', /\/comments$/)).toHaveLength(1);
  });

  it('读请求遇 502 会重试', async () => {
    const { gh, fake } = setup();
    let n = 0;
    fake.before.push((req) =>
      req.path === '/repos/acme/widgets' && n++ < 2 ? json(502, { message: 'Bad Gateway' }) : undefined,
    );
    expect((await gh.client.request(get)).status).toBe(200);
  });

  it('翻页跟着 Link 头走完', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    for (let i = 0; i < 230; i += 1)
      issue.comments.push({ id: i + 1, body: `c${i}`, user: fake.human, updated_at: '2026-09-25T00:00:00Z' });
    const all = await gh.client.all({
      method: 'GET',
      path: `/repos/acme/widgets/issues/${issue.number}/comments`,
      auth: { as: 'engine', repo },
      query: { per_page: 100 },
    });
    expect(all).toHaveLength(230);
  });

  it('翻到页数上限还没翻完：报「没查成」，不悄悄截断当全看过了', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    for (let i = 0; i < 230; i += 1)
      issue.comments.push({ id: i + 1, body: `c${i}`, user: fake.human, updated_at: '2026-09-25T00:00:00Z' });
    const req = {
      method: 'GET' as const,
      path: `/repos/acme/widgets/issues/${issue.number}/comments`,
      auth: { as: 'engine' as const, repo },
      query: { per_page: 100 },
    };
    await expect(gh.client.all(req, (d) => d, 2)).rejects.toMatchObject({ code: 'TOO_MANY_PAGES' });
    // 调用方自己中途停下（找到了要的）不算没翻完
    let pages = 0;
    for await (const _ of gh.client.pages(req, 2)) {
      pages += 1;
      break;
    }
    expect(pages).toBe(1);
  });
});

describe('凭据不外泄', () => {
  // details 要原样转成 PortError、进 Temporal 历史、落库：和 message 一样必须打过码
  const echo = (req: { headers: Headers }) =>
    json(422, {
      message: `bad token ${req.headers.get('authorization')}`,
      errors: [{ message: `raw ${req.headers.get('authorization')}` }],
    });

  it('GitHub 把安装令牌回显在报错里：message、details 都打码', async () => {
    const { gh, fake, logs } = setup();
    fake.before.push((req) => (req.path === '/repos/acme/widgets' ? echo(req) : undefined));
    const err = (await gh.client
      .request({ ...get, method: 'PATCH', body: {} })
      .catch((e: unknown) => e)) as GitHubError;
    expect(err.message).not.toMatch(/ghs_/);
    expect(err.message).toContain('<redacted>');
    const details = JSON.stringify(err.details);
    expect(details).not.toMatch(/ghs_|eyJ/);
    expect(details).toContain('Bearer <redacted>');
    expect(JSON.stringify(logs)).not.toMatch(/ghs_|eyJ/);
  });

  it('GitHub 把 App 的 JWT 回显在报错里：details 也打码', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) => (req.path.endsWith('/installation') ? echo(req) : undefined));
    const err = (await gh.client.request(get).catch((e: unknown) => e)) as GitHubError;
    expect(err).toBeInstanceOf(GitHubError);
    const details = JSON.stringify(err.details);
    expect(details).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    expect(details).toContain('<redacted>');
  });

  it('逐层打码：嵌套的对象、数组、错误对象都不漏', () => {
    const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
    const err = new GitHubError('X', 'x', {
      details: { a: [{ b: `token ghs_${'x'.repeat(20)}` }], c: new Error(`boom ${jwt}`), d: 3 },
    });
    expect(JSON.stringify(err.details)).toBe(
      JSON.stringify({ a: [{ b: 'token <redacted>' }], c: 'Error: boom <redacted>', d: 3 }),
    );
  });
});

describe('A2：凭据文件', () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' })
    .toString();
  const files = (map: Record<string, string>) => (p: string) => {
    const v = map[p];
    if (v === undefined) throw Object.assign(new Error('no'), { code: 'ENOENT' });
    if (v === 'EACCES') throw Object.assign(new Error('no'), { code: 'EACCES' });
    return v;
  };

  it('文件不在 = 这台机器没装；不回退到别的身份', () => {
    expect(() => loadAppCredentials('engine', '/etc/x.json', files({}))).toThrow(
      expect.objectContaining({ code: 'NOT_INSTALLED' }),
    );
  });

  it('读不了 = 运行用户不对', () => {
    expect(() => loadAppCredentials('engine', '/etc/x.json', files({ '/etc/x.json': 'EACCES' }))).toThrow(
      expect.objectContaining({ code: 'CREDENTIALS_UNREADABLE' }),
    );
  });

  it('缺字段、私钥坏了 = 配置错了；报错不带文件内容', () => {
    const noSlug = JSON.stringify({ id: 1, pem });
    expect(() => loadAppCredentials('agent', '/x', files({ '/x': noSlug }))).toThrow(
      expect.objectContaining({ code: 'BAD_CONFIG' }),
    );
    const badPem = JSON.stringify({
      id: 1,
      slug: 'a',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----',
    });
    const err = (() => {
      try {
        loadAppCredentials('agent', '/x', files({ '/x': badPem }));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toMatchObject({ code: 'BAD_CONFIG' });
    expect(err?.message).not.toContain('nope');
  });

  it('GitHub 建 App 时回的那份 json（pem 内嵌）直接能用；也认单独的私钥文件', () => {
    const inline = JSON.stringify({
      id: 7,
      slug: 'fleet-x',
      client_id: 'Iv1.x',
      pem,
      webhook_secret: 's',
      client_secret: 'c',
    });
    expect(loadAppCredentials('agent', '/x', files({ '/x': inline }))).toMatchObject({
      appId: 7,
      slug: 'fleet-x',
      clientId: 'Iv1.x',
    });
    const split = JSON.stringify({ app_id: '8', slug: 'fleet-y', private_key_path: '/k.pem' });
    expect(loadAppCredentials('engine', '/y', files({ '/y': split, '/k.pem': pem }))).toMatchObject({
      appId: 8,
    });
  });
});
