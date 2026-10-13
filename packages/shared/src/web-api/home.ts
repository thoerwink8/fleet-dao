// 驾驶舱接口约定（web-api）：新主页（/）：一屏三块 + 持续状态条。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { TaskStateSchema } from './enums.ts';
import { Id, Time } from './internal.ts';

// —— 新主页（/）：一屏三块 + 持续状态条（#589）——

/**
 * 「要你拍的」一条：decision 级通知（approvals 未决开的时候就经 openApproval 同步写了这么一条，
 * 不另查 approvals 表，免得一条事显示两回）。追问不在这里：v3 没有 AI 追问这一环，旧会话留下的追问在通知中心只读展示（#928）。
 */
export const HomeDecisionSchema = z.object({
  kind: z.enum(['notification', 'approval']),
  id: Id,
  title: z.string(),
  /** 来源需求 / PR / 会话的一句话背景；没有就没有这个键。 */
  context: z.string().optional(),
  since: Time,
  /** 站内路径：通知详情 / 任务详情。 */
  link: z.string(),
});

/** 「在跑的」一张单。segment 由三段流水（runs 表）推出，一笔都没记的老单是 null，不许按字段猜成失败。 */
export const HomeRunningSchema = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string(),
  /** owner/name。 */
  repo: z.string(),
  /** 现在在哪一段；runs 里没有流水可推的是 null。verify_pending = 动手收了、验收还没起，是等，不是失败。 */
  segment: z.enum(['scoping', 'doing', 'verifying', 'verify_pending', 'merge']).nullable(),
  /** 为什么这一刻没进展。nothing = 正常在跑。 */
  waitingReason: z.enum([
    'queue',
    'memory',
    'quota_reset',
    'ci',
    'verify_round',
    'founder_decision',
    'merge_queue',
    /** 被人暂停了（#820 片 3）：不是失败也不是等人，是人让它停的；note 在 paused 里。 */
    'paused',
    'nothing',
  ]),
  /** 被人暂停时引擎写的那句「已暂停：被谁暂停、为什么」；waitingReason === 'paused' 才有。 */
  paused: z.string().optional(),
  /**
   * 等合并期间必过检查是红的：检查名（多个用顿号分开）。有了，卡片写「检查红了：」加这个，不写「等合并队列」。
   */
  redChecks: z.string().min(1).optional(),
  /** 从什么时候起在等；waitingReason === 'nothing' 时没有。 */
  waitingSince: Time.optional(),
  /** 单子进库的时刻（「已经多久」的起点）。 */
  taskSince: Time.optional(),
  /** 在当前这一段待了多久的起点：这一段正在跑的那笔的开始，或上一笔收场的时刻；runs 里一笔都没有就没有这个键。 */
  stageSince: Time.optional(),
  /** 现在谁在做：正在跑的那一笔的模型名；这一刻没有进程在跑（排队、等人、等验）就没有这个键。 */
  worker: z.string().optional(),
  /** 在等创始人拍的那件事（要你拍的那块里挂在这张单上的第一条的标题）；没有就没有这个键。 */
  pendingDecision: z.string().optional(),
  /** 这张单最近一次事件（最近一笔三段流水的开始或收场）。trouble = 超时 / 失败 / 没起来；wait = 切号、内存满这类停下重跑，不是失败。 */
  lastEvent: z
    .object({
      text: z.string(),
      at: Time,
      tone: z.enum(['ok', 'wait', 'trouble']),
    })
    .optional(),
  /** 站内路径：任务详情。 */
  link: z.string(),
  /** 库里的任务编号：首页看板上「继续 / 叫停」这类快捷操作要它（POST /api/tasks/:taskId/actions）。老环境推来的快照里没有，没有就不画操作。 */
  taskId: Id.optional(),
  /** 单子现在的状态。老环境推来的快照里没有：没有时看板仍把等你拍记成 asking、其余记成 running。有了，挂起的单才画得出「重做」。 */
  state: TaskStateSchema.optional(),
  /**
   * 这一刻在跑的那几笔三段流水的编号（#1973）。引擎给每笔起的会话 scope 就叫 `fleet-agent-<编号>.scope`，
   * 看板拿它到 HomeResources.sessions.byRun 里找这张单此刻占的内存、CPU。没有会话在跑是空数组；老后端没有这个键。
   */
  runIds: z.array(z.string().min(1)).optional(),
  /**
   * 上一次收场的会话（#1979 的内存峰值，#1980 加上 CPU 秒数）。没在跑时卡片写
   * 「上次动手峰值 3.5G · CPU 12 分钟」。内存、CPU 各自没记是 unread，不写 0。老后端没有这个键。
   */
  lastSession: z
    .object({
      memory: z.discriminatedUnion('state', [
        z.object({ state: z.literal('ok'), peakMb: z.number().int().min(0) }),
        z.object({ state: z.literal('unread'), why: z.string().min(1) }),
      ]),
      cpu: z.discriminatedUnion('state', [
        z.object({ state: z.literal('ok'), seconds: z.number().int().positive() }),
        z.object({ state: z.literal('unread'), why: z.string().min(1) }),
      ]),
    })
    .optional(),
});

/** 一样读数没读到：原因原样写给人看（文件不在、内容认不出、这台不是 Linux……），页面写「没读到」，不拿 0 顶。 */
const ResourceUnreadSchema = z.object({ state: z.literal('unread'), why: z.string().min(1) });

/**
 * 整机内存（/proc/meminfo，MiB）：已用 = 总量 − 可用（MemAvailable）。页面上的「已用 / 总量」和百分比都只由这两个数算，
 * 同一回读数，不另给一份已用（免得两份对不上）。
 */
export const HostMemorySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    totalMb: z.number().int().positive(),
    availableMb: z.number().int().min(0),
  }),
  ResourceUnreadSchema,
]);

/**
 * 整机 CPU（/proc/stat 两次读数的差）：percent 是所有核合起来忙的比例（0–100）；busyCores 是同一对差折成的忙的核数
 * （= 忙的比例 × cores，一位小数），和 percent 同源；cores 是 /proc/stat 里 cpuN 的行数（真读，不是常数）；
 * load1 是 /proc/loadavg 的 1 分钟负载。busyCores 缺 = 老版本推来的快照（页面写数值没读到，不拿 percent × cores 补）。
 */
export const HostCpuSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    percent: z.number().min(0).max(100),
    busyCores: z.number().min(0).optional(),
    cores: z.number().int().positive(),
    load1: z.number().min(0).optional(),
  }),
  ResourceUnreadSchema,
]);

/**
 * 一个会话（一个 scope）此刻的占用：memory.current、memory.peak（MiB），cpu.stat 的 usage_usec 两次读数的差算出的
 * CPU 占用（100 = 占满一个核）。cpuPercent 缺 = 这个 scope 刚出现、还只有一次读数，算不出差（不是 0）。
 */
export const SessionUsageSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    memoryMb: z.number().int().min(0),
    memoryPeakMb: z.number().int().min(0).optional(),
    cpuPercent: z.number().min(0).optional(),
  }),
  ResourceUnreadSchema,
]);

/**
 * 这台机器此刻的资源（#1973）：整机内存、CPU，加每个会话 scope 的占用。后端在本机读（/proc、cgroup），
 * 每 everyMs 读一回并经推送（SSE 的 resources 事件）发给开着的页面；主页接口带最近一回。
 */
export const HomeResourcesSchema = z.object({
  /** 这一回读数的时刻。 */
  at: Time,
  /** 采样间隔（毫秒）：页面隔多久该收到一回新的，超过两倍没来就是旧了。 */
  everyMs: z.number().int().positive(),
  memory: HostMemorySchema,
  cpu: HostCpuSchema,
  /** 会话资源池（fleet-agents.slice）下每个 scope 的占用，键是 scope 编号（= 三段流水的编号）；整池读不到是 unread。 */
  sessions: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ok'), byRun: z.record(z.string(), SessionUsageSchema) }),
    ResourceUnreadSchema,
  ]),
});

/**
 * 三段流水线的一段：在途几张、近期跑完的平均耗时。样本一笔都没有，avgMs 不给（不拿 0 冒充「瞬间完成」）。
 * 样本 = 看板窗口里的单的、结局是 done 且起止读得出来的三段流水。
 */
export const HomeFlowStageSchema = z.object({
  segment: z.enum(['scope', 'manual', 'verify']),
  inFlight: z.number().int().nonnegative(),
  avgMs: z.number().int().nonnegative().optional(),
  samples: z.number().int().nonnegative(),
});

/**
 * 「做完的」一篇 PR。链接前端按品牌拼（brand.repoLink，和 alert-work 一个规矩：后端不发网址）；
 * 这里给拼链接要的两段（repo 拆 owner/name 由前端按字符串切，和 alert-work 的 repoRef 一个切法）。
 */
export const HomeDoneSchema = z.object({
  prNumber: z.number().int().positive(),
  title: z.string(),
  /** owner/name。 */
  repo: z.string(),
  mergedAt: Time,
  /** 这篇 PR 挂的单（issueRefs 反查到的）；一个都没挂上没有这个键。 */
  issueNumber: z.number().int().positive().optional(),
});

/**
 * 持续状态条：额度、中转、引擎。有问题一直显示、不伪装成失败（tight/degraded/off 都不是「坏了」）。
 * engine 一项（#902 D7）四种：
 * - off：这台机器按配置（release.env 的 FLEET_SERVICES）没开引擎，是「已停用」，不是坏了，不标红；
 * - on：开着、而且任务队列上有在拉活的引擎工人（和 /healthz 的 engine 项同一个探法）；
 * - down：开着、但探不到在线的工人或连不上调度服务——真的没连上，标红；
 * - unknown：这台后端没有引擎探针（开发、内存版），没查成，不冒充正常。
 */
export const HomeHealthSchema = z.object({
  quota: z.object({
    state: z.enum(['ok', 'tight', 'empty', 'unknown']),
    detail: z.string(),
  }),
  routes: z.object({
    state: z.enum(['ok', 'degraded', 'unknown']),
    detail: z.string(),
  }),
  engine: z.object({
    state: z.enum(['on', 'off', 'down', 'unknown']),
    detail: z.string().optional(),
  }),
});

export const HomeResponseSchema = z.object({
  decisions: z.array(HomeDecisionSchema),
  running: z.array(HomeRunningSchema),
  done: z.array(HomeDoneSchema),
  health: HomeHealthSchema,
  /** 三段流水线图头上的数：固定对题 → 动手 → 验收三项，按这个先后。 */
  flow: z.array(HomeFlowStageSchema).length(3),
  /** 此刻在跑的会话数、已选定还没开跑的数：和法国页、额度页、路由页同一个来源（池占用）。老后端没有这一项。 */
  slots: z.object({ running: z.number().int().min(0), reserved: z.number().int().min(0) }).optional(),
  /** 这台机器此刻的内存、CPU（#1973）。老后端、老环境推来的快照没有：页面写明「没给资源读数」，不画 0。 */
  resources: HomeResourcesSchema.optional(),
  asOf: Time,
});
