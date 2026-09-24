import { describe, expect, it } from 'vitest';
import {
  CHANGES_CHANNEL,
  createAskWaiters,
  createChangeHub,
  parseChangePayload,
  startPgChangeFeed,
} from '../src/changes.ts';
import { silentLogger } from '../src/log.ts';
import type { FeedEvent, Logger } from '../src/ports.ts';

describe('NOTIFY 载荷', () => {
  it('表名 + 主键；数字主键转成字符串；看不懂的丢掉', () => {
    expect(parseChangePayload('{"table":"tasks","id":"t1"}')).toEqual({
      type: 'change',
      table: 'tasks',
      id: 't1',
    });
    expect(parseChangePayload('{"table":"tasks","id":42}')).toEqual({
      type: 'change',
      table: 'tasks',
      id: '42',
    });
    expect(parseChangePayload('tasks:t1')).toBeNull();
    expect(parseChangePayload('{"table":"tasks"}')).toBeNull();
    expect(parseChangePayload('{"table":"","id":"x"}')).toBeNull();
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
    const feed = await startPgChangeFeed(async (ch, onNotify, listen) => {
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
    expect(channel).toBe(CHANGES_CHANNEL);
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
  it('对应主键的变化叫醒；resync 叫醒所有；不然到时间醒', async () => {
    const hub = createChangeHub();
    const waiters = createAskWaiters(hub);
    const started = Date.now();
    const a = waiters.sleep('ask-1', 5_000);
    hub.publish({ type: 'change', table: 'task_questions', id: 'ask-1' });
    await a;
    const b = waiters.sleep('ask-2', 5_000);
    hub.publish({ type: 'resync' });
    await b;
    expect(Date.now() - started).toBeLessThan(1_000);
    const t = Date.now();
    await waiters.sleep('ask-3', 30);
    expect(Date.now() - t).toBeGreaterThanOrEqual(25);
  });

  it('请求中止就不等了', async () => {
    const waiters = createAskWaiters(createChangeHub());
    const controller = new AbortController();
    const p = waiters.sleep('ask-1', 5_000, controller.signal);
    controller.abort();
    await p;
  });
});
