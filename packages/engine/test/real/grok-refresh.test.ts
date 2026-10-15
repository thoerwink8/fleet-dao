// Grok 额度读取：访问令牌过期但登录文件里还有 refresh_token 时，以会话用户跑一次 grok models 让 CLI 自己续再读。
// 读取器不碰 refresh_token。exec、fetch 全是假的。
import { SESSION_USERS } from '@fleet-dao/adapters';
import { type PoolQuotaResult, type QuotaIo, readAllQuotas } from '@fleet-dao/adapters/quota';
import { describe, expect, it } from 'vitest';
import { runQuotaReadJob } from '../../src/jobs/quota-read.ts';
import type { UserCommand, UserCommandResult } from '../../src/real/exec.ts';
import { DEFAULT_GROK_BIN } from '../../src/real/hosts.ts';
import {
  DEFAULT_MIRASIM_HOME,
  GROK_REFRESH_TIMEOUT_MS,
  quotaAsUser,
  refreshGrokLogin,
} from '../../src/real/index.ts';

const [USER] = SESSION_USERS;
const HOME = `/home/${USER}`;
const AUTH = `${HOME}/.grok/auth.json`;
const BIN = DEFAULT_GROK_BIN.replaceAll('{user}', USER as string);
const NOW = new Date('2026-10-16T17:19:00.000Z');
const STALE = 'stale-token-for-test';
const FRESH = 'fresh-token-for-test';
const REFRESH = 'refresh-token-for-test';

const BILLING = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-10-12T00:00:00+00:00',
      end: '2026-10-19T00:00:00+00:00',
    },
    creditUsagePercent: 12,
  },
};

type Mode = 'rewrites' | 'still-stale' | { code: number; stderr: string };

function authJson(key: string, expiresAt: string, refresh: string | null): string {
  return JSON.stringify({
    'https://auth.x.ai::client': {
      key,
      ...(refresh ? { refresh_token: refresh } : {}),
      expires_at: expiresAt,
    },
  });
}

function fakeWorld(mode: Mode, refresh: string | null = REFRESH) {
  const files: Record<string, string> = {
    [AUTH]: authJson(STALE, '2020-01-01T00:00:00.000Z', refresh),
  };
  const commands: UserCommand[] = [];
  const exec = async (c: UserCommand): Promise<UserCommandResult> => {
    commands.push(c);
    const base = { stdout: Buffer.alloc(0), timedOut: false, aborted: false };
    if (c.argv[0] === '/bin/cat') {
      const hit = files[c.argv[2] ?? ''];
      if (hit === undefined) return { ...base, code: 1, stderr: 'No such file or directory' };
      return { ...base, stdout: Buffer.from(hit), code: 0, stderr: '' };
    }
    if (c.argv.includes('models')) {
      if (mode === 'rewrites') files[AUTH] = authJson(FRESH, '2099-01-01T00:00:00.000Z', refresh);
      if (typeof mode === 'object') return { ...base, code: mode.code, stderr: mode.stderr };
      return { ...base, code: 0, stderr: '' };
    }
    return { ...base, code: 127, stderr: 'not expected' };
  };
  const bearers: string[] = [];
  const fetchFake = async (input: string | URL | Request, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
    bearers.push(auth);
    const url = String(input);
    if (auth !== `Bearer ${FRESH}`) return new Response('{}', { status: 401 });
    const body = url.includes('/billing') ? BILLING : { subscriptionTier: 'SuperGrok' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { exec, commands, bearers, fetch: fetchFake as typeof fetch };
}

const refuse = (what: string) => () => {
  throw new Error(`引擎自己的身份不该碰 ${what}`);
};

async function readRound(world: ReturnType<typeof fakeWorld>, withGrok = true) {
  const io = {
    fetch: world.fetch,
    runCommand: refuse('runCommand'),
    readFile: refuse('readFile'),
    listDir: refuse('listDir'),
    openWebSocket: refuse('openWebSocket'),
    workDir: async () => '/nowhere',
    homeDir: '/home/engine-user',
    env: {},
    now: () => NOW,
  } as unknown as QuotaIo;
  const report = await readAllQuotas(
    {
      pools: [{ poolId: 'grok', channelId: 'xai', name: 'Grok', reader: 'grok-billing', authFile: AUTH }],
    } as never,
    {
      ...io,
      asUser: quotaAsUser(
        world.exec,
        USER as never,
        DEFAULT_MIRASIM_HOME,
        undefined,
        undefined,
        undefined,
        withGrok ? DEFAULT_GROK_BIN : undefined,
      ),
    },
  );
  return report.results[0] as PoolQuotaResult;
}

async function alertBody(result: PoolQuotaResult, last: Date | null): Promise<string | undefined> {
  const raised: { body: string }[] = [];
  await runQuotaReadJob({
    loadConfig: async () => ({ pools: [{ poolId: 'grok' }] }) as never,
    read: async () => ({
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      results: [result],
    }),
    save: async () => undefined,
    lastReadOk: async () => new Map([['grok', last]]),
    raise: async (a) => {
      raised.push(a);
    },
    resolve: async () => undefined,
    runs: { start: async () => 1, finish: async () => undefined },
    now: () => NOW,
    log: () => undefined,
  });
  return raised[0]?.body;
}

const modelCommands = (w: ReturnType<typeof fakeWorld>) =>
  w.commands.filter((c) => c.argv.includes('models'));

describe('额度读取：Grok 访问令牌过期，以会话用户跑 grok models 让 CLI 自己续', () => {
  it('有 refresh_token：跑一次 models（命令里没有令牌）→ 重读 → 读成', async () => {
    const w = fakeWorld('rewrites');
    const r = await readRound(w);
    expect(r.ok).toBe(true);
    const ran = modelCommands(w);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.user).toBe(USER);
    expect(ran[0]?.cwd).toBe(HOME);
    expect(ran[0]?.argv).toContain('GROK_DISABLE_AUTOUPDATER=1');
    expect(ran[0]?.argv).toContain(BIN);
    expect(ran[0]?.argv.at(-1)).toBe('models');
    expect(ran[0]?.argv.join(' ')).not.toContain(REFRESH);
    expect(ran[0]?.argv.join(' ')).not.toContain(STALE);
    expect(w.bearers.every((b) => b === `Bearer ${FRESH}`)).toBe(true);
    const text = JSON.stringify(r);
    expect(text).not.toContain(STALE);
    expect(text).not.toContain(FRESH);
    expect(text).not.toContain(REFRESH);
  });

  it('没接 grok 路径：错误码是 auth_refreshable，报警不说不会自己好', async () => {
    const w = fakeWorld('rewrites');
    const r = await readRound(w, false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('auth_refreshable');
    expect(modelCommands(w)).toHaveLength(0);
    expect(w.bearers).toHaveLength(0);
    const body = await alertBody(r, new Date(NOW.getTime() - 30 * 60_000));
    expect(body).toBeTruthy();
    expect(body).not.toContain('不会自己好');
    expect(body).toContain('会在 grok 下次运行后自己好');
    expect(body).toContain('30 分钟');
  });

  it('没有 refresh_token：仍按要人动手报', async () => {
    const w = fakeWorld('rewrites', null);
    const r = await readRound(w);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('auth');
    expect(r.error.message).toContain('没有 refresh_token');
    expect(r.error.message).toContain('grok login');
    expect(modelCommands(w)).toHaveLength(0);
    const body = await alertBody(r, new Date(NOW.getTime() - 15 * 60_000));
    expect(body).toContain('要人动手');
    expect(body).toContain('不会自己好');
  });

  it('grok models 说要重新登录：报 auth，不说成还会自己好', async () => {
    const w = fakeWorld({ code: 1, stderr: 'Token expired. Run `grok login` to re-authenticate.' });
    const r = await readRound(w);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('auth');
    expect(r.error.message).toContain('grok login');
    expect(modelCommands(w)).toHaveLength(1);
    const body = await alertBody(r, new Date(NOW.getTime() - 15 * 60_000));
    expect(body).toContain('要人动手');
    expect(body).toContain('不会自己好');
  });

  it('命令跑完令牌仍过期：报 auth_refreshable，只跑了一次', async () => {
    const w = fakeWorld('still-stale');
    const r = await readRound(w);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('auth_refreshable');
    expect(r.error.message).toContain('已让 grok 跑过一次');
    expect(modelCommands(w)).toHaveLength(1);
    expect(w.bearers).toHaveLength(0);
  });
});

describe('refreshGrokLogin：命令怎么算成功、怎么算失败', () => {
  it('退出 0 算跑完；命令是 grok models，带上关自动升级和叫停信号', async () => {
    const seen: { argv: string[]; cwd: string }[] = [];
    await refreshGrokLogin(
      async (argv, o) => {
        seen.push({ argv, cwd: o.cwd });
        return { code: 0, stdout: 'grok-4.7\n', stderr: '', killed: false };
      },
      BIN,
      HOME,
      new AbortController().signal,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv.at(-1)).toBe('models');
    expect(seen[0]?.argv).toContain('GROK_DISABLE_AUTOUPDATER=1');
    expect(seen[0]?.cwd).toBe(HOME);
    expect(GROK_REFRESH_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('非 0 退出：抛出退出码和 CLI 说的话', async () => {
    await expect(
      refreshGrokLogin(
        async () => ({ code: 1, stdout: '', stderr: 'Not signed in. Run `grok login`', killed: false }),
        BIN,
        HOME,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/退出码 1/);
  });
});
