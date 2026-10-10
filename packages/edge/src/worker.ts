// Cloudflare 定时 Worker（#292 第 1 片）：每 5 分钟从外面查香港、法国，挂了推飞书。
// 真域名、飞书 webhook、认人用的请求头都只从 env 读。wrangler.toml 里只有占位。
// 读不到密钥这一轮记没查成、写日志、抛出去，不当成没挂。
// 法国把「它来查了」记成一轮是后一片；这里每次探测带上 x-fleet-watch，值是 FLEET_EDGE_WATCH_ID。
import {
  judgeRound,
  type MachineState,
  type Previous,
  type ProbeStatus,
  type WatchSnapshot,
} from './judge.ts';
import { feishuWebhookUrl, pushFeishu } from './notify.ts';

export const STATE_KEY = 'fleet-edge-watch';
const WATCH_HEADER = 'x-fleet-watch';

export interface EdgeStateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface EdgeEnv {
  FLEET_EDGE_HK_URL?: string;
  FLEET_EDGE_FR_URL?: string;
  FLEET_FEISHU_WEBHOOK?: string;
  FLEET_EDGE_WATCH_ID?: string;
  EDGE_STATE?: EdgeStateStore;
}

export interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

export interface RoundDeps {
  env: EdgeEnv;
  now: number;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
}

interface RoundConfig {
  hk: string;
  fr: string;
  webhook: string;
  watchId: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(log: (line: string) => void, why: string): never {
  const line = why.includes('不当成没挂') ? why : `${why}。不当成没挂。`;
  const text = line.startsWith('外部看门狗这一轮没查成') ? line : `外部看门狗这一轮没查成：${line}`;
  log(text);
  throw new Error(text);
}

function requireConfig(env: EdgeEnv): RoundConfig {
  const missing: string[] = [];
  const hk = env.FLEET_EDGE_HK_URL?.trim() ?? '';
  const fr = env.FLEET_EDGE_FR_URL?.trim() ?? '';
  const watchId = env.FLEET_EDGE_WATCH_ID?.trim() ?? '';
  const webhookRaw = env.FLEET_FEISHU_WEBHOOK?.trim() ?? '';
  if (hk === '') missing.push('FLEET_EDGE_HK_URL');
  if (fr === '') missing.push('FLEET_EDGE_FR_URL');
  if (watchId === '') missing.push('FLEET_EDGE_WATCH_ID');
  if (webhookRaw === '') missing.push('FLEET_FEISHU_WEBHOOK');
  if (missing.length > 0) {
    throw new Error(`外部看门狗这一轮没查成：读不到 ${missing.join('、')}。不当成没挂。`);
  }
  let webhook: string;
  try {
    webhook = feishuWebhookUrl(webhookRaw);
  } catch (err) {
    throw new Error(`外部看门狗这一轮没查成：${errText(err)}。不当成没挂。`);
  }
  return { hk, fr, webhook, watchId };
}

async function probe(url: string, watchId: string, fetchImpl: typeof fetch): Promise<ProbeStatus> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { [WATCH_HEADER]: watchId, 'cache-control': 'no-store' },
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch {
    return 'unreachable';
  }
}

function isMachine(value: unknown): value is MachineState {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.status !== 'up' && m.status !== 'down' && m.status !== 'unknown') return false;
  const down = m.status === 'down';
  if (down) {
    if (typeof m.downSince !== 'number' || !Number.isFinite(m.downSince)) return false;
    if (typeof m.consecutiveFailures !== 'number' || !Number.isInteger(m.consecutiveFailures)) return false;
    if (m.consecutiveFailures < 1) return false;
  } else if (m.downSince !== null || m.consecutiveFailures !== 0 || m.lastPushedAt !== null) {
    return false;
  }
  if (m.lastPushedAt !== null && (typeof m.lastPushedAt !== 'number' || !Number.isFinite(m.lastPushedAt))) {
    return false;
  }
  return true;
}

function parseSnapshot(raw: string): WatchSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (!isMachine(row.hk) || !isMachine(row.fr)) return undefined;
  return { hk: row.hk, fr: row.fr };
}

async function readPrevious(
  store: EdgeStateStore | undefined,
  log: (line: string) => void,
): Promise<Previous> {
  if (!store) {
    log('外部看门狗读不到上一轮状态：没有 EDGE_STATE');
    return { kind: 'unreadable' };
  }
  let raw: string | null;
  try {
    raw = await store.get(STATE_KEY);
  } catch (err) {
    log(`外部看门狗读不到上一轮状态：${errText(err)}`);
    return { kind: 'unreadable' };
  }
  if (raw === null || raw.trim() === '') return { kind: 'none' };
  const snapshot = parseSnapshot(raw);
  if (!snapshot) {
    log('外部看门狗读不到上一轮状态：存着的内容认不出');
    return { kind: 'unreadable' };
  }
  return { kind: 'known', snapshot };
}

export async function runRound(deps: RoundDeps): Promise<void> {
  if (!Number.isFinite(deps.now)) fail(deps.log, '没有探测时刻');
  let cfg: RoundConfig;
  try {
    cfg = requireConfig(deps.env);
  } catch (err) {
    const why = errText(err);
    deps.log(why);
    throw new Error(why);
  }
  const [hk, fr] = await Promise.all([
    probe(cfg.hk, cfg.watchId, deps.fetchImpl),
    probe(cfg.fr, cfg.watchId, deps.fetchImpl),
  ]);
  const previous = await readPrevious(deps.env.EDGE_STATE, deps.log);
  const decision = judgeRound({ now: deps.now, hk, fr, previous });
  if (decision.push) {
    try {
      await pushFeishu(cfg.webhook, decision.text, deps.fetchImpl);
    } catch (err) {
      fail(deps.log, errText(err));
    }
  }
  const store = deps.env.EDGE_STATE;
  if (!store) fail(deps.log, '上一轮状态没写上（没有 EDGE_STATE）');
  try {
    await store.put(STATE_KEY, JSON.stringify(decision.next));
  } catch (err) {
    fail(deps.log, `上一轮状态没写上（${errText(err)}）`);
  }
}

const worker = {
  async scheduled(event: ScheduledEvent, env: EdgeEnv): Promise<void> {
    await runRound({
      env,
      now: event.scheduledTime,
      fetchImpl: fetch,
      log: (line) => console.error(line),
    });
  },
};

export default worker;
