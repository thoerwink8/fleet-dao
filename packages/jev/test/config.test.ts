// 机器配置与「按路由起后端」：地址和密钥只从配置读、没有默认值；模型不钉死、执行方式接不了都当场报错。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backendForRoute,
  DEFAULT_JEV_CONFIG_PATH,
  JevConfigError,
  jevConfigPath,
  loadJevConfig,
  parseJevConfig,
} from '../src/config.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fleet-jev-config-'));
  dirs.push(d);
  return d;
};

const config = {
  typesafe: { endpoint: 'https://jev.example.invalid/v1/systemone', keyFile: '/etc/fleet-dao/typesafe.key' },
  claude: { command: ['/home/agent/.local/bin/reclaude'], effort: 'low' },
};

describe('机器配置', () => {
  it('路径从 FLEET_JEV_CONFIG 读，没设就是 /etc 下那份（不读仓里的任何东西）', () => {
    expect(jevConfigPath({ FLEET_JEV_CONFIG: '/tmp/x.json' })).toBe('/tmp/x.json');
    expect(jevConfigPath({})).toBe(DEFAULT_JEV_CONFIG_PATH);
  });

  it('合法配置照读；以 _ 开头的键是注释', () => {
    expect(parseJevConfig({ _说明: '注释', ...config })).toEqual(config);
  });

  it('仓里的样例配置本身是合法的', () => {
    const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    expect(parseJevConfig(example).claude?.effort).toBe('low');
  });

  it('写错的一次全报出来', () => {
    try {
      parseJevConfig({
        typesafe: { endpoint: 'http://x', keyFile: '' },
        claude: { command: [], effort: 'huge' },
        extra: 1,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JevConfigError);
      expect((err as JevConfigError).problems).toHaveLength(5);
    }
  });

  it('配置文件不在：报错，不退回任何默认值', async () => {
    await expect(loadJevConfig(join(temp(), 'missing.json'))).rejects.toThrow(JevConfigError);
    const bad = join(temp(), 'bad.json');
    writeFileSync(bad, '{ not json');
    await expect(loadJevConfig(bad)).rejects.toThrow(/不是合法的 JSON/);
  });
});

describe('按路由起后端', () => {
  const keyReader = (text: string) => async () => text;

  it('api-shell + jev-*：TypeSafe；密钥从配置指的文件读', async () => {
    const dir = temp();
    const keyFile = join(dir, 'typesafe.key');
    writeFileSync(keyFile, 'k-123\n');
    const parsed = parseJevConfig({ typesafe: { ...config.typesafe, keyFile } });
    // 测试里没注入 fetch 的 TypeSafe 后端会被拒（不出网），说明它确实在按配置起 TypeSafe。
    await expect(backendForRoute({ hostId: 'api-shell', model: 'jev-1.13.0' }, parsed)).rejects.toThrow(
      /测试里不许真调 TypeSafe/,
    );
  });

  it('claude-code：Claude 会话后端，模型就是路由上的具体型号', async () => {
    const backend = await backendForRoute(
      { hostId: 'claude-code', model: 'claude-opus-5-5' },
      parseJevConfig(config),
    );
    expect(backend).toMatchObject({ kind: 'claude-code', model: 'claude-opus-5-5' });
  });

  it('模型没钉死、配置缺那一节、密钥是空的、执行方式接不了：当场报错', async () => {
    const parsed = parseJevConfig(config);
    await expect(backendForRoute({ hostId: 'api-shell', model: 'jev-latest' }, parsed)).rejects.toThrow(
      /别名/,
    );
    await expect(backendForRoute({ hostId: 'claude-code', model: 'opus' }, parsed)).rejects.toThrow(
      /具体型号/,
    );
    await expect(
      backendForRoute(
        { hostId: 'api-shell', model: 'jev-1.13.0' },
        parseJevConfig({ claude: config.claude }),
      ),
    ).rejects.toThrow(/没有 typesafe/);
    await expect(
      backendForRoute({ hostId: 'api-shell', model: 'jev-1.13.0' }, parsed, keyReader('  \n')),
    ).rejects.toThrow(/空的/);
    await expect(backendForRoute({ hostId: 'codex', model: 'gpt-5.6-luna' }, parsed)).rejects.toThrow(
      /接不了判断题/,
    );
  });
});
