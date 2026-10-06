import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPSTREAM_ENV } from '../src/claude-code/run.ts';
import {
  assertNoForbiddenEnv,
  buildSessionEnv,
  CREDENTIAL_ENV,
  PROXY_ENV_KEYS,
  parseSessionProxy,
  SESSION_NO_PROXY,
} from '../src/env.ts';

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

  it('TMPDIR 不从宿主抄（那是引擎自己的）；给了会话自己的临时目录，TMPDIR、TEMP、TMP 都指向它，已有的写法（Temp）照原样改', () => {
    const host = { ...base, TMPDIR: '/var/lib/fleet-dao/engine/tmp', Temp: 'C:\\engine-temp' };
    expect(buildSessionEnv({ base: host, fleetApi: 'a', fleetToken: 'b' }).TMPDIR).toBeUndefined();
    const own = '/var/lib/fleet-work/_tmp/run-1';
    const env = buildSessionEnv({ base: host, fleetApi: 'a', fleetToken: 'b', tmpDir: own });
    expect(env).toMatchObject({ TMPDIR: own, Temp: own, TMP: own });
    expect(env.TEMP).toBeUndefined();
  });

  it('【故意造出的失败】会话的临时目录不是绝对路径：明确拒，不拿相对路径（会落进工作树）当临时目录', () => {
    expect(() => buildSessionEnv({ base: {}, fleetApi: 'a', fleetToken: 'b', tmpDir: 'tmp/run-1' })).toThrow(
      '绝对路径',
    );
  });

  it('给了代理（期望里登记的 FLEET_SESSION_PROXY）：http(s)_proxy 大小写各一份、no_proxy 只放本机回环，都是规范写法', () => {
    const env = buildSessionEnv({ base, fleetApi: 'a', fleetToken: 'b', proxy: 'http://127.0.0.1:7890/' });
    const proxy = 'http://127.0.0.1:7890';
    expect(Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, env[k]]))).toEqual({
      http_proxy: proxy,
      https_proxy: proxy,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      no_proxy: SESSION_NO_PROXY,
      NO_PROXY: SESSION_NO_PROXY,
    });
    expect(SESSION_NO_PROXY).toBe('localhost,127.0.0.1,::1');
  });

  it('【故意造出的失败】给的代理认不出（带账号密码、https、socks、没写端口、端口出界、带路径、主机认不出、乱写）：拒起，不悄悄直连', () => {
    for (const bad of [
      'http://user:pass@127.0.0.1:7890',
      'http://user@127.0.0.1:7890',
      'https://127.0.0.1:7890',
      'socks5://127.0.0.1:7890',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.1:7890/pac',
      'http://127.0.0.1:7890/?a=1',
      'http://[::1]:7890',
      'http://proxy_1:7890',
      '127.0.0.1:7890',
      '',
    ]) {
      expect(() => buildSessionEnv({ base: {}, fleetApi: 'a', fleetToken: 'b', proxy: bad })).toThrow(
        '会话的代理要写成 http://主机:端口',
      );
    }
    // 报错里不带原值：账号密码会跟着进引擎的日志
    let message = '';
    try {
      parseSessionProxy('http://user:fakesecret@127.0.0.1:7890');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('带了账号密码');
    expect(message).not.toContain('fakesecret');
  });

  it('认的样子、规范成的写法和装机脚本一样（deploy/lib/session-proxy.sh 的 session_proxy_load）：写明的 80 口也认，主机名照小写存', () => {
    expect(parseSessionProxy('http://127.0.0.1:80')).toBe('http://127.0.0.1:80');
    expect(parseSessionProxy(' http://Proxy.Local:7890/ ')).toBe('http://proxy.local:7890');
    // deploy/test/profile.test.sh 拿同一个值核装机脚本那边
    expect(parseSessionProxy('http://Proxy.Local:07890/')).toBe('http://proxy.local:7890');
  });

  it('Claude 会话给了代理就拒起（reclaude 自己管上游和代理，会话经它的本地口出去）', () => {
    const env = buildSessionEnv({ base: {}, fleetApi: 'a', fleetToken: 'b', proxy: 'http://127.0.0.1:7890' });
    expect(() => assertNoForbiddenEnv(env, UPSTREAM_ENV, '改道')).toThrow('PROXY');
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
