import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const PROD = {
  FLEET_ENV: 'production',
  FLEET_PUBLIC_URL: 'https://cockpit.example.test',
  FLEET_COCKPIT_LISTEN: 'wg-france:8787',
  FLEET_SESSION_SECRET: 's'.repeat(40),
  FLEET_AGENT_TOKEN_SECRET: 'a'.repeat(40),
  FLEET_GITHUB_WEBHOOK_SECRET: 'w'.repeat(20),
  FEISHU_APP_ID: 'cli_x',
  FEISHU_APP_SECRET: 'y',
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('配置', () => {
  it('生产配置齐全：能起；Cookie 加 Secure；免登关着；fleet 接口只听本机', () => {
    const config = loadConfig(PROD);
    expect(config).toMatchObject({
      env: 'production',
      cookieSecure: true,
      devLogin: false,
      cockpitListen: { host: 'wg-france', port: 8787 },
      agentListen: { host: '127.0.0.1', port: 8788 },
      askWaitMs: 240_000,
    });
  });

  it('什么都不给就拒绝启动，并且一次列出全部缺的', () => {
    const list = problems({});
    for (const name of [
      'FLEET_PUBLIC_URL',
      'FLEET_COCKPIT_LISTEN',
      'FLEET_SESSION_SECRET',
      'FLEET_AGENT_TOKEN_SECRET',
      'FLEET_GITHUB_WEBHOOK_SECRET',
      'FEISHU_APP_ID',
    ]) {
      expect(list.join('\n')).toContain(name);
    }
  });

  it('开发免登开关在生产环境：拒绝启动', () => {
    expect(problems({ ...PROD, FLEET_DEV_LOGIN: '1' }).join()).toContain('FLEET_DEV_LOGIN');
  });

  it('fleet 接口监听非本机地址、两把密钥相同、密钥太短、生产用 http：都拒绝启动', () => {
    expect(problems({ ...PROD, FLEET_AGENT_LISTEN: '0.0.0.0:8788' }).join()).toContain('FLEET_AGENT_LISTEN');
    expect(problems({ ...PROD, FLEET_AGENT_TOKEN_SECRET: PROD.FLEET_SESSION_SECRET }).join()).toContain(
      '不能相同',
    );
    expect(problems({ ...PROD, FLEET_SESSION_SECRET: 'short' }).join()).toContain('太短');
    expect(problems({ ...PROD, FLEET_PUBLIC_URL: 'http://cockpit.example.test' }).join()).toContain('https');
    expect(problems({ ...PROD, FLEET_ENV: 'staging' }).join()).toContain('FLEET_ENV');
    expect(problems({ ...PROD, FLEET_ASK_WAIT_SECONDS: '600' }).join()).toContain('FLEET_ASK_WAIT_SECONDS');
  });

  it('开发环境：缺的密钥临时生成，飞书和 GitHub 可以不配，免登要显式打开', () => {
    const dev = loadConfig({ FLEET_ENV: 'development' });
    expect(dev.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(dev.sessionSecret).not.toBe(dev.agentTokenSecret);
    expect(dev).toMatchObject({
      feishu: null,
      githubWebhookSecret: null,
      devLogin: false,
      cookieSecure: false,
    });
    expect(loadConfig({ FLEET_ENV: 'development', FLEET_DEV_LOGIN: '1' }).devLogin).toBe(true);
  });
});
