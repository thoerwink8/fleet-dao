// 推送方（看板多机，全仓审查第 1 路 PR-4）：这一台把自己的主页、环境页快照（snapshots.ts 的同一份拼法）每 60 秒加抖动
// POST 给正式环境的看板，带头 X-Fleet-Node-Token。只往外连，不开口子；收的那头在 node-report.ts。
// 改这里之前必须知道：
// - 配了 FLEET_NODE_REPORT_URL 和 FLEET_NODE_REPORT_TOKEN 才起（config.ts 的 nodeReport）；没配，/healthz 的 node_report 报「未接」，
//   不起循环、不发一个请求。
// - 推不成不吞：每次都记日志（错误原文带地址，只进日志），/healthz 的 node_report 报红，说连着几次没推成、上次推成是多久前。
//   起来后第一轮还没推完也报「没查成」，不当成好（和 gateway-seen.ts 一个规矩）。
// - 会随网络、对方自己变红（和这一版好不好无关）：本机档配上之前，发版脚本的 DRIFTING_HEALTH_ITEMS 要加 node_report（deploy/，另一片做）。
// - 代理：Node 自带的 fetch 默认不认 HTTP(S)_PROXY；要走代理就在 api.env 里设 NODE_USE_ENV_PROXY=1 加 HTTPS_PROXY（Node 22.21 起有），
//   仓里没有 undici，不另做 FLEET_NODE_REPORT_PROXY。
// - 一轮做完才排下一轮（setTimeout 链，不用 setInterval）：对方慢的时候不会叠着推。
import {
  NODE_REPORT_HEADER,
  NODE_REPORT_SCHEMA_VERSION,
  type NodeReport,
  NodeReportSchema,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { PublicHealthError } from './health.ts';
import type { HealthCheck, Logger } from './ports.ts';

export const NODE_REPORT_EVERY_MS = 60_000;
/** 每轮在 60 秒上再随机加 0～这么多，几台同时起也不会扎堆。 */
export const NODE_REPORT_JITTER_MS = 15_000;
/** 一次 POST 最多等这么久。 */
export const NODE_REPORT_TIMEOUT_MS = 15_000;
/** 没配推送地址：/healthz 的 node_report 报「未接」（公网看得到，只写中性的话）。 */
export const NODE_REPORT_NOT_WIRED = '这台没配推送地址，不往别的看板推快照';

export interface NodeReportTarget {
  url: URL;
  token: string;
}

/** 一次没推成的分类：对外只说这一句（不带地址、状态码以外的原文），原文进日志。 */
type FailureKind = 'rejected' | 'http_error' | 'timeout' | 'unreachable' | 'bad_snapshot';
const FAILURE_TEXT: Record<FailureKind, string> = {
  rejected: '对方不认这把通行证',
  http_error: '对方回了错误',
  timeout: '对方没回应',
  unreachable: '连不上对方',
  bad_snapshot: '这台的快照拼不出来',
};

export interface NodeReporter {
  /** 推一轮：推成回 true；没推成记日志、记失败次数，回 false，不抛。 */
  pushOnce(): Promise<boolean>;
  /** /healthz 的 node_report 项。 */
  readonly healthCheck: HealthCheck;
  /** 起循环（第一轮在 0～抖动之内）。重复调不会起第二条。 */
  start(): void;
  stop(): void;
}

export interface NodeReporterInput {
  target: NodeReportTarget;
  /** 这一台此刻的两份快照（main.ts 里调 readHomeSnapshot / readEnvSnapshot）。 */
  snapshot: () => Promise<{ home: unknown; env: unknown }>;
  /** 在用的提交号；读不到给 undefined（不写假值）。 */
  codeSha: () => string | undefined;
  log: Logger;
  now: () => Date;
  fetch?: typeof fetch;
  everyMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  random?: () => number;
}

/** 装配用：配了推送目标（config.ts 的 nodeReport）才建；没配回 null——不建、不起循环、不发一个请求。 */
export function nodeReporterFor(
  target: NodeReportTarget | null,
  rest: Omit<NodeReporterInput, 'target'>,
): NodeReporter | null {
  return target ? createNodeReporter({ ...rest, target }) : null;
}

export function createNodeReporter(input: NodeReporterInput): NodeReporter {
  const doFetch = input.fetch ?? fetch;
  const everyMs = input.everyMs ?? NODE_REPORT_EVERY_MS;
  const jitterMs = input.jitterMs ?? NODE_REPORT_JITTER_MS;
  const timeoutMs = input.timeoutMs ?? NODE_REPORT_TIMEOUT_MS;
  const random = input.random ?? Math.random;
  const startedAt = input.now().getTime();
  let lastOkAt: number | undefined;
  let lastTriedAt: number | undefined;
  let failures = 0;
  let lastFailure: FailureKind | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const fail = (kind: FailureKind, detail: string): false => {
    failures++;
    lastFailure = kind;
    input.log.warn('快照没推出去', { kind, detail, failures, url: input.target.url.origin });
    return false;
  };

  async function attempt(): Promise<boolean> {
    let report: NodeReport;
    try {
      const { home, env } = await input.snapshot();
      const codeSha = input.codeSha();
      const parsed = NodeReportSchema.safeParse({
        schemaVersion: NODE_REPORT_SCHEMA_VERSION,
        reportedAt: input.now().toISOString(),
        ...(codeSha === undefined ? {} : { codeSha }),
        home,
        env,
      });
      if (!parsed.success) return fail('bad_snapshot', parsed.error.message);
      report = parsed.data;
    } catch (err) {
      return fail('bad_snapshot', errMessage(err));
    }
    let res: Response;
    try {
      res = await doFetch(input.target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [NODE_REPORT_HEADER]: input.target.token },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return fail(timedOut ? 'timeout' : 'unreachable', errMessage(err));
    }
    // 把回体读掉，连接才能复用；回体只进日志（截一段）
    const body = await res.text().catch(() => '');
    if (res.ok) return true;
    const detail = `HTTP ${res.status} ${body.slice(0, 200)}`;
    return fail(res.status === 401 || res.status === 403 ? 'rejected' : 'http_error', detail);
  }

  async function pushOnce(): Promise<boolean> {
    const ok = await attempt();
    lastTriedAt = input.now().getTime();
    if (ok) {
      lastOkAt = lastTriedAt;
      if (failures > 0) input.log.info('快照又推出去了', { afterFailures: failures });
      failures = 0;
      lastFailure = undefined;
    }
    return ok;
  }

  async function check(): Promise<string> {
    const t = input.now().getTime();
    const okAgo = lastOkAt === undefined ? '起来后还没推成过' : `上次推成在 ${span(t - lastOkAt)}前`;
    if (lastTriedAt === undefined) {
      throw new PublicHealthError('not_yet', `没查成：起来 ${span(t - startedAt)}，第一轮还没推完`);
    }
    if (failures > 0) {
      const why = lastFailure === undefined ? '' : `（${FAILURE_TEXT[lastFailure]}）`;
      throw new PublicHealthError('push_failing', `连着 ${failures} 次没推成${why}，${okAgo}`);
    }
    // 循环卡住了（拼快照卡在库上之类）：三轮没动就报红，不拿上一次的好冒充现在
    if (t - lastTriedAt > 3 * (everyMs + jitterMs)) {
      throw new PublicHealthError('stalled', `${span(t - lastTriedAt)}没推过了，${okAgo}`);
    }
    return okAgo;
  }

  const schedule = (delayMs: number) => {
    timer = setTimeout(async () => {
      await pushOnce();
      if (running) schedule(everyMs + Math.floor(random() * jitterMs));
    }, delayMs);
    timer.unref?.();
  };

  return {
    pushOnce,
    healthCheck: { name: 'node_report', check },
    start() {
      if (running) return;
      running = true;
      schedule(Math.floor(random() * jitterMs));
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}

/** 「12 秒」「7 分钟」「2 小时 5 分钟」（和 gateway-seen.ts 一个说法）。 */
function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** 装配用：/healthz 的 node_report 接什么。有推送方（配了目标）就接它的检查；没有报「未接」。 */
export function nodeReportPart(reporter: NodeReporter | null): Pick<HealthCheck, 'check' | 'notWired'> {
  if (!reporter) return { check: async () => {}, notWired: NODE_REPORT_NOT_WIRED };
  return { check: () => reporter.healthCheck.check() };
}
