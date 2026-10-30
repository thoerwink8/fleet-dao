// 执行体每行输出判成哪一类、算不算「实质事件」（旧坑 A1）：只有助手回话、工具调用开始、工具结果算；
// system/init、进度提示、认不出的行（「Syncing config…」）都不算，起步时限照走。

export interface Frame {
  kind: 'init' | 'assistant' | 'tool_use' | 'tool_result' | 'result' | 'other';
  substantive: boolean;
  /** init 帧里的会话号（A3：按它对账接回、判两个会话号冲突）。 */
  sessionId?: string;
  /** 这一帧开了几个工具调用、收了几个：两者差就是还在跑的工具数，在跑时不判停滞。 */
  toolsOpened: number;
  toolsClosed: number;
  /** 人话的「停在哪一步」，超时原因里用（A2）。 */
  step: string;
}

const OTHER: Frame = { kind: 'other', substantive: false, toolsOpened: 0, toolsClosed: 0, step: '' };

interface Block {
  type?: unknown;
  name?: unknown;
}

/** Claude Code `--output-format stream-json` 的一行。 */
export function classifyClaudeLine(line: string): Frame {
  let msg: { type?: unknown; subtype?: unknown; session_id?: unknown; message?: { content?: unknown } };
  try {
    msg = JSON.parse(line);
  } catch {
    return { ...OTHER, step: `非事件输出：${line.slice(0, 60)}` };
  }
  if (!msg || typeof msg !== 'object') return OTHER;
  const blocks: Block[] = Array.isArray(msg.message?.content) ? (msg.message.content as Block[]) : [];
  const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
  const sid = sessionId ? { sessionId } : {};
  if (msg.type === 'system') {
    return msg.subtype === 'init'
      ? { ...OTHER, kind: 'init', ...sid, step: '会话起来（init）' }
      : { ...OTHER, ...sid, step: `系统消息 ${String(msg.subtype ?? '')}` };
  }
  if (msg.type === 'assistant') {
    const tools = blocks.filter((b) => b.type === 'tool_use');
    if (tools.length > 0) {
      const names = tools.map((b) => String(b.name ?? '?')).join('、');
      return {
        kind: 'tool_use',
        substantive: true,
        ...sid,
        toolsOpened: tools.length,
        toolsClosed: 0,
        step: `调工具 ${names}`,
      };
    }
    return { kind: 'assistant', substantive: true, ...sid, toolsOpened: 0, toolsClosed: 0, step: '助手回话' };
  }
  if (msg.type === 'user') {
    const results = blocks.filter((b) => b.type === 'tool_result').length;
    if (results > 0) {
      return {
        kind: 'tool_result',
        substantive: true,
        ...sid,
        toolsOpened: 0,
        toolsClosed: results,
        step: '工具结果',
      };
    }
    return { ...OTHER, ...sid, step: '用户消息' };
  }
  if (msg.type === 'result') return { ...OTHER, kind: 'result', ...sid, step: '收尾（result）' };
  return { ...OTHER, ...sid, step: `认不出的事件 ${String(msg.type ?? '')}` };
}
