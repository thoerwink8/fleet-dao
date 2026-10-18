import { type Locker, type PolicyGitHub, parseRepoSlug, type RepoRef, redact } from '@fleet-dao/github';
import {
  CI_POLICY_BRIDGE_VERSION,
  type CiPolicy,
  ciPolicyOf,
  type PolicyBridgeDescriptor,
  type PolicyRepo,
  type PolicyResponse,
  policyEndpoint,
  policyId,
  policyOrigin,
  policySourceContext,
  policySourceUrl,
} from '@fleet-dao/shared';
import { ApiError } from './http.ts';
import type { CiPolicyChange, GitHubEventSink } from './ports.ts';

export interface PolicyRow extends RepoRef {
  id: string;
  githubId: number | null;
  ciPolicy: CiPolicy;
}
export interface PolicySync {
  oldGreen: 'revoked' | 'not-applicable';
  source: 'queued' | 'not-applicable';
  finalGate: 'not-awaited';
}
export interface CiPolicyBridge {
  read(githubId: number): Promise<PolicyResponse>;
  describe(repo: RepoRef): Promise<PolicyBridgeDescriptor>;
  refresh(repo: RepoRef, forceEvent?: boolean): Promise<{ public: boolean; heads: number }>;
  publish(repo: RepoRef, number: number): Promise<void>;
  set(
    repo: RepoRef,
    mode: CiPolicy,
    commit: () => Promise<CiPolicyChange | 'not_found'>,
  ): Promise<{ change: CiPolicyChange; sync: PolicySync }>;
}

export function createCiPolicyBridge(deps: {
  origin: string;
  gh: PolicyGitHub;
  locker: Locker;
  log?: { error(message: string, fields?: Record<string, unknown>): void };
  find(repo: RepoRef): Promise<PolicyRow | null>;
  findByGithubId(id: number): Promise<PolicyRow | null>;
}): CiPolicyBridge {
  const origin = policyOrigin(deps.origin).origin;
  const checked = async (repo: RepoRef): Promise<{ row: PolicyRow; identity: PolicyRepo }> => {
    const row = await deps.find(repo);
    if (!row || !policyId(row.githubId)) throw new ApiError(404, 'policy_unavailable', '没有可用的公开策略');
    const identity = await deps.gh.repo(repo);
    if (
      identity.githubId !== row.githubId ||
      identity.repo.toLowerCase() !== `${row.owner}/${row.name}`.toLowerCase()
    )
      throw new ApiError(404, 'policy_unavailable', '没有可用的公开策略');
    return { row, identity };
  };
  const endpoint = (id: number) => policyEndpoint(origin, id);
  const publish = async (repo: RepoRef, identity: PolicyRepo, number: number, force: boolean) => {
    const head = await deps.gh.pull(repo, number, identity);
    if (!head.open || head.fork) return false;
    const url = policySourceUrl(endpoint(identity.githubId), head);
    const context = policySourceContext(number);
    const old = await deps.gh.latest(repo, identity, head.head, context);
    if (force || !old || old.state !== 'success' || old.target_url !== url)
      await deps.gh.write(repo, identity, head.head, {
        context,
        state: 'success',
        description: '当前数据库 CI 策略只读来源（非模式快照）',
        targetUrl: url,
      });
    const back = await deps.gh.pull(repo, number, identity);
    if (!back.open || back.head !== head.head || back.fork)
      throw new Error('source 发布期间 PR head 改变，请重试');
    return true;
  };
  const revoke = async (repo: RepoRef, identity: PolicyRepo) => {
    for (const number of await deps.gh.openPulls(repo)) {
      const head = await deps.gh.pull(repo, number, identity);
      if (!head.open || head.fork) continue;
      await deps.gh.write(repo, identity, head.head, {
        context: 'merge-gate',
        state: 'pending',
        description: 'CI 策略收紧，旧结论已撤，等待合并闸重算',
      });
    }
  };
  const bridge: CiPolicyBridge = {
    async read(id) {
      if (!policyId(id)) throw new ApiError(404, 'policy_unavailable', '没有可用的公开策略');
      const row = await deps.findByGithubId(id);
      if (!row || row.githubId !== id) throw new ApiError(404, 'policy_unavailable', '没有可用的公开策略');
      const { identity } = await checked(row);
      if (!identity.public) throw new ApiError(404, 'policy_unavailable', '没有可用的公开策略');
      // 元信息核过以后重新读唯一 DB 行，不沿用前一次读取的 mode。
      const current = await deps.findByGithubId(id);
      if (
        !current ||
        current.githubId !== id ||
        current.id !== row.id ||
        current.owner !== row.owner ||
        current.name !== row.name
      )
        throw new ApiError(404, 'policy_unavailable', '没有可用的公开策略');
      return {
        version: CI_POLICY_BRIDGE_VERSION,
        githubId: id,
        repo: identity.repo,
        ciPolicy: ciPolicyOf(current.ciPolicy),
      };
    },
    async describe(repo) {
      const { identity } = await checked(repo);
      return {
        version: 1,
        endpoint: identity.public ? endpoint(identity.githubId) : null,
        public: identity.public,
        publisher: true,
      };
    },
    async publish(repo, number) {
      const { identity } = await checked(repo);
      if (identity.public) await publish(repo, identity, number, false);
    },
    async refresh(repo, forceEvent = false) {
      const { identity } = await checked(repo);
      if (!identity.public) return { public: false, heads: 0 };
      const numbers = await deps.gh.openPulls(repo);
      let heads = 0;
      for (const n of numbers) if (await publish(repo, identity, n, forceEvent)) heads++;
      return { public: true, heads };
    },
    async set(repo, mode, commit) {
      let dbState: 'not-attempted' | 'unconfirmed' | 'committed' = 'not-attempted';
      let oldGreen: PolicySync['oldGreen'] | 'unconfirmed' = 'not-applicable';
      let source: PolicySync['source'] | 'unconfirmed' = 'not-applicable';
      try {
        return await deps.locker.withLock(
          `ci-policy:${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`,
          async () => {
            const { identity } = await checked(repo);
            if (!identity.public && mode === 'off')
              throw new ApiError(409, 'private_off_unsupported', '私有仓尚不支持 off 的可信读桥');
            if (identity.public && mode === 'force') {
              oldGreen = 'unconfirmed';
              await revoke(repo, identity);
              oldGreen = 'revoked';
            }
            dbState = 'unconfirmed';
            const change = await commit();
            if (change === 'not_found') throw new ApiError(404, 'repo_not_found', '没有这个项目');
            dbState = 'committed';
            if (identity.public) {
              if (mode === 'force') {
                oldGreen = 'unconfirmed';
                await revoke(repo, identity);
                oldGreen = 'revoked';
              }
              source = 'unconfirmed';
              const refreshed = await bridge.refresh(repo, true);
              source = refreshed.heads > 0 ? 'queued' : 'not-applicable';
            }
            const back = await deps.find(repo);
            if (!back || back.ciPolicy !== mode) throw new Error('CI 策略提交后被别的请求改变，需重试');
            if (oldGreen === 'unconfirmed' || source === 'unconfirmed') throw new Error('策略同步阶段未确认');
            return { change, sync: { oldGreen, source, finalGate: 'not-awaited' as const } };
          },
        );
      } catch (e) {
        deps.log?.error('CI 策略切换未完整确认', {
          dbState,
          oldGreen,
          source,
          error: redact(e instanceof Error ? e.message : String(e)),
        });
        if (e instanceof ApiError && dbState === 'not-attempted' && oldGreen === 'not-applicable') throw e;
        throw new ApiError(
          503,
          'ci_policy_sync_incomplete',
          'CI 模式切换未完整确认，可重试；未确认最终合并闸结论',
          { dbState, oldGreen, source, finalGate: 'not-awaited' },
        );
      }
    },
  };
  return bridge;
}

/** 必须在 intake 的 await accept 内：失败记 failed，沿同一本投递账重放；不依赖 wake。 */
export function withPolicySource(sink: GitHubEventSink, bridge: CiPolicyBridge): GitHubEventSink {
  return {
    async accept(ev) {
      if (ev.event === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(ev.action ?? '')) {
        const payload = ev.payload as { pull_request?: { number?: unknown } };
        if (!policyId(payload?.pull_request?.number)) throw new Error('source PR 事件缺可信单号');
        await bridge.publish(parseRepoSlug(ev.repo), payload.pull_request.number);
      }
      await sink.accept(ev);
    },
  };
}
