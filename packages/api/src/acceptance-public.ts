import type { AcceptanceDutyRow } from '@fleet-dao/db';
import { PublicAcceptanceRoute } from '@fleet-dao/shared';
import { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError } from './http.ts';
export const ACCEPTANCE_PUBLIC_PATH = PublicAcceptanceRoute.path;
export function acceptancePublicRoutes(deps: Deps): Hono {
  const app = new Hono();
  app.get(ACCEPTANCE_PUBLIC_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    const githubId = Number(c.req.param('githubId'));
    const issueNumber = Number(c.req.param('issue'));
    if (
      !Number.isSafeInteger(githubId) ||
      githubId <= 0 ||
      !Number.isSafeInteger(issueNumber) ||
      issueNumber <= 0 ||
      new URL(c.req.url).search
    )
      throw new ApiError(400, 'bad_acceptance_query', '验收责任查询身份不合法');
    if (!deps.ciPolicyBridge || !deps.acceptanceDuties)
      throw new ApiError(503, 'acceptance_not_connected', '真实验收责任账未装配');
    const identity = await deps.ciPolicyBridge.read(githubId);
    const rows = await deps.acceptanceDuties({ repo: identity.repo, issueNumber });
    return c.json({
      version: 1,
      githubId,
      repo: identity.repo,
      issueNumber,
      duties: rows.map((r: AcceptanceDutyRow) => ({
        id: r.id,
        generation: r.generation,
        repo: r.repo,
        issueNumber: r.issueNumber,
        prNumber: r.prNumber,
        head: r.head,
        mergeCommit: r.mergeCommit,
        settledAt: r.settledAt,
        settledBy: r.settledBy,
        settleEvidence: r.settleEvidence,
      })),
    });
  });
  return app;
}
