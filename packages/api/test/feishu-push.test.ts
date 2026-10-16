// 提醒推飞书（决定 0090）：后端用飞书应用机器人把该推的发进团队群（机器人只在一个群里，就是团队群），结局记进送达记录；
// 没配、认不出团队群记「没配」；飞书回错记没送成、下一轮按退避再试；凭据不进错误原文；测试推送命令读回送达记录。
import {
  feishuPushFacts,
  feishuPushProblem,
  notificationDeliveries,
  notifications,
  readFeishuPushStatus,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { noteOnlyOptions } from '@fleet-dao/shared';
import { silentLogger } from '@fleet-dao/store';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFeishuBot,
  createFeishuPusher,
  type FeishuBot,
  postRow,
  pushMessage,
} from '../src/feishu-push.ts';
import { parseFeishuPushArgs, runFeishuPush } from '../src/feishu-push-cli.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const PUBLIC = new URL('https://cockpit.example');
const SECRET = 'app-secret-should-never-leak';

/** 假飞书：记下每次请求，按 handlers 回。 */
function fakeFeishu(opts: { chats?: { chat_id: string; name: string }[]; sendCode?: number } = {}) {
  const calls: { path: string; body: unknown; auth: string | null }[] = [];
  let n = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = url.replace('https://open.feishu.cn/open-apis', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, auth: new Headers(init?.headers).get('authorization') });
    const reply = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (path.startsWith('/auth/v3/tenant_access_token/internal'))
      return reply({ code: 0, tenant_access_token: 't-token', expire: 7200 });
    if (path.startsWith('/im/v1/chats'))
      return reply({
        code: 0,
        data: { items: opts.chats ?? [{ chat_id: 'oc_team', name: '团队群' }], has_more: false },
      });
    if (path.startsWith('/im/v1/messages')) {
      n += 1;
      if (opts.sendCode) return reply({ code: opts.sendCode, msg: 'Bot is not in the chat' });
      return reply({ code: 0, data: { message_id: `om_${n}` } });
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchImpl };
}

function pusher(bot: FeishuBot | null, usage: number[] = []) {
  return createFeishuPusher({
    db: t.db,
    bot,
    notConfiguredWhy: 'api.env 缺 FEISHU_APP_ID / FEISHU_APP_SECRET',
    publicUrl: PUBLIC,
    now: () => new Date(),
    log: silentLogger,
    addUsage: async (calls) => {
      usage.push(calls);
    },
  });
}

const decision = (key: string) =>
  upsertAlert(t.db, {
    dedupeKey: key,
    level: 'decision',
    taskId: null,
    title: `拍 ${key}`,
    body: '第一行\n第二行',
    link: '/tasks',
    options: noteOnlyOptions(),
  });

describe('createFeishuPusher', () => {
  it('把该推的发进团队群（富文本、带驾驶舱链接、uuid 是提醒编号），送达记录有 message_id，用量记上', async () => {
    const { id } = await decision('d1');
    await upsertAlert(t.db, {
      dedupeKey: 'groom:done:1',
      level: 'daily',
      taskId: null,
      title: '日报',
      body: '',
    });
    const f = fakeFeishu();
    const usage: number[] = [];
    const round = await pusher(
      createFeishuBot({ appId: 'cli_x', appSecret: SECRET, fetch: f.fetchImpl }),
      usage,
    ).once();
    expect(round).toEqual({ configured: true, why: null, sent: 1, failed: 0 });
    const send = f.calls.find((c) => c.path.startsWith('/im/v1/messages'));
    if (!send) throw new Error('没发消息');
    expect(send.auth).toBe('Bearer t-token');
    expect(send.body).toMatchObject({ receive_id: 'oc_team', msg_type: 'post', uuid: id });
    const content = JSON.parse((send.body as { content: string }).content);
    expect(content.zh_cn.title).toBe('【要你拍】拍 d1');
    expect(JSON.stringify(content)).toContain('https://cockpit.example/tasks');
    const rows = await t.db.select().from(notificationDeliveries);
    expect(rows).toEqual([
      expect.objectContaining({ notificationId: id, channel: 'feishu', target: 'team', messageId: 'om_1' }),
    ]);
    expect(usage).toEqual([3]);
    expect(await readFeishuPushStatus(t.db)).toMatchObject({ configured: true, why: null });
    expect(feishuPushProblem(await feishuPushFacts(t.db, new Date()), new Date())).toBeNull();
  });

  it('【故意造出的失败】没配凭据：记「没配」、不发，看门狗的判法马上判不通', async () => {
    await decision('d1');
    const round = await pusher(null).once();
    expect(round.configured).toBe(false);
    expect(await readFeishuPushStatus(t.db)).toMatchObject({
      configured: false,
      why: 'api.env 缺 FEISHU_APP_ID / FEISHU_APP_SECRET',
    });
    expect(feishuPushProblem(await feishuPushFacts(t.db, new Date()), new Date())).toContain('没配');
  });

  it('【故意造出的失败】机器人在两个群里：认不出团队群，记「没配」，每条记一次没送成', async () => {
    const { id } = await decision('d1');
    const f = fakeFeishu({
      chats: [
        { chat_id: 'oc_a', name: '团队群' },
        { chat_id: 'oc_b', name: '旧群' },
      ],
    });
    const round = await pusher(
      createFeishuBot({ appId: 'cli_x', appSecret: SECRET, fetch: f.fetchImpl }),
    ).once();
    expect(round).toMatchObject({ configured: false, sent: 0, failed: 1 });
    expect(round.why).toContain('2 个群');
    expect(f.calls.some((c) => c.path.startsWith('/im/v1/messages'))).toBe(false);
    const [row] = await t.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, id));
    expect(row).toMatchObject({ attempts: 1, deliveredAt: null });
    expect(row?.lastError).toContain('认不出哪个是团队群');
  });

  it('【故意造出的失败】飞书回非 0：记没送成和 code，不当成送到；错误里没有凭据', async () => {
    const { id } = await decision('d1');
    const f = fakeFeishu({ sendCode: 230002 });
    const round = await pusher(
      createFeishuBot({ appId: 'cli_x', appSecret: SECRET, fetch: f.fetchImpl }),
    ).once();
    expect(round).toMatchObject({ sent: 0, failed: 1 });
    const [row] = await t.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, id));
    expect(row?.deliveredAt).toBeNull();
    expect(row?.lastError).toContain('code=230002');
    expect(row?.lastError).not.toContain(SECRET);
    // 退避期里下一轮不再发
    const again = await pusher(
      createFeishuBot({ appId: 'cli_x', appSecret: SECRET, fetch: f.fetchImpl }),
    ).once();
    expect(again.failed).toBe(0);
  });
});

describe('没东西要推时省着调飞书', () => {
  it('刚起来认一次团队群（记下状态）；认成了之后没东西要推不再调；没认成隔 5 分钟才再认', async () => {
    const good = fakeFeishu();
    const okPusher = pusher(createFeishuBot({ appId: 'cli_x', appSecret: SECRET, fetch: good.fetchImpl }));
    await okPusher.once();
    const afterFirst = good.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await readFeishuPushStatus(t.db)).toMatchObject({ configured: true });
    await okPusher.once();
    expect(good.calls.length).toBe(afterFirst);

    const two = fakeFeishu({
      chats: [
        { chat_id: 'oc_a', name: 'a' },
        { chat_id: 'oc_b', name: 'b' },
      ],
    });
    let clock = Date.now();
    const offPusher = createFeishuPusher({
      db: t.db,
      bot: createFeishuBot({ appId: 'cli_x', appSecret: SECRET, fetch: two.fetchImpl }),
      notConfiguredWhy: '',
      publicUrl: PUBLIC,
      now: () => new Date(clock),
      log: silentLogger,
    });
    await offPusher.once();
    const probes = two.calls.length;
    expect(await readFeishuPushStatus(t.db)).toMatchObject({ configured: false });
    clock += 60_000;
    await offPusher.once();
    expect(two.calls.length).toBe(probes);
    clock += 5 * 60_000;
    await offPusher.once();
    expect(two.calls.length).toBeGreaterThan(probes);
  });
});

describe('pushMessage', () => {
  it('标题带类别，正文最多 12 行，链接只认站内路径', () => {
    const msg = pushMessage(
      {
        id: 'x',
        level: 'alert',
        dedupeKey: 'k',
        title: '卡了',
        body: Array.from({ length: 20 }, (_, i) => `行${i}`).join('\n'),
        link: 'https://evil.example/',
        createdAt: new Date(),
        attempts: 0,
      },
      PUBLIC,
    );
    expect(msg.title).toBe('【卡住了】卡了');
    expect(msg.lines).toHaveLength(12);
    expect(msg.link).toBe('https://cockpit.example/');
  });

  it('每日简报：标题不再加类别，正文放到 120 行', () => {
    const msg = pushMessage(
      {
        id: 'b',
        level: 'daily',
        dedupeKey: 'feishu:brief:2026-10-15',
        title: '【每日简报】2026-10-15',
        body: Array.from({ length: 150 }, (_, i) => `行${i}`).join('\n'),
        link: '/notifications',
        createdAt: new Date(),
        attempts: 0,
      },
      PUBLIC,
    );
    expect(msg.title).toBe('【每日简报】2026-10-15');
    expect(msg.lines).toHaveLength(120);
    expect(msg.link).toBe('https://cockpit.example/notifications');
  });
});

describe('postRow', () => {
  it('行里的 https 链接做成可点的，其余是文字；没链接就是一段文字', () => {
    expect(postRow('· 卡了（开了 2 小时）— https://github.com/o/r/issues/7，去看')).toEqual([
      { tag: 'text', text: '· 卡了（开了 2 小时）— ' },
      { tag: 'a', text: 'https://github.com/o/r/issues/7', href: 'https://github.com/o/r/issues/7' },
      { tag: 'text', text: '，去看' },
    ]);
    expect(postRow('没有链接')).toEqual([{ tag: 'text', text: '没有链接' }]);
    expect(postRow('')).toEqual([{ tag: 'text', text: '' }]);
  });
});

describe('fleet-api feishu-push', () => {
  it('参数：status、test [--wait 秒]；别的拒', () => {
    expect(parseFeishuPushArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseFeishuPushArgs(['test', '--wait', '5'])).toEqual({ kind: 'test', waitSeconds: 5 });
    expect(() => parseFeishuPushArgs(['test', '--wait', '0'])).toThrow(/--wait/);
    expect(() => parseFeishuPushArgs(['send'])).toThrow(/用法/);
  });

  it('test：建一条测试提醒，在跑的推送把它推出去就退出 0，提醒随后标成已处理', async () => {
    const f = fakeFeishu();
    const p = pusher(createFeishuBot({ appId: 'cli_x', appSecret: SECRET, fetch: f.fetchImpl }));
    let ticks = 0;
    const r = await runFeishuPush(
      { kind: 'test', waitSeconds: 30 },
      {
        db: t.db,
        now: () => new Date(),
        operator: 'root',
        sleep: async () => {
          ticks += 1;
          await p.once();
        },
      },
    );
    expect(r.code).toBe(0);
    expect(r.text).toContain('送到了');
    expect(ticks).toBe(1);
    const [n] = await t.db.select().from(notifications);
    expect(n?.dedupeKey).toMatch(/^feishu:test:/);
    expect(n?.resolvedBy).toBe('ops:feishu-push-test');
  });

  it('【故意造出的失败】test：推送没在跑，等到点退出 1，照实说一次都没试', async () => {
    let clock = Date.now();
    const r = await runFeishuPush(
      { kind: 'test', waitSeconds: 5 },
      {
        db: t.db,
        now: () => new Date(clock),
        operator: 'root',
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(r.code).toBe(1);
    expect(r.text).toContain('一次都没试');
  });
});
