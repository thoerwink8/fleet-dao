import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPSTREAM_ENV } from '../src/claude-code/run.ts';
import { assertNoForbiddenEnv, buildSessionEnv, CREDENTIAL_ENV } from '../src/env.ts';

describe('buildSessionEnv', () => {
  const base = {
    HOME: '/home/agent',
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    XDG_RUNTIME_DIR: '/run/user/999',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    GH_TOKEN: 'ghs_from_host',
    GITHUB_TOKEN: 'ghs_from_host',
    GIT_ASKPASS: '/usr/lib/git-core/git-gui--askpass',
    GIT_CONFIG_COUNT: '1',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    SOME_SECRET: 'x',
    UNSET: undefined,
  };

  it('只从宿主抄白名单里的键：宿主的上游、代理、GitHub 凭据、密钥一个都不带', () => {
    const env = buildSessionEnv({ base, fleetApi: 'http://127.0.0.1:7070', fleetToken: 't1' });
    expect(env).toEqual({
      HOME: '/home/agent',
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      XDG_RUNTIME_DIR: '/run/user/999',
      FLEET_API: 'http://127.0.0.1:7070',
      FLEET_TOKEN: 't1',
    });
  });

  it('pathPrepend 放在 PATH 最前面', () => {
    const env = buildSessionEnv({ base, fleetApi: 'a', fleetToken: 'b', pathPrepend: ['/opt/fleet/bin'] });
    expect(env.PATH).toBe(['/opt/fleet/bin', '/usr/bin'].join(delimiter));
  });

  it.each([
    'GH_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_TOKEN',
    'GIT_ASKPASS',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'SSH_AUTH_SOCK',
  ])('会话只在本地提交、拿不到推送凭据：extra 里带 %s 就拒', (key) => {
    expect(() =>
      buildSessionEnv({ base: {}, fleetApi: 'a', fleetToken: 'b', extra: { [key]: 'x' } }),
    ).toThrow(key);
  });
});

describe('assertNoForbiddenEnv', () => {
  it.each([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'https_proxy',
    'HTTP_PROXY',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
  ])('Claude 会话带 %s 就拒起（reclaude 自己管上游、代理和证书）', (key) => {
    expect(() => assertNoForbiddenEnv({ PATH: '/usr/bin', [key]: 'x' }, UPSTREAM_ENV, '改道')).toThrow(key);
  });

  it('正常的会话环境放行', () => {
    const env = { PATH: '/usr/bin', FLEET_TOKEN: 't', FLEET_RUN_ID: 'r', GIT_TERMINAL_PROMPT: '0' };
    expect(() => assertNoForbiddenEnv(env, [...UPSTREAM_ENV, ...CREDENTIAL_ENV], '')).not.toThrow();
  });
});
