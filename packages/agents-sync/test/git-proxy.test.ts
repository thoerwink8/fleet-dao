// GitHub 的 git 走本机备用代理（src/git-proxy.ts）：~/.fleet-dao/fallback-proxy 在，就把 http.https://github.com/.proxy
// 设成它；不在就不设、照实报。真 git、假家目录（--file 指定死，不碰真机器的 ~/.gitconfig）。
// 起因：reclaude 的 56879 是写进用户级 settings env 的，改它会被写回；非 Claude Code 流量穿过它约 90 秒后设备被解绑
// （docs/reference/adapters.md CC-10）。本机实测 2026-10-13：github 走 127.0.0.1:7890 ok 1.0s，走 56879 失败 10.5s，直连失败 21.8s。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyGitProxy, checkGitProxy, GITHUB_PROXY_KEY, parseFallbackProxy } from '../src/git-proxy.ts';
import { runChild } from './child.ts';
import { cleanup, ctxFor, tempDir } from './helpers.ts';

afterEach(cleanup);
vi.setConfig({ testTimeout: 15_000 });

const KEY = `~/.gitconfig#${GITHUB_PROXY_KEY}`;

function machine(proxyFile?: string) {
  const home = tempDir('home');
  mkdirSync(join(home, '.fleet-dao'), { recursive: true });
  if (proxyFile !== undefined) writeFileSync(join(home, '.fleet-dao', 'fallback-proxy'), proxyFile);
  const ctx = ctxFor(home, ['claude']);
  const read = () => {
    const r = runChild('git', ['config', '--file', join(home, '.gitconfig'), '--get', GITHUB_PROXY_KEY]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return { home, ctx, read };
}

describe('配了备用代理', () => {
  it('查：缺失；写：设上；再查一致、再写零改动', () => {
    const m = machine('http://127.0.0.1:7890\n');
    expect(checkGitProxy(m.ctx)).toEqual([expect.objectContaining({ kind: 'missing', key: KEY })]);
    expect(applyGitProxy(m.ctx)).toEqual([expect.objectContaining({ kind: 'changed', key: KEY })]);
    expect(m.read()).toBe('http://127.0.0.1:7890');
    expect(checkGitProxy(m.ctx)).toEqual([expect.objectContaining({ kind: 'ok' })]);
    expect(applyGitProxy(m.ctx)).toEqual([expect.objectContaining({ kind: 'ok' })]);
  });

  it('机器上设着别的值：查报漂移，写改成备用代理那个', () => {
    const m = machine('socks5://127.0.0.1:7891');
    runChild('git', [
      'config',
      '--file',
      join(m.home, '.gitconfig'),
      GITHUB_PROXY_KEY,
      'http://127.0.0.1:56879',
    ]);
    expect(checkGitProxy(m.ctx)).toEqual([expect.objectContaining({ kind: 'drift' })]);
    expect(applyGitProxy(m.ctx)[0]?.text).toMatch(/56879/);
    expect(m.read()).toBe('socks5://127.0.0.1:7891');
  });
});

describe('【故意造出的失败】没配、配坏了', () => {
  it('没有 ~/.fleet-dao/fallback-proxy：不设，如实报没配（不报成一致）', () => {
    const m = machine();
    for (const lines of [checkGitProxy(m.ctx), applyGitProxy(m.ctx)]) {
      expect(lines).toEqual([expect.objectContaining({ kind: 'skip', key: KEY })]);
      expect(lines[0]?.text).toMatch(/没配.*fallback-proxy/);
    }
    expect(m.read()).toBeNull();
  });

  it('那一行认不出（不是 http:// 或 socks5://）：不设，报没做成', () => {
    const m = machine('ftp://127.0.0.1:7890');
    expect(applyGitProxy(m.ctx)).toEqual([expect.objectContaining({ kind: 'failed' })]);
    expect(checkGitProxy(m.ctx)).toEqual([expect.objectContaining({ kind: 'drift' })]);
    expect(m.read()).toBeNull();
  });
});

it('认备用代理的读法和钩子那份（agents/hooks/git-run.mjs）一样', async () => {
  const hooks = (await import(new URL('../../../agents/hooks/git-run.mjs', import.meta.url).href)) as {
    parseFallbackProxy: (t: string) => unknown;
  };
  for (const t of [
    '',
    'http://127.0.0.1:7890',
    'http://127.0.0.1:7890/\n# 注释',
    'socks5://proxy.lan:1080',
    'https://x:1',
    'http://127.0.0.1',
    '  http://h:2  ',
  ])
    expect(parseFallbackProxy(t)).toEqual(hooks.parseFallbackProxy(t));
});
