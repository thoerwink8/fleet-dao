// 法国发版一键（/france 页 #618）：这一台后端自己跑的 release-train 状态 + 点「发版预检」起 pnpm release:onekey preflight。
// 只到预检；不发版。这里只定义能给页面看的形状：状态三态（在走/暂停中/没在走、读不到），预检一次一回（命令、退出码、输出、读了多久）。
// 每一项各自带「查成了 / 没查成 + 原因」（同 env 页的 EnvFact）；读不到就写读不到，不拿空、0 或假 ok 顶（仓的底线）。
// 这一节只在正式环境接得上（驾驶舱后端真的起在一份检出的仓里、~/.fleet-dao/ 下有 release-train 的状态文件）；
// 开发、内存版后端 deps 没挂上时一律回 unreadable，页面画「没查成 + 原因」，不显示假数据。
import { z } from 'zod';
import { Time } from './internal.ts';

/**
 * release-train 现在的状态：靠两个文件判——
 * - ~/.fleet-dao/release-train.json（一趟的记录；在走、卡住、没成都会在）；
 * - ~/.fleet-dao/release-train.paused（暂停标记；在走 + 已写过 = 暂停了本机和法国的派活）。
 * 三个 state 各说各的：
 * - running：状态文件在、状态是在走 / 卡住 / 没成 → 这一趟还没了结（status + marker + phase 给页面看是哪一段）；做完了、撤销了的记录算 idle；
 * - paused：状态文件不在、暂停标记在 → 之前暂停过、这一趟没人收（孤儿标记）。这是状态机外的情况，要让页面标出来；
 * - idle：两个文件都不在 → 没在走、也没暂停。
 * 读不到（不是这台 backend 的 home、读盘错）走 unreadable，页面画「没查成 + 原因」。
 */
export const FranceReleaseStateSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('running'),
    /** 这一趟的状态：running 在走；blocked 卡住了（到点还有拖后腿的）；failed 没成。做完了（done）、撤销了（aborted）的归 idle，不算在走。 */
    status: z.enum(['running', 'blocked', 'failed']),
    /** 卡住、没成的原因；在走的是 null。 */
    why: z.string().nullable(),
    /** state 文件里 phase 的中文名（走到第几步了；release-train 自己写的）。 */
    phase: z.string(),
    /** 目标提交或版本号，原样 show（sha 截 12 位，tag 全 show）。 */
    target: z.string(),
    /** 暂停标记在不在（在 = 派活正在停着）。 */
    marker: z.boolean(),
    asOf: Time,
  }),
  z.object({ state: z.literal('paused'), asOf: Time }),
  z.object({ state: z.literal('idle'), asOf: Time }),
  z.object({ state: z.literal('unreadable'), why: z.string(), asOf: Time }),
]);

/**
 * 发版预检一次一回：起子进程 `pnpm release:onekey preflight`（命令固定写死，不收参数），最多 60 秒、512KB。
 * code：0 = 预检过了；非 0 原样回（1 用法不对、2 预检没过、3 卡住），页面给不同颜色。起进程都没起来时 code 给 null，另写 spawnError。
 * stdout / stderr 全回，前端原样分块展示；超长的后端已经截断（truncated 标 true）。
 */
export const FrancePreflightResponseSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('done'),
    command: z.string(),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    /** 后端 ms 单位的耗时（前端给一个「跑了 12 秒」的小字）。 */
    durationMs: z.number().int().min(0),
    /** 60 秒超时被杀了；这种情况 code/signal 由 Node 给，原样透出。 */
    timedOut: z.boolean(),
    truncated: z.boolean(),
    asOf: Time,
  }),
  /** 起子进程都没起来：这台后端没接这一节（开发、内存版），或 pnpm 不在 PATH 里。 */
  z.object({ state: z.literal('unreadable'), why: z.string(), asOf: Time }),
]);

export type FranceReleaseState = z.infer<typeof FranceReleaseStateSchema>;
export type FrancePreflightResponse = z.infer<typeof FrancePreflightResponseSchema>;

/**
 * 「发版」卡（#1231，GET /france/release-card）：创始人要在驾驶舱上直接看「现在主线是哪个提交、法国跑的是哪个、有多少没发、最近做完了什么」。
 * 四行各自带「查成了 / 没查成 + 原因」（一行读不到不连累别的行）；读不到 GitHub、读不到法国在用的提交，那一行写没查成和原因，
 * 不拿空、0 或「已是最新」顶。只读，不带任何会改法国的东西。
 */
const CommitLine = z.object({
  /** 40 位全号。 */
  sha: z.string(),
  short: z.string(),
  title: z.string(),
  /** 提交时间。 */
  at: Time,
});

/** 主线头汇总检查（check）的结果：绿、红、在跑，读不到另说。 */
export const ReleaseCardCiSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('green') }),
  z.object({ state: z.literal('red'), detail: z.string() }),
  z.object({ state: z.literal('pending'), detail: z.string() }),
  z.object({ state: z.literal('unreadable'), why: z.string() }),
]);

/**
 * 最近一次「发布到法国」点击的结果：none 没点过；pending 请求写了、法国还没接；refused 接活的核了没过（why 写原因，没动现场）；
 * running / blocked / failed / done / aborted 是进度记录里这一趟的状态；unreadable 读不到（带原因，不当成「没点过」）。
 */
export const ReleaseLastSchema = z.object({
  state: z.enum([
    'none',
    'pending',
    'refused',
    'running',
    'blocked',
    'failed',
    'done',
    'aborted',
    'unreadable',
  ]),
  target: z.string().nullable(),
  at: Time.nullable(),
  why: z.string().nullable(),
  phase: z.string().nullable(),
});

export const ReleaseCardSchema = z.object({
  /** ① 主线最新提交和它的 CI。 */
  mainline: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ok'), commit: CommitLine, ci: ReleaseCardCiSchema }),
    z.object({ state: z.literal('unreadable'), why: z.string() }),
  ]),
  /** ② 法国在用的提交。在用的提交号读到了、标题或发于何时没读到时，那一项各自带原因（不拿空串顶）。 */
  deployed: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('ok'),
      sha: z.string(),
      short: z.string(),
      title: z.string().nullable(),
      titleWhy: z.string().nullable(),
      /** 发于何时（发布历史里这个提交最近一次切上去的时间）。 */
      deployedAt: Time.nullable(),
      deployedAtWhy: z.string().nullable(),
    }),
    z.object({ state: z.literal('unreadable'), why: z.string() }),
  ]),
  /** ③ 两者相差几个提交，最近 5 个合进去的 PR。 */
  gap: z.discriminatedUnion('state', [
    z.object({ state: z.literal('same') }),
    z.object({
      state: z.literal('ahead'),
      count: z.number().int().min(1),
      prs: z.array(z.object({ number: z.number().int(), title: z.string() })).max(5),
      /** 最近一页提交里不是 PR 合并的（提交说明末尾没有 (#号)）个数。 */
      nonPr: z.number().int().min(0),
    }),
    z.object({ state: z.literal('unreadable'), why: z.string() }),
  ]),
  /** ④ 最近做完的一个任务：主线最近合并的一个 PR 和它关的单。 */
  lastDone: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('ok'),
      pr: z.object({ number: z.number().int(), title: z.string(), mergedAt: Time }),
      /** 它写了 Closes 的单：没写、读到、没读到各一种。 */
      issue: z.discriminatedUnion('state', [
        z.object({ state: z.literal('none') }),
        z.object({
          state: z.literal('ok'),
          number: z.number().int(),
          title: z.string(),
          /** 同一个 PR 还写了 Closes 的别的单。 */
          alsoCloses: z.array(z.number().int()),
        }),
        z.object({ state: z.literal('unreadable'), number: z.number().int(), why: z.string() }),
      ]),
    }),
    z.object({ state: z.literal('unreadable'), why: z.string() }),
  ]),
  /** ⑤ 「发布到法国」按钮（#1232）：能不能点、不能点的原因、最近一次点击的结果。 */
  action: z.object({
    state: z.enum(['ready', 'blocked']),
    /** blocked 时的原因（每条一句话，页面原样列在置灰的按钮旁）；ready 时是空数组。 */
    reasons: z.array(z.string()),
    /** 法国上装没装接活的单元（人工档，装一次要在法国跑 france.sh）。 */
    installed: z.boolean(),
    last: ReleaseLastSchema,
  }),
  asOf: Time,
});

export type ReleaseCard = z.infer<typeof ReleaseCardSchema>;

/**
 * 「已发布的提交」（#1255，GET /france/released-commits）：更新日志页的只读列表，读法国的发布历史（release.sh 的 .history）。
 * 发版单位是主线提交（决定 0032），不是里程碑版本；每条写提交号、标题、发于何时、是发布还是回滚。
 * 整份读不到（没接上、读历史失败）走 unreadable 写原因；某一条的标题读不到，那一条的 title 为 null、titleWhy 写原因，不拿空串顶。
 */
export const ReleasedCommitsSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    /** 新的在前。 */
    commits: z.array(
      z.object({
        sha: z.string(),
        short: z.string(),
        title: z.string().nullable(),
        titleWhy: z.string().nullable(),
        at: Time,
        event: z.enum(['release', 'rollback', 'auto-rollback']),
      }),
    ),
    asOf: Time,
  }),
  z.object({ state: z.literal('unreadable'), why: z.string(), asOf: Time }),
]);
export type ReleasedCommits = z.infer<typeof ReleasedCommitsSchema>;

/** 点「确认发布」：只收提交号一个参数，后端核它等于此刻主线头。 */
export const ReleaseRequestBody = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/, '提交号要是完整的 40 位小写十六进制'),
});
export const ReleaseRequestResponse = z.object({
  requested: z.literal(true),
  sha: z.string(),
  at: Time,
});
/** 操作记录里这一点击的动作名和原话（对外发布那一道人闸：创始人在页面上点，就是同意）。 */
export const RELEASE_REQUEST_ACTION = 'release.request';
export const RELEASE_REQUEST_WORD = '驾驶舱点击发布';
