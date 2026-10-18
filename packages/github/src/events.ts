// GitHub 事件过了后端的门（签名、去重、白名单，packages/api 的 github.ts）之后的处理：写 PR 镜像、叫醒工作流。
// 事件只当「叫醒」：里面的文字不当指令，CI 结论回 GitHub 重读，不信事件里带的（事件会乱序、会晚到、会被补收重放）。
// 抛错 = 没处理成：后端把这条投递记成出错、原文留着，对账时按原文重放，所以这里的每一步都要能重放。
import { isFlowBranch, prLinks } from '@fleet-dao/conventions';
import { z } from 'zod';
import { mirrorChecks } from './checks.ts';
import { parseRepoSlug, type RepoRef, repoSlug } from './client.ts';
import type { Deps } from './deps.ts';
import type { ClaimsGitHub } from './engine-pulls.ts';
import { isGitHubError } from './errors.ts';
import type { PrMirror } from './ledger.ts';
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

/** 叫醒哪条工作流由引擎决定：按 PR 号或分支找子任务，按头找合并队列。评论事件不收；issue 只收「关了」，由引擎从投递账捞（#556）。 */
export interface WakeEvent {
  repo: string;
  event: string;
  action?: string | undefined;
  deliveryId: string;
  source: IngestedEvent['source'];
  prNumbers?: number[] | undefined;
  headSha?: string | undefined;
  headRef?: string | undefined;
  /** pull_request_review 事件里评审的状态（GitHub 原样小写：changes_requested、approved、commented、dismissed）。 */
  reviewState?: string | undefined;
  /** 评审的编号、审查者和审的提交（事件里带的就带，留明账用；事件只当叫醒，不拿它们当指令）。 */
  review?: { id: number; reviewer?: string | undefined; commitId?: string | null | undefined } | undefined;
}

/** 要求改的评审到达时 PR 已经合了：撤不了、也回不了工人，留一条未送达的明账（真装配写驾驶舱报警）。写不成要抛。 */
export interface MergedReviewNote {
  repo: string;
  prNumber: number;
  deliveryId: string;
  review: NonNullable<WakeEvent['review']> | null;
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
    // 下面几样给「提醒谁在处理」现算用（design 15.3）；事件里没带（undefined）的不改镜像里的旧值
    created_at: z.string().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
  }),
});

type PullFields = z.infer<typeof PullPayload>['pull_request'];

/** 时刻认不出的当没读到（undefined，不改镜像），不拿空顶。 */
function dateOf(text: string | null | undefined): Date | null | undefined {
  if (text === undefined) return undefined;
  if (text === null) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at) : undefined;
}

/**
 * PR 镜像里给「提醒谁在处理」用的几样：开的时刻、合并的时刻和提交、正文挂的单和修的提醒（@fleet-dao/conventions 的
 * prLinks，认法只有一处）。事件里没带正文（undefined）就不给链接：镜像里的旧值留着。
 */
export function mirrorExtras(
  pr: Pick<PullFields, 'created_at' | 'merged_at' | 'merge_commit_sha' | 'title' | 'body'>,
  merged: boolean,
  repo: string,
): Pick<PrMirror, 'openedAt' | 'mergedAt' | 'mergeSha' | 'links' | 'title'> {
  const sha = pr.merge_commit_sha;
  return {
    openedAt: dateOf(pr.created_at),
    title: pr.title,
    // 没合的 PR 也带着 merge_commit_sha（GitHub 算的试合提交）：只有合了的才记，没合的清空（合了的不会再变回没合，
    // 晚到的旧事件由 updated_at 挡住）
    mergedAt: merged ? dateOf(pr.merged_at) : null,
    mergeSha: merged ? (sha && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined) : null,
    links: pr.body === undefined ? undefined : prLinks({ body: pr.body, title: pr.title ?? '' }, repo),
  };
}

const PullExtras = PullPayload.shape.pull_request.pick({
  created_at: true,
  merged_at: true,
  merge_commit_sha: true,
  title: true,
  body: true,
});

/** 列表接口里的一个 PR（对账审计补合并那一路）：认得出的几样照 mirrorExtras 给，认不出的一样都不给（镜像旧值留着）。 */
export function mirrorExtrasOf(
  item: unknown,
  merged: boolean,
  repo: string,
): Pick<PrMirror, 'openedAt' | 'mergedAt' | 'mergeSha' | 'links' | 'title'> {
  const p = PullExtras.safeParse(item);
  return p.success ? mirrorExtras(p.data, merged, repo) : {};
}
const PrList = z.array(z.object({ number: z.number() })).optional();
const CheckSuitePayload = z.object({
  check_suite: z.object({ head_sha: z.string(), pull_requests: PrList }),
});
const CheckRunPayload = z.object({ check_run: z.object({ head_sha: z.string(), pull_requests: PrList }) });
const WorkflowRunPayload = z.object({
  workflow_run: z.object({ head_sha: z.string(), pull_requests: PrList }),
});
const StatusPayload = z.object({ sha: z.string() });
const ReviewPayload = z.object({
  pull_request: z.object({ head: z.object({ ref: z.string(), sha: z.string() }) }),
  review: z
    .object({
      state: z.string(),
      id: z.number().optional(),
      user: z.object({ login: z.string() }).nullable().optional(),
      commit_id: z.string().nullable().optional(),
    })
    .optional(),
});
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

/**
 * 正式评审交「要求改」时先把引擎任务 PR 的自动合并撤掉（#2991）：冷验收之后、GitHub 自己合之前交的评审，不等引擎等合并那一圈
 * 来读就合进去了。事件只当叫醒、不当指令：这里只撤（不挂、不合、不改代码），撤之前回 GitHub 重读 PR（开着、没合、挂着才撤），
 * 评审算不算数、交不交给工人由引擎合并那一步现读评审定（读到了不再挂，读不到认可的要求改就照常重挂）。
 * 只管引擎任务分支（isFlowBranch），人开的 PR 不碰。撤不成抛错：这条投递记成出错、对账时按原文重放，不当成撤了。
 * 进到这里的评审已过了后端的白名单（作者不认可的事件根本不收），自家机器人的回声不叫醒（wake 为假，到不了这里）。
 */
export function reviewMergeHold(
  claims: Pick<ClaimsGitHub, 'readPull' | 'disableAutoMerge'>,
  log?: Deps['log'],
  onMerged?: (note: MergedReviewNote) => Promise<void>,
): WorkflowWaker {
  return {
    async wake(ev) {
      if (ev.event !== 'pull_request_review' || ev.reviewState !== 'changes_requested') return;
      if (ev.action !== 'submitted' && ev.action !== 'edited') return;
      if (ev.headRef === undefined || !isFlowBranch(ev.headRef)) return;
      const repo = parseRepoSlug(ev.repo);
      for (const n of ev.prNumbers ?? []) {
        const pull = await claims.readPull(repo, n);
        if (pull.merged) {
          // 评审到的时候 PR 已经合了：撤不了、也回不了工人。不装没事：留未送达的明账（写不成抛错，这条投递记成出错、按原文重放）
          log?.warn('正式评审要求改到达时 PR 已经合并，评审回不了工人', {
            deliveryId: ev.deliveryId,
            repo: ev.repo,
            prNumber: n,
          });
          await onMerged?.({
            repo: ev.repo,
            prNumber: n,
            deliveryId: ev.deliveryId,
            review: ev.review ?? null,
          });
          continue;
        }
        if (pull.state !== 'open' || !pull.autoMerge) continue;
        await claims.disableAutoMerge(repo, pull);
        log?.info('正式评审要求改：撤掉了引擎任务 PR 的自动合并，等引擎合并那一步现读评审', {
          deliveryId: ev.deliveryId,
          repo: ev.repo,
          prNumber: n,
        });
      }
    },
  };
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
              ...mirrorExtras(pr, merged, repoSlug(repo)),
            });
          }
          Object.assign(wake, { prNumbers: [pr.number], headSha: pr.head.sha, headRef: pr.head.ref });
        }
      } else if (ev.event === 'pull_request_review' || ev.event === 'pull_request_review_comment') {
        const n = (ev.payload as { pull_request?: { number?: unknown } })?.pull_request?.number;
        if (typeof n === 'number') wake.prNumbers = [n];
        const r = ReviewPayload.safeParse(ev.payload);
        if (r.success) {
          Object.assign(wake, {
            headRef: r.data.pull_request.head.ref,
            headSha: r.data.pull_request.head.sha,
            ...(r.data.review?.state ? { reviewState: r.data.review.state } : {}),
            ...(r.data.review?.id === undefined
              ? {}
              : {
                  review: {
                    id: r.data.review.id,
                    reviewer: r.data.review.user?.login,
                    commitId: r.data.review.commit_id,
                  },
                }),
          });
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
