// 提需求页的纯判断（#2062，方案 specs/2047-提需求/方案.md 第三、四节）。
// 改这里之前必须知道：
// - 菜单只出现详情 actions 里「能做」的项，不在前端猜规则（规则只有 shared 的 request-rules.ts 一份）。
// - 删不了时不出现「删除」：为什么删不了写在「放下」「归档」的悬停上；两样都没有时另给一句（deleteNote）。
// - 批量操作：读不到某条能不能做，就当做不了、留在选中里写原因，不当成能做。
import {
  isIdleCloseReason,
  type RequestActions,
  type RequestRow,
  type RequestStatus,
  type RequestWaiting,
} from '@fleet-dao/shared';
import type { RequestDetail } from '../../api/types';
import type { LayoutTone } from '../layout/tone';

export interface StatusView {
  tone: LayoutTone;
  /** 完整说法（列表悬停、头部悬停）。 */
  label: string;
  /** 头部小标签的短写。 */
  short: string;
}

const SHORT: Record<RequestStatus, string> = {
  discussing: '讨论中',
  pending_decision: '待拍板',
  closed_do: '已结案',
  closed_drop: '已结案',
};

/** 状态：讨论中、待拍板、已结案·不做；已结案·做之后跟着开出的单子走（单子状态由 B 片从 GitHub 接）。收口和「不做」同一个状态，靠原因那句认。 */
export function statusView(
  r: Pick<RequestRow, 'status' | 'issueRefs'> & { closeReason?: string | undefined },
): StatusView {
  const short = SHORT[r.status];
  if (r.status === 'discussing') return { tone: 'wait', label: '讨论中', short };
  if (r.status === 'pending_decision') return { tone: 'human', label: '待拍板', short };
  if (r.status === 'closed_drop' && isIdleCloseReason(r.closeReason))
    return { tone: 'stall', label: '收口', short: '收口' };
  if (r.status === 'closed_drop') return { tone: 'stop', label: '已结案·不做', short };
  const refs = r.issueRefs;
  if (refs.length === 0) return { tone: 'run', label: '已结案·做 · 等开单', short };
  if (refs.every((i) => i.state === 'deployed')) return { tone: 'done', label: '已结案·做 · 已上线', short };
  if (refs.every((i) => i.state === 'deployed' || i.state === 'merged'))
    return { tone: 'done', label: '已结案·做 · 已合并', short };
  if (refs.every((i) => i.state === 'closed')) return { tone: 'stop', label: '已结案·做 · 单子关了', short };
  return { tone: 'run', label: '已结案·做 · 在做', short };
}

const ISSUE_STATE_WORDS = { open: '开着', merged: '已合并', deployed: '已上线', closed: '关了' } as const;

export function issueStateWord(state: keyof typeof ISSUE_STATE_WORDS): string {
  return ISSUE_STATE_WORDS[state];
}

export function waitingLabel(w: RequestWaiting): string {
  return w === 'decide' ? '等我拍板' : w === 'engine_ask' ? '引擎在问我' : '有新消息';
}

/** 列表一行的最后一条消息：前面写是谁说的。 */
export function previewOf(r: RequestRow): string {
  const m = r.lastMessage;
  if (!m) return '';
  if (m.kind === 'commander') return `指挥官：${m.preview}`;
  if (m.kind === 'engine_ask') return `引擎：${m.preview}`;
  if (m.kind === 'review') return `别家挑错：${m.preview}`;
  if (m.kind === 'system') return m.preview;
  return m.authorName ? `${m.authorName}：${m.preview}` : m.preview;
}

export interface NestedRow {
  row: RequestRow;
  /** 「接着这条提」开出来的、原条也在这一页里：缩进挂在原条下面。 */
  child: boolean;
}

/** 「接着这条提」开出的新需求排到原条后面并缩进；原条不在这一页（筛掉了、归档了）的照常排。 */
export function nestRows(items: readonly RequestRow[]): NestedRow[] {
  const present = new Set(items.map((r) => r.seq));
  const childrenOf = new Map<number, RequestRow[]>();
  for (const r of items) {
    if (r.continuesSeq !== undefined && present.has(r.continuesSeq) && r.continuesSeq !== r.seq) {
      const list = childrenOf.get(r.continuesSeq) ?? [];
      list.push(r);
      childrenOf.set(r.continuesSeq, list);
    }
  }
  const out: NestedRow[] = [];
  const placed = new Set<number>();
  const place = (r: RequestRow, child: boolean) => {
    if (placed.has(r.seq)) return;
    placed.add(r.seq);
    out.push({ row: r, child });
    for (const c of childrenOf.get(r.seq) ?? []) place(c, true);
  };
  for (const r of items) {
    const isChild = r.continuesSeq !== undefined && present.has(r.continuesSeq);
    if (!isChild) place(r, false);
  }
  // 成环之类认不出的：照原顺序补上，不丢
  for (const r of items) place(r, false);
  return out;
}

export type MenuAction =
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'withdraw'
  | 'reopen'
  | 'drop'
  | 'archive'
  | 'unarchive'
  | 'delete'
  | 'restore';

export interface MenuEntry {
  action: MenuAction;
  label: string;
  /** 悬停：删不了时写在「放下」「归档」上。 */
  title?: string;
  danger?: boolean;
}

const MENU: readonly { action: MenuAction; label: string; danger?: boolean }[] = [
  { action: 'pin', label: '置顶' },
  { action: 'unpin', label: '取消置顶' },
  { action: 'rename', label: '改名' },
  { action: 'withdraw', label: '撤回到讨论中' },
  { action: 'reopen', label: '重开' },
  { action: 'drop', label: '放下（写理由）' },
  { action: 'archive', label: '归档' },
  { action: 'unarchive', label: '取消归档' },
  { action: 'restore', label: '恢复' },
  { action: 'delete', label: '删除', danger: true },
];

/** 菜单项：只出现 actions 里能做的。删不了时「放下」「归档」的悬停写为什么不能删。 */
export function menuFor(actions: RequestActions): MenuEntry[] {
  const del = actions.delete;
  const deleteWhy = del.allowed ? undefined : del.why;
  const out: MenuEntry[] = [];
  for (const m of MENU) {
    if (!actions[m.action].allowed) continue;
    const entry: MenuEntry = { action: m.action, label: m.label };
    if (m.danger) entry.danger = true;
    if (deleteWhy && (m.action === 'drop' || m.action === 'archive')) entry.title = deleteWhy;
    out.push(entry);
  }
  return out;
}

/** 删不了、菜单里又没有「放下」「归档」可挂原因时，单独写一句（删了的、能删的不写）。 */
export function deleteNote(actions: RequestActions): string | undefined {
  if (actions.delete.allowed || actions.restore.allowed) return undefined;
  if (actions.drop.allowed || actions.archive.allowed) return undefined;
  return actions.delete.why ? `删不了：${actions.delete.why}` : undefined;
}

export interface BulkTarget {
  seq: number;
  actions?: RequestActions | undefined;
  /** 读详情没成的原因。 */
  error?: string | undefined;
}

export interface BulkPlan {
  doable: number[];
  blocked: { seq: number; why: string }[];
}

const BULK_WORD = { archive: '归档', delete: '删' } as const;

/** 批量归档、批量删除：做得了的一起做，做不了的留在选中里写原因。没读到能不能做的也算做不了。 */
export function planBulk(kind: 'archive' | 'delete', targets: readonly BulkTarget[]): BulkPlan {
  const plan: BulkPlan = { doable: [], blocked: [] };
  for (const t of targets) {
    if (!t.actions) {
      plan.blocked.push({
        seq: t.seq,
        why: t.error
          ? `没读到这条能不能${BULK_WORD[kind]}：${t.error}`
          : `还在读这条能不能${BULK_WORD[kind]}，稍等再点`,
      });
      continue;
    }
    const v = t.actions[kind];
    if (v.allowed) plan.doable.push(t.seq);
    else plan.blocked.push({ seq: t.seq, why: v.why ?? `不能${BULK_WORD[kind]}` });
  }
  return plan;
}

/** 头部「下一步轮到谁」。 */
export function nextUp(d: RequestDetail, meId: string | undefined): string {
  const r = d.request;
  const mine = r.initiator.id === meId;
  if (r.deletedAt) return '已删除，30 天内能恢复';
  if (r.status === 'pending_decision') {
    if (!r.decider) return '等拍板';
    return r.decider.id === meId ? '等你拍板' : `等 ${r.decider.name} 拍板`;
  }
  if (r.status === 'closed_drop' && isIdleCloseReason(r.closeReason)) return `收口：${r.closeReason}`;
  if (r.status === 'closed_drop') return r.closeReason ? `不做：${r.closeReason}` : '不做';
  if (r.status === 'closed_do') {
    return r.issueRefs.length > 0 ? `开成 ${r.issueRefs.map((i) => `#${i.number}`).join('、')}` : '等开单';
  }
  const primary = r.needsDecision ? d.actions.submit : d.actions.confirm;
  if (!mine) return `草稿齐了由 ${r.initiator.name} ${r.needsDecision ? '提交拍板' : '确定'}`;
  if (primary.allowed) return r.needsDecision ? '草稿齐了，可以提交拍板' : '草稿齐了，可以确定开单';
  return primary.why ?? '接着聊';
}
