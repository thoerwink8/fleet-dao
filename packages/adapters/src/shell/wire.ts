// 接口外壳的两种线格式：OpenAI 兼容的 chat/completions、Anthropic 的 messages。只做「对话 + 工具调用」这一个子集：
// 把内部的对话记录拼成请求体，把回包解析成统一的「说了什么、要调哪些工具、为什么停、用了多少」。
import { num, rec, str } from '../stream-kit.ts';

export type ShellFormat = 'openai-chat' | 'anthropic-messages';

export interface ShellToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ShellToolResult {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

/** 内部的对话记录：续跑就是把上一轮的记录原样带回来。 */
export type ShellMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ShellToolCall[] }
  | { role: 'tool'; results: ShellToolResult[] };

export interface ShellToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ShellReply {
  text: string;
  toolCalls: ShellToolCall[];
  /** stop / end_turn = 说完了；tool_calls / tool_use = 要调工具；length / max_tokens = 被截断。 */
  stopReason: string;
  /** 回包里的模型（观测值）。 */
  model?: string;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}

export interface ShellApi {
  format: ShellFormat;
  /** OpenAI 兼容给到版本那一级（例如 https://host/v1）；Anthropic 给根（例如 https://api.anthropic.com）。 */
  baseUrl: string;
  model: string;
  /** 只在引擎进程里用来发请求，不进任何日志、报告和子进程环境。 */
  apiKey: string;
  maxTokens?: number;
}

export function requestFor(
  api: ShellApi,
  system: string,
  messages: readonly ShellMessage[],
  tools: readonly ShellToolSpec[],
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = api.baseUrl.replace(/\/+$/, '');
  if (api.format === 'openai-chat') {
    return {
      url: `${base}/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${api.apiKey}` },
      body: {
        model: api.model,
        ...(api.maxTokens ? { max_tokens: api.maxTokens } : {}),
        messages: [{ role: 'system', content: system }, ...messages.flatMap(openaiMessage)],
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
      },
    };
  }
  return {
    url: `${base}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': api.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: api.model,
      max_tokens: api.maxTokens ?? 8192,
      system,
      messages: messages.map(anthropicMessage),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    },
  };
}

function openaiMessage(m: ShellMessage): Record<string, unknown>[] {
  if (m.role === 'user') return [{ role: 'user', content: m.text }];
  if (m.role === 'assistant') {
    return [
      {
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      },
    ];
  }
  return m.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.output }));
}

function anthropicMessage(m: ShellMessage): Record<string, unknown> {
  if (m.role === 'user') return { role: 'user', content: [{ type: 'text', text: m.text }] };
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: [
        ...(m.text ? [{ type: 'text', text: m.text }] : []),
        ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
      ],
    };
  }
  return {
    role: 'user',
    content: m.results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: r.output,
      is_error: r.isError,
    })),
  };
}

/** 回包认不出就抛：调用方记成 bad_response，不拿空回复冒充「说完了」。 */
export function parseReply(format: ShellFormat, body: unknown): ShellReply {
  const root = rec(body);
  if (!root) throw new Error('回包不是 JSON 对象');
  if (format === 'openai-chat') {
    const choice = rec(Array.isArray(root.choices) ? root.choices[0] : undefined);
    const message = rec(choice?.message);
    if (!choice || !message) throw new Error('回包里没有 choices[0].message');
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls = calls.map((raw, i) => {
      const call = rec(raw);
      const fn = rec(call?.function);
      const name = str(fn?.name);
      if (!call || !name) throw new Error(`第 ${i + 1} 个工具调用没有名字`);
      return { id: str(call.id) ?? `call_${i}`, name, input: parseArgs(fn?.arguments) };
    });
    const usage = rec(root.usage);
    return {
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      stopReason: str(choice.finish_reason) ?? (toolCalls.length ? 'tool_calls' : 'unknown'),
      ...(str(root.model) ? { model: str(root.model) as string } : {}),
      usage: {
        ...numberOf('inputTokens', num(usage?.prompt_tokens)),
        ...numberOf('outputTokens', num(usage?.completion_tokens)),
        ...numberOf('cacheReadTokens', num(rec(usage?.prompt_tokens_details)?.cached_tokens)),
      },
    };
  }
  if (!Array.isArray(root.content)) throw new Error('回包里没有 content 数组');
  let text = '';
  const toolCalls: ShellToolCall[] = [];
  for (const raw of root.content) {
    const block = rec(raw);
    if (block?.type === 'text') text += str(block.text) ?? '';
    else if (block?.type === 'tool_use') {
      const name = str(block.name);
      if (!name) throw new Error('tool_use 没有名字');
      toolCalls.push({
        id: str(block.id) ?? `toolu_${toolCalls.length}`,
        name,
        input: rec(block.input) ?? {},
      });
    }
  }
  const usage = rec(root.usage);
  return {
    text,
    toolCalls,
    stopReason: str(root.stop_reason) ?? 'unknown',
    ...(str(root.model) ? { model: str(root.model) as string } : {}),
    usage: {
      ...numberOf('inputTokens', num(usage?.input_tokens)),
      ...numberOf('outputTokens', num(usage?.output_tokens)),
      ...numberOf('cacheReadTokens', num(usage?.cache_read_input_tokens)),
    },
  };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return rec(raw) ?? {};
  try {
    return rec(JSON.parse(raw)) ?? {};
  } catch {
    // 模型给的参数不是 JSON：交给工具报「参数不对」，让模型自己改
    return { __unparsed: raw };
  }
}

function numberOf<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: number };
}

/** 说完了没有：两家的写法不同。 */
export function finished(reply: ShellReply): boolean {
  return reply.toolCalls.length === 0 && ['stop', 'end_turn', 'stop_sequence'].includes(reply.stopReason);
}

export function truncated(reply: ShellReply): boolean {
  return ['length', 'max_tokens'].includes(reply.stopReason);
}
