import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoUpstreamOverride } from '../src/claude-code/run.ts';
import { buildSessionEnv, githubTokenEnv } from '../src/env.ts';
import { git, isolatedGitEnv, tempDir } from './helpers.ts';

describe('buildSessionEnv', () => {
  const base = {
    HOME: '/home/agent',
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    SOME_SECRET: 'x',
    UNSET: undefined,
  };

  it('只从宿主抄白名单里的键，宿主的上游、代理、密钥一个都不带', () => {
    const env = buildSessionEnv({ base, fleetApi: 'http://127.0.0.1:7070', fleetToken: 't1' });
    expect(env).toEqual({
      HOME: '/home/agent',
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      FLEET_API: 'http://127.0.0.1:7070',
      FLEET_TOKEN: 't1',
    });
  });

  it('pathPrepend 放在 PATH 最前面', () => {
    const env = buildSessionEnv({ base, fleetApi: 'a', fleetToken: 'b', pathPrepend: ['/opt/fleet/bin'] });
    expect(env.PATH).toBe(['/opt/fleet/bin', '/usr/bin'].join(delimiter));
  });

  it('带上 GitHub 令牌时，gh 和 git 都能用它', () => {
    const env = buildSessionEnv({ base, fleetApi: 'a', fleetToken: 'b', githubToken: 'ghs_test' });
    expect(env.GH_TOKEN).toBe('ghs_test');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

describe('githubTokenEnv', () => {
  it('git 真的从 GH_TOKEN 取凭据，并且盖掉全局配置里原有的凭据助手', () => {
    // 全局配置里先放一个「错的」助手：清空没生效的话，它会先答
    const env = {
      ...isolatedGitEnv('[credential]\n\thelper = "!f() { echo username=wrong; echo password=wrong; }; f"\n'),
      ...githubTokenEnv('ghs_example_token'),
    };
    const out = git(
      tempDir(),
      ['credential', 'fill'],
      env,
      'protocol=https\nhost=github.com\npath=o/r.git\n\n',
    );
    expect(out).toContain('username=x-access-token');
    expect(out).toContain('password=ghs_example_token');
    expect(out).not.toContain('wrong');
  });
});

describe('assertNoUpstreamOverride', () => {
  it.each([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'https_proxy',
    'HTTP_PROXY',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
  ])('带 %s 就拒起', (key) => {
    expect(() => assertNoUpstreamOverride({ PATH: '/usr/bin', [key]: 'x' })).toThrow(key);
  });

  it('正常的会话环境放行', () => {
    expect(() =>
      assertNoUpstreamOverride({ PATH: '/usr/bin', FLEET_TOKEN: 't', GH_TOKEN: 'g' }),
    ).not.toThrow();
  });
});
