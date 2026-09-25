// TypeSafe（旧系统的 Jev 服务）后端：请求形状照官方接口，出错一律变成「没判」的原因，不出网（假 fetch）。
import { describe, expect, it } from 'vitest';
import type { BackendRequest } from '../src/backend.ts';
import {
  createTypesafeBackend,
  parseTypesafeResponse,
  TYPESAFE_USD_PER_MTOK,
  typesafeBody,
} from '../src/backends/typesafe.ts';

const ENDPOINT = 'https://jev.example.invalid/v1/systemone';
const request: BackendRequest = {
  questions: [
    {
      id: 'error-next',
      instructions: '下一步该怎么办？',
      options: [
        { id: 'retry', criteria: '暂时性的' },
        { id: 'park', criteria: '重试没用' },
      ],
    },
  ],
  evidence: [
    { label: '出错的步骤', text: 'createWorktree' },
    { label: '报错原文', text: 'ECONNRESET' },
  ],
};

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const good = {
  model: 'jev-1.13.0',
  answers: {
    'error-next': {
      type: 'choice',
      choice: 'retry',
      probabilities: { retry: 0.9, park: 0.1 },
      confidence: 0.8,
    },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};

const backend = (fetch: typeof globalThis.fetch, over: { model?: string; timeoutMs?: number } = {}) =>
  createTypesafeBackend({ endpoint: ENDPOINT, apiKey: 'test-key', model: 'jev-1.13.0', fetch, ...over });

describe('TypeSafe 后端', () => {
  it('请求照官方接口：Bearer 密钥，state 是「字段名 → 原文」，每道题是带判据的选择题，模型钉死', async () => {
    const f = fakeFetch(() => json(good));
    const result = await backend(f.fn).ask(request);
    expect(f.calls[0]?.url).toBe(ENDPOINT);
    const headers = f.calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      state: { 出错的步骤: 'createWorktree', 报错原文: 'ECONNRESET' },
      model: 'jev-1.13.0',
      questions: {
        'error-next': {
          type: 'choice',
          instructions: '下一步该怎么办？',
          criteria: { retry: '暂时性的', park: '重试没用' },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      model: 'jev-1.13.0',
      answers: { 'error-next': { option: 'retry', confidence: 0.8 } },
      inputTokens: 318,
      tokensEstimated: false,
    });
  });

  it('按量计费：后端带着官方单价，每日花费上限按它算', () => {
    const f = fakeFetch(() => json(good));
    expect(backend(f.fn).usdPerMTok).toBe(TYPESAFE_USD_PER_MTOK);
    expect(
      createTypesafeBackend({
        endpoint: ENDPOINT,
        apiKey: 'k',
        model: 'jev-1.13.0',
        fetch: f.fn,
        usdPerMTok: 0.05,
      }).usdPerMTok,
    ).toBe(0.05);
  });

  it('回包没带 token 数：按字符数保守估，标明是估的，不记 0', async () => {
    const f = fakeFetch(() => json({ ...good, usage: {} }));
    const result = await backend(f.fn).ask(request);
    const sent = String(f.calls[0]?.init.body);
    expect(result).toMatchObject({ ok: true, inputTokens: sent.length, tokensEstimated: true });
  });

  it('回话的版本和钉死的不一样：当没判（model_mismatch），带上实际版本', async () => {
    const f = fakeFetch(() => json({ ...good, model: 'jev-1.14.0' }));
    expect(await backend(f.fn).ask(request)).toMatchObject({
      ok: false,
      reason: 'model_mismatch',
      model: 'jev-1.14.0',
    });
  });

  it('HTTP 状态码分到原因上；报错原文带回来，不带密钥', async () => {
    const cases: [number, string][] = [
      [401, 'auth'],
      [403, 'auth'],
      [422, 'bad_request'],
      [429, 'rate_limited'],
      [529, 'overloaded'],
      [502, 'overloaded'],
      [404, 'backend_error'],
    ];
    for (const [status, reason] of cases) {
      const f = fakeFetch(() => json({ error: `boom ${status}` }, status));
      const result = await backend(f.fn).ask(request);
      expect(result, String(status)).toMatchObject({ ok: false, reason });
      if (!result.ok) {
        expect(result.detail).toContain(`HTTP ${status}`);
        expect(result.detail).not.toContain('test-key');
      }
    }
  });

  it('连不上是 network，超时是 timeout', async () => {
    const refused = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    expect(await backend(refused.fn).ask(request)).toMatchObject({ ok: false, reason: 'network' });
    const hang = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    expect(await backend(hang.fn, { timeoutMs: 20 }).ask(request)).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
  });

  it('回包不是 JSON、没有 answers、没带 model：认不出（bad_answer）', async () => {
    for (const body of [
      'not json',
      JSON.stringify({ model: 'jev-1.13.0' }),
      JSON.stringify({ answers: {} }),
    ]) {
      const f = fakeFetch(() => new Response(body, { status: 200 }));
      expect(await backend(f.fn).ask(request)).toMatchObject({ ok: false, reason: 'bad_answer' });
    }
  });

  it('某道题的答案形状不对：这道题记成认不出，别的照常', () => {
    const parsed = parseTypesafeResponse(
      {
        model: 'jev-1.13.0',
        answers: { 'error-next': { type: 'noul', noul: 0.9 } },
      },
      request,
    );
    expect(parsed).toMatchObject({ ok: true, answers: { 'error-next': { invalid: '题型不对：noul' } } });
  });

  it('模型没钉死、地址不是 https、没有密钥：当场拒绝创建', () => {
    const f = fakeFetch(() => json(good)).fn;
    expect(() =>
      createTypesafeBackend({ endpoint: ENDPOINT, apiKey: 'k', model: 'jev-latest', fetch: f }),
    ).toThrow(/别名/);
    expect(() =>
      createTypesafeBackend({ endpoint: ENDPOINT, apiKey: 'k', model: 'jev-1.13', fetch: f }),
    ).toThrow(/jev-/);
    expect(() =>
      createTypesafeBackend({ endpoint: 'http://x/v1', apiKey: 'k', model: 'jev-1.13.0', fetch: f }),
    ).toThrow(/https/);
    expect(() =>
      createTypesafeBackend({ endpoint: ENDPOINT, apiKey: ' ', model: 'jev-1.13.0', fetch: f }),
    ).toThrow(/密钥/);
  });

  it('请求体里的题目和证据与 BackendRequest 一一对应', () => {
    const body = typesafeBody('jev-1.13.0', request);
    expect(Object.keys(body.questions)).toEqual(['error-next']);
    expect(Object.keys(body.state)).toEqual(['出错的步骤', '报错原文']);
  });

  it('旧系统生产留痕里的真实答案形状照样解析（VPS judge-calls，2026-09-24，retry-verdict 那一题）', () => {
    const real = {
      retryKind: {
        type: 'choice',
        choice: 'terminal',
        confidence: 0.97,
        probabilities: { retryable: 0, unclear: 0.02, terminal: 0.98 },
      },
    };
    const req: BackendRequest = {
      questions: [
        {
          id: 'retryKind',
          instructions: '这段失败原文说明的是什么？',
          options: [
            { id: 'terminal', criteria: '重试也没用' },
            { id: 'retryable', criteria: '暂时性的' },
            { id: 'unclear', criteria: '说不清' },
          ],
        },
      ],
      evidence: [],
    };
    expect(
      parseTypesafeResponse({ model: 'jev-1.13.0', answers: real, usage: { input_tokens: 461 } }, req),
    ).toEqual({
      ok: true,
      model: 'jev-1.13.0',
      answers: { retryKind: { option: 'terminal', confidence: 0.97 } },
      inputTokens: 461,
    });
  });
});
