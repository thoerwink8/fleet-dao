// 对账与补漏（引擎的定时任务调这里；设计第六节「每小时对账」）：
// - 重投：GitHub 不自动重投失败的投递。用 App 身份拉投递日志，同一次投递（guid）一次都没成功、后端库里也没有原文的就重投
//   （重投时编号不变，后端去重认得出）；库里有原文的由后端按原文重放，不再叫 GitHub 重投。
// - 轮询：按 updated_at 拉 PR，逐条交给后端的同一道门（白名单、去重），漏收的事件这样补回来。issue 和评论不收了：单子由引擎自己拉（#632）。
// - 核对：合并的 PR 都记在镜像里。我们两个机器人开的 PR 还要是「引擎」机器人合的、
//   账上有合并队列的合并记录（C21/C22）。人开的不查这两项：帅位本机开、GitHub 自动合并，没有合并队列这一步。
//   例外：分支以 ci-timings/ 开头、开和合都是引擎机器人的耗时表 PR（isEngineCiTimingsPr）不走任务合并队列，不报没有合并记录。
// 每一项都分清「查了、0 个问题」和「这次没查成」：读不到 GitHub 就报 unscanned，不报 ok；做了一半报 partial，全没做成报 failed。
import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import { enc, type GhRequest, type Logger, nextLink, parseRepoSlug, repoSlug } from './client.ts';
import type { Deps } from './deps.ts';
import { type EchoKind, echoOf } from './echo.ts';
import { isGitHubError } from './errors.ts';
import { mirrorExtrasOf } from './events.ts';
import { HYGIENE_REPO } from './hygiene-scope.ts';
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
  /**
   * 头分支、开的是不是引擎机器人、合的是不是引擎机器人。
   * 对账拿这三样认耗时表（isEngineCiTimingsPr）。不带就按普通的绕队列报。
   */
  headRef?: string;
  openedByEngine?: boolean;
  mergedByEngine?: boolean;
}

/** 合了的 PR 对账的结果：problems 是 findings 的 text 按顺序排下来。 */
export interface MergedPrAuditReport extends AuditReport {
  findings: MergedPrFinding[];
  /**
   * 这一轮看到的引擎自己的耗时表 PR 号（isEngineCiTimingsPr）。
   * 没有「没经合并队列」那条发现，调用方仍要按这个把已经开着的 reconcile:pr 撤掉。
   */
  engineCiTimingsPrs?: number[];
  /** 精确核过同仓、引擎开合、changelog/v<N> 且只改 CHANGELOG.md 的受管 PR。 */
  engineChangelogPrs?: number[];
  /**
   * 这一轮看到的、我们机器人开的、实际合并人是「引擎」、真实 github.merge_pr 的完整回执与 GitHub 一致的 PR 号。
   * 调用方按这个撤掉已经开着的 reconcile:pr；补账不能证明经过合并队列。
   */
  cleanPrs?: number[];
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
  /**
   * 投递日志最多翻几页（每页 100 条），默认 DELIVERY_MAX_PAGES。翻到上限还没翻到 since：翻到的那一截照样重投，
   * 这一步报 partial（没查全，不推进成功水位）。
   */
  maxDeliveryPages?: number | undefined;
}

/**
 * 投递日志默认最多翻 200 页 = 2 万条。client 通用的 50 页（5000 条）在发布勤的时候几小时就满（法国实测 2026-10-20：
 * 每 15 分钟撞一次 50 页上限、一轮轮报没查全、一个都不重投，since 停在原地，窗口越拉越长、越翻越翻不完）。
 * 定时任务在引擎进程里跑、没有活动超时；GitHub 每页约 1 秒，翻满也只要几分钟，落在 15 分钟一轮里。
 */
export const DELIVERY_MAX_PAGES = 200;

/** 翻页位置：下一页的查询参数（GitHub 在 Link 头里给游标，原样带回去）。 */
type ScanCursor = Record<string, string>;
/**
 * 翻到页数上限时留下的续扫位置：[cursor 之前, newestAt 到现在] 已经查全，更早的接着从 cursor 翻。
 * 下一轮先从最新翻到 newestAt（这中间新来的），再从 cursor 往更早接。
 */
interface ResumeState {
  newestAt: string;
  cursor: ScanCursor;
  /**
   * 前几轮已查到、还没重投成的失败投递（超出一次的重投名额、或重投失败的）。续扫不会再翻回那一段，所以连同位置一起带着，
   * 下一轮并回待重投名单；这样名额不够、重投失败也不必停住不存位置，水位照样能往前翻。
   */
  pending: PendingDelivery[];
}
interface PendingDelivery {
  guid: string;
  id: string;
  deliveredAt: string;
}
const ResumeStateSchema = z.object({
  newestAt: z.string(),
  cursor: z.record(z.string(), z.string()),
  pending: z.array(z.object({ guid: z.string(), id: z.string(), deliveredAt: z.string() })).default([]),
});
/** 续扫位置里最多带多少个待重投的；超出就不存位置（宁可从头翻，也不丢）。 */
const MAX_PENDING_DELIVERIES = 2000;
/** 同一个 since 最多存几个续扫位置（一轮存一个，翻完整个回看窗口也用不了几个）。 */
const MAX_RESUME_SLOTS = 1000;
const resumeKey = (since: Date, n: number): string =>
  `gh:reconcile-deliveries-resume:${since.toISOString()}:${n}`;

function cursorOf(link: string | null): ScanCursor | null {
  const next = nextLink(link);
  if (!next) return null;
  try {
    return Object.fromEntries(new URL(next).searchParams);
  } catch {
    return null;
  }
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

// 撤风险必须能把真实队列回执的四个字段与 GitHub 逐项对上；不完整的历史回执不能证明走过队列。
const CompletedMergeReceipt = z.object({
  number: z.number().int().positive().safe(),
  head: z.string().regex(/^[a-f\d]{40}$/i),
  mergeCommit: z.string().regex(/^[a-f\d]{40}$/i),
  mergedBy: z.string().min(1),
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

  // 投递日志续扫位置记在幂等账里（不新增表）：账里的键完成后不能改，所以同一个 since 一轮存一个键，编号 0、1、2……往后排，
  // 读的时候顺着找到最后一个完成的。成功推进水位后 since 变了，旧的这一串就不再被读到。读写失败只是退回从头翻，不挡对账。
  const loadResume = async (
    since: Date,
  ): Promise<{ n: number; state: ResumeState | null; usable: boolean }> => {
    let state: ResumeState | null = null;
    let n = 0;
    try {
      for (; n < MAX_RESUME_SLOTS; n += 1) {
        const row = await ledger.idempotency.peek(resumeKey(since, n));
        if (!row) return { n, state, usable: true };
        if (row.completedAt) {
          const parsed = ResumeStateSchema.safeParse(row.result);
          state = parsed.success ? parsed.data : null;
        }
      }
    } catch (err) {
      log.warn('读投递日志续扫位置失败，这一轮从头翻', { error: errMessage(err) });
    }
    return { n, state: null, usable: false };
  };
  const saveResume = async (since: Date, n: number, state: ResumeState): Promise<boolean> => {
    try {
      const key = resumeKey(since, n);
      const now = client.now();
      const claim = await ledger.idempotency.claim(
        { key, action: 'github.reconcile_deliveries_resume', target: since.toISOString() },
        now,
      );
      if (claim.status !== 'claimed') return false;
      await ledger.idempotency.complete(key, state, now);
      return true;
    } catch (err) {
      log.warn('存投递日志续扫位置失败，下一轮从头翻', { error: errMessage(err) });
      return false;
    }
  };

  return {
    async redeliverFailed(since) {
      const failed = new Map<string, { id: string; deliveredAt: string }>();
      const ok = new Set<string>();
      let checked = 0;
      const maxPages = options.maxDeliveryPages ?? DELIVERY_MAX_PAGES;
      // 续扫位置只在能向后端问「这条投递库里有没有原文」时用：续扫的几轮之间不带 ok 名单，早先轮次里已经成功的 guid
      // （成功 = 后端收到并记了原文）靠这个过滤掉，不会再叫 GitHub 重投一遍
      const resumable = options.storedDeliveries !== undefined;
      const slot = resumable ? await loadResume(since) : { n: 0, state: null, usable: false };
      // 这一轮见到的最老、最新一条的时刻
      const seen: { oldest: string | null; newest: string | null } = { oldest: null, newest: null };
      let pagesUsed = 0;
      const base: GhRequest = {
        method: 'GET',
        path: '/app/hook/deliveries',
        auth: { as: 'app', role: 'engine' },
        query: { per_page: 100 },
      };
      // 从 req 起新的在前往老翻，翻到早于 floorMs 的就停。翻到页数预算还没翻完：done = false，next = 下一页的查询参数
      // （GitHub 的游标在 Link 头里），续扫从它接着翻。形状不认识回 null。
      const walk = async (
        req: GhRequest,
        floorMs: number,
        budget: number,
      ): Promise<{ done: boolean; next: ScanCursor | null } | null> => {
        let next: ScanCursor | null = null;
        try {
          for await (const page of client.pages(req, budget)) {
            pagesUsed += 1;
            next = cursorOf(page.headers.get('link'));
            const parsed = z.array(Delivery).safeParse(page.data);
            if (!parsed.success) return null;
            let older = false;
            // 新的在前：同一个 guid 先看到的是最近一次尝试
            for (const d of parsed.data) {
              if (Date.parse(d.delivered_at) < floorMs) {
                older = true;
                continue;
              }
              checked += 1;
              seen.oldest = d.delivered_at;
              if (seen.newest === null || Date.parse(d.delivered_at) > Date.parse(seen.newest)) {
                seen.newest = d.delivered_at;
              }
              const code = d.status_code ?? 0;
              if (code >= 200 && code < 300) ok.add(d.guid);
              else if (!failed.has(d.guid)) failed.set(d.guid, { id: d.id, deliveredAt: d.delivered_at });
            }
            if (older || parsed.data.length === 0) return { done: true, next: null };
          }
        } catch (err) {
          if (!isGitHubError(err, 'TOO_MANY_PAGES') || checked === 0) throw err;
          return { done: false, next };
        }
        return { done: true, next: null };
      };
      // 扫完了 = 翻到了 since；没扫完时 nextCursor 是续扫位置，cursorSavable = 它接得上已查全的那一截
      let scanDone = true;
      let nextCursor: ScanCursor | null = null;
      let cursorSavable = resumable && slot.usable;
      try {
        // 有存下的续扫位置：先从最新翻到上一轮见到的最新一条（这中间新来的），再从存下的位置往更早接着翻。
        // 已查全的是 [续扫位置, 现在] 这一整段；从头起的话就是翻到 since 为止
        const resumeFrom = slot.state;
        const head = await walk(
          base,
          resumeFrom ? Date.parse(resumeFrom.newestAt) : since.getTime(),
          maxPages,
        );
        if (!head) return { outcome: 'unscanned', checked, recovered: 0, why: '投递日志的形状不认识' };
        scanDone = head.done;
        nextCursor = head.next;
        if (resumeFrom) {
          // 上一段接不上（新来的就占满了页数预算）：这一轮不动存下的位置
          if (!head.done) cursorSavable = false;
          else if (maxPages - pagesUsed <= 0) {
            scanDone = false;
            nextCursor = resumeFrom.cursor;
          } else {
            const tail = await walk(
              { ...base, query: resumeFrom.cursor },
              since.getTime(),
              maxPages - pagesUsed,
            );
            if (!tail) return { outcome: 'unscanned', checked, recovered: 0, why: '投递日志的形状不认识' };
            scanDone = tail.done;
            nextCursor = tail.next;
          }
        }
      } catch (err) {
        return { outcome: 'unscanned', checked, recovered: 0, why: `读投递日志失败：${errMessage(err)}` };
      }
      // 前几轮留下的待重投：这一轮翻到的新尝试优先，没见过的并回来；这一轮见到成功的（含重投后成功的）就不用补了
      for (const p of slot.state?.pending ?? []) {
        if (!failed.has(p.guid)) failed.set(p.guid, { id: p.id, deliveredAt: p.deliveredAt });
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
          why: `查后端库里有没有这些投递失败，这一轮不重投：${errMessage(err)}`,
        };
      }
      const todo = neverOk.filter(([guid]) => !stored.has(guid));
      // 老的先补：上面翻页是新的在前，todo 原样也是「最近失败的排前面」。since 是个固定往回看的窗口、跟着现在往前挪，
      // 不按时间重排的话，一直有新失败的会一轮轮把老的挤到 50 个名额外面，老的永远轮不上、等它超出 since 就再也补不回来
      // （法国实测：发布很勤，几乎每轮都有新的 502/504，10:26 UTC 就开始失败的一批 check_run/workflow_run
      // 500 到 15 点多一次都没被重投过——GitHub 对账补漏一直 partial 就是这么来的）。按 delivered_at 升序重排：
      // 离窗口边界最近、最快过期的先补。
      todo.sort((a, b) => Date.parse(a[1].deliveredAt) - Date.parse(b[1].deliveredAt));
      const limit = options.maxRedeliveries ?? 50;
      let recovered = 0;
      const errors: string[] = [];
      const redelivered = new Set<string>();
      for (const [guid, { id }] of todo.slice(0, limit)) {
        try {
          await client.request({
            method: 'POST',
            path: `/app/hook/deliveries/${id}/attempts`,
            auth: { as: 'app', role: 'engine' },
          });
          recovered += 1;
          redelivered.add(guid);
        } catch (err) {
          errors.push(`${guid}：${errMessage(err)}`);
        }
      }
      if (todo.length > 0) log.warn('有投递一直没成功，已重投', { failed: todo.length, recovered });
      const attempted = Math.min(todo.length, limit);
      // 没翻到 since：存下续扫位置，下一轮从它接着往更早翻（水位不动，这一步仍是 partial）。这一轮没重投成的（名额不够、
      // 重投失败）随位置带到下一轮继续补：不然要么丢了，要么只能每轮从头翻同一截
      const pending = todo
        .filter(([guid]) => !redelivered.has(guid))
        .map(([guid, d]) => ({ guid, id: d.id, deliveredAt: d.deliveredAt }));
      let resumeSaved = false;
      if (
        !scanDone &&
        nextCursor &&
        cursorSavable &&
        seen.newest !== null &&
        pending.length <= MAX_PENDING_DELIVERIES
      ) {
        resumeSaved = await saveResume(since, slot.n, {
          newestAt: seen.newest,
          cursor: nextCursor,
          pending,
        });
      }
      const notes = [
        scanDone
          ? ''
          : `投递日志这一轮翻了 ${pagesUsed} 页还没翻到 ${since.toISOString()}：只查了 ${seen.oldest} 以后的 ${checked} 条，更早的这次没查全${resumeSaved ? '（续扫位置已存，下一轮接着往更早翻）' : ''}`,
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
          why: `轮询 ${slug} 没做完：${errMessage(err)}`,
        };
      }
      return { outcome: 'ok', checked, recovered };
    },

    auditMergedPrs: (repoFullName, since) => auditMergedPrs(deps, repoFullName, since),
  };
}

/**
 * 刷新 CI 测试耗时表的 PR 不走任务的合并队列。
 * 定时任务从默认分支拉 `ci-timings/日期`，引擎机器人自己开 PR、自己挂 GitHub 自动合并。
 * 没有对应的单，进不了只收 `fleet/` 任务分支的合并队列（合前还要核对不落后主线、CI 全绿、人闸）。
 * 账上没有合并记录是这条路径的常态，不是绕过队列。
 * 分支不是 `ci-timings/` 开头，或开、合不是引擎机器人，仍算绕过。
 */
export function isEngineCiTimingsPr(pr: {
  headRef: string;
  openedByEngine: boolean;
  mergedByEngine: boolean;
}): boolean {
  return pr.headRef.startsWith('ci-timings/') && pr.openedByEngine && pr.mergedByEngine;
}

/**
 * 一段时间里合了的 PR：镜像没记成已合并的都补上（人开的、机器人开的一样，补镜像是安全的）。
 * 合并人必须是「引擎」、账上必须有合并队列的合并记录：只查我们两个机器人开的 PR。人开的没有合并队列这一步，
 * 查了会把帅位本机开的、GitHub 自动合并的每一张都报出来。
 * 引擎自己的耗时表 PR（isEngineCiTimingsPr）不报没有合并记录，只补账。
 */
export async function auditMergedPrs(
  deps: Deps,
  repoFullName: string,
  since: Date,
): Promise<MergedPrAuditReport> {
  const { client, ledger } = deps;
  const log: Logger = deps.log;
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
  const engineCiTimingsPrs: number[] = [];
  const engineChangelogPrs: number[] = [];
  const cleanPrs: number[] = [];
  const note = (
    number: number,
    kind: MergedPrFinding['kind'],
    text: string,
    extra?: Pick<MergedPrFinding, 'headRef' | 'openedByEngine' | 'mergedByEngine'>,
  ) => findings.push({ number, kind, text: `#${number} ${text}`, ...extra });
  let scanned = 0;
  const report = (): Omit<MergedPrAuditReport, 'outcome' | 'why'> => ({
    scanned,
    found: findings.filter((f) => f.kind !== 'unchecked').length,
    fixed: findings.filter((f) => f.kind === 'mirror_fixed').length,
    problems: findings.map((f) => f.text),
    findings,
    engineCiTimingsPrs,
    engineChangelogPrs,
    cleanPrs,
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
          if (mirror?.state === 'merged' && mirror.title == null) {
            // 旧行（加标题列之前合的）补标题：主页「做完的」没有任务记录时要用；不算「镜像不对」，不记发现
            await ledger.upsertPullRequest({
              repoId,
              number: item.number,
              state: 'merged',
              headRef: item.head.ref,
              headSha: item.head.sha,
              updatedAt: new Date(item.updated_at),
              ...mirrorExtrasOf(item, true, slug),
            });
          }
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
          const openedByEngine = deps.bots.is('engine', item.user);
          const openedByUs = openedByEngine || deps.bots.is('agent', item.user);
          if (!openedByUs) continue;
          // 合并人只有单张读才有
          const pr = await readPull(deps, repo, item.number, 'engine');
          const mergedByEngine = deps.bots.is('engine', pr.merged_by ?? null);
          const headRef = pr.head.ref;
          const who = { headRef, openedByEngine, mergedByEngine };
          // 更新日志的豁免窄到自仓、真实 Bot 身份、已合的精确分支及唯一文件；不按标题或分支前缀泛放行。
          let managedChangelog = false;
          const self = repoSlug(HYGIENE_REPO);
          if (
            slug === self &&
            openedByEngine &&
            deps.bots.is('engine', pr.user) &&
            mergedByEngine &&
            pr.number === item.number &&
            pr.merged === true &&
            pr.state === 'closed' &&
            /^changelog\/v[1-9]\d*$/.test(headRef) &&
            Number(headRef.slice('changelog/v'.length)) >= 4 &&
            pr.head.repo?.full_name === self &&
            pr.base.ref === 'main' &&
            pr.base.repo.full_name === self
          ) {
            const files = await client.all({
              method: 'GET',
              path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/pulls/${item.number}/files`,
              auth: { as: 'engine', repo },
              query: { per_page: 100 },
            });
            const parsed = z.array(z.object({ filename: z.string(), status: z.string() })).parse(files);
            managedChangelog =
              parsed.length === 1 &&
              parsed[0]?.filename === 'CHANGELOG.md' &&
              parsed[0].status === 'modified';
            if (managedChangelog) engineChangelogPrs.push(item.number);
          }
          // 耗时表这条自己合的，记下来给上面撤旧提醒；有没有合并记录都记，回看窗口里开着的误报才撤得掉。
          if (isEngineCiTimingsPr(who)) engineCiTimingsPrs.push(item.number);
          if (!mergedByEngine) {
            note(
              item.number,
              'not_merged_by_engine',
              `不是「引擎」机器人合的（合并人 ${pr.merged_by?.login ?? '读不到'}）`,
              who,
            );
          }
          // 合并队列合的每一张都在幂等账里留了合并记录（C21）。没留的：多半是绕开了合并队列（#431 那种——账号
          // 手动合的、合并前那几道核对可能没走），账上要补上：receipt 里写明实际合并人，让账反映事实。提醒照报，
          // 创始人判断一次要不要走合并队列；补账保留来源，下一轮仍不能作为走过队列的证据。
          // 耗时表（isEngineCiTimingsPr）不报这一条，只补账。别的引擎 PR（包括 fleet/ 任务分支）照报。
          const key = mergeKey(repo, item.number, pr.head.sha);
          const existing = await ledger.idempotency.peek(key);
          // 只认真实队列动作及与现读 GitHub 完全一致的回执；不能把 backfill 晋升成合前核对证据。
          const receipt = CompletedMergeReceipt.safeParse(existing?.result);
          const clean =
            existing?.completedAt != null &&
            existing.action === 'github.merge_pr' &&
            existing.target === `${slug}#${item.number}` &&
            mergedByEngine &&
            pr.number === item.number &&
            pr.state === 'closed' &&
            pr.merged === true &&
            pr.merged_at != null &&
            receipt.success &&
            receipt.data.number === pr.number &&
            receipt.data.head === pr.head.sha &&
            receipt.data.mergeCommit === pr.merge_commit_sha &&
            receipt.data.mergedBy === pr.merged_by?.login;
          if (clean) cleanPrs.push(item.number);
          else if (!isEngineCiTimingsPr(who) && !managedChangelog) {
            note(item.number, 'no_merge_record', '合并了，但账上没有合并队列的合并记录', who);
          }
          if (!existing?.completedAt) {
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
                log.warn('补记合并记录失败', { repo: slug, number: item.number, why: errMessage(err) });
              }
            }
          }
        } catch (err) {
          note(item.number, 'unchecked', `没查成：${errMessage(err)}`);
        }
      }
    }
  } catch (err) {
    return { outcome: 'unscanned', ...report(), why: `列合并的 PR 失败：${errMessage(err)}` };
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
