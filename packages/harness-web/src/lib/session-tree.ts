// 会话列表里子会话挂在父会话下面。父会话不在这一页里时，子会话自己当一行，不藏起来。

export interface SessionNode {
  id: string;
  parentId: string | null;
}

export type NestedSession<T> = T & { children: NestedSession<T>[] };

/** 有父会话、并且父会话也在 rows 里的，收进父会话的 children。 */
export function nestSessions<T extends SessionNode>(rows: readonly T[]): NestedSession<T>[] {
  const ids = new Set(rows.map((r) => r.id));
  const byParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const row of rows) {
    if (row.parentId && ids.has(row.parentId)) {
      const list = byParent.get(row.parentId) ?? [];
      list.push(row);
      byParent.set(row.parentId, list);
    } else {
      roots.push(row);
    }
  }
  const build = (row: T, seen: Set<string>): NestedSession<T> => {
    if (seen.has(row.id)) return { ...row, children: [] };
    const next = new Set(seen);
    next.add(row.id);
    return {
      ...row,
      children: (byParent.get(row.id) ?? []).map((child) => build(child, next)),
    };
  };
  return roots.map((row) => build(row, new Set()));
}

/** 命中的会话留下，它的父会话和子会话也留下，避免搜到子会话时父会话消失。 */
export function matchingFamilies<T extends SessionNode>(rows: readonly T[], match: (row: T) => boolean): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const keep = new Set<string>();
  for (const row of rows) {
    if (!match(row)) continue;
    keep.add(row.id);
    let parentId = row.parentId;
    const seen = new Set<string>([row.id]);
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      keep.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parentId && keep.has(row.parentId) && !keep.has(row.id)) {
        keep.add(row.id);
        grew = true;
      }
    }
  }
  return rows.filter((row) => keep.has(row.id));
}
