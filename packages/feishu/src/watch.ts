// 网关自己看着自己：推送、盘面快照这两条定时活每一轮走没走通、花了多久，收到消息多久回上「收到」。三个出口——
// - 心跳：每 10 分钟一行「网关心跳」（推了几条、取了几次快照、平均和最慢多久、原话存下几句没存成几句、收到的耗时），
//   走通了也写：日志安静了，看最近一行心跳就分得清是闲着还是挂了。
// - 报警：两条定时活有一条 5 分钟没走通，用网关自己的飞书连接往团队群发一张报警卡——不经过后端：后端连不上时它写不了提醒。
//   同一次故障只报一次；在免打扰时段里的等时段过了再报，时段里就通了的不报。
// - 通了：报过警的，全部连续走通 1 分钟后在那张卡下面回一句、卡改灰。时好时坏的不算通，不来回报。
// 改这里之前必须知道：
// - 状态只在进程里（香港上网关不写磁盘）：网关重启后从起来那一刻重新算，重启前报过的那次不再接着管。
// - 网关整个没了、自己报不了的时候看后端 /healthz 的 feishu_gateway（packages/api/src/gateway-seen.ts），两边同一个 5 分钟。
// - 报警卡只在这里发（test/static.test.ts 核对）；推送的三类照旧只走 outbox.ts。
import { BackendError, describe, type OutboxAck } from './backend.ts';
import { LINK_WORDS, type LinkAlert, linkAlertCard, type RenderContext } from './cards.ts';
import { type QuietHours, quietUntil } from './gate.ts';
import type { Logger } from './log.ts';
import { type FeishuPort, feishuErrorKind } from './port.ts';
import { nextNonce, uuidFor } from './util.ts';
import { clip, duration, when } from './words.ts';

/** 三条定时活：推送（旧的待推送）、盘面快照、意图卡（#553 第 4 条；旧的两条退役后只剩它）。 */
export type LoopName = 'outbox' | 'board' | 'intents';
export type PushStatus = OutboxAck['result']['status'];

export const LOOPS: readonly LoopName[] = ['outbox', 'board', 'intents'];

export interface WatchLimits {
  /**
   * 这么久没走通就报警。法国后端发版重启一般一分钟内回来（release.sh 起稳只看 10 秒），隧道抖一下几十秒，
   * 都不该叫人；5 分钟还没通就不是这些了。和 Prometheus 告警规则文档里「连不上超过 5 分钟」（InstanceDown, for: 5m）同一个量级。
   */
  alertAfterMs: number;
  /** 报过警的，全部连续走通这么久（中间一次失败都没有）才算通了：时好时坏的不来回报。 */
  recoverAfterMs: number;
  /** 多久看一次要不要报。 */
  checkEveryMs: number;
  /** 多久写一行心跳。 */
  heartbeatMs: number;
}

export const WATCH_LIMITS: WatchLimits = {
  alertAfterMs: 5 * 60_000,
  recoverAfterMs: 60_000,
  checkEveryMs: 30_000,
  heartbeatMs: 10 * 60_000,
};

export interface WatchDeps {
  feishu: FeishuPort;
  log: Logger;
  now: () => number;
  teamChatId: string;
  publicUrl: string;
  /**
   * 最近一次从后端拿到的免打扰时段（null = 没设）；undefined = 网关起来后还没拿到过——这时不按免打扰拦：连不上后端时宁可报。
   */
  quietHours: () => QuietHours | null | undefined;
  /** 盘面快照多久取一次：盘面这条的时限至少是它的两倍（配得很长时不误报）。 */
  boardRefreshMs: number;
  /** 「收到」超过这么久算慢，计一次（gateway.ts 的 TARGET_ACK_MS，design 15.4：2 秒内先回「收到」）。 */
  ackTargetMs: number;
  limits?: Partial<WatchLimits> | undefined;
}

export interface Watch {
  /** 定时活走通了一轮（推送取到一批并回执完、取到一次盘面快照）；ms 是这一轮花了多久。 */
  ok(loop: LoopName, ms: number): void;
  /** 定时活这一轮没走通。 */
  fail(loop: LoopName, err: unknown): void;
  /** 推送的一件处理完：结果，和经飞书发出去（或改卡）花了多久。 */
  pushed(status: PushStatus, ms: number): void;
  /** 一条消息从收到到回上「收到」花了多久；null = 表情和那句「收到」都没回上。 */
  acked(ms: number | null): void;
  /** 收原话的一句处理完：后端存下了没有。 */
  intake(stored: boolean): void;
  /** 确认卡超过 10 秒，计一次。 */
  cardSlow(): void;
  /** 看一次要不要报警、报「通了」（定时器调；测试直接调）。同一时刻只跑一个。 */
  check(): Promise<void>;
  /** 写一行心跳，窗口里的计数清零（定时器调；停机时也写一行）。 */
  heartbeat(): void;
  /** 等在途的 check 做完（停机用）。 */
  idle(): Promise<void>;
  readonly limits: WatchLimits;
}

interface LoopState {
  lastOkAt: number | null;
  /** 最近一次失败之后第一次走通的时刻；最近一轮没走通、或还没走通过，是 null。 */
  upSince: number | null;
  lastFail: { at: number; reason: string } | null;
}

interface Incident {
  /** 从什么时候起没走通：没走通的那几条最后一次走通的时刻，都没走通过就是网关起来的时刻。 */
  since: number;
  /** 发出去的报警卡（按它画卡、在它下面回「通了」）；还没发出去是 null。 */
  alert: { messageId: string; card: LinkAlert } | null;
  /** 在免打扰里等着报，已经记过一行日志。 */
  quietLogged: boolean;
}

function freshWindow(at: number) {
  return {
    startedAt: at,
    push: {
      rounds: 0,
      failedRounds: 0,
      sent: 0,
      updated: 0,
      deferred: 0,
      dropped: 0,
      failed: 0,
      /** 经过飞书的几件（发了、改了、没发成）：平均、最慢只算它们。 */
      timed: 0,
      totalMs: 0,
      maxMs: 0,
    },
    board: { ok: 0, failed: 0, totalMs: 0, maxMs: 0 },
    intents: { ok: 0, failed: 0 },
    intake: { stored: 0, failed: 0 },
    messages: {
      count: 0,
      noAck: 0,
      slow: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: null as number | null,
      cardSlow: 0,
    },
    lastError: null as { loop: LoopName; at: number; reason: string } | null,
  };
}

export function createWatch(deps: WatchDeps): Watch {
  const limits: WatchLimits = { ...WATCH_LIMITS, ...deps.limits };
  const log = deps.log;
  const startedAt = deps.now();
  const loops: Record<LoopName, LoopState> = {
    outbox: { lastOkAt: null, upSince: null, lastFail: null },
    board: { lastOkAt: null, upSince: null, lastFail: null },
    intents: { lastOkAt: null, upSince: null, lastFail: null },
  };
  let win = freshWindow(startedAt);
  let incident: Incident | null = null;
  let checking: Promise<void> | null = null;
  let quietBroken = false;

  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const avg = (total: number, n: number) => (n > 0 ? Math.round(total / n) : null);
  const ctx = (): RenderContext => ({
    publicUrl: deps.publicUrl,
    now: deps.now(),
    nonce: nextNonce(deps.now()),
  });

  function limitOf(loop: LoopName): number {
    return loop === 'board' ? Math.max(limits.alertAfterMs, 2 * deps.boardRefreshMs) : limits.alertAfterMs;
  }

  /** 这会儿超过时限没走通的几条。 */
  function down(t: number): LoopName[] {
    return LOOPS.filter((l) => t - (loops[l].lastOkAt ?? startedAt) >= limitOf(l));
  }

  /** 全部连续走通了 recoverAfterMs 以上：返回最后一条恢复走通的时刻；还没稳住返回 null。 */
  function steadySince(t: number): number | null {
    let latest = 0;
    for (const l of LOOPS) {
      const up = loops[l].upSince;
      if (up === null || t - up < limits.recoverAfterMs) return null;
      latest = Math.max(latest, up);
    }
    return latest;
  }

  /** 在免打扰里就返回时段结束的时刻。时段格式认不出（后端本该挡住）：记一次错误，按不在免打扰算——报警宁可报。 */
  function quietUntilAt(t: number): number | null {
    const q = deps.quietHours();
    if (!q) return null;
    try {
      return quietUntil(q, t);
    } catch (err) {
      if (!quietBroken) log.error('免打扰时段认不出，报警照发', { error: String(err) });
      quietBroken = true;
      return null;
    }
  }

  /** 报警卡上写的：这会儿没走通的那几条（「通了」时照着原卡改灰，不重算）。 */
  function alertOf(inc: Incident, t: number): LinkAlert {
    return {
      since: inc.since,
      at: t,
      loops: down(t).map((name) => ({
        name,
        lastOkAt: loops[name].lastOkAt,
        lastFail: loops[name].lastFail,
      })),
    };
  }

  async function sendAlert(inc: Incident, t: number): Promise<void> {
    const card = alertOf(inc, t);
    try {
      const sent = await deps.feishu.send(
        { chatId: deps.teamChatId },
        { card: linkAlertCard(card, ctx()) },
        // 同一次故障同一个 uuid：没收到回应重发时，飞书那边一小时内只发一条
        { uuid: uuidFor('link-down', deps.teamChatId, inc.since) },
      );
      inc.alert = { messageId: sent.messageId, card };
      log.info('已往团队群报警：调不通后端', { messageId: sent.messageId, since: iso(inc.since) });
    } catch (err) {
      log.error('调不通后端的报警没发出去，下一轮再试', { error: String(err) });
    }
  }

  /** 在报警那条下面说一声通了、卡改灰。说成了返回 true（这次故障了结）；没说成下一轮再试。 */
  async function sayBack(inc: Incident, alert: NonNullable<Incident['alert']>, backAt: number, t: number) {
    const words = alert.card.loops.map((l) => LINK_WORDS[l.name]).join('、');
    try {
      await deps.feishu.reply(
        alert.messageId,
        {
          text:
            `通了：${words} ${when(backAt, t)} 起又走通了，断了 ${duration(backAt - inc.since)}。` +
            '断的时候要推的事后端会接着推；那段时间发给我、回了「没记成」的话请重发。',
        },
        { uuid: uuidFor('link-up', alert.messageId) },
      );
    } catch (err) {
      log.error('「通了」没发出去，下一轮再试', { error: String(err) });
      return false;
    }
    try {
      await deps.feishu.updateCard(alert.messageId, linkAlertCard({ ...alert.card, at: t, backAt }, ctx()));
    } catch (err) {
      // 卡没改灰不影响「通了」已经说了（超 14 天的卡飞书不让改）
      log.warn('报警卡没改成「已通」', { kind: feishuErrorKind(err), error: String(err) });
    }
    log.info('后端又调通了，已在报警下面说了', { since: iso(inc.since), backAt: iso(backAt) });
    return true;
  }

  async function runCheck(): Promise<void> {
    const t = deps.now();
    const stuck = down(t);
    if (!incident) {
      if (stuck.length === 0) return;
      incident = {
        since: Math.min(...stuck.map((l) => loops[l].lastOkAt ?? startedAt)),
        alert: null,
        quietLogged: false,
      };
      log.error('网关调不通后端超过时限', {
        since: iso(incident.since),
        loops: stuck,
        lastErrors: stuck.map((l) => ({
          loop: l,
          at: iso(loops[l].lastFail?.at ?? null),
          reason: loops[l].lastFail?.reason ?? null,
        })),
      });
    }
    const inc = incident;
    const quiet = quietUntilAt(t);
    if (stuck.length > 0) {
      if (inc.alert) return;
      if (quiet !== null) {
        if (!inc.quietLogged) log.info('在免打扰时段：调不通后端的报警等时段过了再发', { until: iso(quiet) });
        inc.quietLogged = true;
        return;
      }
      await sendAlert(inc, t);
      return;
    }
    const backAt = steadySince(t);
    if (backAt === null) return;
    if (!inc.alert) {
      // 免打扰里、或报警一直没发出去，就已经通了：不补报
      log.info('后端又调通了（没报过警，不补报）', { since: iso(inc.since), backAt: iso(backAt) });
      incident = null;
      return;
    }
    if (quiet !== null) return;
    if (await sayBack(inc, inc.alert, backAt, t)) incident = null;
  }

  return {
    limits,

    ok(loop, ms) {
      const t = deps.now();
      const s = loops[loop];
      s.lastOkAt = t;
      s.upSince ??= t;
      if (loop === 'outbox') win.push.rounds += 1;
      else if (loop === 'intents') win.intents.ok += 1;
      else {
        win.board.ok += 1;
        win.board.totalMs += ms;
        win.board.maxMs = Math.max(win.board.maxMs, ms);
      }
    },

    fail(loop, err) {
      // 停机时自己撤回的请求不算没走通
      if (err instanceof BackendError && err.kind === 'aborted') return;
      const t = deps.now();
      const s = loops[loop];
      const reason = reasonOf(err);
      s.upSince = null;
      s.lastFail = { at: t, reason };
      win.lastError = { loop, at: t, reason };
      if (loop === 'outbox') win.push.failedRounds += 1;
      else if (loop === 'intents') win.intents.failed += 1;
      else win.board.failed += 1;
    },

    pushed(status, ms) {
      const p = win.push;
      p[status] += 1;
      if (status === 'sent' || status === 'updated' || status === 'failed') {
        p.timed += 1;
        p.totalMs += ms;
        p.maxMs = Math.max(p.maxMs, ms);
      }
    },

    acked(ms) {
      const m = win.messages;
      m.count += 1;
      if (ms === null) {
        m.noAck += 1;
        return;
      }
      m.totalMs += ms;
      m.maxMs = Math.max(m.maxMs, ms);
      m.lastMs = ms;
      if (ms > deps.ackTargetMs) m.slow += 1;
    },

    intake(stored) {
      if (stored) win.intake.stored += 1;
      else win.intake.failed += 1;
    },

    cardSlow() {
      win.messages.cardSlow += 1;
    },

    check() {
      checking ??= runCheck()
        .catch((err) => log.error('看要不要报警时出错', { error: String(err) }))
        .finally(() => {
          checking = null;
        });
      return checking;
    },

    heartbeat() {
      const t = deps.now();
      const w = win;
      const acked = w.messages.count - w.messages.noAck;
      // 现算：不等 check 开了故障才说 down
      const link = down(t).length > 0 ? 'down' : incident ? 'recovering' : 'ok';
      (link === 'ok' ? log.info : log.warn)('网关心跳', {
        minutes: Math.round((t - w.startedAt) / 60_000),
        link,
        ...(incident ? { downSince: iso(incident.since), alerted: incident.alert !== null } : {}),
        push: {
          rounds: w.push.rounds,
          failedRounds: w.push.failedRounds,
          pushed: w.push.sent + w.push.updated,
          sent: w.push.sent,
          updated: w.push.updated,
          deferred: w.push.deferred,
          dropped: w.push.dropped,
          failed: w.push.failed,
          avgMs: avg(w.push.totalMs, w.push.timed),
          maxMs: w.push.timed > 0 ? w.push.maxMs : null,
          lastOkAt: iso(loops.outbox.lastOkAt),
        },
        board: {
          ok: w.board.ok,
          failed: w.board.failed,
          avgMs: avg(w.board.totalMs, w.board.ok),
          maxMs: w.board.ok > 0 ? w.board.maxMs : null,
          lastOkAt: iso(loops.board.lastOkAt),
        },
        intents: { ok: w.intents.ok, failed: w.intents.failed, lastOkAt: iso(loops.intents.lastOkAt) },
        intake: { stored: w.intake.stored, failed: w.intake.failed },
        messages: {
          count: w.messages.count,
          ackAvgMs: avg(w.messages.totalMs, acked),
          ackMaxMs: acked > 0 ? w.messages.maxMs : null,
          lastAckMs: w.messages.lastMs,
          ackSlow: w.messages.slow,
          noAck: w.messages.noAck,
          cardSlow: w.messages.cardSlow,
        },
        ...(w.lastError
          ? { lastError: { loop: w.lastError.loop, at: iso(w.lastError.at), reason: w.lastError.reason } }
          : {}),
      });
      win = freshWindow(t);
    },

    idle: async () => {
      await checking;
    },
  };
}

/**
 * 一轮没走通的原因，给人看的一句：不带地址。连不上时带上系统给的错误码（ECONNREFUSED 这类），后端出错、
 * 拒收时带上 HTTP 状态；推送一轮卡住（OutboxStall）的，接上卡住它的那个后端错误。
 */
export function reasonOf(err: unknown): string {
  if (err instanceof BackendError) {
    const extra =
      err.kind === 'unreachable'
        ? errorCode(err)
        : err.kind === 'server' || (err.kind === 'rejected' && err.said)
          ? `HTTP ${err.status}`
          : undefined;
    return clip(`${describe(err)}${extra ? `（${extra}）` : ''}`, 120);
  }
  if (err instanceof Error && err.name === 'OutboxStall') {
    return clip(
      err.cause instanceof BackendError ? `${err.message}：${reasonOf(err.cause)}` : err.message,
      120,
    );
  }
  return '网关这边出错了（已记日志）';
}

/** 顺着 cause 往下找系统错误码（fetch 抛的 TypeError 的 cause 才带 code）。只认像错误码的，免得把地址带出来。 */
function errorCode(err: unknown): string | undefined {
  let at: unknown = err;
  for (let depth = 0; depth < 4 && at; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
}
