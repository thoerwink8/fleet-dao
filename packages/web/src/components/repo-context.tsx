import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import { brand } from '#brand';
import { keys, useApi, useRepos } from '../api/client';
import type { Repo } from '../api/types';
import { useLocalState } from '../lib/hooks';

interface RepoApi {
  repoId: string | undefined;
  repo: Repo | undefined;
  repos: Repo[];
  /** 仓列表还在读。读完是空的就是真没有仓（不是没读到）。 */
  loading: boolean;
  error: unknown;
  setRepoId(id: string): void;
}

const Ctx = createContext<RepoApi | null>(null);

/** 上次读到的仓编号：只拿来提前拉看板，不拿来显示（显示一律等这次的仓列表）。 */
const HINT_KEY = `${brand.storagePrefix}repo-ids`;

function readHint(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HINT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** 当前看的仓（看板按仓切换）。记在浏览器本地，下次打开还是它。 */
export function RepoProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isPending, error } = useRepos();
  const [stored, setRepoId] = useLocalState<string | null>(`${brand.storagePrefix}repo`, null);
  const repos = data?.repos ?? [];
  const repo = repos.find((r) => r.id === stored) ?? repos[0];

  // 看板要先有仓列表才知道拉哪几个，经香港转到法国每一轮约 0.2 秒：按上次的仓先把看板和仓列表一起拉，
  // 列表回来后看板、侧栏、总览用的是同一份缓存，不再等一轮。上次的仓这次没了，白拉一次，没有别的影响。
  useEffect(() => {
    for (const id of readHint()) {
      void qc.prefetchQuery({ queryKey: keys.board(id), queryFn: () => api.board(id) });
    }
  }, [api, qc]);
  useEffect(() => {
    if (!data) return;
    try {
      localStorage.setItem(HINT_KEY, JSON.stringify(data.repos.map((r) => r.id)));
    } catch {
      // 存不了就下次照旧等仓列表。
    }
  }, [data]);

  const value = useMemo(
    () => ({ repoId: repo?.id, repo, repos, loading: isPending, error, setRepoId }),
    [repo, repos, isPending, error, setRepoId],
  );
  return <Ctx value={value}>{children}</Ctx>;
}

export function useRepo(): RepoApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('缺少 RepoProvider');
  return ctx;
}
