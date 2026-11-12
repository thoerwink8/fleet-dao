// 会话列表的标题和预览。标题用会话自己的名字，不用会话号。
// 预览只取人能读的最后一句，不拿「轮次开始」这类内部事件名来充。编码被当成 Latin-1 的 UTF-8 在这里修回来。

const INTERNAL = new Set([
  'session.created',
  'session.turn.started',
  'worker.spawned',
  'worker.settled',
  'worker.spawn.requested',
  'worker.stop.requested',
  'worker.progress.reported',
  'worker.result.submitted',
  'handback.recorded',
]);

export function sessionTitle(adeTitle: string | undefined): string {
  const t = adeTitle?.replace(/\s+/g, ' ').trim();
  return t || '新会话';
}

function cjkCount(s: string): number {
  return (s.match(/[\u3400-\u9fff]/g) ?? []).length;
}

/** UTF-8 被按 Latin-1 存进字符串时，还原成原文。已经是正常中文的不动。 */
export function repairMojibake(s: string): string {
  if (s.length === 0 || s.length > 8000) return s;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  try {
    const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (out !== s && cjkCount(out) > cjkCount(s)) return out;
  } catch {
    /* 不是合法 UTF-8，保持原样 */
  }
  return s;
}

function unwrapJson(text: string): string {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return stripAnsi(t);
  try {
    const m = JSON.parse(t) as {
      type?: string;
      result?: unknown;
      message?: { content?: { type?: string; text?: string }[] };
      text?: unknown;
    };
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      const parts = m.message.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text ?? '');
      if (parts.length) return parts.join('\n');
    }
    if (typeof m.result === 'string' && m.result.trim()) return m.result;
    if (typeof m.text === 'string' && m.text.trim()) return m.text;
  } catch {
    /* 不是 JSON */
  }
  return stripAnsi(t);
}

function stripAnsi(s: string): string {
  const esc = String.fromCharCode(27);
  return s.replace(new RegExp(`${esc}\\[[0-9;]*m`, 'g'), '');
}

function pullText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  for (const key of ['text', 'summary', 'result'] as const) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** 列表副行。内部事件返回空串，调用方不要再补事件名。 */
export function previewText(type: string, payload: unknown): string {
  if (INTERNAL.has(type)) return '';
  const raw = unwrapJson(repairMojibake(pullText(payload)));
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line || line === type) return '';
  return [...line].slice(0, 80).join('');
}
