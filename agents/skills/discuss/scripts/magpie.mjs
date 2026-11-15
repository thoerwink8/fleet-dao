// magpie 只负责发现固定模型和厂商族；请求复用 gpt-relay 的 chat/completions。
import { completeChat, discussModelOverride, magpieRelayConfig, relayFailureWhy } from './gpt-relay.mjs';

export const MAGPIE_DEFAULT_KEYS = ['gpt', 'grok', 'deepseek', 'swe'];
/** @type {Record<string, string>} */
export const MAGPIE_MODELS = {
  gpt: 'recodex/gpt-6-astra',
  swe: 'devin/swe-2',
  deepseek: 'chaeng/deepseek-v4.1-flash',
  grok: 'grok/grok-4.7',
  haiku: 'cursor/claude-haiku-5-5@300k',
};

/** 型号决定厂商族，渠道名不决定族。路由组和禁用渠道不能用于讨论。 @param {string} model */
export function magpieFamily(model) {
  if (/^(?:group|auto|claude|antigravity|gemini)\//i.test(model)) return null;
  const id = model.split('/');
  if (id.length !== 2 || !id[1]) return null;
  if (id[0] === 'cursor') return /^claude-haiku-5-5(?:@|$)/i.test(id[1]) ? 'claude' : null;
  if (/^gpt-/i.test(id[1])) return 'gpt';
  if (/^swe-/i.test(id[1]) && id[0] === 'devin') return 'swe';
  if (/^deepseek-/i.test(id[1])) return 'deepseek';
  if (/^grok-/i.test(id[1])) return 'grok';
  if (/^claude-/i.test(id[1]) && !/fable/i.test(id[1])) return 'claude';
  return null;
}

/**
 * 探测与读取名单合成一次，整个 GET（含正文）最多两秒；不可用时返回 null，调用方保持旧路。
 * @param {{ fetchImpl?: typeof fetch, probeMs?: number, env?: NodeJS.ProcessEnv, home?: string, readFile?: (path: string) => string }} [opts]
 */
export async function magpieConfig(opts = {}) {
  const relay = magpieRelayConfig(opts);
  if (!relay) return null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${relay.baseUrl}/models`, {
      redirect: 'error',
      headers: { authorization: `Bearer ${relay.apiKey}` },
      signal: AbortSignal.timeout(opts.probeMs ?? 2_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) return null;
    const available = body.data.flatMap((m) =>
      m && typeof m === 'object' && 'id' in m && typeof m.id === 'string' ? [m.id] : [],
    );
    return { ...relay, available };
  } catch {
    return null;
  }
}

/**
 * 族参数只能选同族固定模型，不能把另一族的答案挂错标签。
 * @param {string[]} keys
 * @param {Record<string, string | undefined>} [overrides]
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, readFile?: (path: string) => string }} [opts]
 */
export function magpiePanel(keys = MAGPIE_DEFAULT_KEYS, overrides = {}, opts = {}) {
  if (!keys.length || new Set(keys).size !== keys.length) throw new Error('讨论模型族不能为空或重复');
  return keys.map((key) => {
    if (!Object.hasOwn(MAGPIE_MODELS, key)) throw new Error(`不认识的 magpie 模型族 ${key}`);
    const model = overrides[key] ?? discussModelOverride(key, opts) ?? MAGPIE_MODELS[key] ?? '';
    const family = key === 'haiku' ? 'claude' : key;
    if (magpieFamily(model) !== family) throw new Error(`${key} 型号不是同族固定模型或渠道被禁用：${model}`);
    return { key, family, model };
  });
}

/**
 * 独立请求失败留空正文、照实记录；不换渠道、不拿空答案冒充同意。
 * @param {{ key: string, family: string, model: string }} who
 * @param {string} prompt
 * @param {number} limitSec
 * @param {{ baseUrl: string, apiKey: string, available: string[] }} relay
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function magpieAsk(who, prompt, limitSec, relay, opts = {}) {
  const started = Date.now();
  const r = relay.available.includes(who.model)
    ? await completeChat({
        ...relay,
        model: who.model,
        prompt,
        timeoutMs: limitSec * 1000,
        ...opts,
      })
    : null;
  return {
    ...who,
    ok: r?.ok ?? false,
    secs: (Date.now() - started) / 1000,
    text: r?.ok ? r.text : '',
    why: r === null ? 'magpie 名单里没有这个固定型号' : r.ok ? undefined : relayFailureWhy(r, limitSec),
  };
}
