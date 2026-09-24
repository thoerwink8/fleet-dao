import { FLEET_CHANGES_CHANNEL, REALTIME_TABLES } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { createAskWaiters, createChangeHub, parseChangePayload, startPgChangeFeed } from '../src/changes.ts';
import { silentLogger } from '../src/log.ts';
import type { FeedEvent, Logger } from '../src/ports.ts';

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

describe('LISTEN fleet_changes', () => {
  it('收到 NOTIFY 分发给订阅者；坏载荷告警丢弃；重连后广播 resync', async () => {
    let notify: (payload: string) => void = () => {};
    let onListen: () => void = () => {};
    let channel = '';
    let unlistened = false;
    const warnings: string[] = [];
    const log: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
    const feed = startPgChangeFeed(async (ch, onNotify, listen) => {
      channel = ch;
      notify = onNotify;
      onListen = listen;
      listen();
      return {
        unlisten: async () => {
          unlistened = true;
        },
      };
    }, log);
    expect(channel).toBe(FLEET_CHANGES_CHANNEL);
    expect(feed.status().listening).toBe(true);
    const got: FeedEvent[] = [];
    feed.subscribe((e) => got.push(e));

    notify('{"table":"subtasks","id":"s1"}');
    notify('garbage');
    onListen(); // 断线重连
    expect(got).toEqual([{ type: 'change', table: 'subtasks', id: 's1' }, { type: 'resync' }]);
    expect(warnings).toHaveLength(2);
    await feed.stop();
    expect(unlistened).toBe(true);
  });

  it('库没起来：进程照样起、状态报没接上；退避重试，接上后广播 resync（中间可能漏了）', async () => {
    let attempts = 0;
    const errors: string[] = [];
    const log: Logger = { ...silentLogger, error: (m) => errors.push(m) };
    const feed = startPgChangeFeed(
      async (_channel, _onNotify, onListen) => {
        attempts += 1;
        if (attempts < 3) throw new Error('connect ECONNREFUSED');
        onListen();
        return { unlisten: async () => {} };
      },
      log,
      { retryMinMs: 5, retryMaxMs: 10 },
    );
    const got: FeedEvent[] = [];
    feed.subscribe((e) => got.push(e));
    await new Promise((r) => setTimeout(r, 1));
    expect(feed.status()).toMatchObject({ listening: false, lastError: 'connect ECONNREFUSED' });
    for (let i = 0; i < 100 && !feed.status().listening; i++) await new Promise((r) => setTimeout(r, 5));
    expect(attempts).toBe(3);
    expect(feed.status()).toEqual({ listening: true, lastError: undefined });
    expect(got).toEqual([{ type: 'resync' }]);
    expect(errors).toHaveLength(2);
    await feed.stop();
    expect(feed.status().listening).toBe(false);
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
