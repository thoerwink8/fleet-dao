// 到 Mirasim 服务回环 ws 的连接（协议见 docs/reference/adapters.md 第八节）。
// - 令牌在服务写在本机的令牌文件里，服务每次起停都换：每次建连现读，不缓存；
// - 起一个 codex 会话会把服务端单线程堵 40–58 秒：建连要重试到 90 秒左右，不是一次失败就放弃（MS-08）；
// - 适配器只经这里的 MirasimWire 收发帧，测试给假的连接：单元测试结构上碰不到真服务（GEN-08）。
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export type MirasimFrame = Record<string, unknown>;

/** 一条连接。next 在 timeoutMs 内没有新帧回 'timeout'，连接断了回 'closed'（之后一直回 'closed'）。 */
export interface MirasimWire {
  send(frame: MirasimFrame): void;
  next(timeoutMs: number): Promise<MirasimFrame | 'timeout' | 'closed'>;
  close(): void;
}

export type MirasimConnect = () => Promise<MirasimWire>;

export interface MirasimEndpoint {
  /** 默认 127.0.0.1。 */
  host?: string;
  /** 旧系统那份是 4316；给会话用户单独起的那份按它自己的配置。 */
  port: number;
  /** 回环令牌文件（~/.mirasim/run/local-<端口>.token，在这份 Mirasim 服务的用户家里）。 */
  tokenFile: string;
  /** 建连总共重试多久，默认 90 秒。 */
  connectTimeoutMs?: number;
}

/**
 * 单元测试里连真的 Mirasim 服务一律拒绝：旧系统的假会话就是这么漏出去的。
 * 新起的服务端口不定，所以除了旧的 4316，令牌文件在 .mirasim 目录下（真服务写令牌的地方）也拒。
 */
export function assertNotRealMirasimInTests(endpoint: MirasimEndpoint): void {
  if (!process.env.VITEST) return;
  if (endpoint.port === 4316 || /[\\/]\.mirasim[\\/]/.test(endpoint.tokenFile)) {
    throw new Error('测试里不许连真的 Mirasim 服务：换成假连接，真跑放到测试之外');
  }
}

export function mirasimConnector(endpoint: MirasimEndpoint): MirasimConnect {
  assertNotRealMirasimInTests(endpoint);
  const host = endpoint.host ?? '127.0.0.1';
  const budget = endpoint.connectTimeoutMs ?? 90_000;
  return async () => {
    const deadline = Date.now() + budget;
    let wait = 500;
    let lastError = '';
    for (;;) {
      let token: string;
      try {
        token = (await readFile(endpoint.tokenFile, 'utf8')).trim();
      } catch (err) {
        throw new Error(`读不了 Mirasim 的回环令牌（${endpoint.tokenFile}）：${(err as Error).message}`);
      }
      if (!token) throw new Error(`Mirasim 的回环令牌文件是空的：${endpoint.tokenFile}`);
      try {
        return await openWire(`ws://${host}:${endpoint.port}/ws?token=${encodeURIComponent(token)}`);
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (Date.now() + wait > deadline)
        throw new Error(`连不上 Mirasim 的回环 ws（${host}:${endpoint.port}）：${lastError}`);
      await sleep(wait);
      wait = Math.min(wait * 2, 8_000);
    }
  };
}

/** 打开一条 ws，收到的帧排队，next 按序取。 */
export function openWire(url: string): Promise<MirasimWire> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox: MirasimFrame[] = [];
    const waiters: ((value: MirasimFrame | 'closed') => void)[] = [];
    let open = false;
    let closed = false;
    const push = (value: MirasimFrame | 'closed') => {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else if (value !== 'closed') inbox.push(value);
    };
    ws.onmessage = (ev) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return; // 不是 JSON 的帧不认
      }
      if (frame && typeof frame === 'object' && !Array.isArray(frame)) push(frame as MirasimFrame);
    };
    ws.onclose = () => {
      closed = true;
      if (!open) reject(new Error('建连被关'));
      for (const waiter of waiters.splice(0)) waiter('closed');
    };
    ws.onerror = () => {
      if (!open) reject(new Error('建连失败'));
    };
    ws.onopen = () => {
      open = true;
      resolve({
        send(frame) {
          if (!closed) ws.send(JSON.stringify(frame));
        },
        next(timeoutMs) {
          const queued = inbox.shift();
          if (queued) return Promise.resolve(queued);
          if (closed) return Promise.resolve('closed');
          return new Promise((done) => {
            const timer = setTimeout(() => {
              const at = waiters.indexOf(settle);
              if (at >= 0) waiters.splice(at, 1);
              done('timeout');
            }, timeoutMs);
            const settle = (value: MirasimFrame | 'closed') => {
              clearTimeout(timer);
              done(value);
            };
            waiters.push(settle);
          });
        },
        close() {
          closed = true;
          try {
            ws.close();
          } catch {
            // 已经关了
          }
        },
      });
    };
  });
}
