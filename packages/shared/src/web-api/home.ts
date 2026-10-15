// 驾驶舱接口约定（web-api）：新主页（/）：一屏三块 + 持续状态条。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { TaskExecutorSchema, TaskStateSchema } from './enums.ts';
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
  /**
   * owner/name。挂在某张单上、这张单的仓在库里，才是那一仓。
   * 不挂单，或仓不在库里，是 null（整机的事，看板不藏）。老环境推来的快照没有这个键，同样当整机的事。
   */
  repo: z.string().nullable().optional(),
});

/** 一样读数没读到：原因原样写给人看（文件不在、内容认不出、这台不是 Linux……），页面写「没读到」，不拿 0 顶。 */
const ResourceUnreadSchema = z.object({ state: z.literal('unread'), why: z.string().min(1) });

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
    /**
     * 引擎停下等人（单子 state=stalled：轮数用尽、同因连挂、要人修……）：原因在 parked 里，等「继续」「放弃」「重做」。
     * 排在三段推断前面：停着的单不许写成「在合并队列」「还没验」（#1967、#1971）。
     */
    'parked',
    'nothing',
  ]),
  /** 被人暂停时引擎写的那句「已暂停：被谁暂停、为什么」；waitingReason === 'paused' 才有。 */
  paused: z.string().optional(),
  /** 引擎停下等人的原因（tasks.last_problem 原文）；waitingReason === 'parked' 才有。 */
  parked: z.string().optional(),
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
  /** 谁在做：engine = 法国引擎，local = 本机领的（决定 0096，tasks.executor）。老后端、老环境推来的快照没有这个键，当引擎。 */
  executor: TaskExecutorSchema.optional(),
  /** 本机领的单：领它的环境编号（通行证认出的，如 founder-pc；tasks.claimed_by）。引擎的单没有这个键。 */
  claimedBy: z.string().optional(),
  /** 本机领的单：租约到期的时刻（tasks.lease_until）；到点没续就退回法国队列。引擎的单没有这个键。 */
  leaseUntil: Time.optional(),
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
 * 真读到的内存不到 1M 往上记 1M，不四舍五入成 0。
 * empty（#1992）：scope 还在、memory.current 是 0——里面已经没有进程（会话收场了、scope 没回收）。跑着的会话不可能 0，
 * 所以不当 ok 的 0 报：页面写「空 scope」，不算在跑、不进合计。why 给人看。
 */
export const SessionUsageSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    memoryMb: z.number().int().min(0),
    memoryPeakMb: z.number().int().min(0).optional(),
    cpuPercent: z.number().min(0).optional(),
  }),
  z.object({ state: z.literal('empty'), why: z.string().min(1) }),
  ResourceUnreadSchema,
]);

/**
 * 整台机器的磁盘（#1985）：根文件系统（path，一般是 /）的 statfs，字节。已用 = (总块数 − 空闲块数) × 块大小；
 * 剩余 = 普通用户还写得进的（bavail × 块大小，不含给 root 预留的那一截），所以「已用 + 剩余」可能比总量小一点。
 * 页面上的「已用 / 总量」和百分比都由 usedBytes、totalBytes 算，同一回读数。
 */
export const HostDiskSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    path: z.string().min(1),
    totalBytes: z.number().int().positive(),
    usedBytes: z.number().int().min(0),
    availableBytes: z.number().int().min(0),
  }),
  ResourceUnreadSchema,
]);

/**
 * 一个上线项目（法国上的一个应用，登记表 packages/api/src/vps-apps.ts）此刻的 CPU、内存：它名下各 systemd 单元的 cgroup 合计。
 * - ok：至少一个单元在跑。memoryMb 是各单元 memory.current 之和；memoryMaxMb 是各在跑单元 memory.max 之和（有一个是 max 就不给）；
 *   cpuCores 是各单元 cpu.stat 的 usage_usec 两回的差 ÷ 墙钟（1 = 占满一个核），缺 = 刚开始采样、还只有一回读数（不是 0）。
 * - idle：登记的单元一个都没在跑（cgroup 目录不在）；why 是给人看的补充（例如「这一项没有进程，只占磁盘」）。
 * - unread：读不到 + 原因（这台没有 cgroup v2、文件认不出……）。
 */
export const AppUsageSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    running: z.number().int().positive(),
    memoryMb: z.number().int().min(0),
    memoryMaxMb: z.number().int().positive().optional(),
    cpuCores: z.number().min(0).optional(),
  }),
  z.object({ state: z.literal('idle'), why: z.string().min(1).optional() }),
  ResourceUnreadSchema,
]);

export const HostAppSchema = z.object({
  /** 登记表里的编号（磁盘占用里的 appId 对的就是它）。 */
  id: z.string().min(1),
  name: z.string().min(1),
  /** 放在哪：主要路径，一句话。 */
  place: z.string().min(1),
  /** 名下的 systemd 单元（登记表里的）。 */
  units: z.array(z.string().min(1)),
  /** 不归本仓管的别家常驻服务（照样占这台机器）。 */
  external: z.boolean().optional(),
  /** 磁盘那一格的补充：名下没登记目录时说算在哪（例如「代码在发布版本目录里」）。 */
  diskNote: z.string().min(1).optional(),
  usage: AppUsageSchema,
});

/** 一个目录的大小：遍历文件、按占用的块算（和 du 一样，硬链接只算一次、不跟符号链接）。 */
export const DirSizeSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    bytes: z.number().int().min(0),
    /** 里面有几棵子树读不了（权限、中途没了）：大于 0 时数是下限，页面写「不全：有 N 棵树没读到」。 */
    unreadTrees: z.number().int().min(0),
    /** 第一棵读不了的子树和原因，给悬停看。 */
    unreadSample: z.string().optional(),
    /** 测到时限没测完：数是下限。 */
    capped: z.boolean().optional(),
  }),
  ResourceUnreadSchema,
]);

/** 按目录的磁盘占用（#1985）：遍历较重，每 everyMs（10 分钟）测一回、缓存；还没测完第一回是 pending。 */
export const DiskFootprintSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    /** 这一回测完的时刻。 */
    measuredAt: Time,
    everyMs: z.number().int().positive(),
    /** 这一回测了多久（毫秒）。 */
    tookMs: z.number().int().min(0),
    dirs: z.array(
      z.object({
        path: z.string().min(1),
        appId: z.string().min(1),
        appName: z.string().min(1).optional(),
        size: DirSizeSchema,
      }),
    ),
    /** 库的大小（pg_database_size）：每个库一行，appId 是算在哪个应用名下。整块读不到是 unread。 */
    databases: z.discriminatedUnion('state', [
      z.object({
        state: z.literal('ok'),
        items: z.array(
          z.object({
            name: z.string().min(1),
            appId: z.string().min(1),
            // 应用的名字（上线项目那一段整块读不到时，榜上照样写得出归谁）
            appName: z.string().min(1).optional(),
            size: z.discriminatedUnion('state', [
              z.object({ state: z.literal('ok'), bytes: z.number().int().min(0) }),
              ResourceUnreadSchema,
            ]),
          }),
        ),
      }),
      ResourceUnreadSchema,
    ]),
  }),
  z.object({ state: z.literal('pending'), why: z.string().min(1) }),
]);

/**
 * 这台机器此刻的资源（#1973）：整机内存、CPU，加每个会话 scope 的占用。后端在本机读（/proc、cgroup），
 * 每 everyMs 读一回并经推送（SSE 的 resources 事件）发给开着的页面；主页接口带最近一回。
 * disk、apps、footprint 是 #1985 加的：老后端、老环境推来的快照没有，页面写明「没给」，不画 0。
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
  /** 整台机器的磁盘（每 everyMs 随这一回一起读）。 */
  disk: HostDiskSchema.optional(),
  /** 每个上线项目此刻的 CPU、内存（每 everyMs 随这一回一起读），按登记表的先后；整块读不到是 unread。 */
  apps: z
    .discriminatedUnion('state', [
      z.object({ state: z.literal('ok'), items: z.array(HostAppSchema) }),
      ResourceUnreadSchema,
    ])
    .optional(),
  /** 按目录的磁盘占用（最近测完的那一回，10 分钟一测；带着它推，测的时刻在里面）。 */
  footprint: DiskFootprintSchema.optional(),
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
