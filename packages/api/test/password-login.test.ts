// 账密登录（#120）：密码哈希、登录、防暴力、设置页接口。每条失败路径都故意造一遍。
import { AuthConfigResponse, CredentialsResponse, MeResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { recentFeishuLogin } from '../src/credentials.ts';
import { createLoginThrottle, LOCK_MS } from '../src/login-throttle.ts';
import {
  checkNewPassword,
  checkUsername,
  hashPassword,
  PasswordHashFormatError,
  SCRYPT_PARAMS,
  verifyPassword,
} from '../src/password.ts';
import {
  cookieHeader,
  DEV_USER_ID,
  errorCode,
  harness,
  IDS,
  PUBLIC_ORIGIN,
  setCookies,
  viaGateway,
  write,
} from './harness.ts';

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'another-long-secret-9';
const IP = '203.0.113.7';

type H = ReturnType<typeof harness>;

function passwordLogin(h: H, username: string, password: string, headers: Record<string, string> = {}) {
  return h.cockpit.request('/auth/password/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN, 'x-real-ip': IP, ...headers },
    body: JSON.stringify({ username, password }),
  });
}

/** 飞书登录后在设置页设第一次：用户名 founder-a、密码 PASSWORD。 */
async function setFirst(h: H, username = 'Founder-A', password = PASSWORD) {
  const session = await h.login();
  const res = await h.cockpit.request(
    '/api/me/credentials',
    write('PUT', session, { username, newPassword: password }),
  );
  expect(res.status, await res.clone().text()).toBe(204);
  return session;
}

async function body(res: Response) {
  return (await res.json()) as { error: { code: string; details?: Record<string, unknown> } };
}

describe('密码哈希（crypto.scrypt）', () => {
  it('带参数和盐；同一个密码两次哈希不一样；对的验得过、错的验不过', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).toMatch(
      new RegExp(`^scrypt\\$${SCRYPT_PARAMS.N}\\$${SCRYPT_PARAMS.r}\\$${SCRYPT_PARAMS.p}\\$`),
    );
    expect(a).not.toBe(b);
    expect(a).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}x`, a)).toBe(false);
  });

  it('参数是 OWASP 列的等强度组合之一（N=2^15、r=8、p=3）', () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 3 });
  });

  it('库里的哈希格式认不出：抛 PasswordHashFormatError，不当成「密码错」', async () => {
    const good = await hashPassword(PASSWORD);
    const parts = good.split('$');
    const bad = [
      '',
      'plain-text-password',
      `bcrypt$${parts.slice(1).join('$')}`,
      parts.slice(0, 5).join('$'),
      ['scrypt', 'abc', ...parts.slice(2)].join('$'),
      ['scrypt', 3000, ...parts.slice(2)].join('$'), // N 不是 2 的幂
      ['scrypt', 2 ** 22, ...parts.slice(2)].join('$'), // N 超上限：不许拿库里的值吃光内存
      ['scrypt', parts[1], 99, ...parts.slice(3)].join('$'),
      [...parts.slice(0, 4), 'c2FsdA', parts[5]].join('$'), // 盐太短
      // 规范哈希后面多个非法字符：Buffer.from 会悄悄跳过，必须按格式认不出处理（第二意见第 1 轮）
      [...parts.slice(0, 4), `${parts[4]}!`, parts[5]].join('$'),
      [...parts.slice(0, 5), `${parts[5]}!`].join('$'),
      [...parts.slice(0, 5), `${parts[5]}=`].join('$'),
      [...parts.slice(0, 5), ` ${parts[5]}`].join('$'),
    ];
    for (const stored of bad) {
      await expect(verifyPassword(PASSWORD, stored), stored).rejects.toBeInstanceOf(PasswordHashFormatError);
    }
  });

  it('新密码至少 10 位、不超 256 字节；用户名格式', () => {
    expect(checkNewPassword('123456789')?.code).toBe('weak_password');
    expect(checkNewPassword('1234567890')).toBeNull();
    expect(checkNewPassword('x'.repeat(257))?.code).toBe('password_too_long');
    expect(checkUsername('ab')?.code).toBe('invalid_username');
    expect(checkUsername('-abc')?.code).toBe('invalid_username');
    expect(checkUsername('has space')?.code).toBe('invalid_username');
    expect(checkUsername('Founder.A_1')).toBeNull();
  });
});

describe('账密登录', () => {
  it('登录页配置里有 passwordLogin: true', async () => {
    const h = harness();
    const res = await h.cockpit.request('/auth/config');
    expect(AuthConfigResponse.parse(await res.json()).passwordLogin).toBe(true);
  });

  it('设了密码能登上：204 + 和飞书登录同一种会话 Cookie，用户名大小写不敏感', async () => {
    const h = harness();
    await setFirst(h);
    const res = await passwordLogin(h, 'founder-a', PASSWORD);
    expect(res.status).toBe(204);
    const session = setCookies(res).find((c) => c.startsWith('__Host-fleet_session='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    const me = await h.cockpit.request('/api/me', { headers: { cookie: cookieHeader(res) } });
    expect(me.status).toBe(200);
    expect(MeResponse.parse(await me.json()).user.id).toBe(DEV_USER_ID);
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'login',
      ok: true,
      actor: { id: DEV_USER_ID },
      after: { method: 'password' },
    });
  });

  it('密码错、没这个人、没设过密码、不在白名单：一律 401 bad_credentials，答复一模一样，不发 Cookie', async () => {
    const h = harness();
    await setFirst(h);
    // 机器人不在驾驶舱白名单里：库里给它硬塞一个密码也登不上
    await h.store.setPasswordCredentials(
      {
        userId: IDS.botWorker,
        username: 'robot',
        passwordHash: await hashPassword(PASSWORD),
        at: new Date(),
      },
      { actor: { kind: 'engine', id: 't' }, action: 't', target: 't', via: 'engine', ok: true },
    );
    // 创始人乙只有用户名、没有密码
    await h.store.setPasswordCredentials(
      { userId: IDS.founderB, username: 'founder-b', at: new Date() },
      { actor: { kind: 'engine', id: 't' }, action: 't', target: 't', via: 'engine', ok: true },
    );
    const answers: string[] = [];
    for (const [user, pass] of [
      ['founder-a', 'wrong-password-123'],
      ['nobody-here', PASSWORD],
      ['founder-b', PASSWORD],
      ['robot', PASSWORD],
    ] as const) {
      const res = await passwordLogin(h, user, pass, { 'x-real-ip': `198.51.100.${answers.length}` });
      expect(res.status, user).toBe(401);
      expect(
        setCookies(res).some((c) => c.startsWith('__Host-fleet_session=')),
        user,
      ).toBe(false);
      answers.push(await res.text());
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0] ?? '{}').error.code).toBe('bad_credentials');
    const failures = h.store.data.audit.filter((a) => a.action === 'login' && !a.ok);
    expect(failures).toHaveLength(4);
    expect(failures.every((a) => a.error === 'bad_credentials')).toBe(true);
  });

  it('同一用户名连错 5 次：第 5 次就 429 带到期时刻；锁期内对的密码也进不去；15 分钟后能进', async () => {
    const h = harness();
    await setFirst(h);
    for (let i = 1; i <= 4; i++) {
      // 每次换个来源：证明锁的是用户名，不是来源
      const res = await passwordLogin(h, 'founder-a', `wrong-password-${i}`, {
        'x-real-ip': `198.51.100.${i}`,
      });
      expect(res.status).toBe(401);
    }
    const fifth = await passwordLogin(h, 'founder-a', 'wrong-password-5', { 'x-real-ip': '198.51.100.5' });
    expect(fifth.status).toBe(429);
    const until = (await body(fifth)).error.details?.until;
    expect(until).toBe(new Date(h.clock.now.getTime() + LOCK_MS).toISOString());

    const right = await passwordLogin(h, 'FOUNDER-A', PASSWORD, { 'x-real-ip': '198.51.100.6' });
    expect(right.status).toBe(429);
    expect(setCookies(right).some((c) => c.startsWith('__Host-fleet_session='))).toBe(false);
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'login', ok: false, error: 'locked' });

    h.clock.now = new Date(h.clock.now.getTime() + LOCK_MS + 1000);
    expect((await passwordLogin(h, 'founder-a', PASSWORD, { 'x-real-ip': '198.51.100.7' })).status).toBe(204);
  });

  it('登上一次就清零：错 4 次、登上、再错 4 次也不锁', async () => {
    const h = harness();
    await setFirst(h);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) {
        expect((await passwordLogin(h, 'founder-a', 'wrong-password-x')).status).toBe(401);
      }
      expect((await passwordLogin(h, 'founder-a', PASSWORD)).status).toBe(204);
    }
  });

  it('同一来源连错 5 次（每次换用户名）：这个来源锁 15 分钟，连对的账号也不放；别的来源不受影响', async () => {
    const h = harness();
    await setFirst(h);
    for (let i = 1; i <= 5; i++) {
      const res = await passwordLogin(h, `guess-${i}`, 'whatever-password');
      expect(res.status).toBe(i < 5 ? 401 : 429);
    }
    expect((await passwordLogin(h, 'founder-a', PASSWORD)).status).toBe(429);
    expect((await passwordLogin(h, 'founder-a', PASSWORD, { 'x-real-ip': '192.0.2.1' })).status).toBe(204);
  });

  it('库里没有的用户名也照样计数上锁（锁不锁看不出用户名存不存在）', async () => {
    const h = harness();
    for (let i = 1; i <= 5; i++) {
      const res = await passwordLogin(h, 'no-such-user', 'whatever-password', {
        'x-real-ip': `198.51.100.${i}`,
      });
      expect(res.status).toBe(i < 5 ? 401 : 429);
    }
  });

  it('日志和操作记录里搜不到明文密码、来源地址、没登成的用户名', async () => {
    const h = harness();
    await setFirst(h);
    await passwordLogin(h, 'founder-a', 'wrong-but-secret-1');
    await passwordLogin(h, 'typed-my-password-here', 'wrong-but-secret-2');
    await passwordLogin(h, 'founder-a', PASSWORD);
    const all = JSON.stringify({ logs: h.logs, audit: h.store.data.audit });
    for (const secret of [
      PASSWORD,
      'wrong-but-secret-1',
      'wrong-but-secret-2',
      IP,
      'typed-my-password-here',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('库里的哈希坏了：500 password_hash_unreadable 并记日志，不装成「密码错」', async () => {
    const h = harness();
    await setFirst(h);
    const creds = h.store.data.credentials.get(DEV_USER_ID);
    if (!creds) throw new Error('没设上');
    h.store.data.credentials.set(DEV_USER_ID, { ...creds, passwordHash: 'md5$deadbeef' });
    const res = await passwordLogin(h, 'founder-a', PASSWORD);
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('password_hash_unreadable');
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('哈希'))).toBe(true);
  });

  it('白名单里的人却读不到登录信息：500 credentials_missing 并记日志，不装成「没设密码」、不记输错（第二意见第 2 轮）', async () => {
    const h = harness();
    await setFirst(h);
    h.store.getPasswordCredentials = async () => null;
    const res = await passwordLogin(h, 'founder-a', PASSWORD);
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('credentials_missing');
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('读不到'))).toBe(true);
    expect(h.store.data.credentials.get(DEV_USER_ID)?.failedLogins).toBe(0);
  });

  it('别的站发来的登录请求（Origin 不是驾驶舱）：403，不验密码', async () => {
    const h = harness();
    await setFirst(h);
    const res = await passwordLogin(h, 'founder-a', PASSWORD, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('csrf_origin');
  });

  it('请求体不合约定：400，不是 500', async () => {
    const h = harness();
    const res = await h.cockpit.request('/auth/password/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ username: 'founder-a' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('设置页：看、设、改账密', () => {
  it('没设过：hasPassword=false；飞书刚登录 10 分钟内 canSetWithoutCurrent=true，过了就 false、设不了', async () => {
    const h = harness();
    const session = await h.login();
    const get = async () =>
      CredentialsResponse.parse(
        await (
          await h.cockpit.request('/api/me/credentials', { headers: { cookie: session.cookie } })
        ).json(),
      );
    expect(await get()).toEqual({
      hasPassword: false,
      username: null,
      passwordChangedAt: null,
      canSetWithoutCurrent: true,
    });
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 60_000);
    expect((await get()).canSetWithoutCurrent).toBe(false);
    const res = await h.cockpit.request(
      '/api/me/credentials',
      write('PUT', session, { username: 'founder-a', newPassword: PASSWORD }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('recent_feishu_login_required');
    expect(h.store.data.credentials.get(DEV_USER_ID)).toBeUndefined();
  });

  it('#120 之前发的会话（没有登录方式）、账密登录来的会话：都不算「刚用飞书登录」', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const iat = Math.floor(now.getTime() / 1000);
    const base = { uid: 'u', sid: 's', iat, exp: iat + 100 };
    expect(recentFeishuLogin({ ...base, m: 'feishu-oauth' }, now)).toBe(true);
    expect(recentFeishuLogin({ ...base, m: 'feishu-in-app' }, now)).toBe(true);
    expect(recentFeishuLogin(base, now)).toBe(false);
    expect(recentFeishuLogin({ ...base, m: 'password' }, now)).toBe(false);
    expect(recentFeishuLogin({ ...base, m: 'dev-login' }, now)).toBe(false);
    expect(recentFeishuLogin(undefined, now)).toBe(false);
  });

  it('设第一次：记下用户名和改密时间，操作记录里有、没有密码和哈希', async () => {
    const h = harness();
    await setFirst(h);
    const creds = h.store.data.credentials.get(DEV_USER_ID);
    expect(creds?.username).toBe('Founder-A');
    expect(creds?.passwordChangedAt).toBe(h.clock.now.toISOString());
    const entry = h.store.data.audit.at(-1);
    expect(entry).toMatchObject({ action: 'credentials.set', target: `user:${DEV_USER_ID}`, ok: true });
    const text = JSON.stringify(h.store.data.audit);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(creds?.passwordHash ?? '(none)');
  });

  it('校验失败：400 带 field，什么都不改', async () => {
    const h = harness();
    const session = await h.login();
    const cases: [unknown, string, string | undefined][] = [
      [{ username: 'founder-a', newPassword: 'short' }, 'weak_password', 'newPassword'],
      [{ username: 'a b', newPassword: PASSWORD }, 'invalid_username', 'username'],
      [{ newPassword: PASSWORD }, 'username_required', 'username'],
      [{}, 'nothing_to_change', undefined],
    ];
    for (const [payload, code, field] of cases) {
      const res = await h.cockpit.request('/api/me/credentials', write('PUT', session, payload));
      expect(res.status, code).toBe(400);
      const b = await body(res);
      expect(b.error.code).toBe(code);
      expect(b.error.details?.field).toBe(field);
    }
    expect(h.store.data.credentials.get(DEV_USER_ID)).toBeUndefined();
  });

  it('用户名被别人占了（大小写不同也算）：400 username_taken', async () => {
    const h = harness();
    await h.store.setPasswordCredentials(
      { userId: IDS.founderB, username: 'taken-name', at: new Date() },
      { actor: { kind: 'engine', id: 't' }, action: 't', target: 't', via: 'engine', ok: true },
    );
    const session = await h.login();
    const res = await h.cockpit.request(
      '/api/me/credentials',
      write('PUT', session, { username: 'Taken-Name', newPassword: PASSWORD }),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('username_taken');
  });

  it('设过之后改：不带当前密码 400、当前密码错 401 并计数、对了 204；新密码能登、旧的不能', async () => {
    const h = harness();
    const session = await setFirst(h);
    const put = (payload: unknown) =>
      h.cockpit.request('/api/me/credentials', write('PUT', session, payload));

    const missing = await put({ newPassword: NEW_PASSWORD });
    expect(missing.status).toBe(400);
    expect((await body(missing)).error).toMatchObject({
      code: 'current_password_required',
      details: { field: 'currentPassword' },
    });

    const wrong = await put({ newPassword: NEW_PASSWORD, currentPassword: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(await errorCode(wrong)).toBe('bad_current_password');
    expect(h.store.data.credentials.get(DEV_USER_ID)?.failedLogins).toBe(1);
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'credentials.change',
      ok: false,
      error: 'bad_current_password',
    });

    const ok = await put({ newPassword: NEW_PASSWORD, currentPassword: PASSWORD, username: 'boss' });
    expect(ok.status).toBe(204);
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'credentials.change', ok: true });
    expect((await passwordLogin(h, 'founder-a', PASSWORD)).status).toBe(401);
    expect((await passwordLogin(h, 'boss', PASSWORD)).status).toBe(401);
    expect((await passwordLogin(h, 'boss', NEW_PASSWORD)).status).toBe(204);
  });

  it('当前密码连错 5 次也锁：之后对的当前密码也改不了（429）', async () => {
    const h = harness();
    const session = await setFirst(h);
    const put = (current: string) =>
      h.cockpit.request(
        '/api/me/credentials',
        write('PUT', session, { newPassword: NEW_PASSWORD, currentPassword: current }),
      );
    for (let i = 1; i <= 4; i++) expect((await put(`wrong-current-${i}`)).status).toBe(401);
    expect((await put('wrong-current-5')).status).toBe(429);
    expect((await put(PASSWORD)).status).toBe(429);
  });

  it('写操作没带 CSRF 令牌：403；飞书网关的通行证：进不了这两个接口', async () => {
    const h = harness();
    const session = await h.login();
    const noCsrf = await h.cockpit.request('/api/me/credentials', {
      method: 'PUT',
      headers: { cookie: session.cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'founder-a', newPassword: PASSWORD }),
    });
    expect(noCsrf.status).toBe(403);
    for (const method of ['GET', 'PUT'] as const) {
      const res = await h.cockpit.request(
        '/api/me/credentials',
        viaGateway(method, 'ou_dev_founder_a', method === 'PUT' ? { newPassword: PASSWORD } : undefined),
      );
      expect(res.status, method).toBe(403);
    }
    expect(h.store.data.credentials.get(DEV_USER_ID)).toBeUndefined();
  });

  it('没登录：401', async () => {
    const h = harness();
    expect((await h.cockpit.request('/api/me/credentials')).status).toBe(401);
  });
});

describe('防暴力计数（内存里的那一份）', () => {
  it('第 5 次锁上，锁期内再错不延长，过期后从头算；键数有上限', () => {
    const t = createLoginThrottle({ maxKeys: 3 });
    for (let i = 1; i <= 4; i++) expect(t.fail('k', 1000)).toBeUndefined();
    expect(t.fail('k', 1000)).toBe(1000 + LOCK_MS);
    expect(t.fail('k', 2000)).toBe(1000 + LOCK_MS);
    expect(t.lockedUntil('k', 1000 + LOCK_MS)).toBeUndefined();
    expect(t.fail('k', 1000 + LOCK_MS)).toBeUndefined();
    for (const k of ['a', 'b', 'c', 'd']) t.fail(k, 5000);
    expect(t.size()).toBeLessThanOrEqual(3);
  });

  it('键满了也不扔正锁着的：拿一批新键刷不掉已有的锁（第二意见第 2 轮）', () => {
    const t = createLoginThrottle({ maxKeys: 2 });
    for (let i = 0; i < 5; i++) t.fail('locked-source', 1000);
    expect(t.lockedUntil('locked-source', 1000)).toBe(1000 + LOCK_MS);
    for (let i = 0; i < 100; i++) t.fail(`spam-${i}`, 2000);
    expect(t.lockedUntil('locked-source', 3000)).toBe(1000 + LOCK_MS);
    expect(t.size()).toBeLessThanOrEqual(2);
  });
});
