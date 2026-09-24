// Mirasim 中转账号：问本机 mirasim-server 一句 getRelay（桌面端显示额度用的就是它），零次上游调用、不花额度。
// 一份账号额度被所有走中转的路由共扣（5h、7d），另有只扣某一族模型的窗口（7d_claude、7d_fable…），集合不固定。
import type { Reader, ReaderContext, WebSocketLike } from '../context.ts';
import type { MirasimRelayConfig, QuotaReading } from '../types.ts';
import { QuotaReadError } from '../types.ts';
import { expandHome, isRecord, num, pruned, redact, toIso } from '../util.ts';
import { classifyLabel, normalizeStatus } from '../windows.ts';

const SOURCE = 'mirasim-relay';
export const DEFAULT_MIRASIM_PORT = 4316;
const OPEN_TIMEOUT_MS = 8_000;

/**
 * 一个窗口的数：优先用点数（used / budget）；点数缺了、百分比还在，就按「已用 + 剩余」认刻度
 * （加起来是 100 就是百分数，是 1 就是比例，都不是就不认——不把 0.9% 画成 90%）。
 */
function windowNumbers(
  w: Record<string, unknown>,
): { used: number; limit: number; utilization: number; unit: QuotaReading['unit'] } | undefined {
  const used = num(w.used);
  const budget = num(w.budget);
  if (used !== undefined && budget !== undefined && budget > 0) {
    return { used, limit: budget, utilization: used / budget, unit: 'points' };
  }
  const up = num(w.usedPercent);
  const rp = num(w.remainingPercent);
  if (up === undefined || rp === undefined) return undefined;
  const scale = Math.abs(up + rp - 100) < 0.5 ? 100 : Math.abs(up + rp - 1) < 0.005 ? 1 : undefined;
  if (scale === undefined) return undefined;
  return { used: scale === 100 ? up : up * 100, limit: 100, utilization: up / scale, unit: 'percent' };
}

/**
 * getRelay 回帧 → 窗口读数。
 * - usage.ok 不为真：上游说没读成，报错（带上游给的原因），不填默认窗口；
 * - windows 为空而 ok 为真：零个窗口，正常返回；
 * - 单个窗口缺数：有状态字的只留状态字，什么都没有的不收；都写进 notes。收到了却一格都没收下 → bad_response。
 * 上限（budget）每次都从这一帧取，不沿用旧值——官方会整体改档。
 */
export function readingsFromRelayFrame(
  frame: unknown,
  ctx: { poolId: string; fetchedAt: string },
): { windows: QuotaReading[]; notes: string[] } {
  if (!isRecord(frame)) throw new QuotaReadError('bad_response', '没收到 relay 帧');
  if (frame.type === 'error') {
    throw new QuotaReadError(
      'upstream',
      `mirasim-server 拒了 getRelay：${redact(String(frame.message ?? '没给原因'))}`,
    );
  }
  const relay = frame.type === 'relay' ? frame.relay : undefined;
  if (!isRecord(relay))
    throw new QuotaReadError('bad_response', `不是 relay 帧（type=${String(frame.type)}）`);
  const usage = relay.usage;
  if (!isRecord(usage)) throw new QuotaReadError('bad_response', 'relay 帧里没有 usage');
  if (usage.ok !== true) {
    throw new QuotaReadError(
      'upstream',
      `中转额度没读成（status=${String(usage.status ?? '空')}，error=${redact(String(usage.error ?? '空'))}）`,
    );
  }
  if (!Array.isArray(usage.windows)) throw new QuotaReadError('bad_response', 'usage.windows 不是数组');

  const capturedAt = toIso(usage.capturedAt);
  const readAt = capturedAt ?? ctx.fetchedAt;
  const windows: QuotaReading[] = [];
  const notes: string[] = [];
  for (const [i, w] of usage.windows.entries()) {
    const label = isRecord(w)
      ? (typeof w.label === 'string' && w.label) || (typeof w.name === 'string' && w.name)
      : '';
    if (!isRecord(w) || !label) {
      notes.push(`第 ${i + 1} 个窗口没有名字，没收`);
      continue;
    }
    const numbers = windowNumbers(w);
    const status = normalizeStatus(w.status);
    if (!numbers && !status.statusRaw) {
      notes.push(`窗口 ${label} 既没有已用 / 上限，也没有状态字，没收`);
      continue;
    }
    // 缺数字但带着状态字（比如 limit_reached）的窗口照收：丢了它，用满的窗口就从调度眼里消失了。
    if (!numbers) notes.push(`窗口 ${label} 缺已用或上限，只留上游状态字`);
    const cls = classifyLabel(label, w.modelScoped === true || w.model_scoped === true);
    const afterSec = num(w.resetAfterSeconds);
    const resetsAt =
      toIso(w.resetAt ?? w.reset_at) ??
      (afterSec !== undefined ? new Date(Date.parse(readAt) + afterSec * 1000).toISOString() : undefined);
    windows.push(
      pruned<QuotaReading>({
        poolId: ctx.poolId,
        window: cls.window,
        scope: cls.scope,
        label,
        unit: numbers?.unit ?? 'points',
        used: numbers?.used,
        limit: numbers?.limit,
        utilization: numbers?.utilization,
        resetsAt,
        ...status,
        reading: 'measured',
        readAt,
        source: SOURCE,
      }),
    );
  }
  if (usage.windows.length > 0 && windows.length === 0) {
    throw new QuotaReadError(
      'bad_response',
      `中转回了 ${usage.windows.length} 个窗口，一个都认不出：${notes.join('；')}`,
    );
  }
  if (usage.windows.length === 0) notes.push('中转说这个账号没有额度窗口');
  return { windows, notes };
}

/** 开一条回环 WebSocket，握手后发 getRelay，等 relay 或 error 帧。令牌只进 URL，不进返回值和错误信息。 */
async function fetchRelayFrame(ctx: ReaderContext, url: string): Promise<unknown> {
  let ws: WebSocketLike;
  try {
    ws = ctx.openWebSocket(url);
  } catch (e) {
    throw new QuotaReadError(
      'unreachable',
      `开不了回环 WebSocket：${redact(String((e as Error).message ?? e))}`,
    );
  }
  return new Promise<unknown>((resolve, reject) => {
    let opened = false;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(openTimer);
      ctx.signal.removeEventListener('abort', onAbort);
      try {
        ws.close();
      } catch {
        // 已断
      }
      fn();
    };
    const onAbort = () => finish(() => reject(new QuotaReadError('timeout', '等 relay 帧超时')));
    const openTimer = setTimeout(
      () =>
        finish(() =>
          reject(new QuotaReadError('unreachable', '回环 WebSocket 连不上（mirasim-server 没在跑？）')),
        ),
      OPEN_TIMEOUT_MS,
    );
    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    ws.onopen = () => {
      opened = true;
      clearTimeout(openTimer);
      // state 帧不会自己推：先 clientHello、getState，再要 relay。
      ws.send(JSON.stringify({ type: 'clientHello' }));
      ws.send(JSON.stringify({ type: 'getState' }));
      ws.send(JSON.stringify({ type: 'getRelay' }));
    };
    ws.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (isRecord(msg) && (msg.type === 'relay' || msg.type === 'error')) finish(() => resolve(msg));
    };
    ws.onerror = () => {
      if (!opened)
        finish(() =>
          reject(new QuotaReadError('unreachable', '回环 WebSocket 连不上（mirasim-server 没在跑？）')),
        );
    };
    ws.onclose = () =>
      finish(() => reject(new QuotaReadError('unreachable', '回环 WebSocket 没回 relay 帧就断了')));
  });
}

export const readMirasimRelay: Reader = async (ctx) => {
  const pool = ctx.pool as MirasimRelayConfig;
  const port = pool.port ?? DEFAULT_MIRASIM_PORT;
  const tokenFile = expandHome(pool.tokenFile ?? `~/.mirasim/run/local-${port}.token`, ctx.homeDir);
  let token: string;
  try {
    token = (await ctx.readFile(tokenFile)).trim();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'ERR';
    throw new QuotaReadError(
      'no_credentials',
      `读不到回环令牌 ${tokenFile}（${code}）：mirasim-server 多半没在跑，或读取器用户没权限`,
    );
  }
  if (!token) throw new QuotaReadError('no_credentials', `回环令牌 ${tokenFile} 是空的`);
  const frame = await fetchRelayFrame(ctx, `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const out = readingsFromRelayFrame(frame, { poolId: pool.poolId, fetchedAt: ctx.fetchedAt });
  return { windows: out.windows, notes: out.notes };
};
