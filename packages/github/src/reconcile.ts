// 对账与补漏（引擎的定时任务调这里；设计第六节「每小时对账」）：
// - 重投：GitHub 不自动重投失败的投递。用 App 身份拉投递日志，同一次投递（guid）一次都没成功、后端库里也没有原文的就重投
//   （重投时编号不变，后端去重认得出）；库里有原文的由后端按原文重放，不再叫 GitHub 重投。
// - 轮询：按 updated_at 拉 PR，逐条交给后端的同一道门（白名单、去重），漏收的事件这样补回来。issue 和评论不收了：单子由引擎自己拉（#632）。
// - 核对：合并的 PR 都记在镜像里。我们两个机器人开的 PR 还要是「引擎」机器人合的、
//   账上有合并队列的合并记录（C21/C22）。人开的不查这两项：帅位本机开、GitHub 自动合并，没有合并队列这一步。
// 每一项都分清「查了、0 个问题」和「这次没查成」：读不到 GitHub 就报 unscanned，不报 ok；做了一半报 partial，全没做成报 failed。
import { z } from 'zod';
import { enc, type Logger, parseRepoSlug, repoSlug } from './client.ts';
import type { Deps } from './deps.ts';
import { type EchoKind, echoOf } from './echo.ts';
import { mirrorExtrasOf } from './events.ts';
import { type MergeReceipt, mergeKey, readPull } from './pulls.ts';

/**
 * 和 @fleet-dao/api 的 GitHubIntake 同形：补收的东西走同一道门、同一本投递账。seenBefore = 这一版以前的投递带过
 * （只是被门挡掉了，比如陌生人评论顺带的 issue 那一版）：照样处理了，但不算补回。
 */
export interface Intake {
  ingest(input: {
    deliveryId: string;
    event: string;
    payload: unknown;
    source: 'webhook' | 'poll' | 'redelivery';
  }): Promise<
    | { verdict: 'accepted'; wake: boolean; seenBefore?: boolean | undefined }
    | { verdict: 'ignored'; reason: string }
    | { verdict: 'duplicate' }
  >;
}

/**
 * 重投、轮询的结果。outcome 的写法和定时任务的结局（ScheduleOutcome）一致，@fleet-dao/api 的 reconcileGitHub 照原样汇总：
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

/** 合了的 PR 对账查出来的一条：哪条 PR、哪一种（调用方按 kind 分，不去认 text 里的字）。 */
export interface MergedPrFinding {
  number: number;
  /**
   * mirror_fixed：镜像没记成已合并，已经补上（人开的、机器人开的都补）；not_merged_by_engine：我们机器人开的，合并人却不是
   * 「引擎」（C22）；no_merge_record：我们机器人开的，账上却没有合并队列的合并记录（C21）；backfill_merge_record：
   * 手动合的机器人 PR，账上原来没有合并队列的合并记录，按合并回执补上了（receipt.mergedBy 写实际合并人）；unchecked：
   * 这一条没查成。
   */
  kind: 'mirror_fixed' | 'not_merged_by_engine' | 'no_merge_record' | 'backfill_merge_record' | 'unchecked';
  /** 给人看的一句，也原样进 problems。 */
  text: string;
}

/** 合了的 PR 对账的结果：problems 是 findings 的 text 按顺序排下来。 */
export interface MergedPrAuditReport extends AuditReport {
  findings: MergedPrFinding[];
}

export interface ReconcilerOptions {
  intake: Intake;
  /** 轮询用的投递编号：用后端的 pollDeliveryId，保证和后端的去重账是同一套写法。 */
  pollDeliveryId: (repo: string, kind: string, id: number | string, updatedAt: string) => string;
  /**
   * 这几次投递（guid）里，后端库里已经有原文的：它们由后端按原文重放，不再叫 GitHub 重投（不然同一次投递要算两遍、
   * 做两遍）。不给就全都重投。查不成就抛：宁可这一轮不重投，也不盲目重投。
   */
  storedDeliveries?: ((guids: readonly string[]) => Promise<ReadonlySet<string>>) | undefined;
  /** 一次最多重投几个（重投是写请求，要串行、要间隔），默认 50。 */
  maxRedeliveries?: number | undefined;
}

// 投递编号已超出 JS 安全整数（19 位）：client 按原文留成字符串，小的照旧是数字；一律转成原文拼重投的路径。
// 丢了精度的数字（没拿到原文）不认：拿它重投只会 404，宁可这一轮报「形状不认识」。
const DeliveryId = z
  .union([z.number().int().nonnegative().refine(Number.isSafeInteger), z.string().regex(/^\d+$/)])
  .transform(String);

const Delivery = z.object({
  id: DeliveryId,
  guid: z.string(),
  delivered_at: z.string(),
  status_code: z.number().nullable().optional(),
  event: z.string().optional(),
});

// PR 原样整条送进门（looseObject 不删别的字段）：原文也照样落库、能重放。这里只认要用到的几样在不在。
const PullItem = z.looseObject({
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
  auditMergedPrs(repoFullName: string, since: Date): Promise<MergedPrAuditReport>;
}

export function createReconciler(deps: Deps, options: ReconcilerOptions): Reconciler {
  const { client, ledger } = deps;
  const log: Logger = deps.log;
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

  return {
    async redeliverFailed(since) {
      const failed = new Map<string, { id: string; deliveredAt: string }>();
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
            else if (!failed.has(d.guid)) failed.set(d.guid, { id: d.id, deliveredAt: d.delivered_at });
          }
          if (older || parsed.data.length === 0) break;
        }
      } catch (err) {
        return { outcome: 'unscanned', checked, recovered: 0, why: `读投递日志失败：${why(err)}` };
      }
      const neverOk = [...failed].filter(([guid]) => !ok.has(guid));
      let stored: ReadonlySet<string> = new Set();
      try {
        if (options.storedDeliveries && neverOk.length > 0) {
          stored = await options.storedDeliveries(neverOk.map(([guid]) => guid));
        }
      } catch (err) {
        return {
          outcome: 'failed',
          checked,
          recovered: 0,
          why: `查后端库里有没有这些投递失败，这一轮不重投：${why(err)}`,
        };
      }
      const todo = neverOk.filter(([guid]) => !stored.has(guid));
      // 老的先补：上面翻页是新的在前，todo 原样也是「最近失败的排前面」。since 是个固定往回看的窗口、跟着现在往前挪，
      // 不按时间重排的话，一直有新失败的会一轮轮把老的挤到 50 个名额外面，老的永远轮不上、等它超出 since 就再也补不回来
      // （法国 2026-09-27 夜实测：发布很勤，几乎每轮都有新的 502/504，10:26 UTC 就开始失败的一批 check_run/workflow_run
      // 500 到 15 点多一次都没被重投过——GitHub 对账补漏一直 partial 就是这么来的）。按 delivered_at 升序重排：
      // 离窗口边界最近、最快过期的先补。
      todo.sort((a, b) => Date.parse(a[1].deliveredAt) - Date.parse(b[1].deliveredAt));
      const limit = options.maxRedeliveries ?? 50;
      let recovered = 0;
      const errors: string[] = [];
      for (const [guid, { id }] of todo.slice(0, limit)) {
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
        if (res.verdict === 'accepted' && !res.seenBefore) recovered += 1;
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

    auditMergedPrs: (repoFullName, since) => auditMergedPrs(deps, repoFullName, since),
  };
}

/**
 * 一段时间里合了的 PR：镜像没记成已合并的都补上（人开的、机器人开的一样，补镜像是安全的）。
 * 合并人必须是「引擎」、账上必须有合并队列的合并记录：只查我们两个机器人开的 PR。人开的没有合并队列这一步，
 * 查了会把帅位本机开的、GitHub 自动合并的每一张都报出来。
 */
export async function auditMergedPrs(
  deps: Deps,
  repoFullName: string,
  since: Date,
): Promise<MergedPrAuditReport> {
  const { client, ledger } = deps;
  const log: Logger = deps.log;
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const repo = parseRepoSlug(repoFullName);
  const slug = repoSlug(repo);
  const repoId = await ledger.repoId(repo);
  if (!repoId) {
    return {
      outcome: 'unscanned',
      scanned: 0,
      found: 0,
      fixed: 0,
      problems: [],
      findings: [],
      why: `${slug} 不归本系统管`,
    };
  }
  const findings: MergedPrFinding[] = [];
  const note = (number: number, kind: MergedPrFinding['kind'], text: string) =>
    findings.push({ number, kind, text: `#${number} ${text}` });
  let scanned = 0;
  const report = (): Omit<MergedPrAuditReport, 'outcome' | 'why'> => ({
    scanned,
    found: findings.filter((f) => f.kind !== 'unchecked').length,
    fixed: findings.filter((f) => f.kind === 'mirror_fixed').length,
    problems: findings.map((f) => f.text),
    findings,
  });
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
            await ledger.upsertPullRequest({
              repoId,
              number: item.number,
              state: 'merged',
              headRef: item.head.ref,
              headSha: item.head.sha,
              updatedAt: new Date(item.updated_at),
              ...mirrorExtrasOf(item, true, slug),
            });
            note(
              item.number,
              'mirror_fixed',
              `合并了但镜像里${mirror ? `记的是 ${mirror.state}` : '没有'}（已补）`,
            );
          }
          const openedByUs = deps.bots.is('engine', item.user) || deps.bots.is('agent', item.user);
          if (!openedByUs) continue;
          // 合并人只有单张读才有
          const pr = await readPull(deps, repo, item.number, 'engine');
          if (!deps.bots.is('engine', pr.merged_by ?? null)) {
            note(
              item.number,
              'not_merged_by_engine',
              `不是「引擎」机器人合的（合并人 ${pr.merged_by?.login ?? '读不到'}）`,
            );
          }
          // 合并队列合的每一张都在幂等账里留了合并记录（C21）。没留的：多半是绕开了合并队列（#431 那种——账号
          // 手动合的、合并前那几道核对可能没走），账上要补上：receipt 里写明实际合并人，让账反映事实。提醒照报，
          // 创始人兼断一次要不要走合并队列；补账完下一轮 no_merge_record 不再起。
          const key = mergeKey(repo, item.number, pr.head.sha);
          const existing = await ledger.idempotency.peek(key);
          if (!existing?.completedAt) {
            note(item.number, 'no_merge_record', '合并了，但账上没有合并队列的合并记录');
            if (pr.merged_at) {
              try {
                const receipt: MergeReceipt = {
                  number: item.number,
                  head: pr.head.sha,
                  mergeCommit: pr.merge_commit_sha ?? null,
                  mergedBy: pr.merged_by?.login ?? null,
                };
                const claim = await ledger.idempotency.claim(
                  { key, action: 'github.merge_pr_backfill', target: `${slug}#${item.number}` },
                  new Date(pr.merged_at),
                );
                if (claim.status === 'claimed') {
                  await ledger.idempotency.complete(key, receipt, new Date(pr.merged_at));
                  note(
                    item.number,
                    'backfill_merge_record',
                    `按合并回执补上了合并记录（实际合并人 ${pr.merged_by?.login ?? '读不到'}，未经合并队列）`,
                  );
                }
              } catch (err) {
                // 补账失败不能算这个 PR 没查成：补不上并不影响上面已经报出来的绕过合并队列事实，
                // 下一轮还会再来一次（existing?.completedAt 还是空）。
                log.warn('补记合并记录失败', { repo: slug, number: item.number, why: why(err) });
              }
            }
          }
        } catch (err) {
          note(item.number, 'unchecked', `没查成：${why(err)}`);
        }
      }
    }
  } catch (err) {
    return { outcome: 'unscanned', ...report(), why: `列合并的 PR 失败：${why(err)}` };
  }
  const result = report();
  if (result.found > 0) {
    log.warn('合并的 PR 对账有问题', {
      repo: slug,
      found: result.found,
      problems: result.problems.slice(0, 5).join('；'),
    });
  }
  return { outcome: findings.some((f) => f.kind === 'unchecked') ? 'partial' : 'ok', ...result };
}
