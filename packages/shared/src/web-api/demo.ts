// 驾驶舱接口约定（web-api）：演示版：游客能看什么。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { Time } from './internal.ts';

// —— 演示版：游客能看什么（设计文档第十四节）——

/** 演示版里能逐个开关的模块。总览跟着看板走，任务清单跟着任务详情走。 */
export const DEMO_MODULES = [
  'board',
  'task',
  'quota',
  'schedules',
  'notifications',
  'audit',
  'settings',
] as const;
export const DemoModuleSchema = z.enum(DEMO_MODULES);

/**
 * 细节看到哪一级：status = 只看状态和耗时（标题换成「需求 #12」这类编号）；titles = 还能看任务标题；
 * process = 还能看步骤清单和过程（原话、追问、会话时间线、日志）。
 */
export const DemoDetailSchema = z.enum(['status', 'titles', 'process']);

/**
 * 删掉的模块（调度台、渠道页，#556）：法国上已经写下的范围文件（default.json、各链接的）里还有它们，
 * 读的时候丢掉、不当成「读不懂」——否则演示链接列表、每小时撤过期链接、香港同步都会整个停下。
 */
export const RETIRED_DEMO_MODULES: readonly string[] = ['dispatch', 'channels'];

const DemoModuleList = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((m) => !RETIRED_DEMO_MODULES.includes(m)) : v),
  z
    .array(DemoModuleSchema)
    .max(DEMO_MODULES.length)
    .refine((ms) => new Set(ms).size === ms.length, { message: '同一个模块不能出现两次' }),
);

/**
 * 可见范围文件：后端发布到静态托管上，演示版只读它（法国停了照样能看）。演示链接的那份按链接口令的
 * SHA-256（十六进制）命名，不带链接打开时读 default.json。只放游客能看什么，不放备注、创建人——
 * 拿到链接的人都读得到这个文件。
 */
export const DemoScopeSchema = z.object({
  v: z.literal(1),
  modules: DemoModuleList,
  detail: DemoDetailSchema,
  /** 到期时刻；没有 = 不过期（默认范围不过期）。 */
  expiresAt: Time.optional(),
});
export type DemoScope = z.infer<typeof DemoScopeSchema>;

/** 不带链接、默认范围也没发布过（或读不到）时用这一份：默认从严，只看看板、只看状态和耗时。 */
export const DEMO_STRICT_DEFAULT: DemoScope = { v: 1, modules: ['board'], detail: 'status' };

/** 默认范围文件的名字；演示链接的文件名是 64 位十六进制，不会和它撞。 */
export const DEMO_DEFAULT_SCOPE_FILE = 'default.json';

export const DemoLinkSchema = z.object({
  /** 链接口令的 SHA-256（十六进制），也是可见范围文件的名字。口令本身只在新建时返回一次，后端不存。 */
  id: z.string().regex(/^[0-9a-f]{64}$/),
  modules: DemoModuleList,
  detail: DemoDetailSchema,
  expiresAt: Time,
  /** 发给谁、为什么（只在驾驶舱里看得到，不进可见范围文件）。 */
  note: z.string().optional(),
  createdAt: Time,
  createdBy: z.string().optional(),
  /** 过期了：可见范围文件已撤掉，演示版按默认范围显示。 */
  expired: z.boolean(),
});

export const DemoLinksResponse = z.object({
  /** 后端配了发布目录没有（FLEET_DEMO_DIR）。没配时发不了链接——不是「没有链接」。 */
  configured: z.boolean(),
  links: z.array(DemoLinkSchema),
  /** 不带链接打开时的范围；defaultPublished=false 表示还没发布过，演示版用内置的从严那份。 */
  defaultScope: DemoScopeSchema,
  defaultPublished: z.boolean(),
});

export const CreateDemoLinkRequest = z.object({
  modules: DemoModuleList.refine((ms) => ms.length > 0, { message: '至少开一个模块' }),
  detail: DemoDetailSchema,
  /** 有效天数，到期自动失效；随时可以提前作废。 */
  expiresInDays: z.number().int().min(1).max(90),
  note: z.string().trim().max(60).optional(),
});
export const CreateDemoLinkResponse = z.object({
  link: DemoLinkSchema,
  /**
   * 链接口令：只在这里出现一次，演示版地址后面加 ?k=<它>。演示版在哪由发布脚本定、构建时写进驾驶舱前端，
   * 完整链接由前端拼，后端不管演示版的地址。
   */
  token: z.string().min(32).max(64),
});
export const RevokeDemoLinkResponse = z.object({ ok: z.literal(true) });

export const UpdateDemoDefaultRequest = z.object({
  modules: DemoModuleList,
  detail: DemoDetailSchema,
});
export const UpdateDemoDefaultResponse = z.object({ defaultScope: DemoScopeSchema });
