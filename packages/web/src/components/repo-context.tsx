import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { brand } from '#brand';
import { useRepos } from '../api/client';
import type { Repo } from '../api/types';
import { useLocalState } from '../lib/hooks';

interface RepoApi {
  repo: Repo | undefined;
  repos: Repo[];
  /** 仓列表还在读。读完是空的就是真没有仓（不是没读到）。 */
  loading: boolean;
  error: unknown;
  setRepoId(id: string): void;
}

const Ctx = createContext<RepoApi | null>(null);

/** 顶栏上显示的仓。记在浏览器本地，下次打开还是它。 */
export function RepoProvider({ children }: { children: ReactNode }) {
  const { data, isPending, error } = useRepos();
  const [stored, setRepoId] = useLocalState<string | null>(`${brand.storagePrefix}repo`, null);
  const repos = data?.repos ?? [];
  const repo = repos.find((r) => r.id === stored) ?? repos[0];

  const value = useMemo(
    () => ({ repo, repos, loading: isPending, error, setRepoId }),
    [repo, repos, isPending, error, setRepoId],
  );
  return <Ctx value={value}>{children}</Ctx>;
}

export function useRepo(): RepoApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('缺少 RepoProvider');
  return ctx;
}
