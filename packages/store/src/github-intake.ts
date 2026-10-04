// GitHub 进门的判法（不碰 HTTP）：事件放不放进来（白名单、fork、受管的仓）、投递编号去重、原文落库、重放。
// 收 webhook 的 HTTP 入口（验签、读请求体）和 /healthz 的检查在 @fleet-dao/api 的 github.ts；对账补漏、引擎拉单都从这里进同一道门。
// 改这里之前必须知道：公开仓里陌生人也能开单、评论，这道白名单是唯一的门（design 第三节第 4 条），先审后合
// （packages/conventions/high-risk-paths.json 登记着这份文件）。
import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import {
  type GitHubDeliveryOutcome,
  type GitHubDeliverySource,
  type GitHubEventSink,
  type GitHubObjectVersion,
  type IngestedEvent,
  type Logger,
  REPO_NOT_MANAGED,
  type Store,
} from './ports.ts';
import { GhUser, type GithubWhitelist, githubWhitelist, isTrusted } from './whitelist.ts';

/** 处理中的投递超过这么久没收尾，就当那一次死了，重投、补收、重放时接过来。一次处理是几次查库加一次起工作流，秒级。 */
export const DELIVERY_STALE_MS = 5 * 60_000;
/** 自动重放到第几次为止：还不成的多半是代码或数据的问题，重放也没用，健康检查报红、等人看。 */
export const MAX_AUTO_REPLAYS = 5;
/** 出错原因记进库之前截到这么长（原文可能带整段堆栈）。 */
const MAX_REASON_CHARS = 2_000;

const GhRepo = z.object({ full_name: z.string() });

const Envelope = z.object({
  action: z.string().optional(),
  sender: GhUser.optional(),
  repository: GhRepo.optional(),
});
const PullPayload = z.object({
  pull_request: z.object({
    number: z.number(),
    user: GhUser,
    head: z.object({ repo: GhRepo.nullable() }),
    base: z.object({ repo: GhRepo }),
  }),
});
const ReviewPayload = PullPayload.extend({ review: z.object({ user: GhUser.nullable() }) });

/** 从 fork 来的 PR 不进引擎（head 仓被删时 repo 为 null，也按 fork 算）。 */
function fromFork(pr: z.infer<typeof PullPayload>['pull_request']): boolean {
  return !pr.head.repo || pr.head.repo.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase();
}

/**
 * CI 事件：触发人常是 GitHub 自己或占位账号，按作者过滤没意义，所以不看作者。但里面的提交信息、检查输出
 * 同样是人或 AI 写的字——引擎只把 CI 事件当「叫醒」、回 GitHub 重读结论，不把里面的文字当指令。
 * 从 fork 来的照样不收（各事件认 fork 的办法见 ciFromFork）。
 */
const CI_EVENTS = new Set(['check_suite', 'check_run', 'status', 'workflow_run']);

const CheckSuitePayload = z.object({ check_suite: z.object({ head_branch: z.string().nullable() }) });
const CheckRunPayload = z.object({
  check_run: z.object({ check_suite: z.object({ head_branch: z.string().nullable() }) }),
});
const WorkflowRunPayload = z.object({ workflow_run: z.object({ head_repository: GhRepo.nullable() }) });
const StatusPayload = z.object({ branches: z.array(z.unknown()) });

/**
 * CI 事件是不是 fork 来的；读不懂返回 null。
 * - check_suite / check_run：GitHub 文档写明，fork 的分支推送认不出来，head_branch 为 null、pull_requests 为空。
 * - workflow_run：head_repository 不是本仓。
 * - status：这个提交不在本仓任何分支上（branches 为空）。
 */
function ciFromFork(event: string, payload: unknown, repo: string): boolean | null {
  switch (event) {
    case 'check_suite': {
      const p = CheckSuitePayload.safeParse(payload);
      return p.success ? p.data.check_suite.head_branch === null : null;
    }
    case 'check_run': {
      const p = CheckRunPayload.safeParse(payload);
      return p.success ? p.data.check_run.check_suite.head_branch === null : null;
    }
    case 'workflow_run': {
      const p = WorkflowRunPayload.safeParse(payload);
      if (!p.success) return null;
      const head = p.data.workflow_run.head_repository;
      return !head || head.full_name.toLowerCase() !== repo.toLowerCase();
    }
    case 'status': {
      const p = StatusPayload.safeParse(payload);
      return p.success ? p.data.branches.length === 0 : null;
    }
    default:
      return null;
  }
}

export type Screening =
  | { accept: true; wake: boolean; reason: string; repo: string; action?: string | undefined }
  | { accept: false; reason: string };

/** 纯判断：这条事件放不放进来、要不要叫醒工作流。repos 是本系统管的仓（owner/name，小写）。 */
export function screenGithubEvent(
  event: string,
  payload: unknown,
  ctx: { repos: ReadonlySet<string>; whitelist: GithubWhitelist },
): Screening {
  const env = Envelope.safeParse(payload);
  if (!env.success) return { accept: false, reason: 'payload_unreadable' };
  const { action, sender, repository } = env.data;
  const w = ctx.whitelist;

  if (event === 'ping')
    return { accept: true, wake: false, reason: 'ping', repo: repository?.full_name ?? '' };
  if (!repository || !ctx.repos.has(repository.full_name.toLowerCase())) {
    return { accept: false, reason: REPO_NOT_MANAGED };
  }
  const repo = repository.full_name;
  // 自家机器人（改 issue 进度段、推分支、开 PR）引起的事件只同步镜像，不叫醒工作流，防自己叫醒自己。
  const wake = !(sender?.type === 'Bot' && w.botIds.has(sender.id));
  /** 编辑类动作还要看是谁改的：白名单作者的内容被外人改了，不收。 */
  const editorOk = action !== 'edited' || isTrusted(sender, w);

  const author = (() => {
    switch (event) {
      case 'pull_request': {
        const p = PullPayload.safeParse(payload);
        if (!p.success) return null;
        return fromFork(p.data.pull_request) ? ('fork' as const) : p.data.pull_request.user;
      }
      case 'pull_request_review': {
        const p = ReviewPayload.safeParse(payload);
        if (!p.success) return null;
        return fromFork(p.data.pull_request) ? ('fork' as const) : p.data.review.user;
      }
      default:
        return undefined;
    }
  })();

  if (CI_EVENTS.has(event)) {
    const fork = ciFromFork(event, payload, repo);
    if (fork === null) return { accept: false, reason: 'payload_unreadable' };
    if (fork) return { accept: false, reason: 'from_fork' };
    return { accept: true, wake, reason: 'ci', repo, action };
  }
  if (author === undefined) return { accept: false, reason: 'event_not_handled' };
  if (author === null) return { accept: false, reason: 'payload_unreadable' };
  if (author === 'fork') return { accept: false, reason: 'from_fork' };
  if (!isTrusted(author, w)) return { accept: false, reason: 'author_not_whitelisted' };
  if (!editorOk) return { accept: false, reason: 'edited_by_outsider' };
  return { accept: true, wake, reason: 'whitelisted', repo, action };
}

/** 轮询捞到的东西用这个当投递编号：同一版本（updated_at 相同）只收一次，改过之后再收。 */
export function pollDeliveryId(repo: string, kind: string, id: number | string, updatedAt: string): string {
  return `poll:${repo.toLowerCase()}:${kind}:${id}:${updatedAt}`;
}

/** 对象的键：`<owner/name 小写>:<issue|comment|pull>:<编号>`（PR 当 issue 看时也记成 pull，和轮询 PR 列表对得上）。 */
export function objectKey(repo: string, kind: 'issue' | 'comment' | 'pull', id: number): string {
  return `${repo.toLowerCase()}:${kind}:${id}`;
}

const Versioned = {
  pull: z.object({
    pull_request: z.object({ number: z.number(), updated_at: z.string(), state: z.string().optional() }),
  }),
};
/** 带着整条 PR（和它的 updated_at）的事件。 */
const PULL_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment']);

function versionOf(
  repo: string,
  kind: 'issue' | 'comment' | 'pull',
  id: number,
  updatedAt: string | undefined,
  state?: string | undefined,
): GitHubObjectVersion | null {
  const at = Date.parse(updatedAt ?? '');
  if (!Number.isFinite(at)) return null;
  return {
    object: objectKey(repo, kind, id),
    version: new Date(at).toISOString(),
    ...(state === 'open' || state === 'closed' ? { state } : {}),
  };
}

/**
 * 这条事件带着的那一版：PR 和它的审查、审查评论都是 PR 这一个对象。认不出版本的不写。
 */
export function versionsOf(event: string, payload: unknown, repo: string | undefined): GitHubObjectVersion[] {
  if (!repo) return [];
  const out: (GitHubObjectVersion | null)[] = [];
  if (PULL_EVENTS.has(event)) {
    const p = Versioned.pull.safeParse(payload);
    if (p.success) {
      const pr = p.data.pull_request;
      out.push(versionOf(repo, 'pull', pr.number, pr.updated_at, pr.state));
    }
  }
  return out.filter((v): v is GitHubObjectVersion => v !== null);
}

/**
 * seenBefore：补收的这一版别的投递带过、只是被门挡掉了（陌生人评论顺带的 issue 那一版之类）。处理照样做，对账不算补回。
 */
export type IngestResult =
  | { verdict: 'accepted'; wake: boolean; note?: string | undefined; seenBefore?: boolean | undefined }
  | { verdict: 'ignored'; reason: string }
  | { verdict: 'duplicate' };

/** 重放的结果：not_found = 库里没有这条；in_flight = 正在处理；finished = 已经处理完（要重跑得带 force）。 */
export type ReplayResult = IngestResult | { verdict: 'not_found' | 'in_flight' | 'finished' };

export interface GitHubIntake {
  ingest(input: {
    deliveryId: string;
    event: string;
    payload: unknown;
    source: GitHubDeliverySource;
  }): Promise<IngestResult>;
  /** 按库里的原文再处理一遍（对账重放出错、卡住的投递；修了代码、改了名单之后手动重跑时带 force）。 */
  replay(deliveryId: string, options?: { force?: boolean }): Promise<ReplayResult>;
}

/** createGitHubIntake 要的几样（后端的 Deps 里有的那几项，引擎装配时也给这几样）。 */
export interface GitHubIntakeDeps {
  store: Store;
  github: GitHubEventSink;
  log: Logger;
  now: () => Date;
}

/** 收件（webhook）、补收（对账、轮询）、重放共用这一道门和这一本投递账（github_events）。 */
export function createGitHubIntake(deps: GitHubIntakeDeps): GitHubIntake {
  const { store, log } = deps;
  const staleBefore = () => new Date(deps.now().getTime() - DELIVERY_STALE_MS).toISOString();

  async function finish(id: string, token: string, outcome: GitHubDeliveryOutcome): Promise<void> {
    if (!(await store.finishDelivery(id, token, outcome))) {
      log.warn('这条投递处理期间被别的请求接管了，这次的结局没记上', {
        deliveryId: id,
        status: outcome.status,
      });
    }
  }

  async function process(
    delivery: {
      id: string;
      event: string;
      source: GitHubDeliverySource;
      payload: unknown;
      receivedAt: string;
      seenBefore?: boolean | undefined;
    },
    token: string,
  ): Promise<IngestResult> {
    const { id: deliveryId, event, source, payload } = delivery;
    try {
      const [users, repos] = await Promise.all([store.listUsers(), store.listRepos()]);
      const screening = screenGithubEvent(event, payload, {
        repos: new Set(repos.map((r) => `${r.owner}/${r.name}`.toLowerCase())),
        whitelist: githubWhitelist(users),
      });
      if (!screening.accept) {
        // 外人改了白名单作者的单、认不出的事件：告警（不当成「没事件」）；陌生人、别的仓、不处理的事件：照常不收
        const warn = screening.reason === 'edited_by_outsider' || screening.reason === 'payload_unreadable';
        log[warn ? 'warn' : 'info']('GitHub 事件没放进来', { deliveryId, event, reason: screening.reason });
        await finish(deliveryId, token, { status: 'ignored', reason: screening.reason });
        return { verdict: 'ignored', reason: screening.reason };
      }
      const ingested: IngestedEvent = {
        deliveryId,
        source,
        event,
        action: screening.action,
        repo: screening.repo,
        wake: screening.wake,
        receivedAt: delivery.receivedAt,
        payload,
      };
      await deps.github.accept(ingested);
      await finish(deliveryId, token, { status: 'accepted' });
      return {
        verdict: 'accepted',
        wake: screening.wake,
        ...(delivery.seenBefore ? { seenBefore: true } : {}),
      };
    } catch (err) {
      const reason = errMessage(err).slice(0, MAX_REASON_CHARS) || '没带原因';
      // 原文留在库里：重投、补收或对账重放时还能再来
      try {
        await finish(deliveryId, token, { status: 'failed', reason });
      } catch (recordErr) {
        log.error('GitHub 事件没处理成，出错记录也没写进去', {
          deliveryId,
          event,
          error: reason,
          recordError: String(recordErr),
        });
      }
      throw err;
    }
  }

  return {
    async ingest({ deliveryId, event, payload, source }) {
      const env = Envelope.safeParse(payload);
      const repo = env.success ? env.data.repository?.full_name : undefined;
      const versions = versionsOf(event, payload, repo);
      // 补收拼出来的一条只说一个对象的一版：webhook（或上一轮补收）已经带过这一版就不再做；webhook 自己只按投递编号去重
      const claim = await store.claimDelivery(
        {
          id: deliveryId,
          event,
          action: env.success ? env.data.action : undefined,
          source,
          repo,
          versions,
          payload,
        },
        { staleBefore: staleBefore(), skipIfSeen: source === 'poll' ? versions[0] : undefined },
      );
      if (claim.status === 'duplicate') return { verdict: 'duplicate' };
      return process(
        {
          id: deliveryId,
          event,
          source,
          payload,
          receivedAt: deps.now().toISOString(),
          seenBefore: claim.seenBefore,
        },
        claim.token,
      );
    },

    async replay(deliveryId, options = {}) {
      const claim = await store.reclaimDelivery(deliveryId, {
        staleBefore: staleBefore(),
        force: options.force ?? false,
      });
      if (claim.status !== 'claimed') return { verdict: claim.status };
      const d = claim.delivery;
      return process(
        { id: d.id, event: d.event, source: d.source, payload: d.payload, receivedAt: d.receivedAt },
        claim.token,
      );
    },
  };
}
