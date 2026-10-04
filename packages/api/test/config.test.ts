import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_SERVICES, ConfigError, engineEnabled, loadConfig } from '../src/config.ts';

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
      databaseUrl: 'postgres://fleet@localhost/fleet',
      feishuGatewayToken: null,
      temporalAddress: '127.0.0.1:7243',
      temporalNamespace: 'fleet',
      fleetTaskQueue: 'fleet',
    });
  });

  it('Temporal 地址、命名空间、任务队列：不给用默认（和引擎同一套默认），给了用给的', () => {
    expect(loadConfig(PROD)).toMatchObject({
      temporalAddress: '127.0.0.1:7243',
      temporalNamespace: 'fleet',
      fleetTaskQueue: 'fleet',
    });
    expect(
      loadConfig({
        ...PROD,
        TEMPORAL_ADDRESS: 'temporal.internal:7233',
        TEMPORAL_NAMESPACE: 'fleet-prod',
        FLEET_TASK_QUEUE: 'fleet-main',
      }),
    ).toMatchObject({
      temporalAddress: 'temporal.internal:7233',
      temporalNamespace: 'fleet-prod',
      fleetTaskQueue: 'fleet-main',
    });
  });

  it('这台机器开没开引擎看 release.env 的 FLEET_SERVICES：列了 fleet-engine 才算开，只留 fleet-api 或空的算关', () => {
    expect(engineEnabled({ FLEET_SERVICES: 'fleet-engine fleet-api' })).toBe(true);
    expect(engineEnabled({ FLEET_SERVICES: 'fleet-api fleet-engine' })).toBe(true);
    expect(engineEnabled({ FLEET_SERVICES: '  fleet-engine  ' })).toBe(true);
    expect(engineEnabled({ FLEET_SERVICES: 'fleet-api' })).toBe(false);
    expect(engineEnabled({ FLEET_SERVICES: '' })).toBe(false);
  });

  it('故意造出失败：读不懂的一律按开着算，不能当成「关了」把引擎的红盖住（没读到、拼错了名字、多了不认识的名字）', () => {
    expect(engineEnabled({})).toBe(true);
    expect(engineEnabled({ FLEET_SERVICES: undefined })).toBe(true);
    expect(engineEnabled({ FLEET_SERVICES: 'fleet-engin fleet-api' })).toBe(true);
    expect(engineEnabled({ FLEET_SERVICES: 'fleet-engine-old fleet-api' })).toBe(true);
    expect(engineEnabled({ FLEET_SERVICES: 'fleet-api fleet-gateway' })).toBe(true);
  });

  it('认识的服务名和发布脚本的 APP_UNITS 是同一份（一边加了服务、这边不认，就会一律按开着算）', () => {
    const script = readFileSync(new URL('../../../deploy/release.sh', import.meta.url), 'utf8');
    const units = /^APP_UNITS=\(([^)]*)\)/m.exec(script)?.[1]?.trim().split(/\s+/);
    expect(units).toBeDefined();
    expect([...(units ?? [])].sort()).toEqual([...APP_SERVICES].sort());
  });

  /** fleet-api.service 把 release.env 读进环境：带「-」（机器上没有这个文件也起）、放在 api.env 前面（同名键以 api.env 为准）。 */
  const readsReleaseEnvBeforeApiEnv = (unit: string): boolean => {
    const files = [...unit.matchAll(/^EnvironmentFile=(.+)$/gm)].map((m) => m[1]);
    const release = files.indexOf('-/etc/fleet-dao/release.env');
    const api = files.indexOf('/etc/fleet-dao/api.env');
    return release >= 0 && api >= 0 && release < api;
  };

  it('后端单元真把 release.env 读进环境（否则 engineEnabled 永远读不到 FLEET_SERVICES、一直按开着算）；故意改坏的三种都查得出', () => {
    const unit = readFileSync(new URL('../../../deploy/france/fleet-api.service', import.meta.url), 'utf8');
    expect(readsReleaseEnvBeforeApiEnv(unit)).toBe(true);
    const line = 'EnvironmentFile=-/etc/fleet-dao/release.env\n';
    expect(unit).toContain(line);
    expect(readsReleaseEnvBeforeApiEnv(unit.replace(line, ''))).toBe(false); // 没读
    expect(
      readsReleaseEnvBeforeApiEnv(
        unit
          .replace(line, '')
          .replace(
            'EnvironmentFile=/etc/fleet-dao/api.env\n',
            `EnvironmentFile=/etc/fleet-dao/api.env\n${line}`,
          ),
      ),
    ).toBe(false); // 放到 api.env 后面
    expect(
      readsReleaseEnvBeforeApiEnv(unit.replace(line, 'EnvironmentFile=/etc/fleet-dao/release.env\n')),
    ).toBe(false); // 少了「-」：没这个文件时起不来
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

describe('接不接飞书登录（FLEET_FEISHU_LOGIN：本机档不接飞书，要明说 off）', () => {
  const NO_FEISHU: Record<string, string | undefined> = {
    ...PROD,
    FEISHU_APP_ID: undefined,
    FEISHU_APP_SECRET: undefined,
  };

  it('【故意造出的失败】生产上没写开关、飞书又没配：拒启动，并说清不接的要写 FLEET_FEISHU_LOGIN=off（不默认放行）；写 on、空着跟没写一样', () => {
    for (const env of [
      NO_FEISHU,
      { ...NO_FEISHU, FLEET_FEISHU_LOGIN: 'on' },
      { ...NO_FEISHU, FLEET_FEISHU_LOGIN: '' },
    ]) {
      const text = problems(env).join('\n');
      expect(text).toContain('缺 FEISHU_APP_ID / FEISHU_APP_SECRET');
      expect(text).toContain('FLEET_FEISHU_LOGIN=off');
    }
  });

  it('明说 off、飞书一对空着：能起，飞书登录是 null（登录只剩账密）', () => {
    expect(loadConfig({ ...NO_FEISHU, FLEET_FEISHU_LOGIN: 'off' }).feishu).toBeNull();
    expect(
      loadConfig({ ...NO_FEISHU, FLEET_FEISHU_LOGIN: ' off ', FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' })
        .feishu,
    ).toBeNull();
  });

  it('【故意造出的失败】#803 明说 off、环境文件里却留着网关通行证：不认它（null）、feishuOff 为 true；不写 off 的照旧认', () => {
    const token = 'g'.repeat(40);
    const off = loadConfig({ ...NO_FEISHU, FLEET_FEISHU_LOGIN: 'off', FLEET_FEISHU_GATEWAY_TOKEN: token });
    expect(off.feishuOff).toBe(true);
    expect(off.feishuGatewayToken).toBeNull();
    const on = loadConfig({ ...PROD, FLEET_FEISHU_GATEWAY_TOKEN: token });
    expect(on.feishuOff).toBe(false);
    expect(on.feishuGatewayToken).toBe(token);
    // 通行证写坏了，off 也不放过
    expect(
      problems({ ...NO_FEISHU, FLEET_FEISHU_LOGIN: 'off', FLEET_FEISHU_GATEWAY_TOKEN: 'short' }).join(),
    ).toContain('FLEET_FEISHU_GATEWAY_TOKEN 太短');
  });

  it('【故意造出的失败】off 了又配了飞书（哪怕只配一半）：拒启动，接不接说不清', () => {
    expect(problems({ ...PROD, FLEET_FEISHU_LOGIN: 'off' }).join()).toContain('接不接说不清');
    expect(problems({ ...NO_FEISHU, FLEET_FEISHU_LOGIN: 'off', FEISHU_APP_ID: 'cli_x' }).join()).toContain(
      '接不接说不清',
    );
  });

  it('【故意造出的失败】开关写错（OFF、false、0、no）：拒启动，不猜成哪一种', () => {
    for (const value of ['OFF', 'false', '0', 'no']) {
      expect(problems({ ...NO_FEISHU, FLEET_FEISHU_LOGIN: value }).join(), value).toContain(
        'FLEET_FEISHU_LOGIN 只能是 on 或 off',
      );
    }
  });

  it('照常接飞书（法国）：写 on 或不写、飞书一对齐，飞书登录照常', () => {
    const pair = { appId: 'cli_x', appSecret: 'y' };
    expect(loadConfig(PROD).feishu).toEqual(pair);
    expect(loadConfig({ ...PROD, FLEET_FEISHU_LOGIN: 'on' }).feishu).toEqual(pair);
  });

  it('仓里登记的期望和这里的判法对得上：本机档是 off（拿它、飞书空着起得来），法国是 on（拿它、飞书空着起不来）', () => {
    const apiEnvOf = (profile: 'local' | 'france') =>
      (
        JSON.parse(
          readFileSync(new URL(`../../../deploy/${profile}/desired-config.json`, import.meta.url), 'utf8'),
        ) as { files: { 'api.env': Record<string, { value?: string }> } }
      ).files['api.env'];
    const local = apiEnvOf('local').FLEET_FEISHU_LOGIN?.value;
    const france = apiEnvOf('france').FLEET_FEISHU_LOGIN?.value;
    expect(local).toBe('off');
    expect(france).toBe('on');
    expect(loadConfig({ ...NO_FEISHU, FLEET_FEISHU_LOGIN: local }).feishu).toBeNull();
    expect(problems({ ...NO_FEISHU, FLEET_FEISHU_LOGIN: france }).join()).toContain('缺 FEISHU_APP_ID');
  });
});
