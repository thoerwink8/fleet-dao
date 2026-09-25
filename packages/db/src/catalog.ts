// 目录装载器：读本机的目录配置（默认 /etc/fleet-dao/catalog.json），把族、渠道、账号池、模型、路由、各阶段的路由顺序
// 幂等地写进库。只补缺：库里没有的行插进去，已有的行只填空着的字段；已经有值的、驾驶舱或帅位改过的一概不动，
// 配置和库里不一样的列进 kept 给人看。阶段顺序每个阶段只排一次（stage_policies.catalog_applied_at），之后怎么改都不覆盖。
// 配置文件缺失、格式错、引用不存在都明确报错，库里一行不写——不许当成空目录继续。
import { readFile } from 'node:fs/promises';
import type { StageKind } from '@fleet-dao/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './client.ts';
import { BILLING_KINDS, HOST_IDS, STAGE_KINDS } from './schema/enums.ts';
import {
  auditLog,
  channels,
  families,
  models,
  pools,
  routes,
  stagePolicies,
  stagePolicyRoutes,
} from './schema/index.ts';

export const CATALOG_DEFAULT_PATH = '/etc/fleet-dao/catalog.json';

const Id = z.string().trim().min(1);
const Text = z.string().trim().min(1);

const StageEntry = z.strictObject({ routeId: Id, enabled: z.boolean() });

export const CatalogSchema = z.strictObject({
  families: z.array(z.strictObject({ id: Id, displayName: Text, vendor: Text })).default([]),
  channels: z
    .array(z.strictObject({ id: Id, name: Text, billing: z.enum(BILLING_KINDS), enabled: z.boolean() }))
    .min(1),
  pools: z
    .array(
      z.strictObject({
        id: Id,
        channelId: Id,
        maxConcurrency: z.int().positive(),
        sessionUser: Id.optional(),
        expiresAt: z.iso.datetime({ offset: true }).optional(),
      }),
    )
    .min(1),
  models: z.array(z.strictObject({ id: Id, family: Id, displayName: Text })).default([]),
  routes: z
    .array(
      z.strictObject({
        id: Id,
        poolId: Id,
        modelId: Id,
        hostId: z.enum(HOST_IDS),
        upstreamModel: Id.optional(),
        upstreamAliases: z.array(Id).default([]),
      }),
    )
    .min(1),
  /** default 给没单列的阶段用；单列的阶段整串替换 default。 */
  stages: z
    .partialRecord(z.enum(['default', ...STAGE_KINDS]), z.array(StageEntry).min(1))
    .refine((s) => Object.keys(s).length > 0, '至少要有 default 或某个阶段的顺序'),
});

export type CatalogConfig = z.infer<typeof CatalogSchema>;

export class CatalogError extends Error {
  readonly problems: string[];
  constructor(title: string, problems: string[]) {
    super([title, ...problems.map((p) => `- ${p}`)].join('\n'));
    this.name = 'CatalogError';
    this.problems = problems;
  }
}

/** 以 _ 开头的键是注释（例如 _说明），校验前去掉；其余键写错了照样报错。 */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, v]) => [key, stripComments(v)]),
    );
  }
  return value;
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

/** 解析并校验目录配置的文本。格式错、同一类里 id 重复、同一阶段里路由重复，都抛 CatalogError。 */
export function parseCatalog(text: string, source = '目录配置'): CatalogConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CatalogError(`${source} 不是合法的 JSON`, [e instanceof Error ? e.message : String(e)]);
  }
  const parsed = CatalogSchema.safeParse(stripComments(raw));
  if (!parsed.success) {
    throw new CatalogError(
      `${source} 格式不对`,
      parsed.error.issues.map((i) => `${i.path.join('.') || '（根）'}：${i.message}`),
    );
  }
  const config = parsed.data;
  const problems: string[] = [];
  for (const [kind, list] of [
    ['families', config.families],
    ['channels', config.channels],
    ['pools', config.pools],
    ['models', config.models],
    ['routes', config.routes],
  ] as const) {
    for (const id of duplicates(list.map((x) => x.id))) problems.push(`${kind} 里 ${id} 出现了不止一次`);
  }
  for (const [stage, entries] of Object.entries(config.stages)) {
    for (const id of duplicates((entries ?? []).map((e) => e.routeId))) {
      problems.push(`stages.${stage} 里路由 ${id} 出现了不止一次`);
    }
  }
  if (problems.length > 0) throw new CatalogError(`${source} 有重复`, problems);
  return config;
}

/** 读目录配置文件。文件不在、读不了都明确报错（不当成空目录继续）。readText 留给测试替换，测试不碰真目录。 */
export async function readCatalogFile(
  path: string,
  readText: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<CatalogConfig> {
  let text: string;
  try {
    text = await readText(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    const why = code === 'ENOENT' ? '文件不存在' : `读不了（${e instanceof Error ? e.message : String(e)}）`;
    throw new CatalogError(`目录配置 ${path} ${why}；装载器不会当成空目录继续`, []);
  }
  return parseCatalog(text, `目录配置 ${path}`);
}

/** 配置文件的路径：命令行第一个参数 > 环境变量 FLEET_CATALOG > 默认 /etc/fleet-dao/catalog.json。 */
export function catalogPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string {
  return argv[0] || env.FLEET_CATALOG || CATALOG_DEFAULT_PATH;
}

export interface CatalogLoadResult {
  /** 这次新插进去的行（按类别列 id）。 */
  inserted: {
    families: string[];
    channels: string[];
    pools: string[];
    models: string[];
    routes: string[];
    /** 按配置排了初始顺序的阶段。 */
    stages: StageKind[];
  };
  /** 已有的行上补了空位的字段，例如 routes.opus.upstreamModel。 */
  filled: string[];
  /** 库里已有顺序（或钉住了）、装载器这次接手下来的阶段：没改顺序，只记下以后不再动它。 */
  adoptedStages: StageKind[];
  /** 配置里写了、库里已有且不一样、没动的（驾驶舱或帅位改过，或早先装的）。 */
  kept: string[];
  /** 这次库里一行都没改。 */
  unchanged: boolean;
}

export interface LoadCatalogOptions {
  now?: Date;
  /** 配置从哪来（写进操作记录）。 */
  source?: string;
}

type Row = Record<string, unknown>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b !== undefined && b !== null && a.getTime() === new Date(b as string).getTime()
    );
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 已有的一行和配置逐个字段比：fillable 里的字段库里空着、配置有值，算「可补」；
 * 其余两边都有值又不一样的记进 kept（驾驶舱或帅位改过，或早先装的），不动。
 */
function compare(
  kind: string,
  id: string,
  stored: Row,
  wanted: Row,
  fields: readonly string[],
  fillable: readonly string[],
  kept: string[],
): Row {
  const fill: Row = {};
  const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
  for (const field of fields) {
    const want = wanted[field];
    const have = stored[field];
    if (isEmpty(want) || sameValue(have, want)) continue;
    if (isEmpty(have) && fillable.includes(field)) fill[field] = want;
    else
      kept.push(
        `${kind}.${id}.${field}：库里是 ${JSON.stringify(have)}，配置是 ${JSON.stringify(want)}，没动`,
      );
  }
  return fill;
}

/** 把目录配置写进库：只补缺，同一事务。引用不存在（配置里没有、库里也没有）就整批报错，一行不写。 */
export async function loadCatalog(
  db: Db,
  config: CatalogConfig,
  options: LoadCatalogOptions = {},
): Promise<CatalogLoadResult> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
    const stored = {
      families: byId(await tx.select().from(families)),
      channels: byId(await tx.select().from(channels)),
      pools: byId(await tx.select().from(pools)),
      models: byId(await tx.select().from(models)),
      routes: byId(await tx.select().from(routes)),
    };
    const known = (kind: keyof typeof stored, list: readonly { id: string }[], id: string) =>
      stored[kind].has(id) || list.some((x) => x.id === id);

    const problems: string[] = [];
    for (const m of config.models) {
      if (!known('families', config.families, m.family))
        problems.push(`模型 ${m.id} 的族 ${m.family} 不存在`);
    }
    for (const p of config.pools) {
      if (!known('channels', config.channels, p.channelId)) {
        problems.push(`账号池 ${p.id} 的渠道 ${p.channelId} 不存在`);
      }
    }
    for (const r of config.routes) {
      if (!known('pools', config.pools, r.poolId)) problems.push(`路由 ${r.id} 的账号池 ${r.poolId} 不存在`);
      if (!known('models', config.models, r.modelId))
        problems.push(`路由 ${r.id} 的模型 ${r.modelId} 不存在`);
    }
    for (const [stage, entries] of Object.entries(config.stages)) {
      for (const e of entries ?? []) {
        if (!known('routes', config.routes, e.routeId))
          problems.push(`stages.${stage} 的路由 ${e.routeId} 不存在`);
      }
    }
    if (problems.length > 0) throw new CatalogError('目录配置里引用了不存在的东西', problems);

    const inserted: CatalogLoadResult['inserted'] = {
      families: [],
      channels: [],
      pools: [],
      models: [],
      routes: [],
      stages: [],
    };
    const filled: string[] = [];
    const kept: string[] = [];

    /**
     * 没有的插进去；有的逐个字段比：fillable 里库里空着的补上，其余不一样的记进 kept。
     * fill 只会收到 fillable 里的字段。
     */
    async function upsertMissing<W extends { id: string }>(
      kind: keyof typeof stored,
      list: readonly W[],
      insert: (w: W) => Promise<boolean>,
      fields: readonly (keyof W & string)[],
      fillable: readonly (keyof W & string)[] = [],
      fill: (id: string, values: Row) => Promise<void> = async () => {},
    ) {
      for (const wanted of list) {
        const have = stored[kind].get(wanted.id) as Row | undefined;
        if (!have) {
          if (await insert(wanted)) inserted[kind].push(wanted.id);
          continue;
        }
        const values = compare(kind, wanted.id, have, wanted as Row, fields, fillable, kept);
        if (Object.keys(values).length > 0) {
          await fill(wanted.id, values);
          filled.push(...Object.keys(values).map((f) => `${kind}.${wanted.id}.${f}`));
        }
      }
    }
    const wrote = (rows: { id: string }[]) => rows.length > 0;

    await upsertMissing(
      'families',
      config.families,
      async (f) =>
        wrote(await tx.insert(families).values(f).onConflictDoNothing().returning({ id: families.id })),
      ['displayName', 'vendor'],
    );
    await upsertMissing(
      'channels',
      config.channels,
      async (c) =>
        wrote(await tx.insert(channels).values(c).onConflictDoNothing().returning({ id: channels.id })),
      ['name', 'billing', 'enabled'],
    );
    await upsertMissing(
      'pools',
      config.pools,
      async (p) =>
        wrote(
          await tx
            .insert(pools)
            .values({
              id: p.id,
              channelId: p.channelId,
              maxConcurrency: p.maxConcurrency,
              sessionUser: p.sessionUser ?? null,
              expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
            })
            .onConflictDoNothing()
            .returning({ id: pools.id }),
        ),
      ['channelId', 'maxConcurrency', 'sessionUser', 'expiresAt'],
      ['sessionUser', 'expiresAt'],
      async (id, values) => {
        await tx
          .update(pools)
          .set({
            ...(values.sessionUser !== undefined && { sessionUser: values.sessionUser as string }),
            ...(values.expiresAt !== undefined && { expiresAt: new Date(values.expiresAt as string) }),
          })
          .where(eq(pools.id, id));
      },
    );
    await upsertMissing(
      'models',
      config.models,
      async (m) =>
        wrote(await tx.insert(models).values(m).onConflictDoNothing().returning({ id: models.id })),
      ['family', 'displayName'],
    );
    // 路由挂的渠道跟着池走（库里已有的池以库里为准）。
    const poolChannel = (poolId: string) =>
      stored.pools.get(poolId)?.channelId ?? config.pools.find((p) => p.id === poolId)?.channelId ?? '';
    await upsertMissing(
      'routes',
      config.routes,
      async (r) =>
        wrote(
          await tx
            .insert(routes)
            .values({
              id: r.id,
              channelId: poolChannel(r.poolId),
              poolId: r.poolId,
              modelId: r.modelId,
              hostId: r.hostId,
              upstreamModel: r.upstreamModel ?? null,
              upstreamAliases: r.upstreamAliases,
            })
            .onConflictDoNothing()
            .returning({ id: routes.id }),
        ),
      ['poolId', 'modelId', 'hostId', 'upstreamModel', 'upstreamAliases'],
      ['upstreamModel', 'upstreamAliases'],
      async (id, values) => {
        await tx
          .update(routes)
          .set({
            ...(values.upstreamModel !== undefined && { upstreamModel: values.upstreamModel as string }),
            ...(values.upstreamAliases !== undefined && {
              upstreamAliases: values.upstreamAliases as string[],
            }),
          })
          .where(eq(routes.id, id));
      },
    );

    const adoptedStages: StageKind[] = [];
    for (const stage of STAGE_KINDS) {
      const entries = config.stages[stage] ?? config.stages.default;
      if (!entries) continue;
      await tx.insert(stagePolicies).values({ stage }).onConflictDoNothing();
      const [policy] = await tx
        .select()
        .from(stagePolicies)
        .where(eq(stagePolicies.stage, stage))
        .for('update');
      const current = await tx
        .select()
        .from(stagePolicyRoutes)
        .where(eq(stagePolicyRoutes.stage, stage))
        .orderBy(asc(stagePolicyRoutes.position));
      const sameOrder =
        current.length === entries.length &&
        current.every((c, i) => c.routeId === entries[i]?.routeId && c.enabled === entries[i]?.enabled);
      if (policy?.catalogAppliedAt) {
        if (!sameOrder) kept.push(`阶段 ${stage}：驾驶舱或帅位改过顺序，没动`);
        continue;
      }
      if (policy?.pinned || current.length > 0) {
        // 库里已经有人排过（或钉住了）：接手下来，这次和以后都不动它。
        adoptedStages.push(stage);
        if (!sameOrder) kept.push(`阶段 ${stage}：库里已有顺序${policy?.pinned ? '（钉住了）' : ''}，没动`);
      } else {
        await tx
          .insert(stagePolicyRoutes)
          .values(
            entries.map((e, position) => ({ stage, routeId: e.routeId, position, enabled: e.enabled })),
          );
        inserted.stages.push(stage);
      }
      await tx.update(stagePolicies).set({ catalogAppliedAt: now }).where(eq(stagePolicies.stage, stage));
    }

    const unchanged =
      Object.values(inserted).every((ids) => ids.length === 0) &&
      filled.length === 0 &&
      adoptedStages.length === 0;
    if (!unchanged) {
      await tx.insert(auditLog).values({
        at: now,
        actorKind: 'engine',
        actorId: 'catalog-loader',
        action: 'catalog.load',
        target: 'catalog',
        after: { inserted, filled, adoptedStages },
        reason: `按 ${options.source ?? '目录配置'} 补缺`,
        via: 'engine',
      });
    }
    return { inserted, filled, adoptedStages, kept, unchanged };
  });
}

/** 给命令行打印的摘要。 */
export function formatCatalogResult(r: CatalogLoadResult): string {
  const lines: string[] = [];
  const kinds = ['families', 'channels', 'pools', 'models', 'routes', 'stages'] as const;
  for (const kind of kinds) {
    const ids = r.inserted[kind];
    if (ids.length > 0) lines.push(`新写入 ${kind}（${ids.length}）：${ids.join('、')}`);
  }
  if (r.filled.length > 0) lines.push(`补了空位（${r.filled.length}）：${r.filled.join('、')}`);
  if (r.adoptedStages.length > 0) lines.push(`接手库里已有的阶段顺序：${r.adoptedStages.join('、')}`);
  if (r.unchanged) lines.push('库里已经齐了，这次一行没改');
  for (const note of r.kept) lines.push(`没动：${note}`);
  return lines.join('\n');
}
