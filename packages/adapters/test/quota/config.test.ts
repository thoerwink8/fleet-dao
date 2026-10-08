import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_CONFIG_PATH,
  loadQuotaConfig,
  parseQuotaConfig,
  QuotaConfigError,
  quotaConfigPath,
} from '../../src/quota/index.ts';
import { FIXTURES } from './helpers.ts';

const REPO_QUOTA_CONFIG = join(FIXTURES, '..', '..', '..', '..', '..', 'deploy', 'quota.json');

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
  it('FLEET_QUOTA_CONFIG 优先，没有就读这一版自带的 deploy/quota.json（不再有手放的 /etc 文件）', () => {
    expect(quotaConfigPath({ FLEET_QUOTA_CONFIG: '/tmp/q.json' })).toBe('/tmp/q.json');
    expect(quotaConfigPath({})).toBe(DEFAULT_QUOTA_CONFIG_PATH);
    expect(resolve(DEFAULT_QUOTA_CONFIG_PATH)).toBe(resolve(REPO_QUOTA_CONFIG));
    expect(DEFAULT_QUOTA_CONFIG_PATH).not.toContain('/etc/fleet-dao');
  });
});

describe('仓里的额度配置和校验同步', () => {
  it('不带环境变量的默认路径读得出来、过得了校验', async () => {
    const config = await loadQuotaConfig();
    expect(config.pools.length).toBeGreaterThan(0);
  });

  it('deploy/quota.json 过得了校验；五个池在读，jev 写在 notRead（没有日账）', async () => {
    const config = await loadQuotaConfig(REPO_QUOTA_CONFIG);
    expect(config.pools.map((p) => p.poolId)).toEqual([
      'claude-solo',
      'claude-carpool',
      'mirasim-relay',
      'cursor',
      'grok',
    ]);
    expect(config.notRead?.map((p) => p.poolId)).toEqual(['jev']);
    expect(config.notRead?.[0]?.why).toContain('没有旧系统的日账');
    const text = await readFile(REPO_QUOTA_CONFIG, 'utf8');
    const raw = JSON.parse(text) as { pools: { usage?: unknown; poolId?: string }[] };
    expect(raw.pools.map((p) => p.poolId)).not.toContain('jev');
    expect(raw.pools.every((p) => p.usage === undefined)).toBe(true);
  });

  it('凭据路径都是写死的绝对路径：没有占位符，会话用户的文件写它家里的路径', async () => {
    const text = await readFile(REPO_QUOTA_CONFIG, 'utf8');
    expect(text).not.toMatch(/<[^>]*>/);
    const paths = Object.fromEntries(
      JSON.parse(text).pools.map((p: Record<string, unknown>) => [
        p.poolId,
        [
          p.authFile,
          p.tokenFile,
          p.keyFile,
          (p.command as string[] | undefined)?.[0],
          (p.usage as { dir?: string } | undefined)?.dir,
        ],
      ]),
    ) as Record<string, (string | undefined)[]>;
    for (const poolId of ['claude-solo', 'mirasim-relay', 'cursor', 'grok']) {
      const own = (paths[poolId] ?? []).filter((v): v is string => typeof v === 'string');
      expect(own.length, poolId).toBeGreaterThan(0);
      for (const v of own) expect(v, poolId).toMatch(/^\/home\/fleet-agent-carpool\//);
    }
    expect(paths['claude-carpool']).toContain('/etc/fleet-dao/reclaude-api.key');
  });
});

describe('配置校验：一次列全，不撞到第一个就停', () => {
  it('Cursor 池认 keyFile，空字符串报出来', () => {
    const cursor = { poolId: 'c', channelId: 'c', reader: 'cursor-dashboard' };
    expect(problems({ pools: [{ ...cursor, keyFile: '/home/x/.cursor/fleet-api-key' }] })).toEqual([]);
    expect(problems({ pools: [{ ...cursor, keyFile: ' ' }] })).toEqual(['pools[0].keyFile 要是非空字符串']);
  });

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

  it('【故意造出的失败】同一个池既在 pools 里又写进 notRead：配置不认', () => {
    expect(
      problems({
        pools: [{ poolId: 'jev', channelId: 'jev', reader: 'mirasim-relay' }],
        notRead: [{ poolId: 'jev', why: '没有日账' }],
      }),
    ).toEqual(['notRead[0].poolId jev 已经在 pools 里，不能又写不读']);
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

  it('文件不在：报错并写明默认读哪份、怎么换位置', async () => {
    await expect(loadQuotaConfig(join(dir, 'nope.json'))).rejects.toThrowError(
      /deploy\/quota\.json[\s\S]*FLEET_QUOTA_CONFIG/,
    );
  });

  it('不是 JSON：报错', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{ pools: [');
    await expect(loadQuotaConfig(path)).rejects.toBeInstanceOf(QuotaConfigError);
  });
});
