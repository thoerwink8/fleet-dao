// 香港 nginx 往驾驶舱只读口的连接复用（#3818）：空闲连接由 nginx 先关，后端得留得更久，不然后端刚关的连接 nginx 还拿去发请求就回 502。
// 和 packages/api/test/keep-alive.test.ts 对旧后端做的是同一件事。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COCKPIT_KEEP_ALIVE_MS } from '../src/cockpit.ts';

const NGINX_CONF = fileURLToPath(new URL('../../../deploy/hk/nginx-https.conf', import.meta.url));
const MARGIN_MS = 10_000;

function upstreamBlock(conf: string, name: string): string | null {
  const text = conf.replace(/#.*$/gm, '');
  return new RegExp(String.raw`upstream\s+${name}\s*\{([^}]*)\}`).exec(text)?.[1] ?? null;
}

function idleMs(block: string): number | null {
  const m = /(?:^|[;{\s])keepalive_timeout\s+(\d+)(ms|s|m|h)?\s*;/.exec(block);
  if (!m) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return Number(m[1]) * unit;
}

describe('香港 nginx 的 upstream fleet2_cockpit', () => {
  const conf = readFileSync(NGINX_CONF, 'utf8');
  const block = upstreamBlock(conf, 'fleet2_cockpit');

  it('在，连接复用，只指向隧道上的法国 7346', () => {
    expect(block).not.toBeNull();
    expect(block).toMatch(/keepalive\s+[1-9]\d*;/);
    expect(block).toMatch(/server\s+@@TUNNEL_PEER@@:7346;/);
  });

  it('keepalive_timeout 读得出来，且比后端的空闲超时短至少 10 秒', () => {
    const ms = idleMs(block ?? '');
    expect(ms).not.toBeNull();
    expect(COCKPIT_KEEP_ALIVE_MS).toBeGreaterThanOrEqual((ms ?? Number.POSITIVE_INFINITY) + MARGIN_MS);
  });

  it('读不出来就说读不出来：没写 keepalive_timeout 得到 null', () => {
    expect(idleMs('server 10.0.0.1:1;\n keepalive 16;')).toBeNull();
    expect(idleMs('keepalive_timeout 7m;')).toBe(420_000);
  });
});
