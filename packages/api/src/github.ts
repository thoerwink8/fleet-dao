// GitHub 事件接收：验签名（X-Hub-Signature-256）→ 原文落库、投递编号去重 → 白名单过滤 → PR 镜像 → issue 变成任务和工作流。
// 香港只转发不验签：请求体和几个头原样透传，签名必须对收到的原始字节算，不许先解析再序列化。
// 验签不过的不落库（没认证的请求不许往库里写），只回 401、记日志。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Deps } from './deps.ts';
import { PublicHealthError } from './health.ts';
import { ApiError, errorBody } from './http.ts';
import { CommentPayload, createIssueIntake, IssuePayload, RetryLaterError } from './issue-intake.ts';
import type {
  GitHubDeliveryOutcome,
  GitHubDeliverySource,
  GitHubEventSink,
  GitHubObjectVersion,
  IngestedEvent,
} from './ports.ts';
import { GhUser, type GithubWhitelist, githubWhitelist, isTrusted } from './whitelist.ts';

export { type GithubWhitelist, githubWhitelist, isTrusted } from './whitelist.ts';

/** GitHub 的投递上限是 25 MB。 */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
/** 处理中的投递超过这么久没收尾，就当那一次死了，重投、补收、重放时接过来。一次处理是几次查库加一次起工作流，秒级。 */
export const DELIVERY_STALE_MS = 5 * 60_000;
/** 自动重放到第几次为止：还不成的多半是代码或数据的问题，重放也没用，健康检查报红、等人看。 */
export const MAX_AUTO_REPLAYS = 5;
/** 出错原因记进库之前截到这么长（原文可能带整段堆栈）。 */
const MAX_REASON_CHARS = 2_000;

/**
 * 两个机器人的凭据读不到时 PR 镜像、CI 汇总的去处：这两样要调 GitHub，如实失败（这条投递记成出错）；issue、评论、ping
 * 不用写镜像，照常放过去，issue 照样变成任务。健康检查报红。凭据只在后端启动时读一次：补上之后要重启后端。
 */
export function githubAppMissing(why: string): { sink: GitHubEventSink; check: () => Promise<void> } {
  const message = `GitHub 机器人的凭据没读到，PR 镜像和 CI 汇总写不了：${why}`;
  return {
    sink: {
      async accept(event) {
        if (event.event === 'issues' || event.event === 'issue_comment' || event.event === 'ping') return;
        throw new Error(message);
      },
    },
    async check() {
      throw new PublicHealthError(
        'app_credentials_missing',
        'GitHub 机器人的凭据没读到，PR 和 CI 事件写不进镜像',
      );
    },
  };
}

export function verifyGithubSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

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
    return { accept: false, reason: 'repo_not_managed' };
  }
  const repo = repository.full_name;
  // 自家机器人（改 issue 进度段、推分支、开 PR）引起的事件只同步镜像，不叫醒工作流，防自己叫醒自己。
  const wake = !(sender?.type === 'Bot' && w.botIds.has(sender.id));
  /** 编辑类动作还要看是谁改的：白名单作者的内容被外人改了，不收。 */
  const editorOk = action !== 'edited' || isTrusted(sender, w);

  const author = (() => {
    switch (event) {
      case 'issues': {
        const p = IssuePayload.safeParse(payload);
        return p.success ? p.data.issue.user : null;
      }
      case 'issue_comment': {
        const p = CommentPayload.safeParse(payload);
        return p.success ? p.data.comment.user : null;
      }
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

const VersionedIssue = z.object({
  number: z.number(),
  updated_at: z.string().optional(),
  state: z.string().optional(),
  pull_request: z.unknown().optional(),
});
const Versioned = {
  issues: z.object({ issue: VersionedIssue }),
  issue_comment: z.object({
    comment: z.object({ id: z.number(), updated_at: z.string() }),
    issue: VersionedIssue.optional(),
  }),
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
 * 这条事件带着的每个对象的那一版，主对象在第一个：issue 事件是 issue；评论事件是评论，再是被它顶新的 issue
 * （PR 上的评论是 PR）；PR 和它的审查、审查评论是 PR。认不出版本的不写。
 */
export function versionsOf(event: string, payload: unknown, repo: string | undefined): GitHubObjectVersion[] {
  if (!repo) return [];
  const out: (GitHubObjectVersion | null)[] = [];
  const issueVersion = (i: z.infer<typeof VersionedIssue>) =>
    versionOf(repo, i.pull_request ? 'pull' : 'issue', i.number, i.updated_at, i.state);
  if (event === 'issues') {
    const p = Versioned.issues.safeParse(payload);
    if (p.success) out.push(issueVersion(p.data.issue));
  } else if (event === 'issue_comment') {
    const p = Versioned.issue_comment.safeParse(payload);
    if (p.success) {
      out.push(versionOf(repo, 'comment', p.data.comment.id, p.data.comment.updated_at));
      if (p.data.issue) out.push(issueVersion(p.data.issue));
    }
  } else if (PULL_EVENTS.has(event)) {
    const p = Versioned.pull.safeParse(payload);
    if (p.success) {
      const pr = p.data.pull_request;
      out.push(versionOf(repo, 'pull', pr.number, pr.updated_at, pr.state));
    }
  }
  return out.filter((v): v is GitHubObjectVersion => v !== null);
}

/**
 * 健康检查的 github_events 一项：机器人凭据没读到（credentialsMissing）先报；再查卡住的投递——重放到上限还出错的、
 * 处理中超过 5 分钟没收尾的，有就报红。/healthz 公网能访问：只报条数，不带投递编号和内容（编号、原因在库里和日志里查）。
 * 查库出错就抛原样的错（对外只说「连不上」），不当成「没有卡住的」。
 */
export function githubEventsCheck(
  parts: Pick<Deps, 'store' | 'now'> & { credentialsMissing?: (() => Promise<void>) | undefined },
): () => Promise<void> {
  return async () => {
    await parts.credentialsMissing?.();
    const staleBefore = new Date(parts.now().getTime() - DELIVERY_STALE_MS).toISOString();
    const { exhausted, stale } = await parts.store.countStuckDeliveries({
      staleBefore,
      maxAttempts: MAX_AUTO_REPLAYS,
    });
    if (exhausted === 0 && stale === 0) return;
    const counts = [
      exhausted > 0 ? `重放 ${MAX_AUTO_REPLAYS} 次还出错的 ${exhausted} 条` : '',
      stale > 0 ? `处理中超过 ${DELIVERY_STALE_MS / 60_000} 分钟没收尾的 ${stale} 条` : '',
    ].filter(Boolean);
    throw new PublicHealthError('stuck_deliveries', `有 GitHub 投递没处理成：${counts.join('、')}`);
  };
}

export type IngestResult =
  | { verdict: 'accepted'; wake: boolean; note?: string | undefined }
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

/** 收件（webhook）、补收（对账、轮询）、重放共用这一道门和这一本投递账（github_events）。 */
export function createGitHubIntake(
  deps: Pick<Deps, 'store' | 'github' | 'workflows' | 'requirements' | 'log' | 'now'>,
): GitHubIntake {
  const { store, log } = deps;
  const issues = createIssueIntake(deps);
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
      // issue 事件晚到、或者是重放：同一张 issue 更新的一版已经处理过、开关状态又不一样，就按新的那版算，这条旧的不做
      // （旧的「重开」不会把后来关了的单又拉起来，旧的「关单」也不会把后来重开的单叫停）
      if (event === 'issues') {
        const [v] = versionsOf(event, payload, screening.repo);
        const newer = v?.state
          ? await store.findSupersedingVersion({
              object: v.object,
              version: v.version,
              state: v.state,
              excludeDeliveryId: deliveryId,
            })
          : null;
        if (newer) {
          log.info('同一张 issue 更新的一版已经处理过、开关状态不一样：这条旧的不再做', {
            deliveryId,
            newer: newer.deliveryId,
            newerVersion: newer.version,
          });
          await finish(deliveryId, token, { status: 'ignored', reason: 'superseded' });
          return { verdict: 'ignored', reason: 'superseded' };
        }
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
      const note = await issues.handle(ingested);
      await finish(deliveryId, token, { status: 'accepted', note });
      if (note) log.info('GitHub 事件已处理', { deliveryId, event, note });
      return { verdict: 'accepted', wake: screening.wake, ...(note ? { note } : {}) };
    } catch (err) {
      const reason =
        (err instanceof Error ? err.message : String(err)).slice(0, MAX_REASON_CHARS) || '没带原因';
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
        { id: deliveryId, event, source, payload, receivedAt: deps.now().toISOString() },
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

export function githubRoutes(deps: Deps, intake: GitHubIntake): Hono {
  const app = new Hono();
  app.post(
    '/webhook',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody('too_large', '请求体超过 25 MB'), 413),
    }),
    async (c) => {
      const secret = deps.config.githubWebhookSecret;
      if (!secret) throw new ApiError(503, 'webhook_not_configured', 'GitHub 事件接收还没配置密钥');
      const body = new Uint8Array(await c.req.arrayBuffer());
      const deliveryId = c.req.header('x-github-delivery');
      const event = c.req.header('x-github-event');
      if (!verifyGithubSignature(secret, body, c.req.header('x-hub-signature-256'))) {
        deps.log.warn('GitHub 事件签名不对，已拒绝', { deliveryId, event, bytes: body.length });
        throw new ApiError(401, 'bad_signature', '签名不对');
      }
      if (!deliveryId || !event) {
        deps.log.warn('GitHub 事件缺投递编号或事件名，已拒绝', { deliveryId, event });
        throw new ApiError(400, 'missing_headers', '缺 X-GitHub-Delivery 或 X-GitHub-Event');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        deps.log.warn('GitHub 事件的请求体不是 JSON，已拒绝', { deliveryId, event, bytes: body.length });
        throw new ApiError(400, 'invalid_json', '请求体不是 JSON（Content type 要选 application/json）');
      }
      try {
        const result = await intake.ingest({ deliveryId, event, payload, source: 'webhook' });
        return c.json({ ok: true, ...result });
      } catch (err) {
        // 现在做不了、过一会儿就行（关了又重开、上一轮还没结束）：这条已经记成出错，等对账重放，不当后端出错
        if (!(err instanceof RetryLaterError)) throw err;
        deps.log.warn('GitHub 事件现在做不了，记成出错等重放', { deliveryId, event, reason: err.message });
        return c.json(errorBody('retry_later', err.message), 503);
      }
    },
  );
  return app;
}
