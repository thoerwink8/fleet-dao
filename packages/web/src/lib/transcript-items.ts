// 一笔会话的条目怎么排（#1640、#1802、#3277）：调用和结果并起来、按过程同一套步骤分段、两句话之间连着的调用并成一组、
// 子代理收成一张卡。只有数据，不画东西；画在 components/run-transcript.tsx。
import { isSubagentMeta, type ProcessStep, toolClass } from '@fleet-dao/shared';
import type { TranscriptEntry } from '../api/types';

/** 渲染用的一行：工具调用和它的结果并成一行。 */
export type Item =
  | { kind: 'call'; call: TranscriptEntry; result: TranscriptEntry | undefined }
  | { kind: 'entry'; entry: TranscriptEntry };

export type TranscriptFilter = 'all' | 'errors' | 'text';

/** 子代理里的条目：引擎实际写的 meta.subagent 是它所属那次 Agent 调用的编号（字符串），老记录是 true。 */
export const isSub = (e: TranscriptEntry): boolean => isSubagentMeta(e.meta);

/** 子代理条目所属那次 Agent 调用的编号；老记录只有 true，拿不到。 */
const subOf = (e: TranscriptEntry): string | undefined =>
  typeof e.meta?.subagent === 'string' && e.meta.subagent !== '' ? e.meta.subagent : undefined;

export const callIdOf = (e: TranscriptEntry): string | undefined => {
  const v = e.meta?.callId;
  return typeof v === 'string' && v !== '' ? v : undefined;
};

export const subTypeOf = (e: TranscriptEntry): string => {
  const t = e.meta?.subagentType;
  return typeof t === 'string' && t ? t : '';
};

export const headOf = (item: Item): TranscriptEntry => (item.kind === 'call' ? item.call : item.entry);

/**
 * 工具调用和它的结果并起来。调用和结果都带原生调用号（meta.callId）的按调用号对：并行调用的结果倒序回来也不会错配。
 * 老记录没有调用号的按同工具、同一层往后找第一条结果：结果通常紧跟着；调用的是子代理时，结果在子代理那几条之后，
 * 中间又出现同层同工具的调用就不再找。找不到结果的（还没回来、被截掉的）单画调用。
 */
export function groupEntries(entries: readonly TranscriptEntry[]): Item[] {
  const items: Item[] = [];
  const used = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || used.has(i)) continue;
    if (e.kind !== 'tool_call') {
      items.push({ kind: 'entry', entry: e });
      continue;
    }
    let result: TranscriptEntry | undefined;
    const id = callIdOf(e);
    if (id !== undefined) {
      for (let j = i + 1; j < entries.length; j++) {
        const n = entries[j];
        if (n && !used.has(j) && n.kind === 'tool_result' && callIdOf(n) === id) {
          result = n;
          used.add(j);
          break;
        }
      }
      items.push({ kind: 'call', call: e, result });
      continue;
    }
    for (let j = i + 1; j < entries.length; j++) {
      const n = entries[j];
      if (!n || used.has(j) || isSub(n) !== isSub(e) || n.tool !== e.tool) continue;
      if (n.kind === 'tool_result') {
        result = n;
        used.add(j);
      }
      if (n.kind === 'tool_result' || n.kind === 'tool_call') break;
    }
    items.push({ kind: 'call', call: e, result });
  }
  return items;
}

/** 出错的条目：没成的工具调用、报错、没成的结论、对不上调用的没成的结果。 */
export function isFailedItem(item: Item): boolean {
  if (item.kind === 'call') return item.result?.ok === false;
  const e = item.entry;
  return e.kind === 'error' || ((e.kind === 'result' || e.kind === 'tool_result') && e.ok === false);
}

/** 文字类条目：提示词、助手的话、报错、结论、截断说明；工具调用和工具结果不算。 */
export function isTextItem(item: Item): boolean {
  if (item.kind === 'call') return false;
  return item.entry.kind !== 'tool_result';
}

export function filterItems(items: Item[], filter: TranscriptFilter): Item[] {
  if (filter === 'errors') return items.filter(isFailedItem);
  if (filter === 'text') return items.filter(isTextItem);
  return items;
}

/** 一组里的调用：不是派子代理的，就是对不上调用的结果（单画）。 */
export type ToolItem = Item;

/** 一张子代理卡：派它的那次调用（老记录可能找不到）、它的条目。 */
export interface SubagentCard {
  call: TranscriptEntry | undefined;
  /** 派它的那次调用的结果：子代理回的话。 */
  result: TranscriptEntry | undefined;
  type: string;
  items: Item[];
}

/** 会话里的一块：分隔线、一句话、一组调用、一张子代理卡，或单独一条（提示词、报错、结论、截断）。 */
export type Block =
  | { kind: 'divider'; step: ProcessStep }
  | { kind: 'say'; entry: TranscriptEntry }
  | { kind: 'tools'; items: ToolItem[] }
  | { kind: 'subagent'; card: SubagentCard }
  | { kind: 'entry'; entry: TranscriptEntry };

/** 一块的第一条序号（分段、窗口、key 都用它）。 */
export function blockSeq(b: Exclude<Block, { kind: 'divider' }>): number {
  if (b.kind === 'tools') return headOf(b.items[0] as Item).seq;
  if (b.kind === 'subagent') return b.card.call?.seq ?? headOf(b.card.items[0] as Item).seq;
  return b.entry.seq;
}

/** 一块里所有的条目（找的时候判命中、判有没有失败用）。 */
export function blockEntries(b: Block): TranscriptEntry[] {
  const ofItem = (i: Item) => (i.kind === 'call' ? [i.call, ...(i.result ? [i.result] : [])] : [i.entry]);
  switch (b.kind) {
    case 'divider':
      return [];
    case 'tools':
      return b.items.flatMap(ofItem);
    case 'subagent':
      return [
        ...(b.card.call ? [b.card.call] : []),
        ...b.card.items.flatMap(ofItem),
        ...(b.card.result ? [b.card.result] : []),
      ];
    default:
      return [b.entry];
  }
}

/**
 * 条目 → 一块一块（「全部」视图）：
 * - 主会话的话一句一块；两句话之间连着的调用（加对不上调用的结果）并成一组；
 * - 派子代理的调用和它带出来的条目收成一张卡（按调用号归；老记录没编号的，连着的子代理条目归到前一张卡）；
 * - 提示词、报错、结论、截断各自一块；
 * - steps（过程同一套切法）给了就在每一步开头插一条分隔线。
 */
export function buildBlocks(
  entries: readonly TranscriptEntry[],
  steps: readonly ProcessStep[] = [],
): Block[] {
  const out: Exclude<Block, { kind: 'divider' }>[] = [];
  const cards = new Map<string, SubagentCard>();
  let lastCard: SubagentCard | undefined;
  for (const item of groupEntries(entries)) {
    const head = headOf(item);
    if (isSub(head)) {
      const id = subOf(head);
      let card = id === undefined ? lastCard : cards.get(id);
      if (!card) {
        card = { call: undefined, result: undefined, type: subTypeOf(head), items: [] };
        out.push({ kind: 'subagent', card });
        if (id !== undefined) cards.set(id, card);
      }
      if (!card.type) card.type = subTypeOf(head);
      card.items.push(item);
      lastCard = card;
      continue;
    }
    if (item.kind === 'call' && toolClass(item.call.tool) === 'agent') {
      const card: SubagentCard = { call: item.call, result: item.result, type: '', items: [] };
      const id = callIdOf(item.call);
      if (id !== undefined) cards.set(id, card);
      out.push({ kind: 'subagent', card });
      lastCard = card;
      continue;
    }
    if (item.kind === 'call' || item.entry.kind === 'tool_result') {
      const prev = out.at(-1);
      if (prev?.kind === 'tools') prev.items.push(item);
      else out.push({ kind: 'tools', items: [item] });
      continue;
    }
    lastCard = undefined;
    if (item.entry.kind === 'assistant') out.push({ kind: 'say', entry: item.entry });
    else out.push({ kind: 'entry', entry: item.entry });
  }
  if (!steps.length) return out;
  // 每一步开头那块前面插分隔线：块按序号排，步骤也按序号排，一起往后走
  const blocks: Block[] = [];
  let s = 0;
  for (const b of out) {
    const seq = blockSeq(b);
    let step: ProcessStep | undefined;
    while (s < steps.length && (steps[s] as ProcessStep).firstSeq <= seq) {
      step = steps[s];
      s++;
    }
    if (step) blocks.push({ kind: 'divider', step });
    blocks.push(b);
  }
  return blocks;
}

/** 一组调用的一句话：「已运行 2 个命令，已读取 2 个文件 · 1 个失败」。 */
export function toolsSummary(items: readonly ToolItem[]): { text: string; failed: number } {
  const n = { command: 0, read: 0, edit: 0, search: 0, other: 0 };
  let failed = 0;
  for (const item of items) {
    if (isFailedItem(item)) failed++;
    if (item.kind !== 'call') continue;
    const cls = toolClass(item.call.tool);
    if (cls === 'command' || cls === 'read' || cls === 'edit' || cls === 'search') n[cls]++;
    else n.other++;
  }
  const parts = [
    n.command ? `已运行 ${n.command} 个命令` : '',
    n.read ? `已读取 ${n.read} 个文件` : '',
    n.edit ? `已编辑 ${n.edit} 次文件` : '',
    n.search ? `已搜索 ${n.search} 次` : '',
    n.other ? `调用了 ${n.other} 次工具` : '',
  ].filter(Boolean);
  const orphans = items.length - items.filter((i) => i.kind === 'call').length;
  if (!parts.length) parts.push(`${orphans} 条工具结果`);
  return { text: parts.join('，'), failed };
}

/** 文字里有没有这个词（不分大小写）。空词不算命中。 */
export function hasHit(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q !== '' && text.toLowerCase().includes(q);
}
