// 网关（#2047 提需求 F1，方案第八节）：飞书收缩后不收群聊、私聊的话，不写意图库，不发意图卡，没有机器人菜单。
// 剩下的：进群说明、旧卡按钮回「已停用」、每分钟向后端报飞书用量、自己的看守（watch.test.ts）。
// 用真实形状的事件喂进来，后端是真 HTTP 的假服务器，飞书是假的。每条「读不到 / 认不出」的路径都配【故意造出的失败】测试。
import { FEISHU_JOIN_GROUP_TEXT, FEISHU_JOIN_REASON } from '@fleet-dao/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FeishuError } from '../src/port.ts';
import { A, asAction, B, cardEvent, STRANGER, TEAM, TEST_GROUP } from './events.ts';
import { apiError } from './fake-backend.ts';
import { type Harness, harness, QUIET_USAGE, until } from './harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function click(
  messageId: string,
  value: unknown,
  o: { from?: string; form?: Record<string, unknown> } = {},
) {
  const evt = await asAction(cardEvent({ messageId, value, ...o }));
  h.gateway.onCardAction(evt);
  await h.gateway.idle();
}

const join = (o: { chatId?: string; openIds?: string[]; eventId?: string } = {}) => ({
  chatId: o.chatId ?? TEAM,
  at: 1_790_000_000_000,
  openIds: o.openIds ?? [STRANGER],
  ...(o.eventId ? { eventId: o.eventId } : {}),
});

describe('收缩：不再收话、不写意图库、不发意图卡、没有菜单', () => {
  it('网关没有收消息、收撤回、收菜单的入口（飞书那头订不订阅都不会进来）', async () => {
    h = await harness();
    const keys = Object.keys(h.gateway);
    for (const gone of ['onMessage', 'onRecall', 'onMenu', 'onReject', 'backfill', 'missed']) {
      expect({ gone, present: keys.includes(gone) }).toEqual({ gone, present: false });
    }
  });

  it('起网关跑一阵：后端只收到用量上报，没有收原话、撤回、补漏游标、意图卡、回执、拒收这些请求', async () => {
    h = await harness({ timing: { usageEveryMs: 20 } });
    h.backend.on('POST', '/feishu/gateway/usage', { body: QUIET_USAGE });
    h.gateway.start();
    await until(() => h.backend.calls('POST', '/feishu/gateway/usage').length >= 3);
    await h.gateway.stop(2_000);
    const paths = new Set(h.backend.requests.map((r) => `${r.method} ${r.path}`));
    expect([...paths]).toEqual(['POST /feishu/gateway/usage']);
    // 飞书那头也一条没发
    expect(h.feishu.calls).toEqual([]);
  });
});

describe('有人进白名单群', () => {
  it('白名单外的人进来：群里说那一句，末 4 位送给后端', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/joins', { body: { recorded: 1 } });
    h.gateway.onJoin(join());
    await h.gateway.idle();
    expect(h.feishu.of('send')[0]).toMatchObject({
      to: { chatId: TEAM },
      message: { text: FEISHU_JOIN_GROUP_TEXT },
    });
    expect(h.backend.calls('POST', '/feishu/intake/joins')[0]?.body).toEqual({
      chatId: TEAM,
      openIdTails: ['nger'],
      at: new Date(1_790_000_000_000).toISOString(),
      reason: FEISHU_JOIN_REASON,
    });
    expect(h.gateway.stats).toMatchObject({ join_outsider: 1 });
  });

  it('进来的都是创始人：不说话、不报；不在允许的群、同一个事件重投：不理', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/joins', { body: { recorded: 1 } });
    h.gateway.onJoin(join({ openIds: [A, B] }));
    h.gateway.onJoin(join({ chatId: 'oc_other_group' }));
    h.gateway.onJoin(join({ chatId: TEST_GROUP, eventId: 'evt_same' }));
    h.gateway.onJoin(join({ chatId: TEST_GROUP, eventId: 'evt_same' }));
    await h.gateway.idle();
    expect(h.gateway.stats).toMatchObject({
      join_founders: 1,
      join_ignored: 1,
      join_duplicate: 1,
      join_outsider: 1,
    });
    // 测试群那一次只处理了一回
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(h.backend.calls('POST', '/feishu/intake/joins')).toHaveLength(1);
  });

  it('【故意造出的失败】说明发不出去：记错误，后端的记录照样送；后端不收：记错误，不抛', async () => {
    h = await harness();
    h.feishu.fail('send', new FeishuError('unavailable', '连不上飞书'));
    h.backend.on('POST', '/feishu/intake/joins', { body: { recorded: 1 } });
    h.gateway.onJoin(join({ eventId: 'evt_1' }));
    await h.gateway.idle();
    expect(h.gateway.stats).toMatchObject({ join_notice_failed: 1 });
    expect(h.backend.calls('POST', '/feishu/intake/joins')).toHaveLength(1);

    h.backend.on('POST', '/feishu/intake/joins', apiError(503, 'unavailable', '后端暂时不可用'));
    h.gateway.onJoin(join({ eventId: 'evt_2' }));
    await h.gateway.idle();
    expect(h.gateway.stats).toMatchObject({ join_record_failed: 1 });
    expect(h.logs.some((l) => l.level === 'error' && l.message === '进群记录没送到后端')).toBe(true);
  });
});

describe('旧卡上的按钮：回「已停用」，不悄悄不理', () => {
  it('旧卡上的按钮：回一句说清楚（同一张卡同一天只说一次），不调后端、不认按钮是什么', async () => {
    h = await harness();
    await click('om_old_card', { a: 'draft.confirm', d: 'draft-1', r: 1, _n: 'n1' }, { form: {} });
    expect(h.backend.requests).toHaveLength(0);
    const [reply] = h.feishu.of('reply');
    expect(reply?.messageId).toBe('om_old_card');
    expect(reply?.message).toEqual({ text: expect.stringContaining('已经停用') });
    expect(reply?.message && 'text' in reply.message && reply.message.text).toContain(
      'https://cockpit.example.test',
    );
    expect(h.gateway.stats).toMatchObject({ disabled_button: 1 });

    // 同一天、同一张卡再点：不再回
    await click('om_old_card', { a: 'draft.confirm', d: 'draft-1', r: 1, _n: 'n2' }, { form: {} });
    expect(h.feishu.of('reply')).toHaveLength(1);
    expect(h.gateway.stats).toMatchObject({ disabled_button: 2 });
  });

  it('认不出的按钮回传值也回「已停用」并计数，不调后端【故意造出的失败】', async () => {
    h = await harness();
    await click('om_weird', { hello: 'world' });
    expect(h.backend.requests).toHaveLength(0);
    expect(h.feishu.of('reply')[0]?.message).toEqual({ text: expect.stringContaining('已经停用') });
    expect(h.gateway.stats).toMatchObject({ disabled_button: 1 });
  });

  it('陌生人点按钮：不回话、不调后端，只计数', async () => {
    h = await harness();
    await click('om_old_card', { hello: 'world' }, { from: STRANGER });
    expect(h.feishu.calls).toEqual([]);
    expect(h.backend.requests).toHaveLength(0);
    expect(h.gateway.stats).toMatchObject({ stranger: 1 });
  });

  it('「已停用」那句不再提「只收原话」（飞书已经不收话了）', async () => {
    h = await harness();
    await click('om_old', { a: 'ask.answer', k: 'ask-1', o: '批准', _n: 'n1' });
    const sent = h.feishu.of('reply')[0]?.message as { text: string };
    expect(sent.text).not.toContain('只收原话');
    expect(sent.text).not.toContain('指挥官一条条读');
  });
});

describe('定时向后端报用量（也是后端认「网关还在」的心跳）', () => {
  it('start() 起来就报一次，之后按间隔再报；stop() 之后不再报', async () => {
    h = await harness({ timing: { usageEveryMs: 20 } });
    h.backend.on('POST', '/feishu/gateway/usage', { body: QUIET_USAGE });
    h.gateway.start();
    await until(() => h.backend.calls('POST', '/feishu/gateway/usage').length >= 3);
    await h.gateway.stop(2_000);
    const after = h.backend.calls('POST', '/feishu/gateway/usage').length;
    await new Promise((r) => setTimeout(r, 80));
    expect(h.backend.calls('POST', '/feishu/gateway/usage').length).toBe(after);
  });

  it('默认一分钟一次，比后端 5 分钟没来就报红的时限短得多', async () => {
    const { DEFAULT_TIMING } = await import('../src/gateway.ts');
    expect(DEFAULT_TIMING.usageEveryMs).toBe(60_000);
    expect(DEFAULT_TIMING.usageEveryMs * 3).toBeLessThan(5 * 60_000);
  });
});

const OVER = { month: '2026-10', calls: 8100, limit: 10_000, readable: true };
const UNREADABLE = { month: '2026-10', calls: 0, limit: 10_000, readable: false };

describe('飞书用量：八成标出来、读不到不装没事', () => {
  it('报到 81%：记上打出去的次数，status 写明；不停任何发送（收话、改卡、补漏都没了，没有可停的）', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/gateway/usage', { body: OVER });
    h.backend.on('POST', '/feishu/intake/joins', { body: { recorded: 1 } });
    h.gateway.onJoin(join());
    await h.gateway.idle();
    await h.gateway.reportUsage();

    const reported = h.backend.calls('POST', '/feishu/gateway/usage');
    expect(reported).toHaveLength(1);
    // 进群说明那一条已经打出去
    expect(reported[0]?.body).toMatchObject({ calls: 1 });
    expect(h.gateway.status).toMatchObject({ level: 'over', calls: 8100, limit: 10_000 });
    expect(h.gateway.status.sentence).toContain('8100/10000');
    expect(h.gateway.status).not.toHaveProperty('stopped');
  });

  it('【故意造出的失败】用量读不到：status 标 unreadable、calls 是 null（不写 0），心跳里带上，看守记一次没走通', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/gateway/usage', apiError(500, 'usage_down', '用量表读不了'));
    await h.gateway.reportUsage();
    expect(h.gateway.status).toMatchObject({ level: 'unreadable', calls: null });
    expect(h.gateway.status.sentence).toContain('读不到');
    expect(h.logs.some((l) => l.level === 'error' && l.message === '飞书用量没报上，按读不到处理')).toBe(
      true,
    );
    h.gateway.watch.heartbeat();
    const beat = h.logs.find((l) => l.message === '网关心跳');
    expect(beat?.fields?.usage).toMatchObject({ ok: 0, failed: 1 });
    expect(beat?.fields?.feishuUsage).toMatchObject({ level: 'unreadable' });

    // 后端好了：下一轮就恢复
    h.backend.on('POST', '/feishu/gateway/usage', { body: QUIET_USAGE });
    await h.gateway.reportUsage();
    expect(h.gateway.status.level).toBe('ok');
  });

  it('读回的是「不可读」快照（readable=false）：同样标 unreadable', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/gateway/usage', { body: UNREADABLE });
    await h.gateway.reportUsage();
    expect(h.gateway.status).toMatchObject({ level: 'unreadable', calls: null });
  });

  it('已发出但超时或失败的飞书调用也计入用量，不因为没成功就漏报', async () => {
    h = await harness();
    h.feishu.fail('send', new FeishuError('timeout', '发消息：飞书没及时回应'));
    h.feishu.fail('reply', new FeishuError('timeout', '回复消息：飞书没及时回应'));
    h.backend.on('POST', '/feishu/intake/joins', { body: { recorded: 1 } });
    h.backend.on('POST', '/feishu/gateway/usage', { body: OVER });
    h.gateway.onJoin(join());
    await h.gateway.idle();
    await click('om_old', { a: 'ask.answer', k: 'ask-1', o: '批准', _n: 'n1' });
    await h.gateway.reportUsage();
    const reported = h.backend.calls('POST', '/feishu/gateway/usage');
    expect(reported).toHaveLength(1);
    // 进群说明超时、旧卡的回复也超时：两次都已经打出去。
    expect(reported[0]?.body).toMatchObject({ calls: 2 });
  });

  it('用量上报的回应丢了：同一份 reportId 和次数重报，期间新打的另算一批', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/joins', { body: { recorded: 1 } });
    h.backend.on('POST', '/feishu/gateway/usage', apiError(500, 'usage_down', '回应丢了'));
    h.gateway.onJoin(join());
    await h.gateway.idle();
    await h.gateway.reportUsage();
    const first = h.backend.calls('POST', '/feishu/gateway/usage')[0]?.body as {
      reportId?: string;
      calls?: number;
    };
    expect(first.reportId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.calls).toBe(1);

    // 旧按钮的回复照样打出去，不并进还没确认的那一批。
    await click('om_old', { a: 'ask.answer', k: 'ask-1', o: '批准', _n: 'n1' });
    h.backend.on('POST', '/feishu/gateway/usage', { body: OVER });
    await h.gateway.reportUsage();
    const reported = h.backend.calls('POST', '/feishu/gateway/usage');
    const second = reported[1]?.body as { reportId?: string; calls?: number };
    expect(second).toEqual({ reportId: first.reportId, calls: 1, at: expect.any(String) });
    const third = reported[2]?.body as { reportId?: string; calls?: number };
    expect(third?.reportId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(third?.reportId).not.toBe(first.reportId);
    expect(third?.calls).toBe(1);
    expect(reported).toHaveLength(3);
  });
});

describe('停机', () => {
  it('停机时手上的活做完再退：在途的进群记录不被掐断，照样落到后端', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/joins', { body: { recorded: 1 }, delayMs: 300 });
    h.gateway.onJoin(join());
    await h.gateway.stop(5_000);
    expect(h.backend.calls('POST', '/feishu/intake/joins')).toHaveLength(1);
  });

  it('停机时在途的用量上报被撤回：不记成「读不到」、不算看守没走通', async () => {
    h = await harness({ timing: { backendMs: 5_000 } });
    h.backend.on('POST', '/feishu/gateway/usage', 'hang');
    const running = h.gateway.reportUsage();
    await until(() => h.backend.calls('POST', '/feishu/gateway/usage').length === 1);
    await h.gateway.stop(2_000);
    await running;
    expect(h.gateway.status.level).toBe('ok');
    expect(h.logs.some((l) => l.message === '飞书用量没报上，按读不到处理')).toBe(false);
  });
});
