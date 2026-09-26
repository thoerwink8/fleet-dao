// 目录装载器：读本机的目录配置（默认 /etc/fleet-dao/catalog.json），把族、渠道、账号池、模型、路由、各阶段的路由顺序
// 幂等地写进库。只补缺：库里没有的行插进去，已有的行只填空着的字段；已经有值的、驾驶舱或帅位改过的一概不动，
// 配置和库里不一样的列进 kept 给人看。阶段顺序每个阶段只排一次（stage_policies.catalog_applied_at），之后怎么改都不覆盖。
// 配置文件缺失、格式错、引用不存在都明确报错，库里一行不写——不许当成空目录继续。
import { readFile } from 'node:fs/promises';
import { type BanSubject, hardBanFor, type OrgKind, type RunAsUser, type StageKind } from '@fleet-dao/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './client.ts';
import {
  BILLING_KINDS,
  HOST_IDS,
  ORG_KINDS,
  RETIRED_RUN_AS_USERS,
  RUN_AS_USERS,
  STAGE_KINDS,
} from './schema/enums.ts';
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

/** 停用的会话用户（fleet-agent-dedicated）写进来要明确报错、说清改成什么：法国已经没有这个用户，装进去会话起不来。 */
const RunAsUserField = z
  .string()
  .superRefine((value, ctx) => {
    if ((RETIRED_RUN_AS_USERS as readonly string[]).includes(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `${value} 已停用（法国只留一个会话用户，docs/design.md 第十节），改成 ${RUN_AS_USERS.join('、')}，并用 orgKind 标明是拼车还是独享池`,
      });
    } else if (!(RUN_AS_USERS as readonly string[]).includes(value)) {
      ctx.addIssue({ code: 'custom', message: `会话用户只能是 ${RUN_AS_USERS.join('、')}，给的是 ${value}` });
    }
  })
  .transform((value) => value as RunAsUser);

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
        runAsUser: RunAsUserField.optional(),
        orgKind: z.enum(ORG_KINDS).optional(),
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

const routeLine = (r: { poolId: string; modelId: string; hostId: string }) =>
  `${r.poolId} / ${r.modelId} / ${r.hostId}`;

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
  // 库里（池, 模型, 执行方式）唯一：换个 id 写同一条线，插的时候会被唯一约束挡掉。
  for (const line of duplicates(config.routes.map(routeLine))) {
    problems.push(`routes 里（账号池 / 模型 / 执行方式）${line} 出现了不止一次`);
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

    for (const r of config.routes) {
      const same = [...stored.routes.values()].find((s) => s.id !== r.id && routeLine(s) === routeLine(r));
      if (same) problems.push(`路由 ${r.id} 和库里的 ${same.id} 是同一条线（${routeLine(r)}）`);
    }
    if (problems.length > 0) throw new CatalogError('目录配置里的路由和库里的重了', problems);

    // 硬禁令（shared/bans.ts）：配置里写了就拒收，不等选路时再拦。按模型本身、再按路由带上游串判。
    const modelOf = (id: string) => config.models.find((m) => m.id === id) ?? stored.models.get(id);
    const routeSubject = (routeId: string): BanSubject | undefined => {
      const r = config.routes.find((x) => x.id === routeId) ?? stored.routes.get(routeId);
      const model = r && modelOf(r.modelId);
      return model && { ...model, upstreamModel: r.upstreamModel, upstreamAliases: r.upstreamAliases };
    };
    for (const m of config.models) {
      const ban = hardBanFor(m, undefined);
      if (ban) problems.push(`模型 ${m.id}：${ban.reason}`);
    }
    for (const r of config.routes) {
      const subject = routeSubject(r.id);
      const ban = subject && hardBanFor(subject, undefined);
      if (ban) problems.push(`路由 ${r.id}：${ban.reason}`);
    }
    for (const stage of STAGE_KINDS) {
      const key = config.stages[stage] ? stage : 'default';
      for (const e of config.stages[key] ?? []) {
        const subject = routeSubject(e.routeId);
        const ban = subject && hardBanFor(subject, stage);
        if (ban && !problems.some((p) => p.startsWith(`路由 ${e.routeId}：`))) {
          problems.push(
            `stages.${key} 的路由 ${e.routeId} 不能用在 ${stage}${key === stage ? '' : '（没单列这个阶段，用的是 default）'}：${ban.reason}`,
          );
        }
      }
    }
    if (problems.length > 0) throw new CatalogError('目录配置撞了硬禁令', problems);

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
     * fill 一次补一个 fillable 里的字段，而且只在库里那一格还空着时才写（返回写没写成）：
     * 两个装载器并发、或读完之后有人刚填上，都不会被覆盖。
     */
    async function upsertMissing<W extends { id: string }>(
      kind: keyof typeof stored,
      list: readonly W[],
      insert: (w: W) => Promise<boolean>,
      fields: readonly (keyof W & string)[],
      fillable: readonly (keyof W & string)[] = [],
      fill: (id: string, field: string, value: unknown) => Promise<boolean> = async () => false,
    ) {
      for (const wanted of list) {
        const have = stored[kind].get(wanted.id) as Row | undefined;
        if (!have) {
          if (await insert(wanted)) inserted[kind].push(wanted.id);
          continue;
        }
        const values = compare(kind, wanted.id, have, wanted as Row, fields, fillable, kept);
        for (const [field, value] of Object.entries(values)) {
          if (await fill(wanted.id, field, value)) filled.push(`${kind}.${wanted.id}.${field}`);
        }
      }
    }
    const wrote = (rows: { id: string }[]) => rows.length > 0;

    await upsertMissing(
      'families',
      config.families,
      async (f) =>
        wrote(
          await tx
            .insert(families)
            .values(f)
            .onConflictDoNothing({ target: families.id })
            .returning({ id: families.id }),
        ),
      ['displayName', 'vendor'],
    );
    await upsertMissing(
      'channels',
      config.channels,
      async (c) =>
        wrote(
          await tx
            .insert(channels)
            .values(c)
            .onConflictDoNothing({ target: channels.id })
            .returning({ id: channels.id }),
        ),
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
              runAsUser: p.runAsUser ?? null,
              orgKind: p.orgKind ?? null,
              expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
            })
            .onConflictDoNothing({ target: pools.id })
            .returning({ id: pools.id }),
        ),
      ['channelId', 'maxConcurrency', 'runAsUser', 'orgKind', 'expiresAt'],
      ['runAsUser', 'orgKind', 'expiresAt'],
      async (id, field, value) => {
        const [set, empty] =
          field === 'runAsUser'
            ? [{ runAsUser: value as RunAsUser }, isNull(pools.runAsUser)]
            : field === 'orgKind'
              ? [{ orgKind: value as OrgKind }, isNull(pools.orgKind)]
              : [{ expiresAt: new Date(value as string) }, isNull(pools.expiresAt)];
        return wrote(
          await tx
            .update(pools)
            .set(set)
            .where(and(eq(pools.id, id), empty))
            .returning({ id: pools.id }),
        );
      },
    );
    await upsertMissing(
      'models',
      config.models,
      async (m) =>
        wrote(
          await tx
            .insert(models)
            .values(m)
            .onConflictDoNothing({ target: models.id })
            .returning({ id: models.id }),
        ),
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
            .onConflictDoNothing({ target: routes.id })
            .returning({ id: routes.id }),
        ),
      ['poolId', 'modelId', 'hostId', 'upstreamModel', 'upstreamAliases'],
      ['upstreamModel', 'upstreamAliases'],
      async (id, field, value) => {
        const [set, empty] =
          field === 'upstreamModel'
            ? [{ upstreamModel: value as string }, isNull(routes.upstreamModel)]
            : [{ upstreamAliases: value as string[] }, sql`cardinality(${routes.upstreamAliases}) = 0`];
        return wrote(
          await tx
            .update(routes)
            .set(set)
            .where(and(eq(routes.id, id), empty))
            .returning({ id: routes.id }),
        );
      },
    );

    const adoptedStages: StageKind[] = [];
    for (const stage of STAGE_KINDS) {
      const entries = config.stages[stage] ?? config.stages.default;
      if (!entries) continue;
      await tx.insert(stagePolicies).values({ stage }).onConflictDoNothing({ target: stagePolicies.stage });
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
      // 配置里有、这个阶段里没挂上的路由点名出来（例如排过之后配置里新加的）：装载器不再动这个阶段，要用得去驾驶舱加。
      const missing = entries
        .filter((e) => !current.some((c) => c.routeId === e.routeId))
        .map((e) => e.routeId);
      const why = (base: string) =>
        missing.length > 0
          ? `阶段 ${stage}：${base}，配置里的 ${missing.join('、')} 没挂上（要用就在驾驶舱里加）`
          : `阶段 ${stage}：${base}，和配置不一样，没动`;
      if (policy?.catalogAppliedAt) {
        if (!sameOrder) kept.push(why('装载器早先排过，之后不再动它'));
        continue;
      }
      if (policy?.pinned || current.length > 0) {
        // 库里已经有人排过（或钉住了）：接手下来，这次和以后都不动它。
        adoptedStages.push(stage);
        if (!sameOrder) kept.push(why(`库里已有顺序${policy?.pinned ? '（钉住了）' : ''}`));
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
