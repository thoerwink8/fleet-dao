// fleet-api node-key new / list / revoke（#3388）：发钥匙直接写库、不改配置不重启；明文只打印一次、操作记录里没有明文；
// 记录写不进就不打印；参数不对的每条路都故意造一遍。发出去的明文要能被接收方（node-report.ts 的认人）认。
import { createMemoryStore, devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { type CliDeps, CliError, main, NODE_KEY_NEW, NODE_KEY_REVOKE, parseNodeKeyArgs } from '../src/cli.ts';
import { effectiveNodeKeys } from '../src/node-keys.ts';
import { nodeIdForToken, nodeKeyHash } from '../src/node-report.ts';
import type { Store } from '../src/ports.ts';
import { testConfig } from './harness.ts';

/** 接收方认人用的依赖（只要配置、库、日志）：和后端认人读的是同一个 effectiveNodeKeys。 */
const authDeps = (store: Store) => ({
  config: testConfig(),
  store,
  log: { info() {}, warn() {}, error() {} },
});

const T0 = new Date('2026-10-05T08:00:00.000Z');
const TOKEN = 'node-key-new-test-token-0123456789abcdefg';

function setup(override?: Store, env: Record<string, string> = {}) {
  const memory = createMemoryStore(devFixtures(T0), { now: () => T0 });
  const store = override ?? memory;
  const out: string[] = [];
  const err: string[] = [];
  let closed = 0;
  const deps: CliDeps = {
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root', ...env },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => T0,
    newToken: () => TOKEN,
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
    run: (args: string[]) => main(['node-key', ...args], deps),
  };
}

describe('参数', () => {
  it('【故意造出的失败】不认的子命令、缺编号、多参数、不认的参数、编号不合法一律拒（退出码 2）', () => {
    for (const argv of [
      [],
      ['new'],
      ['frob'],
      ['list', 'x'],
      ['revoke'],
      ['revoke', 'a', 'b'],
      ['revoke', '--json'],
      ['new', 'a', 'b'],
      ['new', '--id=a'],
      ['new', 'a', '--name'],
      ['new', 'a', '--name', ''],
      ['new', 'a', '--name', 'x', '--name', 'y'],
      ['new', 'a', '--name', 'x'.repeat(81)],
      ['new', 'Local'],
      ['new', '1abc'],
      ['new', 'a_b'],
      ['new', 'a'.repeat(41)],
    ]) {
      const attempt = () => parseNodeKeyArgs(argv);
      expect(attempt, argv.join(' ')).toThrow(CliError);
      try {
        attempt();
      } catch (e) {
        expect((e as CliError).exitCode).toBe(2);
      }
    }
  });

  it('认得出的写法', () => {
    expect(parseNodeKeyArgs(['new', 'local'])).toEqual({
      sub: 'new',
      id: 'local',
      name: undefined,
      json: false,
    });
    expect(parseNodeKeyArgs(['new', 'wsl-2', '--json', '--name', '二号 机'])).toEqual({
      sub: 'new',
      id: 'wsl-2',
      name: '二号 机',
      json: true,
    });
    expect(parseNodeKeyArgs(['new', '--name=甲', 'a'])).toMatchObject({ id: 'a', name: '甲' });
    expect(parseNodeKeyArgs(['list'])).toEqual({ sub: 'list' });
    expect(parseNodeKeyArgs(['revoke', 'a'])).toEqual({ sub: 'revoke', id: 'a' });
  });
});

describe('node-key new', () => {
  it('写库、不改环境文件：打印一次明文；库里只有哈希；操作记录有指纹、没有明文和完整哈希；接收方认得这把明文', async () => {
    const s = setup();
    expect(await s.run(['new', 'local', '--name', '本机'])).toBe(0);
    expect(s.err).toEqual([]);
    const text = s.out.join('\n');
    expect(text).toContain(TOKEN);
    expect(text.split(TOKEN)).toHaveLength(2);
    // 不再叫人改 api.env、重启
    expect(text).not.toContain('FLEET_NODE_KEYS 里加');

    const rows = await s.memory.listNodeKeys();
    expect(rows).toEqual([
      {
        nodeId: 'local',
        tokenHash: nodeKeyHash(TOKEN),
        displayName: '本机',
        createdAt: T0.toISOString(),
        revokedAt: undefined,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);

    const entry = s.memory.data.audit.at(-1);
    expect(entry).toMatchObject({
      action: NODE_KEY_NEW,
      target: 'node:local',
      via: 'ops',
      actor: { kind: 'ops', id: 'ops:node-key' },
    });
    const logged = JSON.stringify(s.memory.data.audit);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(nodeKeyHash(TOKEN));
    expect(entry?.after).toEqual({ fingerprint: nodeKeyHash(TOKEN).slice(0, 12) });
    expect(s.closed()).toBe(1);

    // 后端不改配置、不重启，下一次认人就认得
    expect(nodeIdForToken(await effectiveNodeKeys(authDeps(s.memory)), TOKEN)).toBe('local');
  });

  it('--json：标准输出只有一行 {env, token}，提示走标准错误；显示名不给就是编号', async () => {
    const s = setup();
    expect(await s.run(['new', 'founder-pc', '--json'])).toBe(0);
    expect(s.out).toEqual([JSON.stringify({ env: 'founder-pc', token: TOKEN })]);
    expect(s.err.join('\n')).not.toContain(TOKEN);
    expect(s.err.length).toBeGreaterThan(0);
    expect((await s.memory.listNodeKeys())[0]?.displayName).toBe('founder-pc');
  });

  it('【故意造出的失败】编号库里已有有效的 / 旧环境变量里有：退出 1、标准错误写明、不发新的、标准输出空', async () => {
    const s = setup();
    expect(await s.run(['new', 'a', '--json'])).toBe(0);
    s.out.length = 0;
    s.deps.newToken = () => 'another-token-0123456789abcdefghijklmnop';
    expect(await s.run(['new', 'a', '--json'])).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join('\n')).toContain('已经有一把有效的通行证');
    expect((await s.memory.listNodeKeys()).map((k) => k.tokenHash)).toEqual([nodeKeyHash(TOKEN)]);

    const envOnly = setup(undefined, { FLEET_NODE_KEYS: JSON.stringify({ legacy: nodeKeyHash('old') }) });
    expect(await envOnly.run(['new', 'legacy', '--json'])).toBe(1);
    expect(envOnly.out).toEqual([]);
    expect(envOnly.err.join('\n')).toContain('FLEET_NODE_KEYS');
    expect(await envOnly.memory.listNodeKeys()).toEqual([]);
  });

  it('作废后同编号可以再发（库里的作废行遮住了旧环境变量那一项）', async () => {
    const s = setup(undefined, { FLEET_NODE_KEYS: JSON.stringify({ a: nodeKeyHash('old') }) });
    // 环境里有、库里没有：拒
    expect(await s.run(['new', 'a'])).toBe(1);
    await s.memory.createNodeKey(
      { nodeId: 'a', tokenHash: nodeKeyHash('db-token'), displayName: 'a' },
      { actor: { kind: 'ops', id: 'x' }, action: NODE_KEY_NEW, target: 'node:a', via: 'ops', ok: true },
    );
    await s.run(['revoke', 'a']);
    expect(await s.run(['new', 'a'])).toBe(0);
    const row = (await s.memory.listNodeKeys())[0];
    expect(row).toMatchObject({ tokenHash: nodeKeyHash(TOKEN) });
    expect(row?.revokedAt).toBeUndefined();
  });

  it('【故意造出的失败】库写不进（含操作记录）：退出码 1，什么都不打印，库里没有这把', async () => {
    const base = createMemoryStore(devFixtures(T0));
    const broken = new Proxy(base, {
      get(target, key, receiver) {
        if (key === 'createNodeKey') {
          return async () => {
            throw new Error('库连不上');
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const s = setup(broken);
    expect(await s.run(['new', 'local'])).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join('\n')).toContain('没发成');
    expect(s.err.join('\n')).not.toContain(TOKEN);
    expect(await base.listNodeKeys()).toEqual([]);
    expect(s.closed()).toBe(1);
  });

  it('【故意造出的失败】参数不对：退出码 2，不连库', async () => {
    const s = setup();
    let opened = 0;
    s.deps.openStore = async () => {
      opened += 1;
      throw new Error('不该连库');
    };
    for (const args of [[], ['new'], ['new', 'Bad'], ['wat']]) {
      expect(await main(['node-key', ...args], s.deps), args.join(' ')).toBe(2);
    }
    expect(opened).toBe(0);
    expect(s.out).toEqual([]);
  });

  it('真随机：不给 newToken 时每次发的都不一样，长度够（43 个字符）', async () => {
    const s = setup();
    delete s.deps.newToken;
    await main(['node-key', 'new', 'a', '--json'], s.deps);
    await main(['node-key', 'new', 'b', '--json'], s.deps);
    const tokens = s.out.map((t) => (JSON.parse(t) as { token: string }).token);
    expect(tokens[0]).toHaveLength(43);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('--help 只打印用法', async () => {
    const s = setup();
    expect(await s.run(['--help'])).toBe(0);
    expect(s.out.join('\n')).toContain('node-key new');
  });
});

describe('node-key list / revoke', () => {
  it('list：库里的（含作废的）和旧环境变量的都列，标来源；同编号库为准会标出；最近推送取快照和会话里晚的', async () => {
    const s = setup(undefined, {
      FLEET_NODE_KEYS: JSON.stringify({ legacy: nodeKeyHash('old'), both: nodeKeyHash('old-both') }),
    });
    // both 在环境里有、库里也有一行；库里的盖过环境的
    await s.memory.createNodeKey(
      { nodeId: 'both', tokenHash: nodeKeyHash('db-both'), displayName: '双份' },
      { actor: { kind: 'ops', id: 'x' }, action: NODE_KEY_NEW, target: 'node:both', via: 'ops', ok: true },
    );
    // 最近一次推送：快照收到的时刻（list 只读摘要，快照本体不用真的）
    s.memory.data.nodeReports.push({
      nodeId: 'both',
      displayName: '双份',
      schemaVersion: 1,
      reportedAt: T0.toISOString(),
      receivedAt: '2026-10-05T09:30:00.000Z',
      snapshot: {} as never,
    });
    expect(await s.run(['list'])).toBe(0);
    const lines = s.out.join('\n').split('\n');
    const both = lines.find((l) => l.startsWith('both')) as string;
    expect(both).toContain('双份');
    expect(both).toContain('最近推送 2026-10-05T09:30:00.000Z');
    expect(lines.find((l) => l.startsWith('legacy'))).toContain('最近推送 从未');
    expect(both).toContain(nodeKeyHash('db-both').slice(0, 12));
    expect(both).toContain('以库为准');
    expect(both).not.toContain(nodeKeyHash('db-both'));
    const legacy = lines.find((l) => l.startsWith('legacy')) as string;
    expect(legacy).toContain('旧配置');
    expect(legacy).toContain(nodeKeyHash('old').slice(0, 12));
  });

  it('revoke：作废后记操作记录（只有指纹）、认人立刻不认；重复作废、没有这个编号、只在旧环境变量里都退出 1', async () => {
    const s = setup(undefined, { FLEET_NODE_KEYS: JSON.stringify({ legacy: nodeKeyHash('old') }) });
    await s.run(['new', 'a', '--json']);
    expect(nodeIdForToken(await effectiveNodeKeys(authDeps(s.memory)), TOKEN)).toBe('a');
    s.out.length = 0;
    expect(await s.run(['revoke', 'a'])).toBe(0);
    expect(nodeIdForToken(await effectiveNodeKeys(authDeps(s.memory)), TOKEN)).toBeNull();
    const entry = s.memory.data.audit.at(-1);
    expect(entry).toMatchObject({ action: NODE_KEY_REVOKE, target: 'node:a' });
    expect(entry?.after).toEqual({ fingerprint: nodeKeyHash(TOKEN).slice(0, 12) });
    expect(JSON.stringify(s.memory.data.audit)).not.toContain(nodeKeyHash(TOKEN));

    s.err.length = 0;
    expect(await s.run(['revoke', 'a'])).toBe(1);
    expect(s.err.join('\n')).toContain('早已作废');
    expect(await s.run(['revoke', 'zzz'])).toBe(1);
    expect(await s.run(['revoke', 'legacy'])).toBe(1);
    expect(s.err.join('\n')).toContain('旧配置');
  });

  it('【故意造出的失败】库读不到：list、revoke、new 都退出 1，不假装空', async () => {
    const base = createMemoryStore(devFixtures(T0));
    const broken = new Proxy(base, {
      get(target, key, receiver) {
        if (key === 'listNodeKeys') {
          return async () => {
            throw new Error('库连不上');
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    for (const args of [['list'], ['revoke', 'a'], ['new', 'a']]) {
      const s = setup(broken);
      expect(await s.run(args), args.join(' ')).toBe(1);
      expect(s.out).toEqual([]);
    }
  });
});
