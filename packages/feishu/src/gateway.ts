// 网关：飞书收缩后（#2047 提需求 F1，方案第八节）不再收群聊、私聊的话，不写意图库，不发意图卡，没有机器人菜单；
// 提需求去驾驶舱。网关还管三件事：有人进群时说明并通知后端、每分钟向后端报飞书用量（也是后端认「网关还在」的心跳）、
// 自己看着自己（watch.ts：心跳、调不通后端报警）。
// 改这里之前必须知道：
// - 进群：白名单外的人进群，在群里说一句、让后端提醒。谁是创始人只看 FEISHU_FOUNDERS。
// - 飞书用量：每次已经打出去的端口调用记一笔（失败、超时、重试也算），按批报给后端。
//   同一批带同一个 reportId，回应丢了就原样重报，不加第二次。读不到用量只在心跳和报警里标出来，不停任何发送。
// - 旧卡上的按钮一律回一句「已停用」，不悄悄不理。
// - 收事件的回调一律立刻返回（SDK 按会话排队，回调慢了会挡住后面的人），活放到后台跑。

import {
  FEISHU_JOIN_GROUP_TEXT,
  FEISHU_JOIN_REASON,
  FEISHU_MONTHLY_CALL_LIMIT,
  feishuUsageLevel,
  feishuUsageSentence,
} from '@fleet-dao/shared';
import type { Backend, FeishuUsage } from './backend.ts';
import { ActionValueSchema } from './cards.ts';
import type { Founder } from './config.ts';
import type { Logger } from './log.ts';
import type { FeishuPort, InboundCardAction, InboundJoin, OutMessage, Sent } from './port.ts';
import { measureFeishuCall } from './usage-meter.ts';
import { Inflight, Lru, uuidFor } from './util.ts';
import { createWatch, type Watch, type WatchLimits } from './watch.ts';
import { beijingDay, clip } from './words.ts';

export interface Timing {
  /** 调后端一次（进群记录、用量上报）最多等多久。 */
  backendMs: number;
  /** 多久向后端报一次飞书用量。后端 5 分钟没收到就把 /healthz 的 feishu_gateway 报红（gateway-seen.ts）。 */
  usageEveryMs: number;
}

export const DEFAULT_TIMING: Timing = {
  backendMs: 5_000,
  usageEveryMs: 60_000,
};

export interface GatewayOptions {
  feishu: FeishuPort;
  backend: Backend;
  log: Logger;
  now?: () => number;
  founders: Founder[];
  teamChatId: string;
  testChatId?: string | null;
  publicUrl: string;
  timing?: Partial<Timing>;
  /** 网关自己看守的时限（watch.ts 的 WATCH_LIMITS）；测试调小。 */
  watch?: Partial<WatchLimits>;
}

export interface GatewayUsageStatus {
  /** ok 没到八成；over 到了；unreadable 这一轮没读出来。还没问过之前是 ok。 */
  level: 'ok' | 'over' | 'unreadable';
  /** ok 时是 null。其余是写在心跳和报警里的那一句。 */
  sentence: string | null;
  /** 后端这个月的累计。读不到是 null，不拿 0 冒充。还没问过是 0。 */
  calls: number | null;
  limit: number;
}

export interface Gateway {
  /** 有人进了群（im.chat.member.user.added_v1）。 */
  onJoin(evt: InboundJoin): void;
  onCardAction(evt: InboundCardAction): void;
  /** 开始定时向后端报用量，和网关自己的看守（心跳、调不通后端报警）。 */
  start(): void;
  /** 停止定时活，最多等 drainMs 让在途的活做完。 */
  stop(drainMs?: number): Promise<void>;
  /** 测试用：等手上的活都做完。 */
  idle(): Promise<void>;
  /** 把记着的调用次数报给后端，并按回的累计记档。测试直接调。 */
  reportUsage(): Promise<void>;
  readonly status: GatewayUsageStatus;
  readonly stats: Readonly<Record<string, number>>;
  readonly watch: Watch;
}

/** 一次端口调用记它实际打出去的次数（含失败、超时、重试）。事件本身不是调用，不进这里。 */
function metered(port: FeishuPort, onAttempts: (n: number) => void): FeishuPort {
  const count = <T>(fn: () => Promise<T>): Promise<T> => measureFeishuCall(fn, onAttempts);
  return {
    send: (to, message, opts) => count(() => port.send(to, message, opts)),
    reply: (messageId, message, opts) => count(() => port.reply(messageId, message, opts)),
    updateCard: (messageId, card) => count(() => port.updateCard(messageId, card)),
  };
}

export function createGateway(o: GatewayOptions): Gateway {
  const now = o.now ?? Date.now;
  const timing: Timing = { ...DEFAULT_TIMING, ...o.timing };
  const log = o.log;
  const founders = new Map(o.founders.map((f) => [f.openId, f]));
  const allowedGroups = new Set([o.teamChatId, ...(o.testChatId ? [o.testChatId] : [])]);
  const stats: Record<string, number> = {};
  const count = (key: string) => {
    stats[key] = (stats[key] ?? 0) + 1;
  };
  const inflight = new Inflight((err) => {
    count('unhandled');
    log.error('后台活出了没接住的错', {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  });
  const life = new AbortController();
  /** 还没问过后端之前是 ok：不拿「还没读」当成「可能超了」。 */
  const usageState: GatewayUsageStatus = {
    level: 'ok',
    sentence: null,
    calls: 0,
    limit: FEISHU_MONTHLY_CALL_LIMIT,
  };
  let pendingCalls = 0;
  /** 已经取出、还没拿到后端确认的那一批。回应丢了就原样重报，不并进后来新打的。 */
  let usageBatch: { reportId: string; calls: number; at: string } | null = null;
  let reporting: Promise<void> | null = null;

  function applySnapshot(s: FeishuUsage) {
    const level = feishuUsageLevel(s);
    usageState.level = level;
    usageState.limit = s.limit > 0 ? s.limit : FEISHU_MONTHLY_CALL_LIMIT;
    usageState.calls = level === 'unreadable' ? null : s.calls;
    usageState.sentence =
      level === 'ok' ? null : feishuUsageSentence(level, { calls: s.calls, limit: usageState.limit });
  }

  function applyUnreadable() {
    applySnapshot({ month: '1970-01', calls: 0, limit: FEISHU_MONTHLY_CALL_LIMIT, readable: false });
  }

  function reportUsage(): Promise<void> {
    if (reporting) return reporting;
    // 清标记要比的是包过 finally 的那个 promise。写在初始化表达式里直接点它，tsc 会判「还没赋值就用了」。
    const slot: { current: Promise<void> | null } = { current: null };
    const run = (async () => {
      try {
        for (;;) {
          if (!usageBatch) {
            usageBatch = {
              reportId: crypto.randomUUID(),
              calls: pendingCalls,
              at: new Date(now()).toISOString(),
            };
            pendingCalls = 0;
          }
          const batch = usageBatch;
          const snap = await o.backend.reportUsage(
            { reportId: batch.reportId, calls: batch.calls, at: batch.at },
            { timeoutMs: timing.backendMs, signal: life.signal },
          );
          if (usageBatch === batch) usageBatch = null;
          applySnapshot(snap);
          watch.ok('usage');
          // 这一批在路上时又打出去的，接着报，不等下一次。
          if (pendingCalls === 0) break;
        }
      } catch (err) {
        // 停机时自己撤回的请求：这一批留着不用管，进程就要退了
        if (life.signal.aborted) return;
        applyUnreadable();
        watch.fail('usage', err);
        log.error('飞书用量没报上，按读不到处理', { error: clip(String(err), 300) });
      }
    })().finally(() => {
      if (reporting === slot.current) reporting = null;
    });
    slot.current = run;
    reporting = run;
    return run;
  }

  const feishu = metered(o.feishu, (n) => {
    pendingCalls += n;
  });
  const watch = createWatch({
    feishu,
    log,
    now,
    teamChatId: o.teamChatId,
    publicUrl: o.publicUrl,
    limits: o.watch,
    feishuUsage: () => ({ level: usageState.level, sentence: usageState.sentence }),
  });
  const seenJoins = new Lru<string, true>(500);
  /** 「已停用」每张旧卡每天只说一次。 */
  const toldDisabled = new Lru<string, string>(1000);

  // —— 往飞书发东西：出错记日志、计数，不往上抛（回调里没人接）——

  async function reply(messageId: string, message: OutMessage, key: string): Promise<Sent | null> {
    try {
      return await feishu.reply(messageId, message, { uuid: uuidFor('reply', messageId, key) });
    } catch (err) {
      count('feishu_failed');
      log.error('回复没发出去', { messageId, key, error: String(err) });
      return null;
    }
  }

  // —— 旧卡上的按钮：都停用了，回一句说清楚 ——

  async function buttonDisabled(evt: InboundCardAction): Promise<void> {
    const parsed = ActionValueSchema.safeParse(evt.value);
    // 记下点的是哪种旧按钮（不记回传值里的别的东西）：看得出还有谁在点什么
    const action = parsed.success ? parsed.data.a : 'unknown';
    count('disabled_button');
    log.info('有人点了旧卡上的按钮：已停用', { messageId: evt.messageId, action });
    const day = beijingDay(now());
    if (toldDisabled.get(`card:${evt.messageId}`) === day) return;
    toldDisabled.set(`card:${evt.messageId}`, day);
    await reply(
      evt.messageId,
      { text: `这张卡上的按钮已经停用。要拍板、要回答、提需求，请打开驾驶舱：${o.publicUrl}` },
      `disabled:${day}`,
    );
  }

  let watchTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let usageTimer: NodeJS.Timeout | undefined;

  return {
    onJoin(evt) {
      if (!allowedGroups.has(evt.chatId)) {
        count('join_ignored');
        return;
      }
      if (evt.eventId) {
        if (seenJoins.has(evt.eventId)) {
          count('join_duplicate');
          return;
        }
        seenJoins.set(evt.eventId, true);
      }
      inflight.track(announceJoin(evt));
    },

    onCardAction(evt) {
      if (!founders.has(evt.operatorId)) {
        count('stranger');
        return;
      }
      inflight.track(buttonDisabled(evt));
    },

    start() {
      watchTimer = setInterval(() => void watch.check(), watch.limits.checkEveryMs);
      heartbeatTimer = setInterval(() => watch.heartbeat(), watch.limits.heartbeatMs);
      // 起来就报一次（后端马上知道网关来了），之后每隔 usageEveryMs 报一次
      void reportUsage();
      usageTimer = setInterval(() => void reportUsage(), timing.usageEveryMs);
    },

    async stop(drainMs = 20_000) {
      clearInterval(watchTimer);
      clearInterval(heartbeatTimer);
      clearInterval(usageTimer);
      life.abort();
      await watch.idle();
      await reporting;
      const left = await inflight.drain(drainMs);
      if (left > 0) log.warn('停机时还有活没做完', { left });
      // 停机前把这一段的心跳也写上：重启时不丢最后几分钟的读数
      if (watchTimer) watch.heartbeat();
    },

    idle: () => inflight.idle(),
    reportUsage: () => reportUsage(),
    get status() {
      return {
        level: usageState.level,
        sentence: usageState.sentence,
        calls: usageState.calls,
        limit: usageState.limit,
      };
    },
    stats,
    watch,
  };

  /** 白名单外的人进来：群里说一句，同时把末 4 位送给后端。说明发不出去，记录照样送。 */
  async function announceJoin(evt: InboundJoin): Promise<void> {
    const short = evt.openIds.filter((id) => id.length < 4);
    if (short.length > 0) {
      log.error('进群的 open_id 不到 4 位，这几个不报', { chatId: evt.chatId, count: short.length });
    }
    const outsiders = evt.openIds.filter((id) => id.length >= 4 && !founders.has(id));
    if (outsiders.length === 0) {
      count('join_founders');
      return;
    }
    count('join_outsider');
    const tails = outsiders.map((id) => id.slice(-4));
    try {
      await feishu.send(
        { chatId: evt.chatId },
        { text: FEISHU_JOIN_GROUP_TEXT },
        { uuid: uuidFor('join-notice', evt.eventId ?? `${evt.chatId}:${evt.at}:${tails.join(',')}`) },
      );
    } catch (err) {
      count('join_notice_failed');
      log.error('进群说明没发出去，驾驶舱提醒照样报', {
        chatId: evt.chatId,
        error: clip(String(err), 300),
      });
    }
    try {
      await o.backend.recordJoin(
        {
          chatId: evt.chatId,
          openIdTails: tails,
          at: new Date(evt.at).toISOString(),
          reason: FEISHU_JOIN_REASON,
        },
        { timeoutMs: timing.backendMs },
      );
    } catch (err) {
      count('join_record_failed');
      log.error('进群记录没送到后端', { chatId: evt.chatId, error: clip(String(err), 300) });
    }
  }
}
