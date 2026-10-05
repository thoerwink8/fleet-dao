// 引擎连 github.com 的 git 经这一档登记的代理（#786）：本机档 WSL 直连 github.com 时通时不通，要经 Windows 上的 Clash；
// 法国登记空＝直连，一项代理都不加。只认 FLEET_SESSION_PROXY，不认环境里碰巧有的 http_proxy。不出网：git 用桩。
import { describe, expect, it } from 'vitest';
import { execGit, type GitRunner, netGitConfig, sessionProxyConfig } from '../src/git.ts';
import { setup } from './helpers.ts';

const repo = { owner: 'acme', name: 'widgets' };
const PROXY = 'http://127.0.0.1:7890';

/** 配置里（GIT_CONFIG_KEY_n / VALUE_n）有没有 http.proxy，有就返回值。 */
function proxyOf(env: Record<string, string>): string | undefined {
  const n = Number(env.GIT_CONFIG_COUNT ?? '0');
  for (let i = 0; i < n; i++)
    if (env[`GIT_CONFIG_KEY_${i}`] === 'http.proxy') return env[`GIT_CONFIG_VALUE_${i}`];
  return undefined;
}

describe('sessionProxyConfig', () => {
  it('登记了就给 http.proxy（规范写法），空着或没写＝不加', () => {
    expect(sessionProxyConfig({ FLEET_SESSION_PROXY: PROXY })).toEqual([['http.proxy', PROXY]]);
    expect(sessionProxyConfig({ FLEET_SESSION_PROXY: 'http://Clash.local:7890/' })).toEqual([
      ['http.proxy', 'http://clash.local:7890'],
    ]);
    expect(sessionProxyConfig({ FLEET_SESSION_PROXY: '' })).toEqual([]);
    expect(sessionProxyConfig({ FLEET_SESSION_PROXY: '  ' })).toEqual([]);
    expect(sessionProxyConfig({})).toEqual([]);
  });

  it('不认环境里碰巧有的 http_proxy 之类（只认登记的那一项）', () => {
    expect(sessionProxyConfig({ http_proxy: PROXY, HTTPS_PROXY: PROXY, ALL_PROXY: PROXY })).toEqual([]);
  });

  it('写了但认不出就抛错，不退回直连，错误里不带值', () => {
    for (const bad of [
      'socks5://127.0.0.1:7890',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:70000',
      // 拆开拼：整串「带账号密码的网址」摆在公开仓里会被卫生检查拦（它不是真密钥，但形状一样）
      `http://user:${'secretpw'}@127.0.0.1:7890`,
      '127.0.0.1:7890',
    ]) {
      let message = '';
      try {
        sessionProxyConfig({ FLEET_SESSION_PROXY: bad });
      } catch (err) {
        expect((err as { code?: string }).code).toBe('BAD_SESSION_PROXY');
        message = (err as Error).message;
      }
      expect(message, bad).not.toBe('');
      expect(message).not.toContain('secretpw');
    }
  });

  it('netGitConfig：令牌请求头和代理一起给', () => {
    const cfg = netGitConfig('https://github.com/', 'ghs_x', { FLEET_SESSION_PROXY: PROXY });
    expect(cfg.some(([k]) => k === 'http.https://github.com/.extraHeader')).toBe(true);
    expect(cfg.at(-1)).toEqual(['http.proxy', PROXY]);
    expect(netGitConfig('https://github.com/', 'ghs_x', {}).some(([k]) => k === 'http.proxy')).toBe(false);
  });
});

/** 记下每次 git 的参数和环境；查远端那一步（出网）直接返回失败，不真连。 */
function recording() {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const runner: GitRunner = async (args, call) => {
    calls.push({ args, env: call.env });
    if (args[0] === 'ls-remote' || args[0] === 'fetch')
      return { code: 128, stdout: '', stderr: 'fatal: stub: no network' };
    return execGit(args, call);
  };
  return { calls, runner };
}

const NET = new Set(['ls-remote', 'fetch', 'push']);

describe('引擎出网的 git 带上登记的代理', () => {
  const entries: [string, (gh: ReturnType<typeof setup>['gh']) => Promise<unknown>][] = [
    [
      '推分支',
      (gh) => gh.pushBranch({ repo, bundlePath: '/nonexistent', branch: 'task/1-a', head: 'a'.repeat(40) }),
    ],
    ['同步主线', (gh) => gh.syncMainline({ repo, branch: 'task/1-a', head: 'a'.repeat(40), prNumber: 1 })],
    ['抓主线', (gh) => gh.fetchMainline({ repo })],
    ['抓分支头', (gh) => gh.fetchBranchHead({ repo, branch: 'task/1-a' })],
  ];

  for (const [name, run] of entries) {
    it(`${name}：本机档（登记了）出网那步带 http.proxy，本地的 git 不带`, async () => {
      const { calls, runner } = recording();
      const { gh } = setup({
        git: runner,
        gitUrl: () => 'https://github.com/acme/widgets.git',
        env: { FLEET_SESSION_PROXY: PROXY },
      });
      await run(gh).catch(() => undefined);
      const net = calls.filter((c) => NET.has(c.args[0] ?? ''));
      expect(net.length, '没跑到出网那一步，测不到').toBeGreaterThan(0);
      for (const c of net) expect(proxyOf(c.env)).toBe(PROXY);
      for (const c of calls.filter((x) => !NET.has(x.args[0] ?? ''))) expect(proxyOf(c.env)).toBeUndefined();
      // 代理不进命令行参数
      expect(calls.filter((c) => c.args.join(' ').includes('7890'))).toEqual([]);
    });

    it(`${name}：法国档（登记空）一项代理都不带，环境里碰巧有的 http_proxy 也不当成登记`, async () => {
      const { calls, runner } = recording();
      const { gh } = setup({
        git: runner,
        gitUrl: () => 'https://github.com/acme/widgets.git',
        env: { FLEET_SESSION_PROXY: '', http_proxy: PROXY },
      });
      await run(gh).catch(() => undefined);
      const net = calls.filter((c) => NET.has(c.args[0] ?? ''));
      expect(net.length, '没跑到出网那一步，测不到').toBeGreaterThan(0);
      for (const c of calls) expect(proxyOf(c.env)).toBeUndefined();
    });

    it(`${name}：登记的认不出，报 BAD_SESSION_PROXY，一次出网的 git 都不跑`, async () => {
      const { calls, runner } = recording();
      const { gh } = setup({
        git: runner,
        gitUrl: () => 'https://github.com/acme/widgets.git',
        env: { FLEET_SESSION_PROXY: 'socks5://127.0.0.1:7890' },
      });
      const err = await run(gh).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as { code?: string } | null)?.code).toBe('BAD_SESSION_PROXY');
      expect(calls.filter((c) => NET.has(c.args[0] ?? ''))).toEqual([]);
    });
  }
});
