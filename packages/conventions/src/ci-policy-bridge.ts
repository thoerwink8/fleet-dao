// Actions 的零安装真实读桥；协议 import 也只能走零依赖文件。
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  latestPolicyStatus,
  type PolicyRepo,
  type PolicyResponse,
  parsePolicyResponse,
  parsePolicyUrl,
  policyHead,
  policyId,
  policyRecord,
  policyRepo,
  policySourceContext,
} from '../../shared/src/ci-policy-bridge.ts';
import type { GhApi } from './gh-api.ts';
import type { GitHubReads } from './merge-gate.ts';

export interface ClosedPolicyHead {
  closed: true;
  number: number;
  head: string;
  repo: PolicyRepo;
}
export type PolicyReadResult = 'force' | 'off' | ClosedPolicyHead;

interface PolicyTrace {
  stage: 'unknown' | 'headers' | 'body';
}
const policyTraceScope = new AsyncLocalStorage<PolicyTrace>();
const policyNetworkCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'EPROTO',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'TimeoutError',
  'AbortError',
]);

/** 仅提取已知枚举；不保留可能含地址、响应体或凭据的原始异常。 */
function policyErrorCodes(error: unknown): string[] {
  const codes = new Set<string>();
  const visited = new Set<object>();
  const queue: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }];
  for (let i = 0; i < queue.length && i < 32 && codes.size < 8; i++) {
    const entry = queue[i];
    // 诊断不能让代理对象或自定义 getter 的异常取代原失败。
    try {
      if (!entry || !policyRecord(entry.value) || visited.has(entry.value)) continue;
      const value = entry.value;
      visited.add(value);
      for (const code of [value.code, value.name]) {
        if (typeof code === 'string' && policyNetworkCodes.has(code)) codes.add(code);
      }
      if (entry.depth < 4) {
        queue.push({ value: value.cause, depth: entry.depth + 1 });
        if (value instanceof AggregateError && Array.isArray(value.errors)) {
          for (let n = 0; n < Math.min(value.errors.length, 8); n++)
            queue.push({ value: value.errors[n], depth: entry.depth + 1 });
        }
      }
    } catch {
      // 未识别的异常结构没有可用诊断。
    }
  }
  return [...codes].slice(0, 8);
}

class PolicyHttpContractError extends Error {}

function observePolicyHttp(url: string, trace: PolicyTrace): () => void {
  const requestCreated = channel('undici:request:create');
  const sendHeaders = channel('undici:client:sendHeaders');
  let request: object | undefined;
  let ambiguous = false;
  let events = 0;
  // 诊断频道缺事件或结构不认识时保持unknown，不猜DNS/TCP/TLS的socket归属。
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return () => {};
  }
  const guard = (action: (message: unknown) => void) => (message: unknown) => {
    try {
      action(message);
    } catch {
      // 被动观察器不能改变 fetch 的成功或失败。
    }
  };
  const created = guard((message) => {
    if (policyTraceScope.getStore() !== trace) return;
    if (++events > 64) {
      ambiguous = true;
      if (trace.stage !== 'body') trace.stage = 'unknown';
      return;
    }
    if (!policyRecord(message) || !policyRecord(message.request)) return;
    const candidate = message.request;
    if (
      candidate.method !== 'GET' ||
      candidate.origin !== target.origin ||
      candidate.path !== target.pathname + target.search
    )
      return;
    // 同scope的同URL也可能属于另一次请求；第二身份出现后撤回早先的阶段证据。
    if (request && request !== candidate) {
      ambiguous = true;
      if (trace.stage !== 'body') trace.stage = 'unknown';
    }
    request ??= candidate;
  });
  const sending = guard((message) => {
    if (ambiguous || !request || !policyRecord(message) || message.request !== request) return;
    if (++events > 64) {
      ambiguous = true;
      if (trace.stage !== 'body') trace.stage = 'unknown';
      return;
    }
    // request对象身份来自本次create；事件调度所在scope不代表连接归属。
    if (trace.stage !== 'body') trace.stage = 'headers';
  });
  requestCreated.subscribe(created);
  sendHeaders.subscribe(sending);
  return () => {
    requestCreated.unsubscribe(created);
    sendHeaders.unsubscribe(sending);
  };
}

export async function readPolicyHttp(
  url: string,
  repo: Pick<PolicyRepo, 'githubId' | 'repo'>,
  fetchImpl: typeof fetch = fetch,
): Promise<PolicyResponse> {
  const trace: PolicyTrace = { stage: 'unknown' };
  const started = performance.now();
  const cleanup = observePolicyHttp(url, trace);
  try {
    return await policyTraceScope.run(trace, async () => {
      const init: RequestInit & { cache: 'no-store' } = {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json', 'cache-control': 'no-cache, no-store' },
        signal: AbortSignal.timeout(10_000),
      };
      const res = await fetchImpl(url, init);
      trace.stage = 'body';
      if (
        res.status !== 200 ||
        res.redirected ||
        !/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type') ?? '')
      )
        throw new PolicyHttpContractError(
          `CI 策略桥未读成（HTTP ${Number.isInteger(res.status) && res.status >= 100 && res.status <= 599 ? res.status : 'unknown'} 或非 JSON/重定向）`,
        );
      if (
        !(res.headers.get('cache-control') ?? '')
          .split(',')
          .some((x) => x.trim().toLowerCase() === 'no-store')
      )
        throw new PolicyHttpContractError('CI 策略桥没有禁止缓存');
      if (!res.body) throw new PolicyHttpContractError('CI 策略桥没有响应体');
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let bodyFailed = false;
      let bodyError: unknown;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) throw new PolicyHttpContractError('CI 策略桥响应超过 4096 字节');
          chunks.push(value);
        }
      } catch (error) {
        bodyFailed = true;
        bodyError = error;
      }
      try {
        await reader.cancel();
      } catch (error) {
        if (!bodyFailed) throw error;
      }
      if (bodyFailed) throw bodyError;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new PolicyHttpContractError('CI 策略桥响应不是有效 UTF-8 JSON');
      }
      try {
        return parsePolicyResponse(raw, repo);
      } catch {
        throw new PolicyHttpContractError('CI 策略桥响应的协议、仓身份或模式不匹配');
      }
    });
  } catch (error) {
    let reason = 'CI 策略桥 HTTP 读取失败';
    try {
      if (error instanceof PolicyHttpContractError) reason = error.message;
    } catch {
      // 被撤销的 Proxy 等未知异常也只报告固定失败。
    }
    const codes = policyErrorCodes(error);
    throw new Error(
      `${reason} [stage=${trace.stage}; elapsedMs=${Math.max(0, Math.round(performance.now() - started))}; codes=${codes.join(',') || 'unknown'}]`,
    );
  } finally {
    cleanup();
  }
}

/** writer slug 只从可信标准检出读取，不从 caller 或 source 接收。 */
export function trustedEngineLogin(): string {
  const raw: unknown = JSON.parse(readFileSync(new URL('../github-apps.json', import.meta.url), 'utf8'));
  if (
    !policyRecord(raw) ||
    !policyRecord(raw.apps) ||
    !policyRecord(raw.apps.engine) ||
    typeof raw.apps.engine.slug !== 'string' ||
    !/^[a-z0-9-]+$/.test(raw.apps.engine.slug)
  )
    throw new Error('标准 engine App 配置认不出');
  return `${raw.apps.engine.slug}[bot]`;
}

export function policyReader(api: GhApi, gh: GitHubReads, slug: string, fetchImpl: typeof fetch = fetch) {
  return async (number: number, expectedHead: string): Promise<PolicyReadResult> => {
    const repo = policyRepo(await api.get(''));
    if (repo.repo.toLowerCase() !== slug.toLowerCase()) throw new Error('GitHub 实际仓身份不匹配');
    const head = policyHead(await gh.pr(number), repo);
    if (head.number !== number || head.head !== expectedHead) throw new Error('PR 当前 head 已改变');
    if (!head.open) return { closed: true, number, head: head.head, repo };
    // 私有仓沿原强制路径；绝不跟随它曾公开时留下的来源 URL。
    if (!repo.public) return 'force';
    const statuses = await gh.statuses(head.head);
    const context = policySourceContext(number);
    // 缺来源保留旧 force；出现来源以后任何不可验证材料均明确失败。
    if (!statuses.some((s) => policyRecord(s) && s.context === context)) return 'force';
    if (!api.globalGet) throw new Error('GitHub writer 身份 reader 未装配');
    const login = trustedEngineLogin();
    const bot = await api.globalGet(`/users/${encodeURIComponent(login)}`);
    if (!policyRecord(bot) || !policyId(bot.id) || bot.type !== 'Bot' || bot.login !== login)
      throw new Error('可信 Bot 数字身份未查成');
    const source = latestPolicyStatus(statuses, repo, head.head, bot.id, context);
    if (!source) throw new Error('没有可信 engine writer 的 source');
    if (head.fork || source.state !== 'success') throw new Error('source 不是公开同仓当前头的可用读口');
    const url = parsePolicyUrl(source.target_url, repo.githubId, head);
    return (await readPolicyHttp(url, repo, fetchImpl)).ciPolicy;
  };
}
