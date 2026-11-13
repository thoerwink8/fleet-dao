// 上下文用量（#3931）。只认执行体这一帧里给出的数。缺的字段不补 0，不拿模型名去猜窗口。
//
// Claude stream-json：
// - assistant.message.usage 是这一次调用的 input_tokens、output_tokens、
//   cache_read_input_tokens、cache_creation_input_tokens。带 parent_tool_use_id 的是子代理，另一个窗口，不算。
// - result.usage 是终帧上的同名字段（这一次调用）。帧里没有窗口大小。
// Grok streaming-json：
// - type=usage 的 usage 是这一次调用，另有 reasoning_tokens。
// - type=end 的 usage 是这一轮各次调用加总（和 usage 帧逐项对得上），不是当前窗口，不拿来显示。
// - 帧里没有窗口大小。
// Codex、pi 没有这几样。没有准数时 contextLabel 是「未知」。

export interface ContextReading {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  /** 只有帧里写了窗口大小才有。没有就不填。 */
  windowTokens?: number;
}

const USAGE_FIELDS = {
  inputTokens: ['input_tokens', 'inputTokens'],
  outputTokens: ['output_tokens', 'outputTokens'],
  cacheReadInputTokens: ['cache_read_input_tokens', 'cacheReadInputTokens'],
  cacheCreationInputTokens: ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  reasoningTokens: ['reasoning_tokens', 'reasoningTokens'],
} as const;

const WINDOW_FIELDS = [
  'context_window',
  'contextWindow',
  'max_context_tokens',
  'window_tokens',
  'windowTokens',
];

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function pick(obj: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const n = finite(obj[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** 从一个 usage 对象抄出给过的数字。一个都没有就是 null。 */
export function readingFromUsage(usage: unknown, also?: unknown): ContextReading | null {
  const source = rec(usage);
  if (!source) return null;
  const reading: ContextReading = {};
  for (const [field, keys] of Object.entries(USAGE_FIELDS) as [
    keyof typeof USAGE_FIELDS,
    readonly string[],
  ][]) {
    const n = pick(source, keys);
    if (n !== undefined) reading[field] = n;
  }
  const window = pick(source, WINDOW_FIELDS) ?? pick(rec(also), WINDOW_FIELDS);
  if (window !== undefined) reading.windowTokens = window;
  return Object.keys(reading).length > 0 ? reading : null;
}

/**
 * 这一次调用占了多少上下文：输入、缓存读、缓存写三样都在才相加。
 * 缺一就不把缺的当成 0。输出和推理不进这个数。
 */
export function usedTokens(reading: ContextReading): number | null {
  const input = reading.inputTokens;
  const cacheRead = reading.cacheReadInputTokens;
  const cacheWrite = reading.cacheCreationInputTokens;
  if (typeof input !== 'number' || typeof cacheRead !== 'number' || typeof cacheWrite !== 'number') {
    return null;
  }
  return input + cacheRead + cacheWrite;
}

/** 「用了多少 / 窗口多大」。两边都没有准数时整句是「未知」。 */
export function contextLabel(reading: ContextReading | null | undefined): string {
  if (!reading) return '未知';
  const used = usedTokens(reading);
  const window = typeof reading.windowTokens === 'number' ? reading.windowTokens : null;
  if (used === null && window === null) return '未知';
  return `${used === null ? '未知' : String(used)} / ${window === null ? '未知' : String(window)}`;
}

/** 一行标准输出。这一行没有可用的用量就返回 null，调用方保留上一笔。 */
export function contextFromStreamLine(agent: string, line: string): ContextReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const frame = rec(parsed);
  if (!frame) return null;
  if (agent === 'claude') {
    if (frame.type === 'assistant') {
      if (typeof frame.parent_tool_use_id === 'string' && frame.parent_tool_use_id !== '') return null;
      const message = rec(frame.message);
      return readingFromUsage(message?.usage, message);
    }
    if (frame.type === 'result') return readingFromUsage(frame.usage, frame);
    return null;
  }
  if (agent === 'grok') {
    if (frame.type !== 'usage') return null;
    return readingFromUsage(frame.usage, frame);
  }
  return null;
}
