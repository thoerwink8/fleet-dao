// fleet 命令（跑在 AI 会话里）⇄ 驾驶舱后端 的接口约定。命令这边（packages/cli）和后端那边（packages/api）都按这份实现。
// 认证：请求头 `Authorization: Bearer <FLEET_TOKEN>`；令牌只对一个任务的一次会话有效，过期即失效，不能合并、不能改调度台。
// 出错时返回体是 `{ error: { code, message, details? } }`（同 web-api.ts 的 ApiErrorBody），message 是给 AI 看的白话：
//   401 令牌无效、过期或这次会话已结束（重试没用）；400 请求不合约定；
//   409 暂时做不了、过一会儿再试（例如 done 带的 PR 还没同步进库）；422 核实不过、要改了再交（done 的原因在 details.reasons）；
//   503 同一个幂等键的上一次请求还在处理，稍后用同一个键重试。
import { z } from 'zod';

export const AGENT_API_PREFIX = '/agent/v1';

/**
 * 写动作（plan / say / ask / done / blocked）带这个请求头：同一条命令的几次重试用同一个值。
 * 后端按「会话 + 键」只执行一次，重试拿到第一次成功的结果，不会把一句话记成两句；没成功的那次不占键，重试会重新执行。
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export const StepSchema = z.object({
  title: z.string().min(1).max(200),
  state: z.enum(['pending', 'in_progress', 'done']),
});

/** 照 Codex 的做法：一张步骤清单，同一时间最多一步在进行。 */
export const PlanRequest = z
  .object({ steps: z.array(StepSchema).min(1).max(30) })
  .refine((v) => v.steps.filter((s) => s.state === 'in_progress').length <= 1, {
    message: '同一时间只能有一步在进行',
  });

/** 一句白话进度，例如「正在写验证码过期的测试」。 */
export const SayRequest = z.object({ text: z.string().min(1).max(500) });

/**
 * 问创始人（#259）：一律带选项和推荐，命令当场返回、不等回答——他多半不在场，问他不许卡住活。
 * 默认是这张单范围内的岔路，按推荐先做；outside = 超出这张单的范围，另开一张单等他拍，这张单绕开它接着做；
 * hold = 碰了人闸四类（release 对外发布、spend 花钱、delete 删数据、standard 改标准），也先按推荐做，合并前等他批。
 * 合不合格由 core 的 checkAsk 判：不合格回 400（ask_incomplete），message 写明怎么补。
 */
/** 一次提问最多几个选项（飞书卡片一排放得下的按钮数）：命令行本地先挡，后端 core 的 checkAsk 照它判。 */
export const ASK_MAX_OPTIONS = 4;

export const AskRequest = z.object({
  question: z.string().min(1).max(2000),
  /** 至少 2 个、最多 4 个由后端判（core 的 checkAsk，退回时写清怎么补）；这里只挡离谱的大小。 */
  options: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** 推荐哪个：照抄其中一个选项。 */
  recommend: z.string().min(1).max(200).optional(),
  outside: z.boolean().optional(),
  hold: z.string().min(1).max(20).optional(),
});
export const AskResponse = z.object({
  askId: z.string(),
  /**
   * answered = 这一句创始人已经回过了（同一个会话问过一模一样的），answer 是他的回答；assumed = 按推荐先做，answer 是推荐的；
   * outside = 另开一张单等他拍，这张单绕开它接着做；held = 先按推荐做（answer），合并前等他批。
   */
  status: z.enum(['answered', 'assumed', 'outside', 'held']),
  answer: z.string().optional(),
});

/**
 * 交活。后端会核实，不是说了就算：写码的活要有本次会话跑测试的记录、且最后一次是绿的；带了 PR 编号就核对它在本会话分支上、没关掉。
 * 会话只在本地提交，推分支和开 PR 由引擎在会话后做，所以一般不带 PR 编号。
 */
export const DoneRequest = z.object({
  summary: z.string().min(1).max(4000),
  prNumber: z.number().int().positive().optional(),
  testsPassed: z.boolean(),
});

export const BlockedRequest = z.object({
  reason: z.string().min(1).max(4000),
  needs: z.enum(['human', 'info', 'access', 'other']),
});

/** 看自己的任务：需求、做完标准、要改哪里、当前步骤。 */
export const TaskResponse = z.object({
  taskId: z.string(),
  subtaskId: z.string().optional(),
  repo: z.string(),
  /** 会话干活的分支；引擎还没给这次会话建分支时没有。 */
  branch: z.string().optional(),
  specDir: z.string().optional(),
  request: z.string(),
  acceptance: z.array(z.string()),
  touches: z.array(z.string()),
  plan: z.array(StepSchema),
});

/** 翻历史需求：按改动位置和关键词找做过的需求与结果。 */
export const HistoryRequest = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(5),
});
export const HistoryResponse = z.object({
  items: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      specDir: z.string().optional(),
      resultSummary: z.string().optional(),
      mergedAt: z.string().optional(),
    }),
  ),
});

export const AgentRoutes = {
  task: { method: 'GET', path: '/task', response: TaskResponse },
  plan: { method: 'POST', path: '/plan', request: PlanRequest },
  say: { method: 'POST', path: '/say', request: SayRequest },
  ask: { method: 'POST', path: '/ask', request: AskRequest, response: AskResponse },
  history: { method: 'POST', path: '/history', request: HistoryRequest, response: HistoryResponse },
  done: { method: 'POST', path: '/done', request: DoneRequest },
  blocked: { method: 'POST', path: '/blocked', request: BlockedRequest },
} as const;
