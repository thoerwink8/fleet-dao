// fleet-api session-mint（#1800）：法国 root 发一枚短命会话 Cookie 给 AI 点验线上驾驶舱。
// 打印的值要能被 readSession 认出（m=cli-mint、exp-iat=给的分钟数）；先记操作记录（不含 Cookie 值）再打印，记不进就不打印；
// 超时长、不在白名单、缺原因都拒；「退出所有设备」（会话版本加 1）能作废它。
import { createMemoryStore, DEV_USER_ID, devFixtures, IDS } from '@fleet-dao/store';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type CliDeps, CliError, main, parseSessionMintArgs, SESSION_MINT } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import type { Store } from '../src/ports.ts';
import { readSession } from '../src/session.ts';

const T0 = new Date('2026-10-11T04:00:00.000Z');
const ENV = {
  FLEET_ENV: 'production',
  FLEET_PUBLIC_URL: 'https://cockpit.example.test',
  FLEET_COCKPIT_LISTEN: 'wg-france:8787',
  FLEET_SESSION_SECRET: 's'.repeat(40),
  FLEET_AGENT_TOKEN_SECRET: 'a'.repeat(40),
  FLEET_GITHUB_WEBHOOK_SECRET: 'w'.repeat(20),
  FEISHU_APP_ID: 'cli_x',
  FEISHU_APP_SECRET: 'y',
  DATABASE_URL: 'postgres:///fleet',
  FLEET_OPS_OPERATOR: 'root',
};

function setup(override?: Store, env: Record<string, string | undefined> = ENV) {
  const memory = createMemoryStore(devFixtures(T0));
  const store = override ?? memory;
  const out: string[] = [];
  const err: string[] = [];
  let closed = 0;
  const deps: CliDeps = {
    env,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => T0,
    openStore: async () => ({
      store,
      close: async () => {
        closed += 1;
      },
    }),
  };
  return {
    memory,
    out,
    err,
    deps,
    closed: () => closed,
    run: (args: string[]) => main(['session-mint', ...args], deps),
  };
}

/** 用后端同一个 readSession 读一枚 Cookie。 */
async function read(cookieName: string, value: string, at: Date) {
  const config = loadConfig(ENV);
  const app = new Hono();
  app.get('/', (c) => c.json(readSession(c, config, at)));
  const res = await app.request('/', { headers: { cookie: `${cookieName}=${value}` } });
  return (await res.json()) as { uid: string; iat: number; exp: number; m?: string; v?: number } | null;
}

describe('参数', () => {
  it('缺用户、缺或空的 --reason、--ttl 超过 120 或不是正整数、认不出的参数、多的参数：一律拒（退出码 2）', () => {
    for (const argv of [
      [],
      ['创始人甲'],
      ['创始人甲', '--reason', ' '],
      ['创始人甲', '--reason'],
      ['创始人甲', '--reason', 'x', '--ttl', '121'],
      ['创始人甲', '--reason', 'x', '--ttl', '0'],
      ['创始人甲', '--reason', 'x', '--ttl', '-5'],
      ['创始人甲', '--reason', 'x', '--ttl', '1.5'],
      ['创始人甲', '--reason', 'x', '--ttl', 'abc'],
      ['创始人甲', '--reason', 'x', '--ttl'],
      ['创始人甲', '--reason', 'x', '--cookie'],
      ['创始人甲', '别人', '--reason', 'x'],
      ['创始人甲', '--reason', 'x'.repeat(201)],
    ]) {
      const attempt = () => parseSessionMintArgs(argv);
      expect(attempt, argv.join(' ')).toThrow(CliError);
      try {
        attempt();
      } catch (e) {
        expect((e as CliError).exitCode).toBe(2);
      }
    }
  });

  it('默认 60 分钟；120 分钟刚好可以', () => {
    expect(parseSessionMintArgs(['创始人甲', '--reason', '点验'])).toEqual({
      who: '创始人甲',
      ttlMinutes: 60,
      reason: '点验',
    });
    expect(parseSessionMintArgs(['--reason', '点验', '创始人甲', '--ttl', '120']).ttlMinutes).toBe(120);
  });
});

describe('session-mint', () => {
  it('打印 Cookie 名和值各一行：readSession 认得，m 为 cli-mint，exp - iat 等于给的分钟数；到期后不认', async () => {
    const s = setup();
    expect(await s.run(['创始人甲', '--ttl', '30', '--reason', '点验线上驾驶舱'])).toBe(0);
    expect(s.err).toEqual([]);
    const lines = s.out.join('\n').split('\n');
    expect(lines).toHaveLength(2);
    const [name, value] = lines as [string, string];
    expect(name).toBe('__Host-fleet_session');

    const claims = await read(name, value, T0);
    expect(claims).toMatchObject({ uid: DEV_USER_ID, m: 'cli-mint', v: 0 });
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(30 * 60);
    expect(await read(name, value, new Date(T0.getTime() + 29 * 60_000))).not.toBeNull();
    expect(await read(name, value, new Date(T0.getTime() + 30 * 60_000))).toBeNull();
    expect(s.closed()).toBe(1);
  });

  it('默认 60 分钟；按用户 id 找也行；非 https 的配置下 Cookie 名不带 __Host-', async () => {
    const s = setup(undefined, {
      ...ENV,
      FLEET_PUBLIC_URL: 'http://localhost:5173',
      FLEET_ENV: 'development',
    });
    expect(await s.run([DEV_USER_ID, '--reason', '点验'])).toBe(0);
    const [name, value] = s.out.join('\n').split('\n') as [string, string];
    expect(name).toBe('fleet_session');
    const config = loadConfig({
      ...ENV,
      FLEET_PUBLIC_URL: 'http://localhost:5173',
      FLEET_ENV: 'development',
    });
    const app = new Hono();
    app.get('/', (c) => c.json(readSession(c, config, T0)));
    const res = await app.request('/', { headers: { cookie: `${name}=${value}` } });
    const claims = (await res.json()) as { exp: number; iat: number };
    expect(claims.exp - claims.iat).toBe(60 * 60);
  });

  it('操作记录先写：actor 是 cli 一类、target 是 cockpit、after 写给谁多久，原因在 reason；记录里没有 Cookie 值和密钥', async () => {
    const s = setup();
    await s.run(['创始人甲', '--ttl', '45', '--reason', '点验线上驾驶舱']);
    const value = s.out.join('\n').split('\n')[1] as string;
    const entry = s.memory.data.audit.at(-1);
    expect(entry).toMatchObject({
      action: SESSION_MINT,
      target: 'cockpit',
      via: 'engine',
      actor: { kind: 'engine', id: 'ops:session-mint' },
      reason: '点验线上驾驶舱',
      ok: true,
    });
    expect(entry?.after).toMatchObject({ userId: DEV_USER_ID, ttlMinutes: 45, operator: 'root' });
    const logged = JSON.stringify(s.memory.data.audit);
    expect(logged).not.toContain(value);
    expect(logged).not.toContain(ENV.FLEET_SESSION_SECRET);
  });

  it('会话的版本号取此人当前的：退出所有设备（版本加 1）之后，后端对它的版本比对不上', async () => {
    const s = setup();
    await s.memory.bumpSessionVersion(DEV_USER_ID);
    await s.run(['创始人甲', '--reason', '点验']);
    const [name, value] = s.out.join('\n').split('\n') as [string, string];
    const claims = await read(name, value, T0);
    const before = await s.memory.getUser(DEV_USER_ID);
    expect(claims?.v).toBe(1);
    expect(claims?.v).toBe(before?.sessionVersion);
    await s.memory.bumpSessionVersion(DEV_USER_ID);
    const after = await s.memory.getUser(DEV_USER_ID);
    expect(claims?.v).not.toBe(after?.sessionVersion);
  });

  it('【故意造出的失败】操作记录写不进：退出码 1，什么都不打印（发出去的会话必须有记录）', async () => {
    const base = createMemoryStore(devFixtures(T0));
    const broken = new Proxy(base, {
      get(target, key, receiver) {
        if (key === 'appendAudit') {
          return async () => {
            throw new Error('库连不上');
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const s = setup(broken);
    expect(await s.run(['创始人甲', '--reason', '点验'])).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join('\n')).toContain('没发成');
    expect(s.closed()).toBe(1);
  });

  it('【故意造出的失败】不在白名单（机器人、停用的创始人、查无此人）：退出码 1，不记录不打印', async () => {
    const data = devFixtures(T0);
    data.users = (data.users ?? []).map((u) => (u.id === IDS.founderB ? { ...u, active: false } : u));
    const memory = createMemoryStore(data);
    const s = setup(memory);
    const audits = memory.data.audit.length;
    for (const who of [IDS.botWorker, '干活的机器人', IDS.founderB, '查无此人']) {
      expect(await s.run([who, '--reason', '点验']), who).toBe(1);
    }
    expect(s.out).toEqual([]);
    expect(memory.data.audit).toHaveLength(audits);
  });

  it('【故意造出的失败】参数不对：退出码 2，不连库不打印', async () => {
    const s = setup();
    let opened = 0;
    s.deps.openStore = async () => {
      opened += 1;
      throw new Error('不该连库');
    };
    for (const args of [[], ['创始人甲'], ['创始人甲', '--reason', 'x', '--ttl', '121']]) {
      expect(await s.run(args), args.join(' ')).toBe(2);
    }
    expect(opened).toBe(0);
    expect(s.out).toEqual([]);
  });

  it('【故意造出的失败】拿不到会话密钥：退出码 2，不连库不打印，不拿随机密钥签', async () => {
    for (const env of [
      { ...ENV, FLEET_SESSION_SECRET: undefined },
      { ...ENV, FLEET_SESSION_SECRET: 'short' },
      { DATABASE_URL: 'postgres:///fleet', FLEET_ENV: 'development' },
    ]) {
      const s = setup(undefined, env);
      let opened = 0;
      s.deps.openStore = async () => {
        opened += 1;
        throw new Error('不该连库');
      };
      expect(await s.run(['创始人甲', '--reason', '点验'])).toBe(2);
      expect(opened).toBe(0);
      expect(s.out).toEqual([]);
      expect(s.err.join('\n')).toContain('没发会话');
    }
  });

  it('--help 只打印用法', async () => {
    const s = setup();
    expect(await s.run(['--help'])).toBe(0);
    expect(s.out.join('\n')).toContain('session-mint');
  });
});
