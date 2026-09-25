// GitHub 事件过了后端的门（签名、去重、白名单，packages/api 的 github.ts）之后的处理：写 PR 镜像、叫醒工作流。
// 事件只当「叫醒」：里面的文字不当指令，CI 结论回 GitHub 重读，不信事件里带的（事件会乱序、会晚到、会被补收重放）。
// 抛错 = 没处理成：后端会撤掉投递登记，让重投或补收再进来一次，所以这里的每一步都要能重放。
import { z } from 'zod';
import { mirrorChecks } from './checks.ts';
import { parseRepoSlug, type RepoRef, repoSlug } from './client.ts';
import type { Deps } from './deps.ts';
import { isGitHubError } from './errors.ts';
import { readCi, requiredChecksFor } from './pulls.ts';

/** 和 @fleet-dao/api 的 IngestedEvent 同形（通过签名与白名单之后交过来的事件）。 */
export interface IngestedEvent {
  deliveryId: string;
  source: 'webhook' | 'poll' | 'redelivery';
  event: string;
  action?: string | undefined;
  repo: string;
  /** false = 自家机器人的回声：只同步镜像，不叫醒工作流。 */
  wake: boolean;
  receivedAt: string;
  payload: unknown;
}

/** 叫醒哪条工作流由引擎决定：按 issue 号找需求，按 PR 号或分支找子任务，按头找合并队列。 */
export interface WakeEvent {
  repo: string;
  event: string;
  action?: string | undefined;
  deliveryId: string;
  source: IngestedEvent['source'];
  issueNumber?: number | undefined;
  prNumbers?: number[] | undefined;
  headSha?: string | undefined;
  headRef?: string | undefined;
}

export interface WorkflowWaker {
  wake(event: WakeEvent): Promise<void>;
}

/** 和 @fleet-dao/api 的 GitHubEventSink 同形。 */
export interface EventSink {
  accept(event: IngestedEvent): Promise<void>;
}

const PullPayload = z.object({
  pull_request: z.object({
    number: z.number(),
    state: z.enum(['open', 'closed']),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    updated_at: z.string(),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
});
const IssuePayload = z.object({
  issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }),
});
const PrList = z.array(z.object({ number: z.number() })).optional();
const CheckSuitePayload = z.object({
  check_suite: z.object({ head_sha: z.string(), pull_requests: PrList }),
});
const CheckRunPayload = z.object({ check_run: z.object({ head_sha: z.string(), pull_requests: PrList }) });
const WorkflowRunPayload = z.object({
  workflow_run: z.object({ head_sha: z.string(), pull_requests: PrList }),
});
const StatusPayload = z.object({ sha: z.string() });
const PushPayload = z.object({ ref: z.string(), after: z.string() });

/** CI 事件里的头；不是 CI 事件返回 null。 */
function ciHead(event: string, payload: unknown): { sha: string; prs: number[]; completed: boolean } | null {
  const prs = (l: { number: number }[] | undefined) => (l ?? []).map((p) => p.number);
  const action = (payload as { action?: unknown })?.action;
  switch (event) {
    case 'check_suite': {
      const p = CheckSuitePayload.safeParse(payload);
      return p.success
        ? {
            sha: p.data.check_suite.head_sha,
            prs: prs(p.data.check_suite.pull_requests),
            completed: action === 'completed',
          }
        : null;
    }
    case 'check_run': {
      const p = CheckRunPayload.safeParse(payload);
      return p.success
        ? {
            sha: p.data.check_run.head_sha,
            prs: prs(p.data.check_run.pull_requests),
            completed: action === 'completed',
          }
        : null;
    }
    case 'workflow_run': {
      const p = WorkflowRunPayload.safeParse(payload);
      return p.success
        ? {
            sha: p.data.workflow_run.head_sha,
            prs: prs(p.data.workflow_run.pull_requests),
            completed: action === 'completed',
          }
        : null;
    }
    case 'status': {
      const p = StatusPayload.safeParse(payload);
      return p.success ? { sha: p.data.sha, prs: [], completed: true } : null;
    }
    default:
      return null;
  }
}

export function createEventSink(deps: Deps, waker: WorkflowWaker): EventSink {
  const { ledger, log } = deps;

  /** 按 GitHub 重读这个头上的 CI，写进镜像里 head 还是它的 PR。 */
  async function refreshChecks(repo: RepoRef, repoId: string, sha: string): Promise<number[]> {
    const rows = await ledger.pullRequestsByHead(repoId, sha);
    if (rows.length === 0) return [];
    let required: string[];
    try {
      required = await requiredChecksFor(deps, repo);
    } catch (err) {
      // 主线没配必过检查：镜像的 CI 汇总没法算，别让事件一直重投
      if (isGitHubError(err, 'NO_REQUIRED_CHECKS')) {
        log.warn(err.message, { repo: repoSlug(repo) });
        return [];
      }
      throw err;
    }
    const ci = await readCi(deps, repo, sha, required);
    const summary = mirrorChecks(ci.evaluation);
    for (const row of rows) await ledger.setChecks(repoId, row.number, sha, summary);
    return rows.map((r) => r.number);
  }

  return {
    async accept(ev) {
      if (ev.event === 'ping') return;
      const repo = parseRepoSlug(ev.repo);
      const repoId = await ledger.repoId(repo);
      const wake: WakeEvent = {
        repo: repoSlug(repo),
        event: ev.event,
        action: ev.action,
        deliveryId: ev.deliveryId,
        source: ev.source,
      };

      if (ev.event === 'pull_request') {
        const p = PullPayload.safeParse(ev.payload);
        if (p.success) {
          const pr = p.data.pull_request;
          const merged = pr.merged ?? (pr.merged_at !== null && pr.merged_at !== undefined);
          if (repoId) {
            await ledger.upsertPullRequest({
              repoId,
              number: pr.number,
              state: merged ? 'merged' : pr.state,
              headRef: pr.head.ref,
              headSha: pr.head.sha,
              updatedAt: new Date(pr.updated_at),
            });
          }
          Object.assign(wake, { prNumbers: [pr.number], headSha: pr.head.sha, headRef: pr.head.ref });
        }
      } else if (ev.event === 'pull_request_review' || ev.event === 'pull_request_review_comment') {
        const n = (ev.payload as { pull_request?: { number?: unknown } })?.pull_request?.number;
        if (typeof n === 'number') wake.prNumbers = [n];
      } else if (ev.event === 'issues' || ev.event === 'issue_comment') {
        const p = IssuePayload.safeParse(ev.payload);
        if (p.success) {
          if (p.data.issue.pull_request) wake.prNumbers = [p.data.issue.number];
          else wake.issueNumber = p.data.issue.number;
        }
      } else if (ev.event === 'push') {
        const p = PushPayload.safeParse(ev.payload);
        if (p.success && p.data.ref.startsWith('refs/heads/')) {
          Object.assign(wake, { headRef: p.data.ref.slice('refs/heads/'.length), headSha: p.data.after });
        }
      } else {
        const ci = ciHead(ev.event, ev.payload);
        if (ci) {
          wake.headSha = ci.sha;
          const touched = repoId && ci.completed ? await refreshChecks(repo, repoId, ci.sha) : [];
          wake.prNumbers = [...new Set([...ci.prs, ...touched])];
        }
      }

      if (!ev.wake) {
        log.info('自家机器人的事件：只同步镜像，不叫醒', { deliveryId: ev.deliveryId, event: ev.event });
        return;
      }
      await waker.wake(wake);
    },
  };
}
