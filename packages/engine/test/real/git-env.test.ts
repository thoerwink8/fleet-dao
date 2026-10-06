// 引擎自己的 git 出网经会话代理（real/git-env.ts，#786 同一个根）：登记了代理，git 子进程的环境里就带 http(s)_proxy；
// 法国不登记一个字不加；代理认不出直接抛、不悄悄直连；凭据类变量照旧被 gitEnv 去掉。
import { gitEnv } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { gitNetworkEnv } from '../../src/real/git-env.ts';

const BASE = { PATH: '/usr/bin', HOME: '/root', GH_TOKEN: 'placeholder-never-reaches-git' };

describe('引擎 git 的父环境', () => {
  it('登记了代理：经 gitEnv 到 git 子进程的环境里有 http(s)_proxy 和 no_proxy，凭据类变量照旧被去掉', () => {
    const env = gitEnv({ base: gitNetworkEnv(BASE, 'http://127.0.0.1:7890') });
    expect(env.https_proxy).toBe('http://127.0.0.1:7890');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.http_proxy).toBe('http://127.0.0.1:7890');
    expect(env.no_proxy).toContain('127.0.0.1');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('【故意造出的失败】不登记（法国）：环境里一个代理变量都不许有（多了就是法国走了代理）', () => {
    const env = gitEnv({ base: gitNetworkEnv(BASE, undefined) });
    for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY']) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it('【故意造出的失败】代理认不出（带账号密码、socks、没写端口）：直接抛，不悄悄改成直连', () => {
    for (const bad of [
      'socks5://127.0.0.1:7890',
      ['http://u', 'ser:p', 'w@127.0.0.1:7890'].join(''),
      'http://127.0.0.1',
    ]) {
      expect(() => gitNetworkEnv(BASE, bad), bad).toThrow();
    }
  });
});
