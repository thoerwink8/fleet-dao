// fleet 命令到后端的一次请求：带通行证和幂等键；连不上或后端临时不可用时短暂重试，之后大声失败。
import { randomUUID } from 'node:crypto';
import { AGENT_API_PREFIX } from '@fleet-dao/shared';

/** 退出码。AI 和脚本按它判下一步，改之前看 fleet --help 里的说明。 */
export const EXIT = {
  ok: 0,
  /** 连不上后端或后端出错（已重试） */
  backend: 1,
  /** 用法不对：参数、缺环境变量 */
  usage: 2,
  /** 通行证无效或过期：会话已被收回，重试没用 */
  auth: 3,
  /** 后端拒收（例如交活没通过核实） */
  rejected: 4,
} as const;

export class CliError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** 每次重试前说一声（写 stderr）。 */
  onRetry?: (message: string) => void;
  /** 默认 [500, 1000, 2000]：一共试 4 次，最多多等 3.5 秒。 */
  retryDelaysMs?: readonly number[];
  /** 单次请求的超时，默认 15 秒。 */
  timeoutMs?: number;
}

export interface BackendCall {
  method: 'GET' | 'POST';
  /** 例如 /task（前缀 /agent/v1 由这里加）。 */
  path: string;
  body?: unknown;
  timeoutMs?: number;
  /** 超时后要不要重试。等回答的 ask 本来就要等很久，超时就是没等到，不重试。 */
  retryOnTimeout?: boolean;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export async function callBackend(options: ClientOptions, call: BackendCall): Promise<unknown> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}${AGENT_API_PREFIX}${call.path}`;
  const delays = options.retryDelaysMs ?? [500, 1000, 2000];
  const timeoutMs = call.timeoutMs ?? options.timeoutMs ?? 15_000;
  // 同一条命令的几次重试用同一个键，后端据此去重，重试不会把一句话记成两句
  const idempotencyKey = randomUUID();
  let last = '';
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      const wait = delays[attempt - 1] ?? 0;
      options.onRetry?.(
        `${last}，${wait / 1000} 秒后重试（第 ${attempt + 1} 次，共 ${delays.length + 1} 次）`,
      );
      await options.sleep(wait);
    }
    let res: Response;
    try {
      res = await options.fetch(url, {
        method: call.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
          'idempotency-key': idempotencyKey,
          'user-agent': 'fleet-cli',
          ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (timedOut && call.retryOnTimeout === false) {
        throw new CliError(EXIT.backend, `等后端回应超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`);
      }
      last = timedOut ? `超时（${Math.round(timeoutMs / 1000)} 秒）` : networkError(err);
      continue;
    }
    const text = await res.text().catch(() => '');
    if (res.ok) return parseBody(text, url);
    const reason = messageOf(text);
    const suffix = reason ? `：${reason}` : '';
    if (res.status === 401 || res.status === 403) {
      throw new CliError(
        EXIT.auth,
        `通行证无效或已过期（HTTP ${res.status}）${suffix}。它只对本任务这次会话有效，会话被收回后就失效，别再重试`,
      );
    }
    if (RETRY_STATUS.has(res.status)) {
      last = `后端暂时不可用（HTTP ${res.status}${reason ? ` ${reason}` : ''}）`;
      continue;
    }
    throw new CliError(EXIT.rejected, `后端拒收（HTTP ${res.status}）${suffix}`);
  }
  throw new CliError(EXIT.backend, `连不上后端 ${url}（试了 ${delays.length + 1} 次，最后一次：${last}）`);
}

function parseBody(text: string, url: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(EXIT.backend, `后端回的不是 JSON：${url} → ${text.slice(0, 200)}`);
  }
}

/** 后端的出错说明：JSON 里的 error / message，否则原文。 */
function messageOf(text: string): string {
  const t = text.trim();
  if (!t) return '';
  try {
    const body = JSON.parse(t) as Record<string, unknown>;
    const nested =
      body.error && typeof body.error === 'object'
        ? (body.error as Record<string, unknown>).message
        : undefined;
    const msg = [body.error, body.message, nested].find((v) => typeof v === 'string');
    if (typeof msg === 'string') return msg.slice(0, 500);
  } catch {
    // 不是 JSON，用原文
  }
  return t.slice(0, 500);
}

function networkError(err: unknown): string {
  const cause =
    err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  return cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
}
