import { FLEET_CHANGES_CHANNEL, REALTIME_TABLES } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  createAskWaiters,
  createChangeHub,
  PROBE_CHANNEL,
  parseChangePayload,
  startPgChangeFeed,
} from '../src/changes.ts';
import { silentLogger } from '../src/log.ts';
import type { FeedEvent, Logger } from '../src/ports.ts';
import { fakePostgres } from './fake-postgres.ts';

describe('NOTIFY 载荷（形状照 shared/realtime.ts）', () => {
  it('表名 + 文本主键；名单外的表、数字主键、看不懂的都丢掉', () => {
    for (const table of REALTIME_TABLES) {
      expect(parseChangePayload(JSON.stringify({ table, id: 'x1' }))).toEqual({
        type: 'change',
        table,
        id: 'x1',
      });
    }
    expect(parseChangePayload('{"table":"tasks","id":42}')).toBeNull();
    expect(parseChangePayload('{"table":"pull_requests","id":"1"}')).toBeNull();
    expect(parseChangePayload('tasks:t1')).toBeNull();
    expect(parseChangePayload('{"table":"tasks"}')).toBeNull();
  });
});

describe('LISTEN fleet_changes（替身照 postgres.js：失败后监听仍挂着、自己重连）', () => {
  const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  /** 不让定时探活插进来（测试里手动 probe）；一轮恢复等 10 毫秒没有新的 onListen 就发 resync。 */
  const manual = { probeEveryMs: 60 * 60_000, resyncSettleMs: 10 };
  /** 等过一轮恢复的收尾，resync 该发的已经发了。 */
  const afterRecovery = () => settle(50);
  const change = (id: string) => JSON.stringify({ table: 'tasks', id });

  function start(
    pg: ReturnType<typeof fakePostgres>,
    options: { probeEveryMs?: number; probeTimeoutMs?: number; resyncSettleMs?: number } = manual,
    log: Logger = silentLogger,
  ) {
    const feed = startPgChangeFeed(pg, log, options);
    const got: FeedEvent[] = [];
    feed.subscribe((e) => got.push(e));
    return { feed, got };
  }

  it('收到通知分发给订阅者；坏载荷告警丢弃；每个频道只 LISTEN 一次；探活的 ping 不推给订阅方', async () => {
    const pg = fakePostgres();
    const warnings: string[] = [];
    const { feed, got } = start(pg, manual, { ...silentLogger, warn: (m) => warnings.push(m) });
    await settle();
    expect(feed.status()).toEqual({ healthy: true, lastError: undefined });
    expect(pg.listenCalls()).toBe(2);
    expect(pg.listeners(FLEET_CHANGES_CHANNEL)).toBe(1);
    expect(pg.listeners(PROBE_CHANNEL)).toBe(1);

    pg.fire(FLEET_CHANGES_CHANNEL, '{"table":"subtasks","id":"s1"}');
    pg.fire(FLEET_CHANGES_CHANNEL, 'garbage');
    await feed.probe(50);
    // 别的进程（比如交接中的旧进程）发的 ping 不算数。
    pg.fire(PROBE_CHANNEL, 'someone-else:1');
    expect(got).toEqual([{ type: 'change', table: 'subtasks', id: 's1' }]);
    expect(warnings).toHaveLength(1);

    await feed.stop();
    expect(pg.listeners(FLEET_CHANGES_CHANNEL)).toBe(0);
    await expect(feed.probe(50)).rejects.toMatchObject({ code: 'not_listening' });
  });

  it('库没起来就启动：报红、不自己重试；库回来后连接自己接上，一条通知只推一次、只发一个 resync', async () => {
    const pg = fakePostgres();
    pg.stopDb();
    const { feed, got } = start(pg);
    await settle();
    expect(feed.status()).toMatchObject({ healthy: false });
    expect(feed.status().lastError).toContain('ECONNREFUSED');
    await expect(feed.probe(20)).rejects.toMatchObject({ code: 'not_listening' });
    await settle(50);
    // 失败了只记状态：再调 listen 就多挂一个监听（审查在真库上实测到一条通知推 5 遍）。
    expect(pg.listenCalls()).toBe(2);

    pg.startDb();
    pg.fire(FLEET_CHANGES_CHANNEL, change('t1'));
    await feed.probe(50);
    await afterRecovery();
    expect(feed.status().healthy).toBe(true);
    // 接上之后的通知照常推（只推一次）；这一轮恢复收尾时发一个 resync。
    expect(got).toEqual([{ type: 'change', table: 'tasks', id: 't1' }, { type: 'resync' }]);
    await feed.stop();
  });

  it('库停了一阵、其间重连失败好几次：恢复时排着的几条 LISTEN 逐条回来，同一轮恢复只发一个 resync', async () => {
    const pg = fakePostgres();
    const { feed, got } = start(pg);
    await settle();
    pg.stopDb();
    pg.failReconnects(3);
    pg.startDb();
    await afterRecovery();
    expect(got).toEqual([{ type: 'resync' }]);
    expect(feed.status().healthy).toBe(true);
    await feed.stop();
  });

  it('库没起来就启动、其间重连失败好几次：恢复时也只发一个 resync', async () => {
    const pg = fakePostgres();
    pg.stopDb();
    const { feed, got } = start(pg);
    await settle();
    pg.failReconnects(7);
    pg.startDb();
    await afterRecovery();
    expect(got).toEqual([{ type: 'resync' }]);
    await feed.stop();
  });

  it('恢复到一半又断了：这一轮先不发，下一轮恢复时一起发一个', async () => {
    const pg = fakePostgres();
    const { feed, got } = start(pg);
    await settle();
    pg.stopDb();
    pg.startDb();
    pg.stopDb();
    await expect(feed.probe(20)).rejects.toMatchObject({ code: 'not_listening' });
    await afterRecovery();
    expect(got).toEqual([]);
    pg.failReconnects(2);
    pg.startDb();
    await afterRecovery();
    expect(got).toEqual([{ type: 'resync' }]);
    await feed.stop();
  });

  it('两轮分开的恢复各发一个 resync', async () => {
    const pg = fakePostgres();
    const { feed, got } = start(pg);
    await settle();
    for (const round of [1, 2]) {
      pg.stopDb();
      pg.failReconnects(2);
      pg.startDb();
      await afterRecovery();
      expect(got).toHaveLength(round);
    }
    await feed.stop();
  });

  it('跑着跑着库停了：探活当场报红，不再说好；库回来只发一个 resync', async () => {
    const pg = fakePostgres();
    const { feed, got } = start(pg);
    await settle();
    await feed.probe(50);
    pg.stopDb();
    await expect(feed.probe(50)).rejects.toMatchObject({ code: 'not_listening' });
    expect(feed.status().healthy).toBe(false);
    pg.startDb();
    await feed.probe(50);
    await afterRecovery();
    expect(got).toEqual([{ type: 'resync' }]);
    expect(feed.status().healthy).toBe(true);
    await feed.stop();
  });

  it('两次探活之间断了又自己重连上（探活没赶上）：光凭重连也发 resync，断开时的通知已经丢了', async () => {
    const pg = fakePostgres();
    const { feed, got } = start(pg);
    await settle();
    pg.dropListenConnection();
    pg.fire(FLEET_CHANGES_CHANNEL, change('lost'));
    pg.startDb();
    await afterRecovery();
    expect(got).toEqual([{ type: 'resync' }]);
    expect(feed.status().healthy).toBe(true);
    await feed.stop();
  });

  it('只有 LISTEN 那条连接悄悄断了（查询照常）：自己发的 ping 收不回来就报红；重连后 resync', async () => {
    const pg = fakePostgres();
    const { feed, got } = start(pg);
    await settle();
    pg.dropListenConnection();
    pg.fire(FLEET_CHANGES_CHANNEL, change('lost'));
    await expect(feed.probe(30)).rejects.toMatchObject({ code: 'not_listening' });
    expect(feed.status().lastError).toContain('没收回来');
    pg.startDb();
    await afterRecovery();
    expect(got).toEqual([{ type: 'resync' }]);
    await feed.stop();
  });

  it('没断线、只是通知一时没送到：ping 又收得回来就恢复，并补一个 resync（这段时间可能漏了）', async () => {
    const pg = fakePostgres();
    const { feed, got } = start(pg);
    await settle();
    pg.setDelivering(false);
    await expect(feed.probe(30)).rejects.toMatchObject({ code: 'not_listening' });
    pg.setDelivering(true);
    await feed.probe(50);
    await afterRecovery();
    expect(got).toEqual([{ type: 'resync' }]);
    await feed.stop();
  });

  it('定时探活：没人调健康检查也会发现断线，恢复后照样 resync', async () => {
    const pg = fakePostgres();
    const { feed, got } = start(pg, { probeEveryMs: 10, probeTimeoutMs: 20, resyncSettleMs: 10 });
    await settle();
    pg.dropListenConnection();
    for (let i = 0; i < 100 && feed.status().healthy; i++) await settle(5);
    expect(feed.status().healthy).toBe(false);
    pg.startDb();
    await afterRecovery();
    expect(got).toEqual([{ type: 'resync' }]);
    await feed.stop();
  });

  it('一个订阅者抛错不影响别人；退订后收不到', () => {
    const hub = createChangeHub(silentLogger);
    const got: FeedEvent[] = [];
    hub.subscribe(() => {
      throw new Error('坏订阅者');
    });
    const off = hub.subscribe((e) => got.push(e));
    hub.publish({ type: 'resync' });
    off();
    hub.publish({ type: 'resync' });
    expect(got).toHaveLength(1);
  });
});

describe('等回答', () => {
  it('asks 表对应那一行的变化叫醒；别的表同编号不叫醒；resync 叫醒所有；不然到时间醒', async () => {
    const hub = createChangeHub();
    const waiters = createAskWaiters(hub);
    const started = Date.now();
    const a = waiters.sleep('ask-1', 5_000);
    hub.publish({ type: 'change', table: 'asks', id: 'ask-1' });
    await a;
    const b = waiters.sleep('ask-2', 5_000);
    hub.publish({ type: 'resync' });
    await b;
    expect(Date.now() - started).toBeLessThan(1_000);

    let woke = false;
    const c = waiters.sleep('ask-3', 60).then(() => {
      woke = true;
    });
    hub.publish({ type: 'change', table: 'tasks', id: 'ask-3' });
    await new Promise((r) => setTimeout(r, 20));
    expect(woke).toBe(false);
    await c;
  });

  it('请求中止就不等了', async () => {
    const waiters = createAskWaiters(createChangeHub());
    const controller = new AbortController();
    const p = waiters.sleep('ask-1', 5_000, controller.signal);
    controller.abort();
    await p;
  });
});
