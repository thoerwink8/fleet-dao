// 法国的工作树（#1993，母单 #1990）：每个受管仓在 VPS 上占多少、有几棵工作树、每棵现在是什么状态，和「一键清理没用的工作树」。
// 「我只需要关心我们发版的……仓库这种，它占用多少……最好也能加上比如说工作树这种，这样子也能动态的去发现……
// 有很多不需要的工作树这样子可以一键清理掉……所以也要加一些按钮，提供一键清理的方式。」
//
// 数据从哪来：工作树的根（/var/lib/fleet-work）下每棵树归会话用户、700，后端（fleet 用户）读不了；只有引擎能以会话用户的身份看。
// 所以清单由引擎出：每小时对账删残留树那一轮（engine/src/jobs/worktree-sweep.ts）顺手把每棵树的去向记成清单，存进库
// （worktree_inventory，最近一份覆盖写）；后端只读这一份。镜像（/var/lib/fleet-dao/github/mirrors/<owner>/<仓>.git）也由引擎量。
//
// 一键清理和「临时指挥官整理待办」同一个做法（shared/groom.ts）：点一下 = 记一条操作记录 worktrees.cleanup.request，引擎每几秒看一眼，
// 接手记 worktrees.cleanup.start，跑一轮和每小时对账**同一份判据**的清扫，记 worktrees.cleanup.done（删了哪些、拒了哪些、为什么）。
// 走到哪不另存，读的时候从这三种记录现算（foldCleanupRequests）。
//
// 改这里之前必须知道（安全线，不许松）：
// - 只删「没用」的树：没有在跑的任务工作流在用、没有没结束的会话在里面、里面没有没提交的改动、没推的提交、stash、认不出的文件
//   （能重新生成的编译和工具缓存不算，名单是 engine 的 DISPOSABLE）。其余一律拒删并写明原因，删数据要人拍。
// - 一键清理和每小时对账用同一个函数判，不另写一套宽松的。
// - 查不成的（看不了归谁、git 跑不成）算拒删，写「没查成」，不当成干净的删。
import { z } from 'zod';
import { Time } from './internal.ts';

export const WORKTREE_TARGET = 'worktrees';
export const WORKTREE_ACTION = {
  request: 'worktrees.cleanup.request',
  start: 'worktrees.cleanup.start',
  done: 'worktrees.cleanup.done',
} as const;
/** 引擎记接手、清完时写的「谁」。 */
export const WORKTREE_ENGINE_ACTOR = 'engine:worktrees';
/** 引擎多久看一眼有没有人点。 */
export const WORKTREE_POLL_MS = 5_000;
/** 点了这么久引擎还没接手：作废，引擎也不再接（引擎停了一夜，起来不把隔夜点的全跑一遍）。 */
export const WORKTREE_REQUEST_TTL_MS = 15 * 60_000;
/** 接手了这么久还没回结果：当没做成（引擎多半中途重启了），放开，可以再点。 */
export const WORKTREE_RUN_TTL_MS = 30 * 60_000;
/** 读操作记录往回看多久（页面列最近几次、引擎找没人接的）。 */
export const WORKTREE_LIST_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * 一棵树现在的状态（每小时对账或一键清理那一轮看到的）：
 * - running：这张需求的任务工作流（或子任务工作流）在跑，在用；
 * - session：树里有没结束的会话，在用；
 * - leftover：没人用了，但里面还有没提交的改动 / 没推的提交 / stash / 认不出的文件——拒删，报了要人拍；
 * - kept：同上，人已经看过那条要人拍、决定留着；
 * - unchecked：查不成（看不了归谁、git 跑不成、认不出是哪张需求的树）——拒删；
 * - deferred：残留太多，这一轮没轮到看（下一轮看）。
 * 判为没用的树当场就删了，不在清单里（删了几棵在 removed）。
 */
export const WorktreeStateSchema = z.enum([
  'running',
  'session',
  'leftover',
  'kept',
  'unchecked',
  'deferred',
]);
export type WorktreeState = z.infer<typeof WorktreeStateSchema>;

/** 一样东西的大小：量成了是字节；量不了写原因（不拿 0 顶）。 */
export const SizeReadSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), bytes: z.number().int().min(0) }),
  z.object({ state: z.literal('unread'), why: z.string().min(1) }),
]);
export type SizeRead = z.infer<typeof SizeReadSchema>;

export const WorktreeRowSchema = z.object({
  /** owner/name。 */
  repo: z.string().min(1),
  /** 树的目录名（仓那一层下面）。 */
  tree: z.string().min(1),
  /** 这是哪张需求的什么树（「需求 #12 的子任务「a」」）；认不出是哪张需求的写「认不出」。 */
  what: z.string().min(1),
  /** 那张需求的单号；认不出没有。 */
  issueNumber: z.number().int().positive().optional(),
  state: WorktreeStateSchema,
  /** 为什么是这个状态：在用写谁在用；拒删写里面还剩什么、或哪一步没查成。 */
  why: z.string().min(1),
  /** 最近一次在这棵树里起的会话：收场的时刻（还没收场就是起的时刻）。库里一笔都没有就没有这个键。 */
  lastSessionAt: Time.optional(),
  /** 这棵树多大（以会话用户的身份 du）。 */
  size: SizeReadSchema,
});
export type WorktreeRow = z.infer<typeof WorktreeRowSchema>;

export const WorktreeRepoSchema = z.object({
  repo: z.string().min(1),
  /** 引擎的镜像裸仓（/var/lib/fleet-dao/github/mirrors/<owner>/<仓>.git）。还没镜像过是 unread「还没有镜像」。 */
  mirror: SizeReadSchema,
});

/** 一份清单：每小时对账那一轮（hourly）或一键清理那一轮（cleanup）看到的。 */
export const WorktreeInventorySchema = z.object({
  takenAt: Time,
  trigger: z.enum(['hourly', 'cleanup']),
  /** 工作树的根。 */
  root: z.string().min(1),
  /** 这一轮还留着的树（删了的不在里面）。 */
  trees: z.array(WorktreeRowSchema),
  /** 这一轮判为没用、删掉的树（<仓那一层>/<树>）。 */
  removed: z.array(z.string().min(1)),
  /** 受管的仓和根下出现过的仓，各一行（没有树的仓也列，镜像照量）。 */
  repos: z.array(WorktreeRepoSchema),
  /** 整轮没跑成（工作树的根读不了）：有这个键时 trees 不可信，页面写没查成。 */
  failed: z.string().min(1).optional(),
  /** 一部分没查成（某个仓那一层列不了、根下有认不出的东西）。 */
  unchecked: z.array(z.string()),
});
export type WorktreeInventory = z.infer<typeof WorktreeInventorySchema>;

/** 一次清理的结果（worktrees.cleanup.done 的 after.result）。 */
export const WorktreeCleanupResultSchema = z.object({
  /** 删掉的树（<仓那一层>/<树>）。 */
  removed: z.array(z.string()),
  /** 拒删的树和原因。 */
  refused: z.array(z.object({ tree: z.string(), state: WorktreeStateSchema, why: z.string() })),
  /** 一部分没查成的说法。 */
  unchecked: z.array(z.string()),
});
export type WorktreeCleanupResult = z.infer<typeof WorktreeCleanupResultSchema>;

const RequestRecord = z.object({ requestId: z.string().min(1) });
const DoneRecord = z.object({ requestId: z.string().min(1), result: WorktreeCleanupResultSchema.optional() });

export interface WorktreeAuditRow {
  at: Date;
  action: string;
  actorId: string;
  after: unknown;
  ok: boolean;
  error: string | null;
}

export type CleanupStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired';

export interface CleanupView {
  requestId: string;
  by: string;
  requestedAt: Date;
  startedAt?: Date;
  doneAt?: Date;
  status: CleanupStatus;
  result?: WorktreeCleanupResult;
  error?: string;
}

/** 从三种操作记录现算每次清理走到哪（新的在前）。认不出的数进 unreadable，不丢、不瞎拼。 */
export function foldCleanupRequests(
  rows: readonly WorktreeAuditRow[],
  now: Date,
): { requests: CleanupView[]; unreadable: number } {
  let unreadable = 0;
  const rank = (a: string) => (a === WORKTREE_ACTION.request ? 0 : a === WORKTREE_ACTION.start ? 1 : 2);
  const sorted = [...rows].sort((a, b) => rank(a.action) - rank(b.action) || a.at.getTime() - b.at.getTime());
  const byId = new Map<string, CleanupView>();
  for (const row of sorted) {
    const ref = (row.action === WORKTREE_ACTION.done ? DoneRecord : RequestRecord).safeParse(row.after);
    if (!ref.success) {
      unreadable += 1;
      continue;
    }
    const id = ref.data.requestId;
    if (row.action === WORKTREE_ACTION.request) {
      if (byId.has(id)) {
        unreadable += 1;
        continue;
      }
      byId.set(id, { requestId: id, by: row.actorId, requestedAt: row.at, status: 'queued' });
      continue;
    }
    const req = byId.get(id);
    if (!req) {
      unreadable += 1;
      continue;
    }
    if (row.action === WORKTREE_ACTION.start) {
      req.startedAt ??= row.at;
    } else if (row.action === WORKTREE_ACTION.done) {
      const result = DoneRecord.safeParse(row.after).data?.result;
      // 做成了的必须带认得出的结果：认不出不当成做成了
      if (row.ok && !result) {
        unreadable += 1;
        continue;
      }
      req.doneAt = row.at;
      if (result) req.result = result;
      if (!row.ok) req.error = row.error ?? '引擎没写原因';
    } else {
      unreadable += 1;
    }
  }
  const t = now.getTime();
  for (const r of byId.values()) {
    if (r.doneAt) r.status = r.error === undefined ? 'done' : 'failed';
    else if (r.startedAt) {
      if (t - r.startedAt.getTime() > WORKTREE_RUN_TTL_MS) {
        r.status = 'failed';
        r.error = `接手 ${Math.round(WORKTREE_RUN_TTL_MS / 60_000)} 分钟还没回结果（引擎多半中途重启了），当没做成`;
      } else r.status = 'running';
    } else if (t - r.requestedAt.getTime() > WORKTREE_REQUEST_TTL_MS) r.status = 'expired';
    else r.status = 'queued';
  }
  const requests = [...byId.values()].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  return { requests, unreadable };
}

/** 有没有一次在排队或在做（有就不再收新的点击，也不再接手第二次）。 */
export function activeCleanup(requests: readonly CleanupView[]): CleanupView | undefined {
  return requests.find((r) => r.status === 'queued' || r.status === 'running');
}

// —— 接口形状 ——

const CleanupViewSchema = z.object({
  requestId: z.string(),
  by: z.string(),
  requestedAt: Time,
  startedAt: Time.optional(),
  doneAt: Time.optional(),
  status: z.enum(['queued', 'running', 'done', 'failed', 'expired']),
  result: WorktreeCleanupResultSchema.optional(),
  error: z.string().optional(),
});

/** GET /worktrees：最近一份清单（一次都没出过是 null，页面写「引擎还没出过清单」），加最近几次清理。 */
export const WorktreesResponseSchema = z.object({
  inventory: WorktreeInventorySchema.nullable(),
  /** 清单读不成（库里那份认不出）：写原因，inventory 是 null，不当成「没有树」。 */
  inventoryWhy: z.string().optional(),
  cleanups: z.array(CleanupViewSchema),
  /** 操作记录里认不出的几条。 */
  unreadable: z.number().int().min(0),
});
export type WorktreesResponse = z.infer<typeof WorktreesResponseSchema>;

export const WorktreeCleanupRequestSchema = z.object({
  /** 为什么点（可空）。 */
  reason: z.string().max(500).optional(),
});
export const WorktreeCleanupResponseSchema = z.object({ requestId: z.string(), requestedAt: Time });
