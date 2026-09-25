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
  DATABASE_URL: 'postgres://fleet@localhost/fleet',
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
  it('生产配置齐全：能起；Cookie 加 Secure；免登关着；fleet 接口只听本机；网关通行证没配就是 null', () => {
    const config = loadConfig(PROD);
    expect(config).toMatchObject({
      env: 'production',
      cookieSecure: true,
      devLogin: false,
      cockpitListen: { host: 'wg-france', port: 8787 },
      agentListen: { host: '127.0.0.1', port: 8788 },
      askWaitMs: 240_000,
      databaseUrl: 'postgres://fleet@localhost/fleet',
      feishuGatewayToken: null,
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
      'DATABASE_URL',
    ]) {
      expect(list.join('\n')).toContain(name);
    }
  });

  it('开发免登开关在生产环境：拒绝启动', () => {
    expect(problems({ ...PROD, FLEET_DEV_LOGIN: '1' }).join()).toContain('FLEET_DEV_LOGIN');
  });

  it('开发免登开关 + 驾驶舱接口监听非回环地址（/auth 会被转发到公网）：拒绝启动，哪怕是开发环境', () => {
    for (const listen of ['wg-france:8787', '0.0.0.0:8787', '[::]:8787']) {
      const list = problems({ FLEET_ENV: 'development', FLEET_DEV_LOGIN: '1', FLEET_COCKPIT_LISTEN: listen });
      expect(list.join(), listen).toContain('只允许驾驶舱接口监听本机回环地址');
    }
    for (const listen of ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787']) {
      expect(
        loadConfig({ FLEET_ENV: 'development', FLEET_DEV_LOGIN: '1', FLEET_COCKPIT_LISTEN: listen }).devLogin,
      ).toBe(true);
    }
    // 没开免登的开发环境照样可以听非回环地址。
    expect(loadConfig({ FLEET_ENV: 'development', FLEET_COCKPIT_LISTEN: 'wg-france:8787' }).devLogin).toBe(
      false,
    );
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

  it('飞书网关通行证：太短、和别的密钥相同都拒绝启动', () => {
    expect(problems({ ...PROD, FLEET_FEISHU_GATEWAY_TOKEN: 'short' }).join()).toContain(
      'FLEET_FEISHU_GATEWAY_TOKEN 太短',
    );
    expect(problems({ ...PROD, FLEET_FEISHU_GATEWAY_TOKEN: PROD.FLEET_SESSION_SECRET }).join()).toContain(
      '不能和别的密钥相同',
    );
    expect(loadConfig({ ...PROD, FLEET_FEISHU_GATEWAY_TOKEN: 'g'.repeat(40) }).feishuGatewayToken).toBe(
      'g'.repeat(40),
    );
  });

  it('开发环境：缺的密钥临时生成，飞书、GitHub、数据库可以不配，免登要显式打开', () => {
    const dev = loadConfig({ FLEET_ENV: 'development' });
    expect(dev.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(dev.sessionSecret).not.toBe(dev.agentTokenSecret);
    expect(dev).toMatchObject({
      feishu: null,
      githubWebhookSecret: null,
      databaseUrl: null,
      devLogin: false,
      cookieSecure: false,
    });
    expect(loadConfig({ FLEET_ENV: 'development', FLEET_DEV_LOGIN: '1' }).devLogin).toBe(true);
  });
});
