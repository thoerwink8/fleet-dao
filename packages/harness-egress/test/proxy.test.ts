// 透明出网代理：用真的 TLS 客户端发 ClientHello（tls.connect 带 servername），上游换成本地明文口记收到的字节。
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { createEgressProxy, type EgressDecision, type EgressMode } from '../src/proxy.ts';
import { allowed, readSni } from '../src/sni.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(s: Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

/** 上游：记下收到的第一块字节和连的是谁。 */
async function upstream() {
  const got: { host: string; first: Buffer }[] = [];
  const port = await listen(
    createServer((sock) => {
      sock.once('data', (b) => {
        const last = got[got.length - 1];
        if (last) last.first = b;
      });
    }),
  );
  const dial = (host: string): Socket => {
    got.push({ host, first: Buffer.alloc(0) });
    return connect({ host: '127.0.0.1', port });
  };
  return { got, dial };
}

async function proxy(mode: EgressMode, allowlist: string[], helloTimeoutMs = 2_000) {
  const decisions: EgressDecision[] = [];
  const up = await upstream();
  const port = await listen(
    createEgressProxy({
      allowlist,
      mode,
      onDecision: (d) => decisions.push(d),
      dial: up.dial,
      helloTimeoutMs,
    }),
  );
  return { port, decisions, up };
}

/** 起一个 TLS 客户端连代理，等它被断开或 500 毫秒。 */
function hello(port: number, servername: string): Promise<void> {
  return new Promise((resolve) => {
    const s = tlsConnect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false });
    s.on('error', () => resolve());
    s.on('close', () => resolve());
    setTimeout(() => {
      s.destroy();
      resolve();
    }, 500);
  });
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('名单', () => {
  it('完全相同，或以点开头的规则匹配它的子域（不含自己）', () => {
    expect(allowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(allowed('API.Example.com', ['api.example.com'])).toBe(true);
    expect(allowed('a.example.com', ['.example.com'])).toBe(true);
    expect(allowed('example.com', ['.example.com'])).toBe(false);
    expect(allowed('evilexample.com', ['.example.com'])).toBe(false);
    expect(allowed('github.com', ['api.example.com'])).toBe(false);
  });
});

describe('enforce', () => {
  it('名单里的主机：按 SNI 连上游，首条记录原样转过去', async () => {
    const p = await proxy('enforce', ['model.example.com']);
    await hello(p.port, 'model.example.com');
    await until(() => (p.up.got[0]?.first.length ?? 0) > 0);
    expect(p.decisions).toMatchObject([{ host: 'model.example.com', verdict: 'allowed' }]);
    expect(p.up.got[0]?.host).toBe('model.example.com');
    expect(p.up.got[0]?.first[0]).toBe(0x16);
    expect(readSni(p.up.got[0]?.first ?? Buffer.alloc(0))).toBe('model.example.com');
  });

  it('名单外的主机（例如 github.com）：断开，不连上游', async () => {
    const p = await proxy('enforce', ['model.example.com']);
    await hello(p.port, 'github.com');
    expect(p.decisions).toMatchObject([{ host: 'github.com', verdict: 'denied', why: '不在名单' }]);
    expect(p.up.got).toEqual([]);
  });

  it('不是 TLS（明文 HTTP）：断开', async () => {
    const p = await proxy('enforce', ['model.example.com']);
    await new Promise<void>((resolve) => {
      const s = connect({ host: '127.0.0.1', port: p.port }, () =>
        s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'),
      );
      s.on('close', () => resolve());
      s.on('error', () => resolve());
    });
    expect(p.decisions).toMatchObject([{ host: null, verdict: 'denied', why: '不是 TLS 握手' }]);
    expect(p.up.got).toEqual([]);
  });

  it('连上来不说话：等满时限断开', async () => {
    const p = await proxy('enforce', ['model.example.com'], 200);
    await new Promise<void>((resolve) => {
      const s = connect({ host: '127.0.0.1', port: p.port });
      s.on('close', () => resolve());
      s.on('error', () => resolve());
    });
    expect(p.decisions[0]).toMatchObject({ verdict: 'denied' });
    expect(p.decisions[0]?.why).toContain('没等到');
  });
});

describe('learn', () => {
  it('名单外的也放行，但记成 learned，供定名单', async () => {
    const p = await proxy('learn', []);
    await hello(p.port, 'gateway.example.net');
    await until(() => p.up.got.length > 0);
    expect(p.decisions).toMatchObject([{ host: 'gateway.example.net', verdict: 'learned' }]);
    expect(p.up.got[0]?.host).toBe('gateway.example.net');
  });
});
