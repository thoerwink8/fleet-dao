// 对账与补漏（引擎的定时任务调这里；设计第六节「每小时对账」）：
// - 重投：GitHub 不自动重投失败的投递。用 App 身份拉投递日志，同一次投递（guid）一次都没成功的就重投（重投时编号不变，后端去重认得出）。
// - 轮询：按 updated_at 拉 issue、评论、PR，逐条交给后端的同一道门（白名单、去重），漏收的事件这样补回来。
// - 核对：白名单作者开的开放 issue 都有工作流；合并的 PR 都记在镜像里、都是「引擎」机器人合的（C21/C22）。
// 每一项都分清「查了、0 个问题」和「这次没查成」：读不到 GitHub 就报 unscanned，不报 ok；做了一半报 partial，全没做成报 failed。
import { z } from 'zod';
import { enc, type Logger, parseRepoSlug, repoSlug } from './client.ts';
import type { Deps } from './deps.ts';
import { type EchoKind, echoOf } from './echo.ts';
import { mergeKey, readPull } from './pulls.ts';

/** 和 @fleet-dao/api 的 GitHubIntake 同形：补收的东西走同一道门、同一本投递账。 */
export interface Intake {
  ingest(input: {
    deliveryId: string;
    event: string;
    payload: unknown;
    source: 'webhook' | 'poll' | 'redelivery';
  }): Promise<
    { verdict: 'accepted'; wake: boolean } | { verdict: 'ignored'; reason: string } | { verdict: 'duplicate' }
  >;
}

/**
 * 重投、轮询的结果。和 @fleet-dao/api 的 ReconcileReport 同形，只是 outcome 多两态（和定时任务的结局 ScheduleOutcome 一致）：
 * ok = 查完了、该做的都做成了；partial = 做了一部分（有的重投失败、翻到一半断了）；
 * unscanned = 这次没查成（和「查了没发现」分开）；failed = 该做的一件都没做成。
 */
export interface ReconcileReport {
  outcome: 'ok' | 'partial' | 'unscanned' | 'failed';
  checked: number;
  recovered: number;
  why?: string | undefined;
}

/** 核对的结果。outcome 的写法和定时任务的结局（ScheduleOutcome）一致。 */
export interface AuditReport {
  outcome: 'ok' | 'partial' | 'unscanned';
  /** 查了几个对象。 */
  scanned: number;
  /** 发现几个问题。 */
  found: number;
  /** 其中自动补上的。 */
  fixed: number;
  problems: string[];
  why?: string | undefined;
}

export interface ReconcilerOptions {
  intake: Intake;
  /** 轮询用的投递编号：用后端的 pollDeliveryId，保证和后端的去重账是同一套写法。 */
  pollDeliveryId: (repo: string, kind: string, id: number | string, updatedAt: string) => string;
  /** 这张 issue 有没有在跑的工作流；引擎按 Temporal 实现。不给就按「库里有这个需求」算。 */
  hasWorkflow?: ((repo: string, issueNumber: number) => Promise<boolean>) | undefined;
  /** 一次最多重投几个（重投是写请求，要串行、要间隔），默认 50。 */
  maxRedeliveries?: number | undefined;
}

const Delivery = z.object({
  id: z.number(),
  guid: z.string(),
  delivered_at: z.string(),
  status_code: z.number().nullable().optional(),
  event: z.string().optional(),
});

const IssueItem = z.object({
  number: z.number(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
  user: z.object({ login: z.string(), id: z.number(), type: z.string() }).nullable(),
});
const CommentItem = z.object({
  id: z.number(),
  updated_at: z.string(),
  issue_url: z.string().optional(),
  user: z.object({ login: z.string(), id: z.number(), type: z.string() }).nullable(),
});
const PullItem = z.object({
  number: z.number(),
  updated_at: z.string(),
  merged_at: z.string().nullable().optional(),
  state: z.string(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  user: z.object({ login: z.string(), id: z.number(), type: z.string() }).nullable(),
});

export interface Reconciler {
  redeliverFailed(since: Date): Promise<ReconcileReport>;
  poll(repoFullName: string, since: Date): Promise<ReconcileReport>;
  auditOpenIssues(repoFullName: string): Promise<AuditReport>;
  auditMergedPrs(repoFullName: string, since: Date): Promise<AuditReport>;
}

export function createReconciler(deps: Deps, options: ReconcilerOptions): Reconciler {
  const { client, ledger } = deps;
  const log: Logger = deps.log;
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

  return {
    async redeliverFailed(since) {
      const failed = new Map<string, number>();
      const ok = new Set<string>();
      let checked = 0;
      try {
        for await (const page of client.pages({
          method: 'GET',
          path: '/app/hook/deliveries',
          auth: { as: 'app', role: 'engine' },
          query: { per_page: 100 },
        })) {
          const parsed = z.array(Delivery).safeParse(page.data);
          if (!parsed.success)
            return { outcome: 'unscanned', checked, recovered: 0, why: '投递日志的形状不认识' };
          let older = false;
          // 新的在前：同一个 guid 先看到的是最近一次尝试
          for (const d of parsed.data) {
            if (Date.parse(d.delivered_at) < since.getTime()) {
              older = true;
              continue;
            }
            checked += 1;
            const code = d.status_code ?? 0;
            if (code >= 200 && code < 300) ok.add(d.guid);
            else if (!failed.has(d.guid)) failed.set(d.guid, d.id);
          }
          if (older || parsed.data.length === 0) break;
        }
      } catch (err) {
        return { outcome: 'unscanned', checked, recovered: 0, why: `读投递日志失败：${why(err)}` };
      }
      const todo = [...failed].filter(([guid]) => !ok.has(guid));
      const limit = options.maxRedeliveries ?? 50;
      let recovered = 0;
      const errors: string[] = [];
      for (const [guid, id] of todo.slice(0, limit)) {
        try {
          await client.request({
            method: 'POST',
            path: `/app/hook/deliveries/${id}/attempts`,
            auth: { as: 'app', role: 'engine' },
          });
          recovered += 1;
        } catch (err) {
          errors.push(`${guid}：${why(err)}`);
        }
      }
      if (todo.length > 0) log.warn('有投递一直没成功，已重投', { failed: todo.length, recovered });
      const attempted = Math.min(todo.length, limit);
      const notes = [
        todo.length > limit ? `还有 ${todo.length - limit} 个没重投（一次最多 ${limit} 个）` : '',
        errors.length ? `重投失败 ${errors.length} 个：${errors.slice(0, 3).join('；')}` : '',
      ].filter(Boolean);
      // 重投失败如实报：一个都没成是 failed，成了一部分或还剩着没重投是 partial
      const outcome =
        attempted > 0 && errors.length === attempted ? 'failed' : notes.length > 0 ? 'partial' : 'ok';
      return { outcome, checked, recovered, why: notes.length ? notes.join('；') : undefined };
    },

    async poll(repoFullName, since) {
      const repo = parseRepoSlug(repoFullName);
      const slug = repoSlug(repo);
      const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
      const auth = { as: 'engine' as const, repo };
      const repository = { full_name: slug };
      let checked = 0;
      let recovered = 0;
      const ingest = async (deliveryId: string, event: string, payload: unknown) => {
        checked += 1;
        const res = await options.intake.ingest({ deliveryId, event, payload, source: 'poll' });
        if (res.verdict === 'accepted') recovered += 1;
      };
      // 列表里没有「是谁改的」：这一版是自家机器人写出来的（按写入回执记过 updated_at），就把机器人当 sender，
      // 后端据此不叫醒工作流；认不出的不带 sender（后端当别人改的，叫醒）
      const senderOf = async (kind: EchoKind, number: number, updatedAt: string) => {
        const role = await echoOf(ledger.idempotency, repo, kind, number, updatedAt);
        if (!role) return {};
        const bot = await deps.bots.identity(role, repo);
        return { sender: { login: bot.login, id: bot.userId, type: 'Bot' } };
      };
      try {
        const sinceIso = since.toISOString();
        for await (const page of client.pages({
          method: 'GET',
          path: `${base}/issues`,
          auth,
          query: { state: 'all', since: sinceIso, sort: 'updated', direction: 'asc', per_page: 100 },
        })) {
          const items = z.array(IssueItem).parse(page.data);
          for (const it of items) {
            if (it.pull_request) continue; // PR 下面单独拉，拿完整的 PR 对象
            await ingest(options.pollDeliveryId(slug, 'issue', it.number, it.updated_at), 'issues', {
              action: 'synced',
              issue: it,
              repository,
              ...(await senderOf('issue', it.number, it.updated_at)),
            });
          }
        }
        for await (const page of client.pages({
          method: 'GET',
          path: `${base}/issues/comments`,
          auth,
          query: { since: sinceIso, sort: 'updated', direction: 'asc', per_page: 100 },
        })) {
          const items = z.array(CommentItem).parse(page.data);
          for (const c of items) {
            // 评论列表里没有 issue 号这一栏，只有 issue_url；只认 GitHub 自己的固定形状，认不出就不带号（引擎会回读）
            const m = /\/issues\/(\d+)$/.exec(c.issue_url ?? '');
            await ingest(options.pollDeliveryId(slug, 'comment', c.id, c.updated_at), 'issue_comment', {
              action: 'synced',
              comment: c,
              ...(m?.[1] ? { issue: { number: Number(m[1]) } } : {}),
              repository,
              // 评论是谁写的就是谁：自家机器人发的关单评论，后端认得出是回声
              ...(c.user ? { sender: c.user } : {}),
            });
          }
        }
        outer: for await (const page of client.pages({
          method: 'GET',
          path: `${base}/pulls`,
          auth,
          query: { state: 'all', sort: 'updated', direction: 'desc', per_page: 100 },
        })) {
          const items = z.array(PullItem).parse(page.data);
          for (const pr of items) {
            if (Date.parse(pr.updated_at) < since.getTime()) break outer;
            await ingest(options.pollDeliveryId(slug, 'pull', pr.number, pr.updated_at), 'pull_request', {
              action: 'synced',
              pull_request: pr,
              repository,
              ...(await senderOf('pull', pr.number, pr.updated_at)),
            });
          }
        }
      } catch (err) {
        // 翻到一半断了：前面送进门的算数，但这次没查全
        return {
          outcome: checked > 0 ? 'partial' : 'unscanned',
          checked,
          recovered,
          why: `轮询 ${slug} 没做完：${why(err)}`,
        };
      }
      return { outcome: 'ok', checked, recovered };
    },

    async auditOpenIssues(repoFullName) {
      const repo = parseRepoSlug(repoFullName);
      const slug = repoSlug(repo);
      const repoId = await ledger.repoId(repo);
      if (!repoId)
        return {
          outcome: 'unscanned',
          scanned: 0,
          found: 0,
          fixed: 0,
          problems: [],
          why: `${slug} 不归本系统管`,
        };
      let issues: z.infer<typeof IssueItem>[];
      try {
        issues = z
          .array(IssueItem)
          .parse(
            await client.all({
              method: 'GET',
              path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues`,
              auth: { as: 'engine', repo },
              query: { state: 'open', per_page: 100 },
            }),
          )
          .filter((i) => !i.pull_request);
      } catch (err) {
        return {
          outcome: 'unscanned',
          scanned: 0,
          found: 0,
          fixed: 0,
          problems: [],
          why: `列开放 issue 失败：${why(err)}`,
        };
      }
      const runAt = client.now().toISOString();
      const problems: string[] = [];
      let found = 0;
      let fixed = 0;
      let failures = 0;
      for (const issue of issues) {
        try {
          const has = options.hasWorkflow
            ? await options.hasWorkflow(slug, issue.number)
            : (await ledger.taskFor(repoId, issue.number)) !== null;
          if (has) continue;
          // 没有工作流：重新走一遍门。白名单外的作者会被门挡下（不算问题）；放进来的就是漏掉的，引擎收到会起工作流
          const res = await options.intake.ingest({
            deliveryId: options.pollDeliveryId(slug, 'issue-audit', issue.number, runAt),
            event: 'issues',
            payload: { action: 'reconcile', issue, repository: { full_name: slug } },
            source: 'poll',
          });
          if (res.verdict === 'accepted') {
            found += 1;
            fixed += 1;
            problems.push(`#${issue.number} 是白名单作者开的，却没有工作流（已重新送进引擎）`);
          }
        } catch (err) {
          failures += 1;
          problems.push(`#${issue.number} 没查成：${why(err)}`);
        }
      }
      return {
        outcome: failures > 0 ? 'partial' : 'ok',
        scanned: issues.length,
        found,
        fixed,
        problems,
      };
    },

    async auditMergedPrs(repoFullName, since) {
      const repo = parseRepoSlug(repoFullName);
      const slug = repoSlug(repo);
      const repoId = await ledger.repoId(repo);
      if (!repoId)
        return {
          outcome: 'unscanned',
          scanned: 0,
          found: 0,
          fixed: 0,
          problems: [],
          why: `${slug} 不归本系统管`,
        };
      const problems: string[] = [];
      let scanned = 0;
      let found = 0;
      let fixed = 0;
      let failures = 0;
      try {
        outer: for await (const page of client.pages({
          method: 'GET',
          path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/pulls`,
          auth: { as: 'engine', repo },
          query: { state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 },
        })) {
          for (const item of z.array(PullItem).parse(page.data)) {
            if (Date.parse(item.updated_at) < since.getTime()) break outer;
            if (!item.merged_at) continue;
            scanned += 1;
            try {
              const mirror = await ledger.getPullRequest(repoId, item.number);
              if (mirror?.state !== 'merged') {
                found += 1;
                await ledger.upsertPullRequest({
                  repoId,
                  number: item.number,
                  state: 'merged',
                  headRef: item.head.ref,
                  headSha: item.head.sha,
                  updatedAt: new Date(item.updated_at),
                });
                fixed += 1;
                problems.push(
                  `#${item.number} 合并了但镜像里${mirror ? `记的是 ${mirror.state}` : '没有'}（已补）`,
                );
              }
              // 合并人只有单张读才有
              const pr = await readPull(deps, repo, item.number, 'engine');
              if (!deps.bots.is('engine', pr.merged_by ?? null)) {
                found += 1;
                problems.push(
                  `#${item.number} 不是「引擎」机器人合的（合并人 ${pr.merged_by?.login ?? '读不到'}）`,
                );
              }
              // 合并队列合的每一张都在幂等账里留了合并记录（C21）
              const record = await ledger.idempotency.peek(mergeKey(repo, item.number, pr.head.sha));
              if (!record?.completedAt) {
                found += 1;
                problems.push(`#${item.number} 合并了，但账上没有合并队列的合并记录`);
              }
            } catch (err) {
              failures += 1;
              problems.push(`#${item.number} 没查成：${why(err)}`);
            }
          }
        }
      } catch (err) {
        return {
          outcome: 'unscanned',
          scanned,
          found,
          fixed,
          problems,
          why: `列合并的 PR 失败：${why(err)}`,
        };
      }
      if (found > 0)
        log.warn('合并的 PR 对账有问题', { repo: slug, found, problems: problems.slice(0, 5).join('；') });
      return { outcome: failures > 0 ? 'partial' : 'ok', scanned, found, fixed, problems };
    },
  };
}
