// fleet-api node-key new：给往这台推快照的环境发通行证。明文只打印一次、操作记录里没有明文；
// 记录写不进就不打印；参数不对的每条路都故意造一遍。生成的哈希要能被接收方（node-report.ts）和配置（FLEET_NODE_KEYS）认。
import { createMemoryStore, devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { type CliDeps, CliError, main, NODE_KEY_NEW, parseNodeKeyArgs } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { nodeIdForToken } from '../src/node-report.ts';
import type { Store } from '../src/ports.ts';

const T0 = new Date('2026-10-05T08:00:00.000Z');
const TOKEN = 'node-key-new-test-token-0123456789abcdefg';

function setup(override?: Store) {
  const memory = createMemoryStore(devFixtures(T0));
  const store = override ?? memory;
  const out: string[] = [];
  const err: string[] = [];
  let closed = 0;
  const deps: CliDeps = {
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
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
  it('只认 new <合法环境编号>；别的子命令、缺编号、多参数、带 -、编号不合法一律拒（退出码 2）', () => {
    for (const argv of [
      [],
      ['new'],
      ['list'],
      ['new', 'a', 'b'],
      ['new', '--id=a'],
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
    expect(parseNodeKeyArgs(['new', 'local'])).toEqual({ id: 'local' });
    expect(parseNodeKeyArgs(['new', 'wsl-2'])).toEqual({ id: 'wsl-2' });
  });
});

describe('node-key new', () => {
  it('打印一次明文和要贴进 FLEET_NODE_KEYS 的哈希；操作记录里有指纹、没有明文和完整哈希；贴上去配置认得、接收方认得这把明文', async () => {
    const s = setup();
    expect(await s.run(['new', 'local'])).toBe(0);
    expect(s.err).toEqual([]);
    const text = s.out.join('\n');
    expect(text).toContain(TOKEN);
    const pasted = /"local":"([0-9a-f]{64})"/.exec(text)?.[1];
    expect(pasted).toBeDefined();
    // 明文只出现一次，哈希那一项里没有明文
    expect(text.split(TOKEN)).toHaveLength(2);

    const entry = s.memory.data.audit.at(-1);
    expect(entry).toMatchObject({
      action: NODE_KEY_NEW,
      target: 'node:local',
      via: 'engine',
      actor: { kind: 'engine', id: 'ops:node-key' },
    });
    const logged = JSON.stringify(s.memory.data.audit);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(pasted as string);
    expect(entry?.after).toEqual({ fingerprint: (pasted as string).slice(0, 12) });
    expect(s.closed()).toBe(1);

    // 贴进 FLEET_NODE_KEYS：启动认得；接收方拿这把明文认得出是 local
    const config = loadConfig({
      FLEET_ENV: 'development',
      FLEET_NODE_KEYS: JSON.stringify({ local: pasted }),
    });
    expect(nodeIdForToken(config.nodeKeys, TOKEN)).toBe('local');
  });

  it('【故意造出的失败】操作记录写不进：退出码 1，什么都不打印（发出去的钥匙必须有记录）', async () => {
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
    expect(await s.run(['new', 'local'])).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join('\n')).toContain('没发成');
    expect(s.err.join('\n')).not.toContain(TOKEN);
    expect(s.closed()).toBe(1);
  });

  it('【故意造出的失败】参数不对：退出码 2，不连库', async () => {
    const s = setup();
    let opened = 0;
    s.deps.openStore = async () => {
      opened += 1;
      throw new Error('不该连库');
    };
    for (const args of [[], ['new'], ['new', 'Bad']]) {
      expect(await main(['node-key', ...args], s.deps), args.join(' ')).toBe(2);
    }
    expect(opened).toBe(0);
    expect(s.out).toEqual([]);
  });

  it('真随机：不给 newToken 时每次发的都不一样，长度够（43 个字符）', async () => {
    const s = setup();
    delete s.deps.newToken;
    await main(['node-key', 'new', 'a'], s.deps);
    await main(['node-key', 'new', 'a'], s.deps);
    const tokens = s.out.map((t) => /^ {2}(\S{43})$/m.exec(t)?.[1]);
    expect(tokens[0]).toBeDefined();
    expect(tokens[1]).toBeDefined();
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('--help 只打印用法', async () => {
    const s = setup();
    expect(await s.run(['--help'])).toBe(0);
    expect(s.out.join('\n')).toContain('node-key new');
  });
});
