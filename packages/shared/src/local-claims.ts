// 本机领单（决定 0096）：本机会话要做一张单，先在法国的 tasks 登记一行（executor = local、带租约），法国的拉单看见这一行就不接；
// 本机会话死了（租约到期、也没有续租的迹象），法国的拉单把这一行退回成引擎可接的，并摘掉「本机做」、在单上留一句话。
//
// 改这里之前必须知道：
// - tasks 只认引擎会写的状态（queued、running、done、stopped、failed、stalled）：本机领的单照样只用这几个，谁在做另记在 executor，
//   不新造状态。本机在做 = running + executor local；退回法国 = stopped + executor engine（拉单按「行是 stopped、Temporal 里没有任何一代」
//   接手这一行，和接手老行同一条路）。
// - 一张单固定一个分支前缀：引擎 fleet/<单号>-，本机 local/<单号>-。两边开 PR 前都按「需求」栏挂的单号和这两个前缀查有没有别的开着的 PR，
//   有就不开（围栏：租约过期了旧会话照样能推，所以光靠租约不够）。
// - 续租不靠人记得：领单、显式续租之外，法国读本机会话心跳（/api/nodes/sessions），有会话在 local/<单号>- 分支上、不到租约时长前还动过，
//   或这张单有开着的 PR，都算还活着，租约顺延。
// - 本机经 /api/nodes/claims 写（和本机会话心跳同一个通行证 X-Fleet-Node-Token），本机不放机器人凭据。
import { z } from 'zod';

/** 本机领单的租约时长：这么久没续上就退回法国。 */
export const LOCAL_LEASE_MS = 2 * 60 * 60_000;
/** 收本机领单的路径（在 /api 下），和本机会话心跳同一个通行证头。 */
export const LOCAL_CLAIMS_PATH = '/nodes/claims';

/** 谁在做这张单：引擎（法国）或本机。 */
export const TASK_EXECUTORS = ['engine', 'local'] as const;
export type TaskExecutor = (typeof TASK_EXECUTORS)[number];

// 分支前缀的认法（localBranchPrefix、issueOfBranch）在 conventions 的 issue-branch.ts：pnpm work、pnpm pr:open 在零安装区也要用。

const RepoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name');
const IssueNo = z.number().int().positive();

/** 本机结束一张单：done 做完了；failed 做不成（记账，不退回）；released 放手，退回法国队列。 */
export const LOCAL_FINISH_OUTCOMES = ['done', 'failed', 'released'] as const;
export type LocalFinishOutcome = (typeof LOCAL_FINISH_OUTCOMES)[number];

/** 接手已有 PR 的单：精确 PR 号和完整 40 位小写 head。后端按它独立现核，不信客户端的「已核」。 */
const TakeoverPr = z
  .object({
    pr: z.number().int().positive(),
    head: z.string().regex(/^[0-9a-f]{40}$/, '完整 40 位小写 head'),
  })
  .strict();

export const LocalClaimRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('claim'),
      repo: RepoSlug,
      issue: IssueNo,
      title: z.string().min(1).max(300),
      /** 只有受管接手路径带；不带就是普通 claim（单上有开着的 PR 照旧由本机命令拒绝）。 */
      takeoverPr: TakeoverPr.optional(),
    })
    .strict(),
  /** 接手交接确认：原工作流确认终态、本机租约在、原 PR/head 仍匹配，后端才回 ok；信号受理不算交接完成。 */
  z
    .object({ action: z.literal('takeover_confirm'), repo: RepoSlug, issue: IssueNo, takeoverPr: TakeoverPr })
    .strict(),
  z.object({ action: z.literal('renew'), repo: RepoSlug, issue: IssueNo }).strict(),
  z
    .object({
      action: z.literal('finish'),
      repo: RepoSlug,
      issue: IssueNo,
      outcome: z.enum(LOCAL_FINISH_OUTCOMES),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
]);
export type LocalClaimRequest = z.infer<typeof LocalClaimRequestSchema>;

/**
 * 不成的原因：引擎在做；这张单不是本机领着的；仓不归法国管；
 * takeover_refused 接手的身份核不过或引擎没明确停下（串仓、换头、多 PR、读不到、有未结束的工人……）；
 * takeover_pending 接手已登记但原工作流还没确认终态（责任保留在本机，重跑同一命令复核）。
 */
export const LOCAL_CLAIM_REFUSALS = [
  'engine_has_it',
  'not_claimed',
  'unknown_repo',
  'takeover_refused',
  'takeover_pending',
] as const;
export type LocalClaimRefusal = (typeof LOCAL_CLAIM_REFUSALS)[number];

export const LocalClaimResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    taskId: z.string(),
    state: z.string(),
    executor: z.enum(TASK_EXECUTORS),
    /** 租约到哪一刻；结束了是 null。 */
    leaseUntil: z.string().nullable(),
  }),
  z.object({ ok: z.literal(false), code: z.enum(LOCAL_CLAIM_REFUSALS), why: z.string() }),
]);
export type LocalClaimResponse = z.infer<typeof LocalClaimResponseSchema>;
