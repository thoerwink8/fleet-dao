// 从 stream-json（一行一个事件）里读出：最终回答、token、回合数。
// 认不出（没有 result 事件、result 事件缺字段）抛 StreamFormatError，由调用方记成「没跑成」，不当没过也不当过。
export class StreamFormatError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'StreamFormatError';
  }
}

export interface StreamSummary {
  /** 最终回答（result 事件的 result）。 */
  answer: string;
  /** 输入 token：新输入加缓存读、缓存写，三项之和。 */
  inputTokens: number;
  outputTokens: number;
  /** 会话自己报的回合数，没报是 undefined。 */
  numTurns: number | undefined;
  /** 会话自己报的出错（is_error）；调用方记成没跑成。 */
  isError: boolean;
  subtype: string | undefined;
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new StreamFormatError(`${what} 不是非负数：${String(v)}`);
  }
  return v;
}

export function parseStream(stdout: string): StreamSummary {
  let result: Record<string, unknown> | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev && typeof ev === 'object' && (ev as { type?: unknown }).type === 'result') {
      result = ev as Record<string, unknown>;
    }
  }
  if (!result) throw new StreamFormatError('输出里没有 type=result 的事件');
  const isError = result.is_error === true;
  const usage = result.usage;
  if (!usage || typeof usage !== 'object') throw new StreamFormatError('result 事件没有 usage');
  const u = usage as Record<string, unknown>;
  const optional = (k: string) => (u[k] === undefined ? 0 : num(u[k], `usage.${k}`));
  const inputTokens =
    num(u.input_tokens, 'usage.input_tokens') +
    optional('cache_creation_input_tokens') +
    optional('cache_read_input_tokens');
  const outputTokens = num(u.output_tokens, 'usage.output_tokens');
  const answer = result.result;
  if (typeof answer !== 'string' && !isError) {
    throw new StreamFormatError('result 事件的 result 不是字符串');
  }
  return {
    answer: typeof answer === 'string' ? answer : '',
    inputTokens,
    outputTokens,
    numTurns: typeof result.num_turns === 'number' ? result.num_turns : undefined,
    isError,
    subtype: typeof result.subtype === 'string' ? result.subtype : undefined,
  };
}
