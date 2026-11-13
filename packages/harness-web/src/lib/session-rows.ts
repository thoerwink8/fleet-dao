// 侧栏一行从哪来：有 ADE 会话行的用那一行；内核里有、会话表里没有的才是内核行。
// 列表筛掉的（已归档、标题对不上）不是内核行。
import type { AdeSession, AdeWorkspace } from './ade';
import { previewText, sessionTitle } from './preview';
import type { SessionSummary } from './types';

export interface SessionListRow {
  id: string;
  parentId: string | null;
  title: string;
  preview: string;
  workspaceId: string;
  workspaceName: string;
  agent: string;
  model: string;
  running: boolean;
  pinned: boolean;
  /** null：不是 ADE 会话，没有「跑了几轮」这个数。 */
  turns: number | null;
  lastAt: number;
}

export function buildRows(
  ade: AdeSession[],
  cockpit: SessionSummary[] | null,
  spaces: AdeWorkspace[],
  includeKernel: boolean,
  knownAdeIds: ReadonlySet<string>,
): SessionListRow[] {
  const byId = new Map((cockpit ?? []).map((s) => [s.id, s]));
  const names = new Map(spaces.map((w) => [w.id, w.name]));
  const seen = new Set<string>();
  const rows: SessionListRow[] = [];
  for (const s of ade) {
    seen.add(s.id);
    const c = byId.get(s.id);
    rows.push({
      id: s.id,
      parentId: s.parentId ?? null,
      title: sessionTitle(s.title),
      preview: c ? previewText(c.lastType, c.lastPayload) : '',
      workspaceId: s.workspaceId,
      workspaceName: names.get(s.workspaceId) ?? '工作区',
      agent: s.agent ?? '',
      model: s.model ?? '',
      running: s.status === 'running',
      pinned: s.pinned === true,
      turns: s.turns ?? 0,
      lastAt: Date.parse(s.updatedAt ?? c?.lastAt ?? '') || 0,
    });
  }
  if (!includeKernel) return rows;
  for (const s of cockpit ?? []) {
    if (seen.has(s.id) || knownAdeIds.has(s.id)) continue;
    rows.push({
      id: s.id,
      parentId: null,
      title: sessionTitle(undefined),
      preview: previewText(s.lastType, s.lastPayload),
      workspaceId: '',
      workspaceName: '内核',
      agent: '',
      model: '',
      running: false,
      pinned: false,
      turns: null,
      lastAt: Date.parse(s.lastAt) || 0,
    });
  }
  return rows;
}
