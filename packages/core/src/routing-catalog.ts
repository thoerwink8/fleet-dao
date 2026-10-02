// 路由两层：用途 → 模型顺序 + 模型 → 渠道顺序（specs/509-需求梳理/流程重做方案.md 第八节、
// specs/574-路由两层DB/需求.md）。创始人 2026-10-02：「opus 5.5 有很多个供货渠道，是不是
// 在这个模型里面还要选供货渠道的优先级。」这份文件的职责只剩判「这份配置认得出吗」：
// 读文件、合并项目侧覆盖、判「这条现在活着吗」都由外壳/后续切片做（同 packages/core/src/config.ts
// 的「流程配置只判、不读」约定）。
import { z } from 'zod';

/** 引擎认的格式版本。 */
export const ROUTING_FORMAT_VERSION = 1;
export const SUPPORTED_ROUTING_FORMATS: readonly number[] = [1];

/** 全组织默认放在 fleet-dao 的这个位置；项目仓里的覆盖放在 .fleet/routing.json。 */
export const ORG_ROUTING_DEFAULT_PATH = 'packages/core/routing.default.json';
export const PROJECT_ROUTING_PATH = '.fleet/routing.json';

/**
 * 用途（routing 第一层的键）。StageKind 是引擎干活那一侧的枚举（shared 的 domain.ts）；
 * 这里多一份是因为它还有几种「干活会话之外的活」——autoDispatchGate、讨论、副手——既不属于
 * StageKind、又都得走同一张路由。取值和 shared 的 RoutingPurpose 逐一对齐（少一个数据库
 * 检查约束就报错、多一个这里就拒收）。新加用途两边同步加。
 */
export const PURPOSES = [
  'triage',
  'spec',
  'plan',
  'execute',
  'ui',
  'review',
  'verify',
  'research',
  'judge',
  'autoDispatchGate',
  'discuss',
  'sidekick',
] as const;
export type Purpose = (typeof PURPOSES)[number];

const id = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !s.includes('..'), '不许写 ..');

/** 模型 → 渠道顺序：一个模型在哪家渠道先派、哪条垫底。 */
export const ModelChannelsSchema = z
  .object({
    /** 渠道的先后顺序（carpool 拼车 → solo 独享 → mirasim 之类）；同一个渠道不重复出现。 */
    channels: z.array(id).min(1),
  })
  .strict();

/** 用途 → 模型顺序。 */
export const PurposeModelsSchema = z
  .object({
    /** 模型 id（opus-5.5、gpt-6-luna 这种）；前一个接不上、额度空、被禁令挡就换下一个。 */
    models: z.array(id).min(1),
  })
  .strict();

export const RoutingCatalogSchema = z
  .object({
    说明: z.string().optional(),
    formatVersion: z.literal(ROUTING_FORMAT_VERSION),
    /** 第二层：每个模型 id → 挂的渠道顺序。挂进第一层的每一个模型都得在这层出现一次。 */
    models: z.record(id, ModelChannelsSchema),
    /** 第一层：每个用途挂一串模型顺序。所有用途都得有（缺一个 = 那一步永远派不出去），由 checkCrossReferences 拒收。 */
    purposes: z.partialRecord(z.enum(PURPOSES), PurposeModelsSchema),
  })
  .strict();

export type RoutingCatalog = z.infer<typeof RoutingCatalogSchema>;

/** 外壳读文件的结果：读到了、文件不在、在却读不了。 */
export type RoutingSource =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string };

export type RoutingConfigDecision =
  | { ok: true; catalog: RoutingCatalog }
  | { ok: false; code: string; why: string };

function routingIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const where = i.path.join('.') || '整份';
      return `${where}：${i.message}`;
    })
    .join('；');
}

/**
 * 判一份「路由两层」配置认不认得出。照 packages/core/src/config.ts 的约定：
 * 外壳把整份原文递进来，它只判——读不到、不是 JSON、格式不对都明确失败，不拿空默认顶。
 */
export function resolveRoutingCatalog(source: RoutingSource): RoutingConfigDecision {
  if (source.kind === 'missing') {
    return {
      ok: false,
      code: 'ROUTING_CONFIG_MISSING',
      why: `找不到 ${ORG_ROUTING_DEFAULT_PATH}`,
    };
  }
  if (source.kind === 'unreadable') {
    return {
      ok: false,
      code: 'ROUTING_CONFIG_UNREADABLE',
      why: `读不了（${source.error}）`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source.text);
  } catch (e) {
    return {
      ok: false,
      code: 'ROUTING_CONFIG_NOT_JSON',
      why: `不是 JSON（${e instanceof Error ? e.message : String(e)}）`,
    };
  }
  const parsed = RoutingCatalogSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'ROUTING_CONFIG_INVALID',
      why: routingIssues(parsed.error),
    };
  }
  const problem = checkCrossReferences(parsed.data);
  if (problem) {
    return { ok: false, code: 'ROUTING_CONFIG_CROSS_REF', why: problem };
  }
  return { ok: true, catalog: parsed.data };
}

/** 第一层挂的每一个模型，第二层必须也有；第二层挂的每一个模型，第一层至少有一个用途用到；
 *  所有用途都得挂——一层接管的是「整套路由」，缺一个 = 那一步永远派不出去，宁可在配置就读就在这拒。 */
function checkCrossReferences(catalog: RoutingCatalog): string | undefined {
  for (const p of PURPOSES) {
    if (catalog.purposes[p] === undefined) return `purposes 缺用途「${p}」`;
  }
  const inPurposes = new Set<string>();
  for (const p of PURPOSES) {
    const entry = catalog.purposes[p];
    if (!entry) continue;
    for (const m of entry.models) inPurposes.add(m);
    const missing = entry.models.find((m) => !catalog.models[m]);
    if (missing) return `用途「${p}」挂了模型「${missing}」，但 models 里没有它`;
  }
  const orphan = Object.keys(catalog.models).find((m) => !inPurposes.has(m));
  if (orphan) return `models 里有「${orphan}」，但没有任何用途用到它`;
  for (const [m, entry] of Object.entries(catalog.models)) {
    const seen = new Set<string>();
    for (const c of entry.channels) {
      if (seen.has(c)) return `模型「${m}」的渠道顺序里「${c}」出现了两次`;
      seen.add(c);
    }
  }
  for (const [p, entry] of Object.entries(catalog.purposes)) {
    if (!entry) continue;
    const seen = new Set<string>();
    for (const m of entry.models) {
      if (seen.has(m)) return `用途「${p}」的模型顺序里「${m}」出现了两次`;
      seen.add(m);
    }
  }
  return undefined;
}

/** 缺的用途列表（对账里给「差哪几种」用；正常通过 checkCrossReferences 后应当为空）。 */
export function missingPurposes(catalog: RoutingCatalog): Purpose[] {
  return PURPOSES.filter((p) => catalog.purposes[p] === undefined);
}
