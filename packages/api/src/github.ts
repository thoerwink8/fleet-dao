// GitHub 事件接收：验签名（X-Hub-Signature-256）→ 投递编号去重 → 白名单过滤 → 交给引擎（写镜像、叫醒工作流）。
// 公开仓里陌生人也能开单、评论；设计删了「进门标签」，这道白名单就是唯一的门，所以在代码里强制，不靠互动限制。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Deps } from './deps.ts';
import { ApiError, errorBody } from './http.ts';
import type { User } from './ports.ts';

/** GitHub 的投递上限是 25 MB。 */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function verifyGithubSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const GhUser = z.object({ login: z.string(), id: z.number(), type: z.string() });
type GhUser = z.infer<typeof GhUser>;
const GhRepo = z.object({ full_name: z.string() });

const Envelope = z.object({
  action: z.string().optional(),
  sender: GhUser.optional(),
  repository: GhRepo.optional(),
});
const IssuePayload = z.object({ issue: z.object({ number: z.number(), user: GhUser }) });
const CommentPayload = z.object({ comment: z.object({ id: z.number(), user: GhUser }) });
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

export interface GithubWhitelist {
  /** 有数字编号的人只按编号认。 */
  userIds: ReadonlySet<number>;
  /** 没登记数字编号的人才按登录名认（小写）。 */
  logins: ReadonlySet<string>;
  /** 自家机器人：只按数字编号认，且 type 必须是 Bot。 */
  botIds: ReadonlySet<number>;
}

export function githubWhitelist(users: User[]): GithubWhitelist {
  const userIds = new Set<number>();
  const logins = new Set<string>();
  const botIds = new Set<number>();
  for (const u of users) {
    if (!u.active) continue;
    if (u.role === 'bot') {
      if (u.githubId !== undefined) botIds.add(u.githubId);
    } else if (u.githubId !== undefined) {
      userIds.add(u.githubId);
    } else if (u.githubLogin) {
      logins.add(u.githubLogin.toLowerCase());
    }
  }
  return { userIds, logins, botIds };
}

export function isTrusted(user: GhUser | null | undefined, w: GithubWhitelist): boolean {
  if (!user) return false;
  if (user.type === 'Bot') return w.botIds.has(user.id);
  if (user.type !== 'User') return false;
  return w.userIds.has(user.id) || w.logins.has(user.login.toLowerCase());
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

export type IngestResult =
  | { verdict: 'accepted'; wake: boolean }
  | { verdict: 'ignored'; reason: string }
  | { verdict: 'duplicate' };

export interface GitHubIntake {
  ingest(input: {
    deliveryId: string;
    event: string;
    payload: unknown;
    source: 'webhook' | 'poll' | 'redelivery';
  }): Promise<IngestResult>;
}

/** 收件（webhook）和补收（对账、轮询）共用这一道门和这一本投递账。 */
export function createGitHubIntake(deps: Pick<Deps, 'store' | 'github' | 'log' | 'now'>): GitHubIntake {
  const { store, log } = deps;
  return {
    async ingest({ deliveryId, event, payload, source }) {
      const receivedAt = deps.now().toISOString();
      const claim = await store.claimDelivery({ id: deliveryId, event, source, receivedAt });
      if (claim === 'duplicate') return { verdict: 'duplicate' };
      try {
        const [users, repos] = await Promise.all([store.listUsers(), store.listRepos()]);
        const screening = screenGithubEvent(event, payload, {
          repos: new Set(repos.map((r) => `${r.owner}/${r.name}`.toLowerCase())),
          whitelist: githubWhitelist(users),
        });
        if (!screening.accept) {
          const level = screening.reason === 'edited_by_outsider' ? 'warn' : 'info';
          log[level]('GitHub 事件没放进来', { deliveryId, event, reason: screening.reason });
          return { verdict: 'ignored', reason: screening.reason };
        }
        await deps.github.accept({
          deliveryId,
          source,
          event,
          action: screening.action,
          repo: screening.repo,
          wake: screening.wake,
          receivedAt,
          payload,
        });
        return { verdict: 'accepted', wake: screening.wake };
      } catch (err) {
        // 没处理成就撤销登记，让 GitHub 重投或补收还能再进来。
        await store.releaseDelivery(deliveryId);
        throw err;
      }
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
      if (!deliveryId || !event)
        throw new ApiError(400, 'missing_headers', '缺 X-GitHub-Delivery 或 X-GitHub-Event');
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new ApiError(400, 'invalid_json', '请求体不是 JSON（Content type 要选 application/json）');
      }
      const result = await intake.ingest({ deliveryId, event, payload, source: 'webhook' });
      return c.json({ ok: true, ...result });
    },
  );
  return app;
}

/**
 * 补收（先留接口）：GitHub 不会自动重投失败的投递，事件也可能在路上丢。由引擎的定时任务实现，
 * 捞回来的事件一律走 GitHubIntake.ingest（同一道白名单门、同一本投递账）。
 */
export interface GitHubReconciler {
  /** 对账：用 App 身份拉投递日志，把失败的重投（重投时投递编号不变，去重账会认出来）。 */
  redeliverFailed(since: Date): Promise<ReconcileReport>;
  /** 轮询：按 updated_at 拉一个仓的 issue、评论、PR，逐条 ingest（source=poll，编号用 pollDeliveryId）。 */
  poll(repoFullName: string, since: Date): Promise<ReconcileReport>;
}

export interface ReconcileReport {
  /** ok = 查完了；unscanned = 这次没查成（和「查了没发现」分开）。 */
  outcome: 'ok' | 'unscanned';
  checked: number;
  recovered: number;
  why?: string | undefined;
}

/** 轮询捞到的东西用这个当投递编号：同一版本（updated_at 相同）只收一次，改过之后再收。 */
export function pollDeliveryId(repo: string, kind: string, id: number | string, updatedAt: string): string {
  return `poll:${repo.toLowerCase()}:${kind}:${id}:${updatedAt}`;
}
