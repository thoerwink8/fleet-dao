// 优雅停机（src/shutdown.ts）：main.ts 的停机顺序抽成的可测函数——长轮询醒了不再查库、关库在在途请求做完之后、
// 有上限不会无限等下去，各写一条故意造出来的失败场景钉住（#364：库关早了，长轮询查库会报错，回 500）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeConnectionWhenStopping, type DrainableServer, gracefulShutdown } from '../src/shutdown.ts';

describe('closeConnectionWhenStopping：停机之后的响应补 Connection: close', () => {
  it('还没停机：原样放行，不加头', async () => {
    const wrapped = closeConnectionWhenStopping(
      () => new Response('ok', { status: 200 }),
      () => false,
    );
    const res = (await wrapped(new Request('http://x/'), undefined as never)) as Response;
    expect(res.headers.get('connection')).toBeNull();
    expect(await res.text()).toBe('ok');
  });

  it('停机之后：补 Connection: close，状态码、正文原样；原有的头照留', async () => {
    const wrapped = closeConnectionWhenStopping(
      () => new Response('draining', { status: 201, headers: { 'x-a': '1' } }),
      () => true,
    );
    const res = (await wrapped(new Request('http://x/'), undefined as never)) as Response;
    expect(res.status).toBe(201);
    expect(res.headers.get('connection')).toBe('close');
    expect(res.headers.get('x-a')).toBe('1');
    expect(await res.text()).toBe('draining');
  });

  it('fetch 回的不是 Response（理论上不会，防御一下）：原样交回，不当 Response 处理', async () => {
    const notResponse = { weird: true };
    const wrapped = closeConnectionWhenStopping(
      () => notResponse,
      () => true,
    );
    const res = await wrapped(new Request('http://x/'), undefined as never);
    expect(res).toBe(notResponse);
  });
});

/** 记调用顺序，方便断言「先……再……」。 */
function orderedLog() {
  const events: string[] = [];
  return { events, push: (e: string) => events.push(e) };
}

/** close(cb) 什么时候调用 cb 由调用方控制：立即、延迟、或永远不调用（模拟连接一直没结束）。 */
function fakeServer(
  log: ReturnType<typeof orderedLog>,
  name: string,
  closeAfterMs: number | null,
): DrainableServer {
  return {
    close(cb) {
      log.push(`${name}.close 发起`);
      if (closeAfterMs === null) return; // 模拟在途连接一直没结束：cb 永远不调用
      setTimeout(() => {
        log.push(`${name}.close 完成`);
        cb();
      }, closeAfterMs);
    },
    closeIdleConnections: () => log.push(`${name}.closeIdleConnections`),
    closeAllConnections: () => log.push(`${name}.closeAllConnections`),
  };
}

describe('gracefulShutdown：停机的先后顺序和上限', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** 拨钟：先让排着的 promise 跑完，拨过去，再跑完一轮（draft-opening.test.ts 同款手法）。 */
  const advance = async (ms: number) => {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(ms);
    await new Promise((r) => setImmediate(r));
  };

  it('两个 server 都发起 close、马上叫醒长轮询；在途连接很快做完，不用等满 drainMs 才去关库', async () => {
    const log = orderedLog();
    const servers = [fakeServer(log, 'cockpit', 50), fakeServer(log, 'agent', 50)];
    let closedDb = false;
    const done = gracefulShutdown({
      servers,
      notifyLongPollers: () => log.push('notifyLongPollers'),
      drainMs: 10_000,
      close: async () => {
        log.push('close() 开始');
        closedDb = true;
      },
    });
    await advance(0); // 让 close(cb) 的调用、notifyLongPollers 都先跑到
    expect(log.events).toEqual([
      'cockpit.close 发起',
      'agent.close 发起',
      'notifyLongPollers',
      'cockpit.closeIdleConnections',
      'agent.closeIdleConnections',
    ]);
    expect(closedDb).toBe(false); // 在途连接还没做完，库不能这时候就关

    await advance(50); // 两个 server 的在途连接做完了
    await done;
    expect(closedDb).toBe(true);
    expect(log.events).toContain('cockpit.close 完成');
    expect(log.events).toContain('agent.close 完成');
    expect(log.events).toContain('cockpit.closeAllConnections');
    expect(log.events).toContain('agent.closeAllConnections');
    // 关库排在两个 close 完成、closeAllConnections 之后（关早了在途请求会看见「库关着」，#364）
    const closeDbAt = log.events.indexOf('close() 开始');
    expect(closeDbAt).toBeGreaterThan(log.events.indexOf('cockpit.close 完成'));
    expect(closeDbAt).toBeGreaterThan(log.events.indexOf('agent.close 完成'));
    expect(closeDbAt).toBeGreaterThan(log.events.indexOf('cockpit.closeAllConnections'));
    expect(closeDbAt).toBeGreaterThan(log.events.indexOf('agent.closeAllConnections'));
  });

  it('【故意造出的失败】在途连接一直不结束（drainMs 从没等到）：到点了照样往下走，不无限等——SSE 这类靠这个收场', async () => {
    const log = orderedLog();
    const servers = [fakeServer(log, 'cockpit', null)]; // 永远不调用 close 的回调
    let closedDb = false;
    const done = gracefulShutdown({
      servers,
      notifyLongPollers: () => {},
      drainMs: 1_000,
      close: async () => {
        closedDb = true;
      },
    });
    await advance(999);
    expect(closedDb).toBe(false); // 还没到上限
    await advance(1);
    await done;
    expect(closedDb).toBe(true); // 到点了，不管 cockpit.close 的回调有没有来，照样往下走
    expect(log.events).toContain('cockpit.closeAllConnections');
  });

  it('关库失败：onCloseError 收到，流程照样走完（数据没救了，多等也没用）', async () => {
    const log = orderedLog();
    const boom = new Error('库连不上');
    let caught: unknown;
    const done = gracefulShutdown({
      servers: [fakeServer(log, 'cockpit', 0)],
      notifyLongPollers: () => {},
      drainMs: 1_000,
      close: async () => {
        throw boom;
      },
      onCloseError: (err) => {
        caught = err;
      },
    });
    await advance(0);
    await done;
    expect(caught).toBe(boom);
  });

  it('没给 onCloseError、关库照样失败：不抛出去（没人接住也不会让停机本身崩掉）', async () => {
    await expect(
      gracefulShutdown({
        servers: [],
        notifyLongPollers: () => {},
        drainMs: 0,
        close: async () => {
          throw new Error('库连不上');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
