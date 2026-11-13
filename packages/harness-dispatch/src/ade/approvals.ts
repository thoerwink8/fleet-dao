// 本机 ADE 的逐条审批（#3932）。只 claude 的 stream-json 控制协议能把「能不能用这个工具」交出来。
// grok、codex、pi 的 headless 流没有可回答的审批帧，不假装有。
export type ApprovalCategory = 'edit' | 'command' | 'network' | 'other';
export type ApprovalsMode = 'per-call' | 'none';

const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'search_replace', 'write_file']);
const COMMAND = new Set(['Bash', 'PowerShell', 'Shell']);
const NETWORK = new Set(['WebFetch', 'WebSearch', 'web_fetch', 'web_search']);

const INPUT_MAX = 2000;

export function toolCategory(name: string): ApprovalCategory {
  if (EDIT.has(name)) return 'edit';
  if (COMMAND.has(name)) return 'command';
  if (NETWORK.has(name)) return 'network';
  return 'other';
}

/** acceptEdits 已经盖住改文件。命令、联网和其余的要人点。 */
export function needsPerson(category: ApprovalCategory): boolean {
  return category !== 'edit';
}

/** 只有 claude 交得出逐条审批。能力以这个为准，界面不自己猜。 */
export function approvalsFor(agent: string): ApprovalsMode {
  return agent === 'claude' ? 'per-call' : 'none';
}

export function clipInput(input: unknown): { text: string; truncated: boolean } {
  const raw = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  if (raw.length <= INPUT_MAX) return { text: raw, truncated: false };
  return { text: raw.slice(0, INPUT_MAX), truncated: true };
}

export interface ToolAsk {
  requestId: string;
  tool: string;
  /** 允许时原样放回 updatedInput，不能换成空对象。 */
  input: unknown;
}

export type ControlRequest =
  | { kind: 'initialize'; requestId: string }
  | ({ kind: 'can_use_tool' } & ToolAsk)
  | { kind: 'other'; requestId: string; subtype: string };

/** 一行 stdout。不是控制帧就返回 null，调用方照旧当过程流。 */
export function parseControlRequest(line: string): ControlRequest | null {
  let msg: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    msg = v as Record<string, unknown>;
  } catch {
    return null;
  }
  if (msg.type !== 'control_request') return null;
  const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
  const request = msg.request;
  if (!requestId || !request || typeof request !== 'object' || Array.isArray(request)) return null;
  const req = request as Record<string, unknown>;
  const subtype = typeof req.subtype === 'string' ? req.subtype : '';
  if (subtype === 'initialize') return { kind: 'initialize', requestId };
  if (subtype === 'can_use_tool') {
    const tool =
      typeof req.tool_name === 'string' ? req.tool_name : typeof req.name === 'string' ? req.name : '';
    if (!tool) return { kind: 'other', requestId, subtype };
    return { kind: 'can_use_tool', requestId, tool, input: 'input' in req ? req.input : {} };
  }
  return { kind: 'other', requestId, subtype };
}

export function controlOk(requestId: string, response: unknown): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  });
}

export function allowFrame(requestId: string, input: unknown): string {
  return controlOk(requestId, { behavior: 'allow', updatedInput: input });
}

export function denyFrame(requestId: string): string {
  return controlOk(requestId, { behavior: 'deny', message: '人拒绝了' });
}

/** claude `--input-format stream-json` 的一句用户消息。session_id 用协议里的 default，续跑靠命令行的 --resume。 */
export function claudeUserLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: 'default',
  });
}

export function streamResult(line: string): boolean {
  try {
    const v: unknown = JSON.parse(line);
    return !!v && typeof v === 'object' && !Array.isArray(v) && (v as { type?: unknown }).type === 'result';
  } catch {
    return false;
  }
}
