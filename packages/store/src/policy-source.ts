import { type PolicyGitHub, parseRepoSlug, type RepoRef } from '@fleet-dao/github';
import {
  policyEndpoint,
  policyId,
  policyOrigin,
  policySourceContext,
  policySourceUrl,
} from '@fleet-dao/shared';
import type { GitHubEventSink } from './ports.ts';

export class PolicySourceUnavailable extends Error {}

/** API webhook 与 engine replay/poll 共用的可信 writer；不携带 DB 模式快照。 */
export function createPolicySourcePublisher(deps: {
  origin: string | (() => string);
  gh: PolicyGitHub;
  find(repo: RepoRef): Promise<{ owner: string; name: string; githubId: number | null } | null>;
}) {
  return {
    async publish(repo: RepoRef, number: number, force = false): Promise<boolean> {
      if (!policyId(number)) throw new Error('source PR 事件缺可信单号');
      const row = await deps.find(repo);
      if (!row || !policyId(row.githubId)) throw new PolicySourceUnavailable('没有可用的公开策略');
      const identity = await deps.gh.repo(repo);
      if (
        identity.githubId !== row.githubId ||
        identity.repo.toLowerCase() !== `${row.owner}/${row.name}`.toLowerCase()
      )
        throw new PolicySourceUnavailable('没有可用的公开策略');
      if (!identity.public) return false;
      const head = await deps.gh.pull(repo, number, identity);
      if (!head.open || head.fork) return false;
      const origin = policyOrigin(typeof deps.origin === 'string' ? deps.origin : deps.origin()).origin;
      const url = policySourceUrl(policyEndpoint(origin, identity.githubId), head);
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
    },
  };
}

/** 必须在 intake 的 await accept 内：失败记 failed，沿同一本投递账重放；不依赖 wake。 */
export function withPolicySource(
  sink: GitHubEventSink,
  publisher: { publish(repo: RepoRef, number: number): Promise<unknown> },
): GitHubEventSink {
  return {
    async accept(ev) {
      if (
        ev.event === 'pull_request' &&
        ['opened', 'synchronize', 'reopened', 'synced'].includes(ev.action ?? '')
      ) {
        const payload = ev.payload as { pull_request?: { number?: unknown } };
        if (!policyId(payload?.pull_request?.number)) throw new Error('source PR 事件缺可信单号');
        await publisher.publish(parseRepoSlug(ev.repo), payload.pull_request.number);
      }
      await sink.accept(ev);
    },
  };
}
