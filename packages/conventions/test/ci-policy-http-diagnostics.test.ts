import { channel } from 'node:diagnostics_channel';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type Server, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPolicyHttp } from '../src/ci-policy-bridge.ts';

const repo = { githubId: 123, repo: 'acme/widgets' };
const url = 'https://policy.example.test/private?token=secret-fixture';
const connectChannel = channel('undici:client:beforeConnect');
const socketChannel = channel('net.client.socket');
const createChannel = channel('undici:request:create');
const sendChannel = channel('undici:client:sendHeaders');
const good = () =>
  new Response(JSON.stringify({ ...repo, version: 1, ciPolicy: 'off' }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
function associate(socket: Socket, origin = url) {
  const u = new URL(origin);
  connectChannel.publish({
    connectParams: {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
    },
  });
  socketChannel.publish({ socket });
}
function request(target = url, method = 'GET') {
  const u = new URL(target);
  return { method, origin: u.origin, path: u.pathname + u.search };
}
function announce(target = url, method = 'GET') {
  const value = request(target, method);
  createChannel.publish({ request: value });
  return value;
}
async function failure(fetchImpl: typeof fetch, target = url, attempts?: number) {
  try {
    await readPolicyHttp(target, repo, fetchImpl, { attempts, pauseMs: 0 });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const e = error as Error;
    expect(e.cause).toBeUndefined();
    expect(e.stack).not.toContain('secret-fixture');
    expect(e.message).toMatch(/elapsedMs=\d+; codes=/);
    return e.message;
  }
  throw new Error('expected failure');
}
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no address'));
      resolve(address.port);
    });
  });
}
async function close(server: Server, sockets: Set<Socket>) {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
afterEach(() => vi.restoreAllMocks());

describe('策略 HTTP 被动阶段诊断', () => {
  it('其它beforeConnect订阅同步建立无关socket，不能冒认目标TLS的headers', async () => {
    const sockets = new Set<Socket>();
    const controller = new AbortController();
    let helperConnected = false;
    let tlsData = false;
    const stop = () => {
      if (helperConnected && tlsData) controller.abort(new DOMException('secret-fixture', 'TimeoutError'));
    };
    const helper = createServer((socket) => sockets.add(socket));
    const target = createServer((socket) => {
      sockets.add(socket);
      socket.once('data', () => {
        tlsData = true;
        stop();
      });
    });
    const [helperPort, targetPort] = await Promise.all([listen(helper), listen(target)]);
    let injected = false;
    const unrelated = () => {
      if (injected) return;
      injected = true;
      const socket = connect({ host: '127.0.0.1', port: helperPort });
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('connect', () => {
        helperConnected = true;
        stop();
      });
    };
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const message = await failure(async (input, init) => {
        connectChannel.subscribe(unrelated);
        try {
          return await fetch(input, init);
        } finally {
          connectChannel.unsubscribe(unrelated);
        }
      }, `https://127.0.0.1:${targetPort}/secret-fixture`);
      expect(helperConnected && tlsData).toBe(true);
      expect(message).toMatch(/stage=unknown;.*codes=TimeoutError/);
    } finally {
      connectChannel.unsubscribe(unrelated);
      for (const socket of sockets) socket.destroy();
      await Promise.all([close(helper, sockets), close(target, sockets)]);
    }
  });
  it('只建一次10000ms截止，保留请求合同，未知异常不回显原文或cause', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      throw Object.assign(new Error(`${url} Authorization=secret-fixture`), { code: 'secret-fixture' });
    });
    expect(await failure(fetchImpl)).toMatch(/stage=unknown;.*codes=unknown/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });
  it('无法证明socket归属时保持unknown；DNS失败只保留白名单code', async () => {
    const socket = new Socket();
    const message = await failure(async () => {
      associate(socket);
      socket.emit('lookup', Object.assign(new Error(url), { code: 'ENOTFOUND' }));
      throw new Error(url, { cause: Object.assign(new Error(url), { code: 'ENOTFOUND' }) });
    });
    expect(message).toMatch(/stage=unknown;.*codes=ENOTFOUND/);
    for (const event of ['lookup', 'connect', 'secureConnect']) expect(socket.listenerCount(event)).toBe(0);
    socket.destroy();
  });
  it('真实Node lookup失败只报unknown和ENOTFOUND，不使用外部DNS', async () => {
    let socket: Socket | undefined;
    try {
      const message = await failure(async () => {
        connectChannel.publish({
          connectParams: {
            protocol: 'https:',
            hostname: 'policy.example.test',
            port: '443',
          },
        });
        await new Promise<never>((_resolve, reject) => {
          socket = connect({
            host: 'policy.example.test',
            port: 443,
            lookup(_host, _options, callback) {
              queueMicrotask(() =>
                callback(Object.assign(new Error(url), { code: 'ENOTFOUND' }), '127.0.0.1', 4),
              );
            },
          });
          socket.once('error', reject);
        });
        throw new Error('unreachable');
      });
      expect(message).toMatch(/stage=unknown;.*codes=ENOTFOUND/);
    } finally {
      socket?.destroy();
    }
  });
  it('同request发送headers后晚到的其它socket失败不改进度', async () => {
    const late = new Socket();
    const message = await failure(async () => {
      const value = announce();
      sendChannel.publish({ request: value });
      associate(late);
      late.emit('lookup', new Error('late DNS failure'));
      throw Object.assign(new Error(url), { code: 'ECONNRESET' });
    });
    expect(message).toMatch(/stage=headers;.*codes=ECONNRESET/);
    late.destroy();
  });
  it('scope内其它origin/path/search/method、未知结构、缺create都不关联', async () => {
    for (const kind of ['other-origin', 'other-path', 'other-search', 'method', 'malformed', 'missing']) {
      const message = await failure(async () => {
        let value = request();
        if (kind === 'other-origin')
          value = announce('https://other.example.test/private?token=secret-fixture');
        if (kind === 'other-path') value = announce(url.replace('/private', '/other'));
        if (kind === 'other-search') value = announce(url.replace('token=', 'other='));
        if (kind === 'method') value = announce(url, 'POST');
        if (kind === 'malformed') createChannel.publish({ request: { origin: new URL(url).origin } });
        sendChannel.publish({ request: value });
        throw new Error(url);
      });
      expect(message).toContain('stage=unknown');
    }
  });
  it('两次并发读取相同URL不串stage；缺sendHeaders不继承前次进度', async () => {
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = failure(async () => {
      sendChannel.publish({ request: announce() });
      await barrier;
      throw new Error(url);
    });
    const second = failure(async () => {
      announce();
      release();
      throw new Error(url);
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toContain('stage=headers');
    expect(b).toContain('stage=unknown');
    expect(
      await failure(async () => {
        throw new Error(url);
      }),
    ).toContain('stage=unknown');
  });
  it('同URL但其它async scope的create和send事件不污染在等的读取', async () => {
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = failure(async () => {
      await barrier;
      throw new Error(url);
    });
    sendChannel.publish({ request: announce() });
    release();
    expect(await reading).toContain('stage=unknown');
  });
  it('未知/恶意事件不影响fetch；成功、网络/合同/体失败均清理订阅且不碰socket监听', async () => {
    const baseline = [createChannel.hasSubscribers, sendChannel.hasSubscribers];
    for (const result of ['success', 'network', 'contract', 'body']) {
      const socket = new Socket();
      const external = () => {};
      socket.on('connect', external);
      const fetchImpl: typeof fetch = async () => {
        createChannel.publish({
          get request() {
            throw new Error(url);
          },
        });
        sendChannel.publish(null);
        sendChannel.publish({ request: announce() });
        if (result === 'network') throw new Error(url);
        if (result === 'contract') return new Response('{}', { status: 503 });
        if (result === 'body')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error(url));
              },
            }),
            { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
          );
        return good();
      };
      if (result === 'success')
        expect(await readPolicyHttp(url, repo, fetchImpl)).toMatchObject({ ciPolicy: 'off' });
      else
        expect(await failure(fetchImpl)).toContain(
          result === 'contract' ? 'HTTP 503' : result === 'network' ? 'stage=headers' : 'stage=body',
        );
      expect([createChannel.hasSubscribers, sendChannel.hasSubscribers]).toEqual(baseline);
      expect(socket.listeners('connect')).toEqual([external]);
      expect(socket.listenerCount('lookup')).toBe(0);
      expect(socket.listenerCount('secureConnect')).toBe(0);
      socket.destroy();
    }
  });
  it('事件过量时撤回阶段为unknown，不继续保留不完整证据', async () => {
    expect(
      await failure(async () => {
        const value = announce();
        sendChannel.publish({ request: value });
        for (let n = 0; n < 80; n++) createChannel.publish({ request: value });
        sendChannel.publish({ request: value });
        throw new Error(url);
      }),
    ).toContain('stage=unknown');
  });
  it.each(['before', 'after'])('第二个同URL请求%s发送后都按歧义unknown，晚到事件不再推进', async (when) => {
    expect(
      await failure(async () => {
        const first = announce();
        if (when === 'after') sendChannel.publish({ request: first });
        const second = announce();
        sendChannel.publish({ request: second });
        sendChannel.publish({ request: first });
        throw new Error(url);
      }),
    ).toContain('stage=unknown');
  });
  it('相同字段但不同request对象的sendHeaders不能借用身份；收场后晚到事件不污染下次', async () => {
    let retained: object = {};
    expect(
      await failure(async () => {
        retained = announce();
        sendChannel.publish({ request: request() });
        throw new Error(url);
      }),
    ).toContain('stage=unknown');
    sendChannel.publish({ request: retained });
    expect(
      await failure(async () => {
        throw new Error(url);
      }),
    ).toContain('stage=unknown');
  });
  it('fetch已返回真实body时，后到重复create/sendHeaders不能降阶段', async () => {
    expect(
      await failure(async () => {
        const first = announce();
        sendChannel.publish({ request: first });
        return new Response(
          new ReadableStream({
            start(controller) {
              setImmediate(() => {
                sendChannel.publish({ request: announce() });
                controller.error(new Error(url));
              });
            },
          }),
          { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
        );
      }),
    ).toContain('stage=body');
  });
  it('循环cause和大量AggregateError有限遍历，白名单以外的名称和文本不泄漏', async () => {
    const cyclic = Object.assign(new Error(url), { code: 'ENOTFOUND', cause: undefined as unknown });
    cyclic.cause = cyclic;
    const nested = new AggregateError([cyclic, ...Array.from({ length: 100 }, () => new Error(url))], url);
    expect(
      await failure(async () => {
        throw nested;
      }),
    ).toMatch(/codes=ENOTFOUND/);
    expect(
      await failure(async () => {
        throw {
          get code() {
            throw new Error(url);
          },
        };
      }),
    ).toContain('codes=unknown');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(
      await failure(async () => {
        throw revoked.proxy;
      }),
    ).toContain('codes=unknown');
  });
  it.each([
    ['UTF-8', new Uint8Array([0xff])],
    ['JSON', '{"secret-fixture":'],
    ['身份', JSON.stringify({ version: 1, githubId: 9, repo: 'secret-fixture', ciPolicy: 'off' })],
    ['大小', 'secret-fixture'.repeat(4096)],
  ])('保留%s合同裁决且不暴露动态body', async (_name, body) => {
    expect(
      await failure(
        async () =>
          new Response(body, {
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          }),
      ),
    ).toContain('stage=body');
  });
  it('真实本机TLS握手未完成，没有可证明的request阶段必须unknown', async () => {
    const sockets = new Set<Socket>();
    const controller = new AbortController();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('data', () => controller.abort(new DOMException('secret-fixture', 'TimeoutError')));
    });
    const port = await listen(server);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const message = await failure(fetch, `https://127.0.0.1:${port}/private?token=secret-fixture`);
      expect(message).toMatch(/stage=unknown;.*codes=TimeoutError/);
      expect(message).not.toContain('127.0.0.1');
    } finally {
      await close(server, sockets);
    }
  });
  it('真实本机HTTP发完headers再断流，报body且保留网络code', async () => {
    const sockets = new Set<Socket>();
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.flushHeaders();
      res.write('{');
    });
    server.on('connection', (socket) => sockets.add(socket));
    const port = await listen(server);
    try {
      const fetchImpl: typeof fetch = async (target, init) => {
        const response = await fetch(target, init);
        for (const socket of sockets) socket.destroy();
        return response;
      };
      expect(await failure(fetchImpl, `http://127.0.0.1:${port}/secret-fixture`)).toMatch(
        /stage=body;.*codes=UND_ERR_SOCKET/,
      );
    } finally {
      await close(server, sockets);
    }
  });
  it('真实新HTTP连接收到请求后等headers截止，报headers', async () => {
    const sockets = new Set<Socket>();
    const controller = new AbortController();
    const server = createHttpServer(() =>
      controller.abort(new DOMException('secret-fixture', 'TimeoutError')),
    );
    server.on('connection', (socket) => sockets.add(socket));
    const port = await listen(server);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      expect(await failure(fetch, `http://127.0.0.1:${port}/secret-fixture`)).toMatch(
        /stage=headers;.*codes=TimeoutError/,
      );
    } finally {
      await close(server, sockets);
    }
  });
  it('真实连接池复用也凭request发送事件证明headers阶段', async () => {
    const sockets = new Set<Socket>();
    const controller = new AbortController();
    let requests = 0;
    const server = createHttpServer((_req, res) => {
      if (++requests === 2) {
        controller.abort(new DOMException('secret-fixture', 'TimeoutError'));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...repo, version: 1, ciPolicy: 'off' }));
    });
    server.on('connection', (socket) => sockets.add(socket));
    const port = await listen(server);
    const target = `http://127.0.0.1:${port}/secret-fixture`;
    try {
      expect(await readPolicyHttp(target, repo)).toMatchObject({ ciPolicy: 'off' });
      // Undici在body完成后的本机事件轮次归还空闲连接；不靠时间sleep。
      await new Promise<void>((resolve) => setImmediate(resolve));
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
      // 只看这一次读取的连接归属：重读会另开连接，重读本身见 ci-policy-read-retry.test.ts。
      expect(await failure(fetch, target, 1)).toMatch(/stage=headers;.*codes=TimeoutError/);
      expect(requests).toBe(2);
      expect(sockets.size).toBe(1);
    } finally {
      await close(server, sockets);
    }
  });
});
