// API 的策略桥只借现有 engine App；不扩大令牌权限，不采用宽松 Bot login fallback。
import {
  latestPolicyStatus,
  type PolicyHead,
  type PolicyRepo,
  policyHead,
  policyRepo,
} from '@fleet-dao/shared';
import type { RepoRef } from './client.ts';
import type { Deps } from './deps.ts';
import { type CommitStatusInput, createClaimsGitHub } from './engine-pulls.ts';

export interface PolicyGitHub {
  repo(repo: RepoRef): Promise<PolicyRepo>;
  pull(repo: RepoRef, number: number, identity: PolicyRepo): Promise<PolicyHead>;
  openPulls(repo: RepoRef): Promise<number[]>;
  latest(
    repo: RepoRef,
    identity: PolicyRepo,
    head: string,
    context: string,
  ): Promise<Record<string, unknown> | null>;
  write(repo: RepoRef, identity: PolicyRepo, head: string, status: CommitStatusInput): Promise<void>;
}

export function createPolicyGitHub(deps: Deps): PolicyGitHub {
  const { client } = deps;
  const claims = createClaimsGitHub(deps);
  const path = (r: RepoRef) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
  const auth = (repo: RepoRef) => ({ as: 'engine' as const, repo });
  const result: PolicyGitHub = {
    async repo(repo) {
      const raw = await client.request({ method: 'GET', path: path(repo), auth: auth(repo) });
      const identity = policyRepo(raw.data);
      if (identity.repo.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase())
        throw new Error('策略仓名与 GitHub 不匹配');
      return identity;
    },
    async pull(repo, number, identity) {
      const raw = await client.request({
        method: 'GET',
        path: `${path(repo)}/pulls/${number}`,
        auth: auth(repo),
      });
      const head = policyHead(raw.data, identity);
      if (head.number !== number) throw new Error('策略 PR 号不匹配');
      return head;
    },
    async openPulls(repo) {
      return (await claims.openPulls(repo)).map((p) => p.number);
    },
    async latest(repo, identity, head, context) {
      const all = await client.all(
        {
          method: 'GET',
          path: `${path(repo)}/commits/${head}/statuses`,
          auth: auth(repo),
          query: { per_page: 100 },
        },
        (x) => x,
        30,
      );
      const bot = await deps.bots.identity('engine', repo);
      return latestPolicyStatus(all, identity, head, bot.userId, context, client.apiUrl);
    },
    async write(repo, identity, head, status) {
      await claims.setStatus(repo, head, status);
      const back = await result.latest(repo, identity, head, status.context);
      if (!back || back.state !== status.state || (back.target_url ?? null) !== (status.targetUrl ?? null))
        throw new Error(`策略 ${status.context} 写后严格回读未确认`);
    },
  };
  return result;
}
