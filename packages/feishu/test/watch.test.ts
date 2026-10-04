// 网关自己看着自己（watch.ts）：调不通后端 5 分钟往团队群报一次、通了说一声、时好时坏不来回报；心跳按时写；
// 收到的耗时量出来。看守单独测用假时钟；最后一段接上真网关（真 HTTP 的假后端）跑一遍，看定时器、推送、盘面都接上了。
import { afterEach, describe, expect, it } from 'vitest';
import { BackendError } from '../src/backend.ts';
import { checkCard, HEALTH_PAGE_PATH } from '../src/cards.ts';
import type { QuietHours } from '../src/gate.ts';
import { OutboxStall } from '../src/outbox.ts';
import { createWatch, reasonOf, WATCH_LIMITS } from '../src/watch.ts';
import { asMessage, messageEvent, TEAM } from './events.ts';
import { apiError } from './fake-backend.ts';
import { buttonsOf, FakeFeishu, textIn, titleOf, unavailable } from './fake-feishu.ts';
import {
  draft,
  type Harness,
  harness,
  type LogLine,
  memoryLogger,
  PUBLIC_URL,
  snapshot,
  until,
} from './harness.ts';

const SEC = 1_000;
const MIN = 60_000;
/** 北京时间 2026-09-26 14:00。 */
const T0 = Date.UTC(2026, 8, 26, 6, 0);
/** 北京时间 2026-09-26 23:30（免打扰 23:00–08:00 里）。 */
const NIGHT = Date.UTC(2026, 8, 26, 15, 30);
const QUIET: QuietHours = { start: '23:00', end: '08:00' };

/** 连不上后端：和 backend.ts 在 fetch 抛错时包出来的一样（系统错误码在 cause 的 cause 里，原文带着地址）。 */
function refused(): BackendError {
  const sys = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:8787'), { code: 'ECONNREFUSED' });
  return new BackendError('unreachable', 'GET /feishu/board：连不上后端（ECONNREFUSED）', {
    cause: new TypeError('fetch failed', { cause: sys }),
  });
}

function setup(o: { start?: number; quiet?: QuietHours | null | undefined; boardRefreshMs?: number } = {}) {
  const base = o.start ?? T0;
  let t = base;
  const feishu = new FakeFeishu();
  const logs: LogLine[] = [];
  const watch = createWatch({
    feishu,
    log: memoryLogger(logs),
    now: () => t,
    teamChatId: TEAM,
    publicUrl: PUBLIC_URL,
    quietHours: () => o.quiet,
    boardRefreshMs: o.boardRefreshMs ?? 30 * SEC,
    ackTargetMs: 2_000,
  });
  return {
    watch,
    feishu,
    logs,
    /** 把时钟拨到起点之后 ms 毫秒。 */
    at(ms: number) {
      t = base + ms;
    },
    /** 定时活都走通一轮（推送、盘面，和意图卡）。 */
    bothOk() {
      watch.ok('outbox', 20);
      watch.ok('board', 80);
      watch.ok('intents', 20);
    },
    bothFail() {
      watch.fail('outbox', refused());
      watch.fail('board', refused());
      watch.fail('intents', refused());
    },
    alerts: () => feishu.of('send').filter((c) => c.to && 'chatId' in c.to && c.to.chatId === TEAM),
  };
}

/** 从起点起每 30 秒两条都没走通，一直到 untilMs，每一轮都看一次要不要报。 */
async function failUntil(s: ReturnType<typeof setup>, fromMs: number, untilMs: number) {
  for (let ms = fromMs; ms <= untilMs; ms += 30 * SEC) {
    s.at(ms);
    s.bothFail();
    await s.watch.check();
  }
}

describe('调不通后端报警', () => {
  it('推送、盘面都调不通满 5 分钟：往团队群发一张报警卡，写明从几点起、为什么（不带地址）；之后一直不通也不再发', async () => {
    const s = setup();
    s.bothOk();
    await failUntil(s, 30 * SEC, 4 * MIN + 30 * SEC);
    s.at(4 * MIN + 59 * SEC);
    await s.watch.check();
    expect(s.alerts()).toHaveLength(0);

    s.at(5 * MIN);
    await s.watch.check();
    const [alert] = s.alerts();
    expect(alert?.message && 'card' in alert.message).toBe(true);
    const card = s.feishu.cardOf(alert?.sentId ?? '');
    expect(titleOf(card)).toBe('机器人连不上后端了');
    const words = textIn(card);
    expect(words).toContain('从 14:00 起一直没走通，到现在 5 分钟');
    expect(words).toContain('推送：最后一次走通 14:00；最近一次没走通 14:04：后端现在连不上（ECONNREFUSED）');
    expect(words).toContain('盘面快照：最后一次走通 14:00');
    expect(words).toContain('要你们拍的事、卡住报警推不过来');
    expect(words).toContain('这次只报这一次');
    expect(words).not.toContain('10.0.0.9');
    expect(buttonsOf(card)).toEqual([
      { label: '打开健康页', primary: true, url: `${PUBLIC_URL}${HEALTH_PAGE_PATH}` },
    ]);
    expect(checkCard(card)).toEqual([]);

    await failUntil(s, 5 * MIN + 30 * SEC, 90 * MIN);
    expect(s.alerts()).toHaveLength(1);
    expect(s.logs.filter((l) => l.message === '网关调不通后端超过时限')).toHaveLength(1);
  });

  it('不到 5 分钟又通了（发版重启、隧道抖一下）：不报', async () => {
    const s = setup();
    s.bothOk();
    await failUntil(s, 30 * SEC, 4 * MIN);
    s.at(4 * MIN + 30 * SEC);
    s.bothOk();
    for (const ms of [5 * MIN, 6 * MIN, 9 * MIN]) {
      s.at(ms);
      s.bothOk();
      await s.watch.check();
    }
    expect(s.alerts()).toHaveLength(0);
    expect(s.logs.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('通了：全部连续走通 1 分钟才算，在报警下面回一句、卡改灰；中途又断一下重新算，不来回报', async () => {
    const s = setup();
    s.bothOk();
    await failUntil(s, 30 * SEC, 20 * MIN);
    const alertId = s.alerts()[0]?.sentId ?? '';
    expect(alertId).not.toBe('');

    s.at(20 * MIN + 10 * SEC);
    s.bothOk();
    s.at(20 * MIN + 40 * SEC);
    await s.watch.check();
    s.watch.fail('outbox', refused()); // 刚通又断一下：重新算
    s.at(21 * MIN);
    s.bothOk();
    s.at(21 * MIN + 50 * SEC);
    await s.watch.check();
    expect(s.feishu.of('reply')).toHaveLength(0);

    s.at(22 * MIN);
    s.bothOk();
    await s.watch.check();
    const replies = s.feishu.of('reply');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.messageId).toBe(alertId);
    expect(replies[0]?.message).toEqual({
      text: expect.stringContaining('通了：推送、盘面快照、意图卡 14:21 起又走通了，断了 21 分钟'),
    });
    const grey = s.feishu.cardOf(alertId);
    expect((grey.header as { template: string }).template).toBe('grey');
    expect(textIn(grey)).toContain('已经通了 · 14:21（断了 21 分钟）');
    expect(checkCard(grey)).toEqual([]);

    // 了结了：之后一直好，不再说；再断满 5 分钟，是新的一次，另报一条
    for (const ms of [23 * MIN, 25 * MIN]) {
      s.at(ms);
      s.bothOk();
      await s.watch.check();
    }
    expect(s.alerts()).toHaveLength(1);
    expect(s.feishu.of('reply')).toHaveLength(1);
    await failUntil(s, 25 * MIN + 30 * SEC, 30 * MIN);
    expect(s.alerts()).toHaveLength(2);
    expect(new Set(s.alerts().map((c) => c.uuid)).size).toBe(2);
  });

  it('报警没发出去（飞书也出错）：下一轮再发，同一个 uuid，群里不会多出一条', async () => {
    const s = setup();
    s.bothOk();
    s.feishu.fail('send', unavailable());
    await failUntil(s, 30 * SEC, 5 * MIN);
    expect(s.feishu.newMessages()).toHaveLength(0);
    expect(s.logs.some((l) => l.message === '调不通后端的报警没发出去，下一轮再试')).toBe(true);

    await failUntil(s, 5 * MIN + 30 * SEC, 6 * MIN);
    expect(s.feishu.newMessages()).toHaveLength(1);
    const uuids = s.alerts().map((c) => c.uuid);
    expect(uuids).toHaveLength(2);
    expect(new Set(uuids).size).toBe(1);
  });

  it('「通了」没发出去：下一轮再说，说成了才算了结', async () => {
    const s = setup();
    s.bothOk();
    await failUntil(s, 30 * SEC, 10 * MIN);
    s.at(10 * MIN + 30 * SEC);
    s.bothOk();
    s.feishu.fail('reply', unavailable());
    s.at(11 * MIN + 30 * SEC);
    s.bothOk();
    await s.watch.check();
    expect(s.logs.some((l) => l.message === '「通了」没发出去，下一轮再试')).toBe(true);
    s.at(12 * MIN);
    s.bothOk();
    await s.watch.check();
    const replies = s.feishu.of('reply');
    expect(replies).toHaveLength(2);
    expect(new Set(replies.map((r) => r.uuid)).size).toBe(1);
    s.at(13 * MIN);
    s.bothOk();
    await s.watch.check();
    expect(s.feishu.of('reply')).toHaveLength(2);
  });

  it('免打扰时段：等时段过了再报；还没通就报，时段里就通了的不报也不补', async () => {
    const night = setup({ start: NIGHT, quiet: QUIET });
    night.bothOk();
    await failUntil(night, 30 * SEC, 8 * 60 * MIN + 29 * MIN); // 到 07:59
    expect(night.alerts()).toHaveLength(0);
    expect(night.logs.filter((l) => l.message.startsWith('在免打扰时段'))).toHaveLength(1);
    await failUntil(night, 8 * 60 * MIN + 30 * MIN, 8 * 60 * MIN + 30 * MIN); // 08:00
    expect(night.alerts()).toHaveLength(1);
    expect(textIn(night.feishu.cardOf(night.alerts()[0]?.sentId ?? ''))).toContain(
      '从 09-26 23:30 起一直没走通，到现在 8 小时',
    );

    const healed = setup({ start: NIGHT, quiet: QUIET });
    healed.bothOk();
    await failUntil(healed, 30 * SEC, 60 * MIN);
    for (const ms of [61 * MIN, 62 * MIN, 63 * MIN, 9 * 60 * MIN]) {
      healed.at(ms);
      healed.bothOk();
      await healed.watch.check();
    }
    expect(healed.feishu.calls).toEqual([]);
    expect(healed.logs.some((l) => l.message === '后端又调通了（没报过警，不补报）')).toBe(true);
  });

  it('还没从后端拿到过免打扰时段（网关起来后后端就连不上）：照报，不因为不知道就不报', async () => {
    const s = setup({ start: NIGHT, quiet: undefined });
    await failUntil(s, 0, 5 * MIN);
    expect(s.alerts()).toHaveLength(1);
    expect(textIn(s.feishu.cardOf(s.alerts()[0]?.sentId ?? ''))).toContain('网关 23:30 起来后一直没走通');
  });

  it('定时活一轮都没跑完（循环悄悄停了）：照样报，写明「一轮都没跑完」，不当成没事；走通之前的旧失败不拿来当原因', async () => {
    const s = setup();
    s.at(5 * MIN);
    await s.watch.check();
    const card = s.feishu.cardOf(s.alerts()[0]?.sentId ?? '');
    expect(textIn(card)).toContain('网关 14:00 起来后一直没走通，到现在 5 分钟');
    expect(textIn(card)).toContain(
      '推送：网关起来后没走通过；这段时间一轮都没跑完（网关的定时活停了，或卡在飞书那头？）',
    );

    const stale = setup();
    stale.bothFail();
    stale.at(30 * SEC);
    stale.bothOk();
    stale.at(5 * MIN + 30 * SEC);
    await stale.watch.check();
    const text = textIn(stale.feishu.cardOf(stale.alerts()[0]?.sentId ?? ''));
    expect(text).toContain('推送：最后一次走通 14:00；这段时间一轮都没跑完');
    expect(text).not.toContain('最近一次没走通');
  });

  it('只有推送卡住（后端说设置读不懂），盘面照常：标题写推送卡住了，只列推送，原因照后端的话写', async () => {
    const s = setup();
    s.bothOk();
    const said = '免打扰时段的设置读不懂（库里的值不合约定），先在驾驶舱里重设';
    const stall = new OutboxStall(
      '推送回执没送到后端，还积压 2 条',
      new BackendError('server', `POST /feishu/outbox/acks：${said}`, { status: 500, said }),
    );
    for (let ms = 30 * SEC; ms <= 5 * MIN; ms += 30 * SEC) {
      s.at(ms);
      s.watch.fail('outbox', stall);
      s.watch.ok('board', 60);
      s.watch.ok('intents', 20);
      await s.watch.check();
    }
    const card = s.feishu.cardOf(s.alerts()[0]?.sentId ?? '');
    expect(titleOf(card)).toBe('推送卡住了：机器人调不通后端');
    expect(textIn(card)).toContain(`推送回执没送到后端，还积压 2 条：${said}（HTTP 500）`);
    expect(textIn(card)).not.toContain('盘面快照：');
  });

  it('盘面取得很慢时（配成每小时一次）：盘面那条的时限放宽到两轮，不误报；两轮都没取到照样报', async () => {
    const s = setup({ boardRefreshMs: 60 * MIN });
    s.bothOk();
    for (let ms = 30 * SEC; ms < 120 * MIN; ms += 30 * SEC) {
      s.at(ms);
      s.watch.ok('outbox', 20);
      s.watch.ok('intents', 20);
      await s.watch.check();
    }
    expect(s.alerts()).toHaveLength(0);
    s.at(120 * MIN);
    s.watch.ok('outbox', 20);
    s.watch.ok('intents', 20);
    await s.watch.check();
    expect(titleOf(s.feishu.cardOf(s.alerts()[0]?.sentId ?? ''))).toBe('盘面卡住了：机器人取不到快照');
  });

  it('没走通的原因：只说人话和错误码，不带地址；停机时自己撤回的请求不算没走通', () => {
    expect(reasonOf(refused())).toBe('后端现在连不上（ECONNREFUSED）');
    expect(reasonOf(new BackendError('timeout', 'GET /feishu/board：5000 毫秒没回应'))).toBe(
      '后端没及时回应',
    );
    expect(reasonOf(new BackendError('rejected', 'x', { status: 401 }))).toBe('后端拒收（HTTP 401）');
    expect(reasonOf(new BackendError('server', 'x', { status: 502 }))).toBe('后端出错了（HTTP 502）');
    expect(reasonOf(new Error('connect ECONNREFUSED 10.0.0.9:8787'))).toBe('网关这边出错了（已记日志）');

    const s = setup();
    s.bothOk();
    s.at(10 * SEC);
    s.watch.fail('outbox', new BackendError('aborted', '网关在停机'));
    s.watch.heartbeat();
    const beat = s.logs.find((l) => l.message === '网关心跳');
    expect(beat?.fields?.lastError).toBeUndefined();
    expect(beat?.fields?.push).toMatchObject({ failedRounds: 0 });
  });
});

describe('心跳', () => {
  it('按时写一行：推了几条、取了几次快照、平均和最慢多久、收到的耗时；写完清零', () => {
    const s = setup();
    s.at(9 * MIN);
    s.watch.fail('board', refused());
    s.at(9 * MIN + 30 * SEC);
    s.watch.ok('outbox', 25_000);
    s.watch.ok('outbox', 25_000);
    s.watch.pushed('sent', 120);
    s.watch.pushed('updated', 80);
    s.watch.pushed('deferred', 0);
    s.watch.pushed('dropped', 1);
    s.watch.ok('board', 50);
    s.watch.ok('board', 150);
    s.watch.ok('intents', 20);
    s.watch.intake(true);
    s.watch.intake(false);
    s.watch.backfill(2, 1);
    s.watch.acked(300);
    s.watch.acked(2_500);
    s.watch.acked(null);
    s.watch.cardSlow();
    s.at(10 * MIN);
    s.watch.heartbeat();

    const beats = () => s.logs.filter((l) => l.message === '网关心跳');
    const okAt = new Date(T0 + 9 * MIN + 30 * SEC).toISOString();
    expect(beats()).toEqual([
      {
        level: 'info',
        message: '网关心跳',
        fields: {
          minutes: 10,
          link: 'ok',
          push: {
            rounds: 2,
            failedRounds: 0,
            pushed: 2,
            sent: 1,
            updated: 1,
            deferred: 1,
            dropped: 1,
            failed: 0,
            avgMs: 100,
            maxMs: 120,
            lastOkAt: okAt,
          },
          board: { ok: 2, failed: 1, avgMs: 100, maxMs: 150, lastOkAt: okAt },
          intents: { ok: 1, failed: 0, lastOkAt: okAt },
          intake: { stored: 1, failed: 1 },
          backfill: { rounds: 1, filled: 2, failed: 1 },
          messages: {
            count: 3,
            ackAvgMs: 1_400,
            ackMaxMs: 2_500,
            lastAckMs: 2_500,
            ackSlow: 1,
            noAck: 1,
            cardSlow: 1,
          },
          lastError: {
            loop: 'board',
            at: new Date(T0 + 9 * MIN).toISOString(),
            reason: '后端现在连不上（ECONNREFUSED）',
          },
        },
      },
    ]);
  });

  it('安静（没人说话、没东西推）和挂了分得开：安静时推送照样一轮轮走通；挂了是一轮都没有、写 down；没有的平均写 null，不写 0', () => {
    const s = setup();
    s.at(19 * MIN + 30 * SEC);
    s.watch.ok('outbox', 25_000);
    s.watch.ok('board', 60);
    s.watch.ok('intents', 20);
    s.at(20 * MIN);
    s.watch.heartbeat();
    s.at(30 * MIN);
    s.watch.heartbeat();

    const [quiet, dead] = s.logs.filter((l) => l.message === '网关心跳');
    expect(quiet).toMatchObject({
      level: 'info',
      fields: {
        link: 'ok',
        push: { rounds: 1, pushed: 0, avgMs: null, maxMs: null },
        board: { ok: 1, avgMs: 60 },
        messages: { count: 0, ackAvgMs: null, ackMaxMs: null, lastAckMs: null },
      },
    });
    expect(quiet?.fields?.lastError).toBeUndefined();
    expect(dead).toMatchObject({
      level: 'warn',
      fields: {
        minutes: 10,
        link: 'down',
        push: { rounds: 0, failedRounds: 0, avgMs: null },
        board: { ok: 0, failed: 0, avgMs: null, maxMs: null },
      },
    });
  });

  it('调不通时的心跳：记成 warn，写明从几点起不通、报没报过', async () => {
    const s = setup();
    s.bothOk();
    await failUntil(s, 30 * SEC, 6 * MIN);
    s.watch.heartbeat();
    const beat = s.logs.find((l) => l.message === '网关心跳');
    expect(beat).toMatchObject({
      level: 'warn',
      fields: { link: 'down', downSince: new Date(T0).toISOString(), alerted: true },
    });
  });
});

describe('接上真网关', () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it('起来后按时写心跳（不等停机、没人说话也写）：推送一轮轮走通、盘面取到了，都记在里面', async () => {
    h = await harness({ watch: { heartbeatMs: 150 }, boardRefreshMs: 40 });
    h.backend.on('GET', '/feishu/outbox', {
      body: { items: [], quietHours: null, asOf: new Date().toISOString() },
    });
    h.backend.on('GET', '/feishu/board', { body: snapshot() });
    h.backend.on('PUT', '/feishu/cards/:messageId', { body: { ok: true } });
    h.gateway.start();
    const beats = () => h.logs.filter((l) => l.message === '网关心跳');
    await until(() => beats().length >= 2, 5_000);
    expect(beats()[0]).toMatchObject({ level: 'info', fields: { link: 'ok' } });
    const counted = beats().map((b) => b.fields as { push: { rounds: number }; board: { ok: number } });
    expect(counted.some((c) => c.push.rounds > 0)).toBe(true);
    expect(counted.some((c) => c.board.ok > 0)).toBe(true);
  });

  it('网关起来后推送、盘面都调不通：到时限往团队群报一次；后端好了，稳住后在报警下面回「通了」；停机时写一行心跳', async () => {
    h = await harness({
      watch: { alertAfterMs: 300, recoverAfterMs: 100, checkEveryMs: 20, heartbeatMs: 60_000 },
      boardRefreshMs: 50,
    });
    let healthy = false;
    h.backend.on('GET', '/feishu/outbox', () =>
      healthy
        ? { body: { items: [], quietHours: null, asOf: new Date().toISOString() } }
        : apiError(503, 'unavailable', '后端暂时不可用'),
    );
    h.backend.on('GET', '/feishu/board', () =>
      healthy ? { body: snapshot() } : apiError(503, 'unavailable', '后端暂时不可用'),
    );
    h.backend.on('GET', '/feishu/intent-cards', () =>
      healthy
        ? { body: { items: [], asOf: new Date().toISOString() } }
        : apiError(503, 'unavailable', '后端暂时不可用'),
    );
    h.backend.on('PUT', '/feishu/cards/:messageId', { body: { ok: true } });
    h.gateway.start();

    const alertCard = () =>
      h.feishu
        .newMessages()
        .find((m) => 'card' in m.message && titleOf(m.message.card) === '机器人连不上后端了');
    await until(() => alertCard() !== undefined, 5_000);
    const alert = alertCard();
    expect(alert?.chatId).toBe(TEAM);
    expect(textIn(h.feishu.cardOf(alert?.messageId ?? ''))).toContain('后端暂时不可用（HTTP 503）');

    healthy = true;
    await until(() => h.feishu.of('reply').length === 1, 8_000);
    expect(h.feishu.of('reply')[0]).toMatchObject({
      messageId: alert?.messageId,
      message: { text: expect.stringContaining('通了：') },
    });
    // 同一次只报一次
    const alertSends = h.feishu
      .of('send')
      .filter((c) => c.message && 'card' in c.message && titleOf(c.message.card) === '机器人连不上后端了');
    expect(alertSends).toHaveLength(1);

    await h.gateway.stop(2_000);
    const beat = h.logs.find((l) => l.message === '网关心跳');
    expect(beat?.fields?.link).toBe('ok');
    expect((beat?.fields?.board as { ok: number } | undefined)?.ok).toBeGreaterThan(0);
  });

  it('收到的耗时量出来：表情回应慢过 2 秒计一次；表情加不上改回一句「收到」也量；都没回上记成没回上，不写 0', async () => {
    let clock = Date.now();
    h = await harness({ now: () => clock });
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    // 飞书那边表情回应花了 2.5 秒
    const react = h.feishu.react.bind(h.feishu);
    h.feishu.react = async (messageId, emoji) => {
      clock += 2_500;
      return react(messageId, emoji);
    };
    const say = async (text: string) => {
      h.gateway.onMessage(await asMessage(messageEvent({ text })));
      await h.gateway.idle();
    };
    await say('给登录页加手机验证码');
    h.feishu.fail('react', unavailable());
    await say('再加一个找回密码');
    h.feishu.fail('react', unavailable());
    h.feishu.fail('reply', unavailable());
    await say('第三句');

    const done = h.logs.filter((l) => l.message === '消息处理完').map((l) => l.fields?.ackMs);
    expect(done).toEqual([2_500, 2_500, null]);
    expect(h.gateway.stats.ack_slow).toBe(2);
    expect(h.logs.filter((l) => l.message === '「收到」超过 2 秒')).toHaveLength(2);
    h.gateway.watch.heartbeat();
    const beat = h.logs.find((l) => l.message === '网关心跳');
    expect(beat?.fields?.messages).toEqual({
      count: 3,
      ackAvgMs: 2_500,
      ackMaxMs: 2_500,
      lastAckMs: 2_500,
      ackSlow: 2,
      noAck: 1,
      cardSlow: 0,
    });
  });
});

describe('时限', () => {
  it('报警 5 分钟、通了要稳住 1 分钟、每 30 秒看一次、心跳 10 分钟（改之前先看 watch.ts 里写的理由）', () => {
    expect(WATCH_LIMITS).toEqual({
      alertAfterMs: 5 * MIN,
      recoverAfterMs: MIN,
      checkEveryMs: 30 * SEC,
      heartbeatMs: 10 * MIN,
    });
  });
});
