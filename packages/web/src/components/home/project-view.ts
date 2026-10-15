// 看板（/board）按顶栏当前项目收：别的仓的单、决定、做完的 PR 不画、不列。
// 没有 repo 的（整机的事，或老快照没写）留下。还没选出项目时不筛，免得仓列表没到就先刷成空的。

export function repoSlug(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

function repoField(item: object): string | null | undefined {
  if (!('repo' in item)) return undefined;
  const value = (item as { repo?: unknown }).repo;
  // 不是字符串（null、没写、老快照）当没挂仓：整机的事留下。
  return typeof value === 'string' ? value : null;
}

export function visibleForProject<T extends object>(
  items: readonly T[],
  slug: string | undefined,
): readonly T[] {
  if (slug === undefined) return items;
  return items.filter((item) => {
    const repo = repoField(item);
    return repo == null || repo === slug;
  });
}
