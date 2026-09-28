// Mirasim 桥接（法国防火墙只放行会话用户和 root 连回环口，引擎自己的进程连不上，2026-09-28 实测断链，#345 后续）：
// - 「假桥接（连接器逻辑）」：bridge-connect.ts 怎么认 ready / error / 退出 / 超时，配一个可摆布的假桥接进程，不用真跑
//   bridge.ts、不用真的 Mirasim 服务。
// - 「真桥接（bridge.ts）」：真跑 bridge.ts（经假帮手，不要 root），连真的假 ws 服务端，验令牌、连接、帧来回、收场
//   这几条真正走了 bridge.ts 自己的代码，不是只测连接器这一层。
//
// 传参数给假 / 真桥接用 FLEET_ 前缀的环境变量：桥接进程的环境是经（假）帮手脚本重新拼的，只放行 FLEET_* 这几类
// （procs.ts 的 scopeLaunch、fake-scope-helper.ts 同一条白名单），所以在测试进程自己的 process.env 上设不管用——
// 要经 spawn 选项，把变量放进直接起帮手那一层的环境，帮手会把 FLEET_* 的原样递给它起的桥接。
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bridgeMirasimConnector } from '../src/mirasim/bridge-connect.ts';
import type { MirasimWire } from '../src/mirasim/wire.ts';
import { tempDir } from './helpers.ts';
import { startWsServer } from './ws-server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_SCOPE_HELPER = join(here, 'fake-scope-helper.ts');
const FAKE_BRIDGE = join(here, 'fake-bridge.ts');
const REAL_BRIDGE = join(here, '..', 'src', 'mirasim', 'bridge.ts');
const onPosix = process.platform !== 'win32';

/** 把这几个 FLEET_ 变量塞进起帮手那一层的环境；帮手照它自己的白名单原样递给它起的桥接。 */
function spawnWithEnv(vars: Record<string, string>): typeof nodeSpawn {
  return ((bin: string, args: readonly string[], opts?: SpawnOptionsWithoutStdio): ChildProcess =>
    nodeSpawn(bin, args, { ...(opts ?? {}), env: { ...(opts?.env ?? {}), ...vars } })) as typeof nodeSpawn;
}

/** 经假帮手起假 / 真桥接：和生产装配一样先过 fleet-agent-scope（这里换成假帮手），不要 root。 */
function connector(
  bridgeCommand: readonly string[],
  extra: Partial<Parameters<typeof bridgeMirasimConnector>[1]> = {},
) {
  return bridgeMirasimConnector(
    { user: 'fleet-agent-carpool', port: 1, tokenFile: '/unused' },
    {
      bridgeCommand,
      helper: FAKE_SCOPE_HELPER,
      sudo: [process.execPath],
      scopeId: () => `t-${Math.random().toString(36).slice(2)}`,
      connectTimeoutMs: 5_000,
      ...extra,
    },
  );
}

describe('假桥接（连接器逻辑）', () => {
  it('桥接命令不是绝对路径：当场拒，不起进程', () => {
    expect(() =>
      bridgeMirasimConnector(
        { user: 'fleet-agent-carpool', port: 1, tokenFile: '/t' },
        { bridgeCommand: ['node', 'x.js'] },
      ),
    ).toThrow('绝对路径');
  });

  it.skipIf(!onPosix)(
    '【故意造出的失败】桥接命令起不来（帮手脚本不存在）：报「桥接进程起不来」，不是别的错',
    async () => {
      const connect = bridgeMirasimConnector(
        { user: 'fleet-agent-carpool', port: 1, tokenFile: '/t' },
        { bridgeCommand: [process.execPath, FAKE_BRIDGE], helper: '/nowhere/does-not-exist', sudo: [] },
      );
      await expect(connect()).rejects.toThrow('桥接进程起不来');
    },
  );

  it.skipIf(!onPosix)('起来、ready、帧来回、close() 干净收场：next() 之后一直回 closed', async () => {
    const connect = connector([process.execPath, FAKE_BRIDGE]);
    const wire: MirasimWire = await connect();
    wire.send({ type: 'hello' });
    expect(await wire.next(2_000)).toEqual({ type: 'hello' });
    wire.close();
    expect(await wire.next(2_000)).toBe('closed');
    expect(await wire.next(50)).toBe('closed');
  });

  it.skipIf(!onPosix)('没有新帧时 next() 超时回 timeout，不是 closed（连着，只是没有新帧）', async () => {
    const connect = connector([process.execPath, FAKE_BRIDGE]);
    const wire = await connect();
    expect(await wire.next(100)).toBe('timeout');
    wire.close();
  });

  it.skipIf(!onPosix)(
    '【故意造出的失败】桥接没起来就退出（没报 ready 也没报 error）：报退出码，不当成连上了',
    async () => {
      const connect = connector([process.execPath, FAKE_BRIDGE], {
        spawn: spawnWithEnv({ FLEET_FAKE_BRIDGE_MODE: 'exit-before-ready', FLEET_FAKE_BRIDGE_EXIT: '3' }),
      });
      await expect(connect()).rejects.toThrow('桥接没起来：退出码 3');
    },
  );

  it.skipIf(!onPosix)(
    '【故意造出的失败】桥接报错（令牌不在）：connect() 被拒，带着桥接给的原话',
    async () => {
      const connect = connector([process.execPath, FAKE_BRIDGE], {
        spawn: spawnWithEnv({
          FLEET_FAKE_BRIDGE_MODE: 'error-before-ready',
          FLEET_FAKE_BRIDGE_ERROR_KIND: 'token_missing',
          FLEET_FAKE_BRIDGE_ERROR_MESSAGE: '假的：读不了 Mirasim 的回环令牌',
        }),
      });
      await expect(connect()).rejects.toThrow('假的：读不了 Mirasim 的回环令牌');
    },
  );

  it.skipIf(!onPosix)(
    '【故意造出的失败】桥接挂着不连（连不上服务）：超过等待预算判超时，进程被杀',
    async () => {
      const connect = connector([process.execPath, FAKE_BRIDGE], {
        spawn: spawnWithEnv({ FLEET_FAKE_BRIDGE_MODE: 'hang' }),
        connectTimeoutMs: 300,
      });
      await expect(connect()).rejects.toThrow('桥接连 Mirasim 超时');
    },
  );
});

describe.skipIf(!onPosix)('真桥接（bridge.ts）：经假帮手真跑，连假的 ws 服务端', () => {
  it('令牌读到、连上、发收帧来回、服务端关连接：next() 回 closed', async () => {
    const dir = tempDir();
    const tokenFile = join(dir, 'local.token');
    writeFileSync(tokenFile, 'tok-1\n');
    let seenUrl = '';
    const server = await startWsServer((conn) => {
      seenUrl = conn.url;
      conn.onMessage((frame) => {
        if (frame.type === 'ping') conn.send({ type: 'pong' });
        if (frame.type === 'bye') conn.close();
      });
    });
    try {
      const connect = bridgeMirasimConnector(
        { user: 'fleet-agent-carpool', port: server.port, tokenFile },
        {
          bridgeCommand: [process.execPath, REAL_BRIDGE],
          helper: FAKE_SCOPE_HELPER,
          sudo: [process.execPath],
          connectTimeoutMs: 5_000,
        },
      );
      const wire = await connect();
      wire.send({ type: 'ping' });
      expect(await wire.next(2_000)).toEqual({ type: 'pong' });
      wire.send({ type: 'bye' });
      expect(await wire.next(2_000)).toBe('closed');
      expect(seenUrl).toBe('/ws?token=tok-1');
      wire.close();
    } finally {
      await server.close();
    }
  });

  it('【故意造出的失败】令牌文件不在：报读不了回环令牌，connect() 被拒，不当成连上了', async () => {
    const dir = tempDir();
    const connect = bridgeMirasimConnector(
      { user: 'fleet-agent-carpool', port: 1, tokenFile: join(dir, 'nowhere.token') },
      {
        bridgeCommand: [process.execPath, REAL_BRIDGE],
        helper: FAKE_SCOPE_HELPER,
        sudo: [process.execPath],
        connectTimeoutMs: 5_000,
      },
    );
    await expect(connect()).rejects.toThrow('读不了 Mirasim 的回环令牌');
  });

  it('【故意造出的失败】令牌文件是空的：报令牌是空的', async () => {
    const dir = tempDir();
    const tokenFile = join(dir, 'empty.token');
    writeFileSync(tokenFile, '\n');
    const connect = bridgeMirasimConnector(
      { user: 'fleet-agent-carpool', port: 1, tokenFile },
      {
        bridgeCommand: [process.execPath, REAL_BRIDGE],
        helper: FAKE_SCOPE_HELPER,
        sudo: [process.execPath],
        connectTimeoutMs: 5_000,
      },
    );
    await expect(connect()).rejects.toThrow('是空的');
  });

  it('【故意造出的失败】服务不在（没人监听这个端口）：调短桥接自己的重试预算，报连不上', async () => {
    const dir = tempDir();
    const tokenFile = join(dir, 'local.token');
    writeFileSync(tokenFile, 'tok\n');
    const server = await startWsServer(() => {});
    const port = server.port;
    await server.close(); // 关掉，端口没人听了
    const connect = bridgeMirasimConnector(
      { user: 'fleet-agent-carpool', port, tokenFile },
      {
        bridgeCommand: [process.execPath, REAL_BRIDGE],
        helper: FAKE_SCOPE_HELPER,
        sudo: [process.execPath],
        connectTimeoutMs: 5_000,
        // bridge.ts 自己 90 秒的重试预算调短，不真的等：FLEET_ 前缀，经帮手原样递下去
        spawn: spawnWithEnv({ FLEET_MIRASIM_BRIDGE_CONNECT_BUDGET_MS: '400' }),
      },
    );
    await expect(connect()).rejects.toThrow('连不上 Mirasim 的回环 ws');
  });
});
