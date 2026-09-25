import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_CONFIG_PATH,
  loadQuotaConfig,
  parseQuotaConfig,
  QuotaConfigError,
  quotaConfigPath,
} from '../../src/quota/index.ts';
import { FIXTURES } from './helpers.ts';

const EXAMPLE = join(FIXTURES, '..', '..', '..', '..', '..', 'deploy', 'examples', 'quota.example.json');

function problems(raw: unknown): string[] {
  try {
    parseQuotaConfig(raw);
    return [];
  } catch (e) {
    if (e instanceof QuotaConfigError) return e.problems;
    throw e;
  }
}

describe('配置文件在哪', () => {
  it('FLEET_QUOTA_CONFIG 优先，没有就用 /etc/fleet-dao/quota.json', () => {
    expect(quotaConfigPath({ FLEET_QUOTA_CONFIG: '/tmp/q.json' })).toBe('/tmp/q.json');
    expect(quotaConfigPath({})).toBe(DEFAULT_QUOTA_CONFIG_PATH);
    expect(DEFAULT_QUOTA_CONFIG_PATH).toBe('/etc/fleet-dao/quota.json');
  });
});

describe('仓里的样例和校验同步', () => {
  it('deploy/examples/quota.example.json 过得了校验，六个池一个不少', async () => {
    const config = await loadQuotaConfig(EXAMPLE);
    expect(config.pools.map((p) => p.poolId)).toEqual([
      'claude-solo',
      'claude-carpool',
      'mirasim-relay',
      'cursor',
      'grok',
      'jev',
    ]);
  });
});

describe('配置校验：一次列全，不撞到第一个就停', () => {
  it('拼错的键、重复的池、没有的读取器都报出来', () => {
    const got = problems({
      pools: [
        { poolId: 'a', channelId: 'c', reader: 'mirasim-relay', tokenfile: '/x' },
        { poolId: 'a', channelId: 'c', reader: 'mirasim-relay' },
        { poolId: 'b', channelId: 'c', reader: 'guess' },
      ],
    });
    expect(got).toEqual([
      'pools[0] 有不认识的键 tokenfile',
      'pools[1].poolId a 重复',
      'pools[2].reader 要是 claude-usage / reclaude-carpool / mirasim-relay / cursor-dashboard / grok-billing / estimate 之一',
    ]);
  });

  it('Claude 的环境变量按前缀禁 ANTHROPIC_*，另禁 CLAUDE_CODE_OAUTH_TOKEN（都会绕开 reclaude）', () => {
    const got = problems({
      pools: [
        {
          poolId: 'c',
          channelId: 'claude-sub',
          reader: 'claude-usage',
          command: ['reclaude'],
          env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/x',
            anthropic_custom_headers: 'x',
            CLAUDE_CODE_OAUTH_TOKEN: 'x',
            LANG: 'C.UTF-8',
          },
        },
      ],
    });
    expect(got).toHaveLength(3);
    for (const key of ['ANTHROPIC_BASE_URL', 'anthropic_custom_headers', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(got.join('\n')).toContain(key);
    }
  });

  it('估算窗口要写全：时长、单位、上限', () => {
    const got = problems({
      pools: [
        {
          poolId: 'j',
          channelId: 'jev',
          reader: 'estimate',
          windows: [{ label: 'd', window: 'day', unit: 'tokens' }],
        },
      ],
    });
    expect(got).toEqual([
      'pools[0].windows[0].window 要是 5h / 7d / 7d_model / month_usd / points / period_usd / other',
      'pools[0].windows[0].unit 要是 usd 或 points',
      'pools[0].windows[0].periodHours 要是正数',
    ]);
  });

  it('_ 开头的键当注释放行；空的 pools 不行', () => {
    expect(
      problems({ _说明: 'x', pools: [{ _说明: 'y', poolId: 'm', channelId: 'c', reader: 'mirasim-relay' }] }),
    ).toEqual([]);
    expect(problems({ pools: [] })).toEqual(['pools 要是非空数组']);
  });
});

describe('读配置文件', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-quota-config-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('文件不在：报错并指向样例', async () => {
    await expect(loadQuotaConfig(join(dir, 'nope.json'))).rejects.toThrowError(/quota\.example\.json/);
  });

  it('不是 JSON：报错', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{ pools: [');
    await expect(loadQuotaConfig(path)).rejects.toBeInstanceOf(QuotaConfigError);
  });
});
