// 数据变化的来源：Postgres 的 LISTEN fleet_changes（频道名、会发通知的表、载荷形状都在 @fleet-dao/shared 的 realtime.ts），
// 在进程里分发给所有订阅者（SSE、等回答的 fleet ask）。整个进程只占一条 LISTEN 连接，不是每个浏览器一条。
import type { PgListen } from '@fleet-dao/db';
import { ChangeEventSchema, FLEET_CHANGES_CHANNEL } from '@fleet-dao/shared';
import { PublicHealthError } from './health.ts';
import type { ChangeFeed, FeedEvent, Logger } from './ports.ts';
import { randomToken } from './tokens.ts';

export interface ChangeHub extends ChangeFeed {
  publish(event: FeedEvent): void;
}

export function createChangeHub(log?: Logger): ChangeHub {
  const listeners = new Set<(event: FeedEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          log?.error('变化订阅者出错', { error: String(err) });
        }
      }
    },
  };
}

/** 载荷不对（不是 JSON、表不在 REALTIME_TABLES 里、缺 id）就返回 null。 */
export function parseChangePayload(raw: string): FeedEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ChangeEventSchema.safeParse(json);
  return parsed.success ? { type: 'change', table: parsed.data.table, id: parsed.data.id } : null;
}

/** 发一条 NOTIFY（走普通查询连接，不是 LISTEN 那条）。生产是 postgres.js 的 sql.notify。 */
export type PgNotify = (channel: string, payload: string) => Promise<void>;

/**
 * 探活频道：本进程自己发、自己收。postgres.js 所有频道共用 LISTEN 那一条专用连接，收得到这里的 ping，
 * 就说明那条连接活着、在收通知。不用 fleet_changes 发 ping：那个频道的载荷是 shared 定的 ChangeEvent，别的读者不该看到 ping。
 */
export const PROBE_CHANNEL = 'fleet_api_probe';

export interface PgChangeFeed extends ChangeFeed {
  /** healthy = LISTEN 接上了、最近一次探活收回了自己发的 ping；不好时带原因（只进日志和本机，不对外）。 */
  status(): { healthy: boolean; lastError?: string | undefined };
  /** 探一次：发一条 ping，timeoutMs 内收回来算好；发不出去或收不回来就报红，并记下「这段时间可能漏了通知」。 */
  probe(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

const PROBE_EVERY_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
/**
 * 一轮恢复只发一个 resync：postgres.js 断线后每次重连失败都给监听多排一条 LISTEN，恢复时这些 LISTEN 在同一条连接上
 * 接连执行、每条调一次 onListen（停 20 秒 4 条、停 120 秒 8 条，审查看库日志证实）。最后一条回来后再等这么久才发，
 * 中间再来的都并进这一个。
 */
const RESYNC_SETTLE_MS = 1_000;

/**
 * LISTEN fleet_changes，再定时探活。
 * - 每个频道只调一次 listen：postgres.js 的 listen 失败后监听仍挂在它身上、断线后它自己重连（接上时调 onListen）。
 *   在外面再调一次就多挂一个监听——一条通知推好几遍（审查在真库上实测过）。所以失败了只记状态。
 * - 断线 postgres.js 不告诉我们，所以靠定时发 ping 看收不收得回来。收不回来就报红，并记下「可能漏了」；
 *   恢复时（重连后的 onListen、或 ping 又收得回来）广播一个 resync：漏收不能装成没变化，订阅方要全量重拉。
 */
export function startPgChangeFeed(
  pg: { listen: PgListen; notify: PgNotify },
  log: Logger,
  options: { probeEveryMs?: number; probeTimeoutMs?: number; resyncSettleMs?: number } = {},
): PgChangeFeed {
  const hub = createChangeHub(log);
  const probeEveryMs = options.probeEveryMs ?? PROBE_EVERY_MS;
  const defaultTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const resyncSettleMs = options.resyncSettleMs ?? RESYNC_SETTLE_MS;
  /** ping 带上本进程这一轮的记号：新旧进程交接时，别把对方的 ping 当成自己的。 */
  const boot = randomToken(6);
  const handles: { unlisten: () => Promise<void> }[] = [];
  const pending = new Map<number, () => void>();
  let listenedOnce = false;
  let missed = false;
  let healthy = false;
  let lastError: string | undefined = 'LISTEN fleet_changes 还没接上';
  let stopped = false;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;

  const down = (reason: string) => {
    if (healthy) log.warn('实时推送断了；恢复时会通知订阅方全量重拉', { reason });
    healthy = false;
    missed = true;
    lastError = reason;
    // 恢复到一半又断了：这一轮的 resync 先不发，下一轮恢复时一起发。
    clearTimeout(resyncTimer);
    resyncTimer = undefined;
  };
  /** 又在收通知了。之前可能漏过就排一个 resync；同一轮恢复里接着来的都并进去，最后一次之后 resyncSettleMs 才发。 */
  const recovered = () => {
    healthy = true;
    lastError = undefined;
    if (!missed) return;
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      resyncTimer = undefined;
      missed = false;
      log.warn('实时推送恢复了，通知订阅方全量重拉（断开期间的变化可能漏了）');
      hub.publish({ type: 'resync' });
    }, resyncSettleMs);
    resyncTimer.unref?.();
  };

  const onNotify = (payload: string) => {
    const event = parseChangePayload(payload);
    if (event) hub.publish(event);
    else log.warn('看不懂的 fleet_changes 载荷，丢弃', { payload: payload.slice(0, 200) });
  };
  const onListen = () => {
    // 第一次之后每一次都是重连：断线期间的通知已经丢了。
    if (listenedOnce) missed = true;
    listenedOnce = true;
    recovered();
  };
  const onPing = (payload: string) => {
    const sep = payload.lastIndexOf(':');
    if (payload.slice(0, sep) !== boot) return;
    pending.get(Number(payload.slice(sep + 1)))?.();
  };

  const listenOnce = async (channel: string, onPayload: (payload: string) => void, onUp: () => void) => {
    try {
      const handle = await pg.listen(channel, onPayload, onUp);
      if (stopped) await handle.unlisten();
      else handles.push(handle);
    } catch (err) {
      const reason = `LISTEN ${channel} 没接上：${err instanceof Error ? err.message : String(err)}`;
      log.error('LISTEN 没接上；连接库会自己重连，接上后恢复', { channel, error: reason });
      down(reason);
    }
  };
  void Promise.all([
    listenOnce(FLEET_CHANGES_CHANNEL, onNotify, onListen),
    listenOnce(PROBE_CHANNEL, onPing, () => {}),
  ]);

  async function probe(timeoutMs = defaultTimeoutMs): Promise<void> {
    if (stopped) throw new PublicHealthError('not_listening', '实时推送已经停了');
    const n = ++seq;
    const received = new Promise<void>((resolve) => pending.set(n, resolve));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      try {
        await pg.notify(PROBE_CHANNEL, `${boot}:${n}`);
      } catch (err) {
        down(`探活 ping 发不出去：${err instanceof Error ? err.message : String(err)}`);
        throw new PublicHealthError('not_listening', '实时推送探活失败：连不上库');
      }
      const late = new Promise<'late'>((resolve) => {
        deadline = setTimeout(() => resolve('late'), timeoutMs);
      });
      if ((await Promise.race([received, late])) === 'late') {
        down(`自己发的探活 ping ${timeoutMs} 毫秒内没收回来`);
        throw new PublicHealthError('not_listening', '实时推送没在收数据库通知（探活 ping 收不回来）');
      }
    } finally {
      clearTimeout(deadline);
      pending.delete(n);
    }
    if (!listenedOnce) {
      down('LISTEN fleet_changes 还没接上');
      throw new PublicHealthError('not_listening', '实时推送还没接上数据库（LISTEN fleet_changes）');
    }
    recovered();
  }

  const loop = () => {
    timer = setTimeout(() => {
      probe()
        .catch(() => {}) // 状态已经记在 down() 里
        .finally(() => {
          if (!stopped) loop();
        });
    }, probeEveryMs);
    timer.unref?.();
  };
  loop();

  return {
    subscribe: hub.subscribe,
    status: () => ({ healthy, lastError }),
    probe,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(resyncTimer);
      healthy = false;
      lastError = '已停止';
      await Promise.all(handles.splice(0).map((h) => h.unlisten()));
    },
  };
}

/** fleet ask 阻塞等回答：asks 表有变化（答上了）或本进程里有人回答时叫醒等的人，醒了自己回库查。 */
export interface AskWaiters {
  wake(askId: string): void;
  /** 被叫醒、到时间或请求中止，三者先到先返回。 */
  sleep(askId: string, ms: number, signal?: AbortSignal): Promise<void>;
}

export function createAskWaiters(changes: ChangeFeed): AskWaiters {
  const waiting = new Map<string, Set<() => void>>();
  const wake = (askId: string) => {
    for (const fn of [...(waiting.get(askId) ?? [])]) fn();
  };
  changes.subscribe((event) => {
    if (event.type === 'resync') for (const id of [...waiting.keys()]) wake(id);
    else if (event.table === 'asks') wake(event.id);
  });
  return {
    wake,
    sleep(askId, ms, signal) {
      return new Promise<void>((resolve) => {
        const set = waiting.get(askId) ?? new Set<() => void>();
        waiting.set(askId, set);
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          set.delete(finish);
          if (set.size === 0) waiting.delete(askId);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        set.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    },
  };
}
