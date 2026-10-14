// 装配完成前先听上：/healthz 立刻回「还在启动」，不挂起；换成正式处理之后走新的函数。
// 公开文案过禁用词名单（和 health-public-text.test.ts 同一套，运行时 import，不把 web 算进 api 的 tsc 项目）。
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type EarlyListeners, openEarly, startupResponse } from '../src/early-listen.ts';

const SCAN = '../../web/src/build/scan.ts';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function devEnv(): Promise<NodeJS.ProcessEnv> {
  const cockpit = await freePort();
  return {
    FLEET_ENV: 'development',
    FLEET_COCKPIT_LISTEN: `127.0.0.1:${cockpit}`,
  };
}

describe('startupResponse：装配前的应答', () => {
  it('/healthz 是 503 的健康报告，带 startup/starting', async () => {
    const res = startupResponse('http://127.0.0.1:9/healthz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      checks: { startup: { ok: false, code: 'starting', message: '还在启动' } },
    });
  });

  it('别的路径也立刻 503，不挂起', async () => {
    const res = startupResponse('http://127.0.0.1:9/auth/config');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'starting', message: '还在启动' } });
  });

  it('公开文案不带禁用词', async () => {
    const scan = (await import(/* @vite-ignore */ SCAN)) as {
      BUILTIN_TERMS: readonly string[];
      scanText: (file: string, text: string, terms: readonly string[]) => unknown[];
    };
    const terms = scan.BUILTIN_TERMS.filter((t) => t !== 'temporal' && t !== '驾驶舱');
    const health = await startupResponse('http://127.0.0.1/healthz').text();
    const other = await startupResponse('http://127.0.0.1/api').text();
    expect(scan.scanText('healthz', health, terms)).toEqual([]);
    expect(scan.scanText('other', other, terms)).toEqual([]);
  });
});

describe('openEarly：先听上，setFetch 之后换成正式处理', () => {
  let early: EarlyListeners | undefined;
  afterEach(() => {
    for (const server of early?.servers ?? []) server.close();
    early = undefined;
  });

  it('听上之后 /healthz 在一秒内回「还在启动」；换上正式处理就不再是占位', async () => {
    const env = await devEnv();
    early = await openEarly(env);
    const port = env.FLEET_COCKPIT_LISTEN?.slice(env.FLEET_COCKPIT_LISTEN.lastIndexOf(':') + 1);
    const url = `http://127.0.0.1:${port}/healthz`;
    const started = Date.now();
    const first = await fetch(url);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ checks: { startup: { code: 'starting' } } });

    early.setFetch(() => Promise.resolve(Response.json({ ok: true, checks: { database: { ok: true } } })));
    const second = await fetch(url);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, checks: { database: { ok: true } } });
  });
});
