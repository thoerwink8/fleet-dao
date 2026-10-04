// GitHub 事件接收：验签名（X-Hub-Signature-256）→ 原文落库、投递编号去重 → 白名单过滤 → PR 镜像。只收 PR 和 CI 的事件（给驾驶舱的镜像用）；
// issue、评论的事件不收：单子由引擎每 5 分钟自己去 GitHub 上拉（#632），不靠事件，也没有认领（#556）。
// 香港只转发不验签：请求体和几个头原样透传，签名必须对收到的原始字节算，不许先解析再序列化。
// 验签不过的不落库（没认证的请求不许往库里写），只回 401、记日志。
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DELIVERY_STALE_MS,
  type GitHubEventSink,
  type GitHubIntake,
  githubWhitelist,
  MAX_AUTO_REPLAYS,
} from '@fleet-dao/store';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from './deps.ts';
import { PublicHealthError } from './health.ts';
import { ApiError, errorBody } from './http.ts';

/** GitHub 的投递上限是 25 MB。 */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

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
    // 收得进来之前的两样：有受管的仓、白名单里有带 GitHub 账号的人。缺一样，事件和对账补回来的单全被门挡掉
    // （仓不受管、作者不在白名单），投递账上是「不收」、不算出错，光看卡住的条数永远是好的
    if ((await parts.store.listRepos()).length === 0) {
      throw new PublicHealthError('no_repos', '还没有受管的仓：GitHub 上的单进不来');
    }
    const members = githubWhitelist(await parts.store.listUsers());
    if (members.userIds.size === 0 && members.logins.size === 0) {
      throw new PublicHealthError(
        'no_github_members',
        '白名单里没有带 GitHub 账号的成员：GitHub 上开的单都会被挡在门外',
      );
    }
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
      const result = await intake.ingest({ deliveryId, event, payload, source: 'webhook' });
      return c.json({ ok: true, ...result });
    },
  );
  return app;
}
