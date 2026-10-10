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
  /** system/init 帧的 model；没有是 null。 */
  initModel: string | null;
  /** 第一条主会话 assistant 帧（parent_tool_use_id 为空）的 message.model；没有是 null。 */
  assistantModel: string | null;
}

/** 点名的模型和实际用的比：剥掉末尾 `[...]` 后缀、不分大小写（同 adapters/src/mirasim/run.ts 的 modelMatches）。 */
export function modelMatches(expected: string, observed: string): boolean {
  const strip = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\[[^\]]*\]$/, '');
  return strip(expected) === strip(observed);
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new StreamFormatError(`${what} 不是非负数：${String(v)}`);
  }
  return v;
}

export function parseStream(stdout: string): StreamSummary {
  let result: Record<string, unknown> | undefined;
  let initModel: string | null = null;
  let assistantModel: string | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    const e = ev as Record<string, unknown>;
    if (e.type === 'result') result = e;
    else if (e.type === 'system' && e.subtype === 'init' && initModel === null) {
      if (typeof e.model === 'string' && e.model) initModel = e.model;
    } else if (e.type === 'assistant' && assistantModel === null && !e.parent_tool_use_id) {
      const m = (e.message as { model?: unknown } | undefined)?.model;
      if (typeof m === 'string' && m) assistantModel = m;
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
    initModel,
    assistantModel,
  };
}
