// 旧系统用的 Jev 服务（TypeSafe System One）。接口照官方文档 docs.typesafe.ai/api 与旧客户端 windsurf-dao scripts/lib/judge-client.mjs：
// POST <地址>，Bearer 密钥，请求体 { state, model, questions }；回包 { model, answers: { 题号: { type, choice, probabilities, confidence } }, usage }。
// 地址和密钥只从机器配置读（config.ts），这里没有默认值。按输入 token 计费，受每日花费上限管（JevPolicy.dailyUsdCap，到了就不问）。
// 请求发出去就可能已经计费：出错的回包里报了 token 数也交回去，记账不按 0 算（ask 那边没报的按事前估算）。
// 回包里的 model 是实际回话的版本号：和钉死的对不上就当没判（model_mismatch），不采纳。
import { performance } from 'node:perf_hooks';
import {
  assertPinnedModel,
  type BackendAnswer,
  type BackendFailure,
  type BackendRequest,
  type BackendResult,
  estimateTokens,
  type JevBackend,
} from '../backend.ts';
import { scrubHead } from '../scrub.ts';

export interface TypesafeOptions {
  /** 例如 https://api.typesafe.ai/v1/systemone，从机器配置读。 */
  endpoint: string;
  apiKey: string;
  /** 钉死的版本，例如 jev-1.13.0（jev-latest 这类别名会被拒）。 */
  model: string;
  /** 默认 TYPESAFE_DEFAULT_TIMEOUT_MS（旧客户端的取值；旧系统实测单次不到 1 秒，生产各题平均一秒多）。 */
  timeoutMs?: number;
  /** 每百万输入 token 多少美元，默认 TYPESAFE_USD_PER_MTOK（官方价目，docs.typesafe.ai/models）。 */
  usdPerMTok?: number;
  fetch?: typeof fetch;
}

export const TYPESAFE_DEFAULT_TIMEOUT_MS = 8_000;
/** jev-1.13 的官方价：每百万输入 token 0.042 美元，输出不收费。 */
export const TYPESAFE_USD_PER_MTOK = 0.042;

export function createTypesafeBackend(options: TypesafeOptions): JevBackend {
  assertPinnedModel('typesafe', options.model);
  if (!/^https:\/\//.test(options.endpoint)) throw new Error('TypeSafe 的地址要是 https:// 开头');
  if (!options.apiKey.trim()) throw new Error('TypeSafe 的密钥是空的');
  // 测试不出网：测试里必须注入假的 fetch（它按输入 token 计费，误调一次就是真花钱）。
  if (process.env.VITEST && !options.fetch) throw new Error('测试里不许真调 TypeSafe：注入假的 fetch');
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TYPESAFE_DEFAULT_TIMEOUT_MS;

  return {
    kind: 'typesafe',
    model: options.model,
    usdPerMTok: options.usdPerMTok ?? TYPESAFE_USD_PER_MTOK,
    async ask(request: BackendRequest): Promise<BackendResult> {
      const body = typesafeBody(options.model, request);
      const payload = JSON.stringify(body);
      const t0 = performance.now();
      const elapsed = () => Math.round(performance.now() - t0);
      const fail = (
        reason: BackendFailure,
        detail: string,
        extra: { model?: string; inputTokens?: number | undefined } = {},
      ): BackendResult => ({
        ok: false,
        reason,
        detail,
        latencyMs: elapsed(),
        ...(extra.model ? { model: extra.model } : {}),
        ...(extra.inputTokens === undefined ? {} : { inputTokens: extra.inputTokens }),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      let res: Response;
      try {
        res = await doFetch(options.endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: payload,
        });
      } catch (err) {
        const aborted = (err as { name?: string })?.name === 'AbortError';
        return fail(aborted ? 'timeout' : 'network', aborted ? `${timeoutMs} 毫秒没回` : errorText(err));
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        return fail('network', `读回包时断了：${errorText(err)}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      if (res.status !== 200) {
        return fail(statusReason(res.status), `HTTP ${res.status}：${scrubHead(text, 300)}`, {
          inputTokens: reportedTokens(json),
        });
      }
      if (json === undefined) return fail('bad_answer', `回包不是 JSON：${scrubHead(text, 200)}`);
      const parsed = parseTypesafeResponse(json, request);
      if (!parsed.ok) return fail('bad_answer', parsed.why, { inputTokens: reportedTokens(json) });
      if (parsed.model !== options.model) {
        return fail('model_mismatch', `钉死的是 ${options.model}，回话的是 ${parsed.model}`, {
          model: parsed.model,
          inputTokens: parsed.inputTokens,
        });
      }
      return {
        ok: true,
        answers: parsed.answers,
        model: parsed.model,
        latencyMs: elapsed(),
        inputTokens: parsed.inputTokens ?? estimateTokens([payload]),
        tokensEstimated: parsed.inputTokens === undefined,
      };
    },
  };
}

/** 证据用对象：一个字段一个键（官方建议给每段证据起名字）；每道题一个选择题。 */
export function typesafeBody(model: string, request: BackendRequest) {
  return {
    state: Object.fromEntries(request.evidence.map((e) => [e.label, e.text])),
    model,
    questions: Object.fromEntries(
      request.questions.map((q) => [
        q.id,
        {
          type: 'choice',
          instructions: q.instructions,
          criteria: Object.fromEntries(q.options.map((o) => [o.id, o.criteria])),
        },
      ]),
    ),
  };
}

function statusReason(status: number): BackendFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 413 || status === 422) return 'bad_request';
  if (status === 429) return 'rate_limited';
  if (status === 529 || status >= 500) return 'overloaded';
  return 'backend_error';
}

function errorText(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return [e?.message, e?.cause?.code, e?.cause?.message].filter((x) => x).join(' · ') || String(err);
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** 回包 usage 里上游报的输入 token 数；没报或不是正数就是 undefined（由调用方估，不当 0）。 */
export function reportedTokens(json: unknown): number | undefined {
  const tokens = rec(rec(json)?.usage)?.input_tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

export function parseTypesafeResponse(
  json: unknown,
  request: BackendRequest,
):
  | { ok: true; model: string; answers: Record<string, BackendAnswer>; inputTokens?: number }
  | { ok: false; why: string } {
  const body = rec(json);
  if (!body) return { ok: false, why: '回包不是对象' };
  if (typeof body.model !== 'string' || !body.model)
    return { ok: false, why: '回包没带 model（实际回话的版本）' };
  const answers = rec(body.answers);
  if (!answers) return { ok: false, why: '回包没有 answers' };
  const out: Record<string, BackendAnswer> = {};
  for (const q of request.questions) {
    if (!(q.id in answers)) continue;
    const a = rec(answers[q.id]);
    if (!a) out[q.id] = { invalid: '这道题的答案不是对象' };
    else if (a.type !== 'choice') out[q.id] = { invalid: `题型不对：${String(a.type)}` };
    else if (typeof a.choice !== 'string') out[q.id] = { invalid: '没有 choice' };
    else if (typeof a.confidence !== 'number') out[q.id] = { invalid: '没有 confidence' };
    else out[q.id] = { option: a.choice, confidence: a.confidence };
  }
  const tokens = reportedTokens(body);
  return {
    ok: true,
    model: body.model,
    answers: out,
    ...(tokens === undefined ? {} : { inputTokens: tokens }),
  };
}
