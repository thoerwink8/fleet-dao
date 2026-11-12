// 对话主视图里放什么。内部事件（会话建立、轮次开始、派工）不进主视图，留给调试。
import type { TimelineItem } from './transcript';

export function isMainChat(item: TimelineItem): boolean {
  if (
    item.kind === 'say' ||
    item.kind === 'tool' ||
    item.kind === 'toolrun' ||
    item.kind === 'end' ||
    item.kind === 'dropped'
  ) {
    return true;
  }
  if (item.kind === 'event' && item.ev.type === 'session.message') {
    const text = item.ev.payload.text;
    return typeof text === 'string' && text.trim() !== '';
  }
  return false;
}

export function splitConversation(items: TimelineItem[]): { main: TimelineItem[]; debug: TimelineItem[] } {
  const main: TimelineItem[] = [];
  const debug: TimelineItem[] = [];
  for (const item of items) (isMainChat(item) ? main : debug).push(item);
  return { main, debug };
}

export interface DiffFile {
  path: string;
  add: number;
  del: number;
}

/** 从 unified diff 数每个文件的增删行。 */
export function summarizeDiff(diff: string): { files: number; add: number; del: number; rows: DiffFile[] } {
  const rows: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const line of diff.split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2] ?? head[1] ?? '', add: 0, del: 0 };
      rows.push(cur);
      continue;
    }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) cur.add += 1;
    else if (line.startsWith('-')) cur.del += 1;
  }
  return {
    files: rows.length,
    add: rows.reduce((n, r) => n + r.add, 0),
    del: rows.reduce((n, r) => n + r.del, 0),
    rows,
  };
}

const READ = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function toolPhrase(steps: { name: string }[]): string {
  if (steps.length === 0) return '调了工具';
  const reads = steps.filter((s) => READ.has(s.name)).length;
  const edits = steps.filter((s) => EDIT.has(s.name)).length;
  const shells = steps.filter((s) => s.name === 'Bash' || s.name === 'PowerShell').length;
  if (reads === steps.length) return `读了 ${reads} 个文件`;
  if (edits === steps.length) return `改了 ${edits} 个文件`;
  if (shells === steps.length) return `跑了 ${shells} 条命令`;
  return `调了 ${steps.length} 个工具`;
}
