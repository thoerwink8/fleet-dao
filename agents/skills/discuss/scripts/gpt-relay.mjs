// 讨论问 GPT 的一条路：本机 ~/.fleet-dao/discuss.env（进程环境变量优先）里
// DISCUSS_GPT_BASE_URL 和 DISCUSS_GPT_API_KEY 都有，才走 OpenAI 兼容的 /chat/completions。
// 缺一个就返回 null，调用方走原来的执行体。失败不改道。
// 报错只留状态和错误码：fetch 的 message 里常带着地址，响应正文可能把密钥回显回来，都不往外带。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_GPT_MODEL = 'gpt-6-luna';
const URL_KEY = 'DISCUSS_GPT_BASE_URL';
const API_KEY = 'DISCUSS_GPT_API_KEY';

/**
 * @typedef {{ ok: true, text: string }} RelayOk
 * @typedef {{ ok: false, kind: 'timeout' } | { ok: false, kind: 'http', status: number } | { ok: false, kind: 'empty' } | { ok: false, kind: 'json' } | { ok: false, kind: 'network', code: string }} RelayFail
 * @typedef {RelayOk | RelayFail} RelayResult
 */

/**
 * @param {string} [home]
 */
export function discussEnvFile(home = homedir()) {
  return join(home, '.fleet-dao', 'discuss.env');
}

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    )
      value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * 两个都有才算配了。进程环境里出现过的名字盖过文件，空字符串也算盖过（等于没配）。
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, readFile?: (path: string) => string }} [opts]
 * @returns {{ baseUrl: string, apiKey: string } | null}
 */
export function gptRelayConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const readFile = opts.readFile ?? ((path) => readFileSync(path, 'utf8'));
  /** @type {Record<string, string>} */
  let file = {};
  try {
    file = parseEnvFile(readFile(discussEnvFile(home)));
  } catch {
    file = {};
  }
  const pick = (/** @type {string} */ key) => {
    if (Object.hasOwn(env, key) && env[key] !== undefined) return String(env[key]).trim();
    return (file[key] ?? '').trim();
  };
  const baseUrl = pick(URL_KEY).replace(/\/+$/, '');
  const apiKey = pick(API_KEY);
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/**
 * ask 的 askOne 和反方的 runCursor 原来各写一遍：空、没有核对码、去掉核对码那一行。
 * 对外的那句话仍由调用方按原来的字样拼。只剩核对码、正文被滤空，仍算答上（两条路径原来都这样）。
 * @param {string} raw
 * @param {string} nonce
 * @param {number} [sampleLen]
 * @returns {{ kind: 'ok', text: string } | { kind: 'empty' } | { kind: 'nonce', sample: string }}
 */
export function judgeCursorText(raw, nonce, sampleLen = 200) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { kind: 'empty' };
  if (!trimmed.includes(nonce)) return { kind: 'nonce', sample: trimmed.slice(0, sampleLen) };
  const text = trimmed
    .split(/\r?\n/)
    .filter((line) => !line.includes(nonce))
    .join('\n')
    .trim();
  return { kind: 'ok', text };
}

/**
 * @param {RelayFail} failure
 * @param {number} seconds
 */
export function relayFailureWhy(failure, seconds) {
  if (failure.kind === 'timeout') return `超过 ${seconds} 秒`;
  if (failure.kind === 'http') return `HTTP ${failure.status}`;
  if (failure.kind === 'empty') return '没有输出';
  if (failure.kind === 'json') return '回答不是 JSON';
  if (failure.kind === 'network' && failure.code) return `连不上（${failure.code}）`;
  return '连不上';
}

/**
 * @param {unknown} cause
 * @returns {string}
 */
function readCode(cause) {
  if (!cause || typeof cause !== 'object') return '';
  if ('code' in cause && typeof cause.code === 'string') return cause.code;
  if ('errors' in cause && Array.isArray(cause.errors)) {
    for (const item of cause.errors) {
      const code = readCode(item);
      if (code) return code;
    }
  }
  return '';
}

/**
 * @param {string} code
 */
function safeCode(code) {
  return /^[A-Z0-9_]+$/.test(code) ? code : '';
}

/**
 * @param {unknown} e
 */
function isTimeout(e) {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

/**
 * @param {unknown} body
 */
function assistantText(body) {
  if (typeof body !== 'object' || body === null || !('choices' in body)) return '';
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) return '';
  const message = first.message;
  if (typeof message !== 'object' || message === null || !('content' in message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string')
        return part.text;
      return '';
    })
    .join('');
}

/**
 * @param {{ baseUrl: string, apiKey: string, model: string, prompt: string, timeoutMs: number, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<RelayResult>}
 */
export async function completeChat(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, opts.timeoutMs);
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: 'user', content: opts.prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, kind: 'http', status: res.status };
    const raw = await res.text();
    /** @type {unknown} */
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, kind: 'json' };
    }
    const text = assistantText(body).trim();
    if (!text) return { ok: false, kind: 'empty' };
    return { ok: true, text };
  } catch (e) {
    if (isTimeout(e)) return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'network', code: safeCode(readCode(e instanceof Error ? e.cause : undefined)) };
  }
}
