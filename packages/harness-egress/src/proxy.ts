// 透明出网代理：nftables 把影子 slice 发往 443 的连接重定向到这里（讨论稿第五节 3 的更正：reclaude 连上游不认
// HTTPS_PROXY，只能透明代理）。读首条 TLS 记录里的 SNI，在名单里就按主机名连 :443、原样双向转发；不在名单、读不出、
// 不是 TLS、首条记录等太久都直接断。不解密、不改字节。
// learn 模式只记不拦：先在法国上收一段时间真实的主机名，定名单再切 enforce。
import { connect, createServer, type Server, type Socket } from 'node:net';
import { allowed, needBytes, readSni } from './sni.ts';

export type EgressMode = 'enforce' | 'learn';

export interface EgressDecision {
  at: string;
  host: string | null;
  verdict: 'allowed' | 'denied' | 'learned';
  why: string;
}

export interface EgressOptions {
  allowlist: readonly string[];
  mode: EgressMode;
  /** 每个判定一条：写日志、记事件。 */
  onDecision(d: EgressDecision): void;
  /** 连上游；默认按主机名连 443。测试换成本地。 */
  dial?: (host: string) => Socket;
  /** 首条记录最多等多久。 */
  helloTimeoutMs?: number;
}

export function createEgressProxy(opts: EgressOptions): Server {
  const dial = opts.dial ?? ((host: string) => connect({ host, port: 443 }));
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
  return createServer((client) => {
    let buf = Buffer.alloc(0);
    let decided = false;
    const decide = (host: string | null, verdict: EgressDecision['verdict'], why: string) => {
      decided = true;
      opts.onDecision({ at: new Date().toISOString(), host, verdict, why });
    };
    const timer = setTimeout(() => {
      if (!decided) {
        decide(null, 'denied', `${helloTimeoutMs} 毫秒没等到完整的首条 TLS 记录`);
        client.destroy();
      }
    }, helloTimeoutMs);
    client.on('error', () => {});
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const need = needBytes(buf);
      if (need === 0) return;
      client.off('data', onData);
      clearTimeout(timer);
      const host = need > 0 ? readSni(buf) : null;
      if (!host) {
        decide(null, 'denied', need < 0 ? '不是 TLS 握手' : '读不出 SNI');
        client.destroy();
        return;
      }
      const ok = allowed(host, opts.allowlist);
      if (!ok && opts.mode === 'enforce') {
        decide(host, 'denied', '不在名单');
        client.destroy();
        return;
      }
      decide(host, ok ? 'allowed' : 'learned', ok ? '在名单' : '不在名单，learn 模式放行');
      const upstream = dial(host);
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      upstream.write(buf);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    client.on('data', onData);
  });
}
