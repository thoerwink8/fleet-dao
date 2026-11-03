// 装配档案（#3858）：france 的配置和默认值守着不变；local 整条装起来、只听回环、无令牌被拒、杀掉再起事件还在、隔离档位读回「弱」。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendToSession, LOCAL_TOKEN_HEADER } from '@fleet-dao/harness-api';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/profiles/config.ts';
import { assembleFrance } from '../src/profiles/france.ts';
import { readIsolation } from '../src/profiles/isolation.ts';
import { assembleLocal, defaultDataDir } from '../src/profiles/local.ts';
import { runAssembly } from '../src/profiles/run.ts';

const root = mkdtempSync(join(tmpdir(), 'fleet2-profiles-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FRANCE_ENV = {
  FLEET2_WORKER_COMMAND: '["reclaude"]',
  FLEET2_DATABASE_URL: 'postgres://127.0.0.1:1/none',
  FLEET2_GITHUB_APP_FILE: '/nonexistent/app.json',
  FLEET2_MODEL: 'm',
  FLEET2_MIRROR_ROOT: '/m',
  FLEET2_WORK_ROOT: '/w',
  FLEET2_WORKER_HOME: '/h',
};

describe('france 档案：行为不变', () => {
  it('必填的环境变量缺一个就报 ConfigError，消息和原来一样', () => {
    for (const k of Object.keys(FRANCE_ENV)) {
      const env: Record<string, string | undefined> = { ...FRANCE_ENV };
      delete env[k];
      expect(() => assembleFrance(env), k).toThrow(new ConfigError(`没给 ${k}，不起`));
    }
  });

  it('配置不合规的报错消息不变', () => {
    expect(() => assembleFrance({ ...FRANCE_ENV, FLEET2_WORKER_COMMAND: '[]' })).toThrow(/非空的字符串数组/);
    expect(() => assembleFrance({ ...FRANCE_ENV, FLEET2_SANDBOX: 'docker' })).toThrow(
      'FLEET2_SANDBOX 只认 scope（或不给）：docker',
    );
    expect(() => assembleFrance({ ...FRANCE_ENV, FLEET2_SHELL: 'x' })).toThrow(/FLEET2_SHELL 只认/);
    expect(() => assembleFrance({ ...FRANCE_ENV, FLEET2_SHELL: 'grok' })).toThrow(
      '没给 FLEET2_GROK_AUTH，不起',
    );
    expect(() => assembleFrance({ ...FRANCE_ENV, FLEET2_PERMISSION_MODE: 'x' })).toThrow(
      /FLEET2_PERMISSION_MODE 只认/,
    );
    expect(() => assembleFrance({ ...FRANCE_ENV, FLEET2_PUBLISH: '2' })).toThrow(
      'FLEET2_PUBLISH 只认 1 或 0',
    );
    expect(() => assembleFrance({ ...FRANCE_ENV, FLEET2_API_PORT: '0' })).toThrow(
      'FLEET2_API_PORT 不是端口：0',
    );
    expect(() => assembleFrance({ ...FRANCE_ENV, FLEET2_EGRESS_PORT: 'abc' })).toThrow(
      'FLEET2_EGRESS_PORT 不是端口：abc',
    );
  });

  it('默认值：口 7345/7344、权限档 bypassPermissions、节拍 30 秒、纯影子（不带 publish）', async () => {
    const a = assembleFrance(FRANCE_ENV);
    try {
      expect(a.profile).toBe('france');
      expect(a.kernel.apiPort).toBe(7345);
      expect(a.kernel.egressPort).toBe(7344);
      expect(a.kernel.tickMs).toBe(30_000);
      expect(a.kernel.dispatcher.permissionMode).toBe('bypassPermissions');
      expect(a.kernel.dispatcher.shell).toBe('claude-code');
      expect(a.kernel.dispatcher.command).toEqual(['reclaude']);
      expect(a.kernel.dispatcher.sandbox).toBeUndefined();
      expect(a.kernel.publish).toBeUndefined();
      expect(a.kernel.probes).toBeUndefined(); // 法国照旧做影子自检
      expect(a.startedFields(7345)).toEqual({ shadow: true, publish: false });
    } finally {
      await a.close();
    }
  });

  it('FLEET2_PUBLISH=1 开真执行，FLEET2_SANDBOX=scope 装会话用户沙箱', async () => {
    const a = assembleFrance({ ...FRANCE_ENV, FLEET2_PUBLISH: '1', FLEET2_SANDBOX: 'scope' });
    try {
      expect(a.kernel.publish).toBeDefined();
      expect(a.kernel.dispatcher.sandbox).toBeDefined();
      expect(a.startedFields(1)).toEqual({ shadow: false, publish: true });
    } finally {
      await a.close();
    }
  });
});

describe('隔离档位读回', () => {
  const base = { permissionMode: 'acceptEdits', platform: 'win32' as const };
  it('强、中、弱按真装了什么推', () => {
    expect(readIsolation({ ...base, separateUser: true, egressGateway: true }).level).toBe('strong');
    expect(readIsolation({ ...base, separateUser: true, egressGateway: false }).level).toBe('medium');
    expect(readIsolation({ ...base, separateUser: false, egressGateway: true }).level).toBe('medium');
    expect(readIsolation({ ...base, separateUser: false, egressGateway: false }).level).toBe('weak');
  });
  it('弱档的事实里点明同一个用户和没有出网关口', () => {
    const { facts } = readIsolation({ ...base, separateUser: false, egressGateway: false });
    expect(facts.join('\n')).toContain('同一个系统用户');
    expect(facts.join('\n')).toContain('没有出网关口');
  });
});

describe('local 档案', () => {
  it('数据目录：Windows 在 LOCALAPPDATA 下，不在安装目录；FLEET2_DATA_DIR 可改', () => {
    expect(
      defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' }, 'win32'),
    ).toBe(join('C:\\Users\\u\\AppData\\Local', 'Fleet2'));
    expect(defaultDataDir({ HOME: '/home/u' }, 'linux')).toBe(join('/home/u', '.local', 'share', 'fleet2'));
    expect(defaultDataDir({ FLEET2_DATA_DIR: root })).toBe(root);
  });

  it('没给本机版页面目录就不起，不悄悄只剩接口', async () => {
    await expect(assembleLocal({ FLEET2_DATA_DIR: join(root, 'nodist') })).rejects.toThrow(/FLEET2_WEB_DIST/);
  });

  it('权限档不许 bypassPermissions', async () => {
    await expect(
      assembleLocal({ FLEET2_DATA_DIR: join(root, 'bad'), FLEET2_PERMISSION_MODE: 'bypassPermissions' }),
    ).rejects.toThrow(/不许 bypassPermissions/);
  });

  it('整条起来：只听回环、无令牌被拒、档位弱；停掉再起，事件还在', async () => {
    const dir = join(root, 'full');
    const env = {
      FLEET2_DATA_DIR: dir,
      FLEET2_UI_PORT: '0',
      FLEET2_TICK_MS: '0',
      FLEET2_WEB_DIST: join(root, 'dist'),
    };
    const a1 = await assembleLocal(env);
    const r1 = await runAssembly(a1, { signals: false });
    const base1 = `http://${(a1.startedFields(r1.apiPort).ui as string).replace(/^http:\/\//, '').replace(/\/$/, '')}`;
    const addr = a1.gateway.server.address();
    expect(addr && typeof addr === 'object' ? addr.address : null).toBe('127.0.0.1');
    expect((await fetch(`${base1}/api/sessions`)).status).toBe(401);
    expect(a1.startedFields(r1.apiPort).isolation).toBe('weak');

    const token = (await import('node:fs')).readFileSync(join(dir, 'local-token'), 'utf8').trim();
    const status = (await (
      await fetch(`${base1}/api/local/status`, { headers: { [LOCAL_TOKEN_HEADER]: token } })
    ).json()) as {
      isolation: { level: string };
      externalWrites: { github: boolean };
    };
    expect(status.isolation.level).toBe('weak');
    expect(status.externalWrites.github).toBe(false);

    // 令牌文件只有本用户读得了：posix 看 0600；Windows 看 icacls 列出的授权里没有 Users、Everyone、Authenticated Users
    if (process.platform === 'win32') {
      const acl = execFileSync('icacls', [join(dir, 'local-token')], { encoding: 'utf8' });
      expect(acl).toContain(process.env.USERNAME ?? '');
      expect(acl).not.toMatch(/Everyone|BUILTINUsers|Authenticated Users/);
    } else {
      expect(statSync(join(dir, 'local-token')).mode & 0o777).toBe(0o600);
    }
    await appendToSession(a1.kernel.db, 'persist-1', 'session.turn.started', {
      role: 'user',
      text: 'hi',
    } as never);
    await appendToSession(a1.kernel.db, 'persist-1', 'worker.progress.reported', {
      summary: 'x',
      percent: 1,
    } as never);
    // 停掉再起（被强杀的那种在真机上验过，PR 里有记录；锁文件遗留的接手在 harness-store 的 local-db 测试里）
    await r1.stop();

    const a2 = await assembleLocal(env);
    const r2 = await runAssembly(a2, { signals: false });
    const base2 = `http://${(a2.startedFields(r2.apiPort).ui as string).replace(/^http:\/\//, '').replace(/\/$/, '')}`;
    const list = (await (
      await fetch(`${base2}/api/sessions`, { headers: { [LOCAL_TOKEN_HEADER]: token } })
    ).json()) as {
      sessions: { id: string; eventCount: number }[];
    };
    expect(list.sessions.find((s) => s.id === 'persist-1')?.eventCount).toBe(2);
    await r2.stop();
  }, 120_000);
});
