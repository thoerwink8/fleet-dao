// 名册读成之后，已有路由清或打「渠道已下架」，早先未归类的自动入库路由能拆名就挪走（#1355）。
// 新看见的上游串不建模型、不建路由：调用方已经写进 channel_seen_models。人把它「加进模型」时才建路由行。
import type { HostId } from '@fleet-dao/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { DISCOVERED_ROUTE_PREFIX, discoveredModelId, nameUpstreamModel } from '../model-naming.ts';
import {
  auditLog,
  channelSeenModels,
  families,
  models,
  pools,
  routes,
  routingCatalog,
} from '../schema/index.ts';

const HOST_BY_CHANNEL: Record<string, HostId> = {
  mirasim: 'mirasim',
  cursor: 'cursor-agent',
  xai: 'grok',
  'claude-sub': 'claude-code',
};

/** 和 deploy/catalog.json 里的族用同一套名字，之后装载器再补缺时不会改写。 */
const FAMILY_ROWS: Record<string, { displayName: string; vendor: string }> = {
  claude: { displayName: 'Claude', vendor: 'Anthropic' },
  gpt: { displayName: 'GPT', vendor: 'OpenAI' },
  kimi: { displayName: 'Kimi', vendor: 'Moonshot AI' },
  deepseek: { displayName: 'DeepSeek', vendor: 'DeepSeek' },
  cursor: { displayName: 'Cursor', vendor: 'Anysphere' },
  grok: { displayName: 'Grok', vendor: 'xAI' },
  glm: { displayName: 'GLM', vendor: '智谱' },
  gemini: { displayName: 'Gemini', vendor: 'Google' },
  muse: { displayName: 'Muse', vendor: 'Meta' },
  unclassified: { displayName: '未归类', vendor: '未知' },
};

export interface DiscoverCounts {
  /** 这次新插进 models 的条数。只来自把早先未归类的路由挪到认出的模型下；新看见的串不建模型。 */
  modelsAdded: number;
  /** 名册发现不再插路由，这一项是 0。路由行只在「加进模型」时建。 */
  routesAdded: number;
  goneMarked: number;
  goneCleared: number;
  /** 早先拆不出、进了未归类的自动入库路由，这次拆名规则认出来了，挪到认出的模型下的条数。 */
  reclassified: number;
}

export interface DiscoverResult extends DiscoverCounts {
  /** 这一次新插进 models 的模型 id（给「发现 N 个新模型」的通知列名字）。 */
  newModelIds: string[];
}

function listedKeys(route: { upstreamModel: string | null; upstreamAliases: readonly string[] }): string[] {
  const out: string[] = [];
  const upstream = route.upstreamModel?.trim() ?? '';
  if (upstream) out.push(upstream);
  for (const alias of route.upstreamAliases) {
    const text = alias.trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * 一个渠道这一次读成的名单。调用方要包在和名册写入同一笔事务里：这里失败，整笔一起回滚。
 * 新看见的串不建路由、不建模型（人「加进模型」才建，见 addChannelModel）。已有的路由：对得上的清下架、能拆名的挪走，名单里没有的标下架。
 * 没有名册命令、靠手工登记的渠道（#1371）：给的只是登记过的那几个串，不是完整名单，所以 markGone 要关（不能拿它判别的路由消失），
 * 登记自己有操作记录，writeAudit 也关。
 */
export async function discoverChannelModels(
  db: Db,
  channelId: string,
  modelKeys: readonly string[],
  now: Date,
  options: { markGone?: boolean; writeAudit?: boolean } = {},
): Promise<DiscoverResult> {
  const markGone = options.markGone ?? true;
  const writeAudit = options.writeAudit ?? true;
  const hostId = HOST_BY_CHANNEL[channelId];
  if (!hostId) throw new Error(`渠道 ${channelId} 没有对应的执行方式，路由挂不上去`);
  const poolRows = await db
    .select({ id: pools.id })
    .from(pools)
    .where(eq(pools.channelId, channelId))
    .orderBy(pools.id);
  const poolId = poolRows[0]?.id;
  if (!poolId) throw new Error(`渠道 ${channelId} 没有账号池，路由挂不上去`);

  const existing = await db.select().from(routes).where(eq(routes.channelId, channelId));
  const posRows = await db
    .select({ modelId: routingCatalog.modelId, position: routingCatalog.position })
    .from(routingCatalog);
  const nextPos = new Map<string, number>();
  for (const row of posRows) {
    const next = row.position + 1;
    if (next > (nextPos.get(row.modelId) ?? 0)) nextPos.set(row.modelId, next);
  }

  const matched = new Set<string>();
  const familiesReady = new Set<string>();
  let modelsAdded = 0;
  const newModelIds: string[] = [];
  const routesAdded = 0;
  let goneCleared = 0;
  let reclassified = 0;

  const ensureFamily = async (familyId: string) => {
    if (familiesReady.has(familyId)) return;
    const row = FAMILY_ROWS[familyId];
    if (!row) throw new Error(`拆名给出了不认识的族 ${familyId}`);
    await db
      .insert(families)
      .values({ id: familyId, displayName: row.displayName, vendor: row.vendor })
      .onConflictDoNothing();
    familiesReady.add(familyId);
  };

  /** 模型不在目录里就插进去（已有的不动），新插的记进 newModelIds。 */
  const ensureModel = async (modelId: string, familyId: string, displayName: string): Promise<void> => {
    await ensureFamily(familyId);
    const inserted = await db
      .insert(models)
      .values({ id: modelId, family: familyId, displayName })
      .onConflictDoNothing({ target: models.id })
      .returning({ id: models.id });
    if (inserted.length > 0) {
      modelsAdded += 1;
      newModelIds.push(modelId);
    }
  };

  /**
   * 早先拆不出、进了未归类的自动入库路由（编号 auto:<渠道>:<原串>、模型 id <渠道>:<原串>），拆名规则后来认出来了：挪到认出的模型下，
   * 补上变体；它在模型顺序里那一行跟着挪（开关、档位照旧，排到那个模型的最后）。手工登记的、已经挂在认得的模型下的不碰。
   */
  const reclassify = async (route: (typeof existing)[number], key: string): Promise<boolean> => {
    if (route.id !== `${DISCOVERED_ROUTE_PREFIX}${channelId}:${key}`) return false;
    if (route.modelId !== `${channelId}:${key}`) return false;
    const named = nameUpstreamModel(channelId, key);
    if ('unclassified' in named) return false;
    await ensureModel(named.modelId, named.family, named.modelId);
    const [entry] = await db
      .delete(routingCatalog)
      .where(and(eq(routingCatalog.routeId, route.id), eq(routingCatalog.modelId, route.modelId)))
      .returning();
    await db
      .update(routes)
      .set({
        modelId: named.modelId,
        variantEffort: named.effort,
        variantFast: named.fast,
        variantThinking: named.thinking,
        variantContext: named.context,
      })
      .where(eq(routes.id, route.id));
    if (entry) {
      const position = nextPos.get(named.modelId) ?? 0;
      nextPos.set(named.modelId, position + 1);
      await db.insert(routingCatalog).values({
        modelId: named.modelId,
        routeId: route.id,
        position,
        enabled: entry.enabled,
        effort: entry.effort,
      });
    }
    route.modelId = named.modelId;
    return true;
  };

  for (const key of modelKeys) {
    const hits = existing.filter((route) => listedKeys(route).includes(key));
    // 新串不建模型、不建路由。调用方已经写进 channel_seen_models；人「加进模型」才建行。
    if (hits.length === 0) continue;
    for (const hit of hits) {
      matched.add(hit.id);
      if (await reclassify(hit, key)) reclassified += 1;
      if (!hit.goneAt) continue;
      await db.update(routes).set({ goneAt: null }).where(eq(routes.id, hit.id));
      hit.goneAt = null;
      goneCleared += 1;
    }
  }

  let goneMarked = 0;
  if (markGone) {
    for (const route of existing) {
      if (matched.has(route.id) || route.goneAt) continue;
      await db.update(routes).set({ goneAt: now }).where(eq(routes.id, route.id));
      goneMarked += 1;
    }
  }

  const counts = { modelsAdded, routesAdded, goneMarked, goneCleared, reclassified };
  if (writeAudit) {
    await db.insert(auditLog).values({
      at: now,
      actorKind: 'engine',
      actorId: 'model-roster',
      action: 'catalog.discover',
      target: `channel:${channelId}`,
      after: counts,
      reason: '名册读成，记进渠道见过的模型',
      via: 'engine',
    });
  }
  return { ...counts, newModelIds };
}

export interface AddChannelModelResult {
  /** 这次新插了一条路由。这个渠道已经有路由列着这个串（上游串或别名）时是 false，不另插。 */
  created: boolean;
  routeId: string | null;
  modelId: string | null;
}

/**
 * 把渠道名册里已经见过的一个串加进模型：补族、模型、一条关着的路由（不进任何用途）。
 * 路由编号 `auto:<渠道>:<原串>`，变体写在路由上，不写进起会话的档位列。执行体留空，下次名册读成再盖。
 * 这个串还没记在 channel_seen_models 里就拒绝（先登记或先读成名册）。已经有路由列着它就不另插，也不补目录行。
 */
export async function addChannelModel(
  db: Db,
  channelId: string,
  rawKey: string,
  now: Date,
  options: { writeAudit?: boolean } = {},
): Promise<AddChannelModelResult> {
  const writeAudit = options.writeAudit ?? true;
  const modelKey = rawKey.trim();
  if (!modelKey) throw new Error('模型串是空的');
  const hostId = HOST_BY_CHANNEL[channelId];
  if (!hostId) throw new Error(`渠道 ${channelId} 没有对应的执行方式，路由挂不上去`);

  return db.transaction(async (tx) => {
    const [seen] = await tx
      .select({ modelKey: channelSeenModels.modelKey })
      .from(channelSeenModels)
      .where(and(eq(channelSeenModels.channelId, channelId), eq(channelSeenModels.modelKey, modelKey)));
    if (!seen) throw new Error('这个模型串还没在渠道名册里见过，不能加进模型');

    const poolRows = await tx
      .select({ id: pools.id })
      .from(pools)
      .where(eq(pools.channelId, channelId))
      .orderBy(pools.id);
    const poolId = poolRows[0]?.id;
    if (!poolId) throw new Error(`渠道 ${channelId} 没有账号池，路由挂不上去`);

    const existing = await tx.select().from(routes).where(eq(routes.channelId, channelId));
    const hit = existing.find((route) => listedKeys(route).includes(modelKey));
    if (hit) return { created: false, routeId: hit.id, modelId: hit.modelId };

    const named = nameUpstreamModel(channelId, modelKey);
    const unclassified = 'unclassified' in named;
    const modelId = discoveredModelId(channelId, modelKey);
    const familyId = unclassified ? 'unclassified' : named.family;
    const family = FAMILY_ROWS[familyId];
    if (!family) throw new Error(`拆名给出了不认识的族 ${familyId}`);
    await tx
      .insert(families)
      .values({ id: familyId, displayName: family.displayName, vendor: family.vendor })
      .onConflictDoNothing();
    await tx
      .insert(models)
      .values({ id: modelId, family: familyId, displayName: unclassified ? modelKey : modelId })
      .onConflictDoNothing({ target: models.id });

    const routeId = `${DISCOVERED_ROUTE_PREFIX}${channelId}:${modelKey}`;
    const insertedRoute = await tx
      .insert(routes)
      .values({
        id: routeId,
        channelId,
        poolId,
        modelId,
        hostId,
        alive: false,
        upstreamModel: modelKey,
        variantEffort: unclassified ? null : named.effort,
        variantFast: unclassified ? null : named.fast,
        variantThinking: unclassified ? null : named.thinking,
        variantContext: unclassified ? null : named.context,
      })
      .returning({ id: routes.id });
    const insertedId = insertedRoute[0]?.id;
    if (!insertedId) throw new Error(`路由 ${routeId} 没写进去`);

    const posRows = await tx
      .select({ position: routingCatalog.position })
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, modelId));
    const position = posRows.reduce((max, row) => Math.max(max, row.position + 1), 0);
    await tx.insert(routingCatalog).values({ modelId, routeId: insertedId, position, enabled: false });

    if (writeAudit) {
      await tx.insert(auditLog).values({
        at: now,
        actorKind: 'engine',
        actorId: 'model-roster',
        action: 'catalog.add-model',
        target: `channel:${channelId}`,
        after: { modelKey, routeId: insertedId, modelId },
        reason: '加进模型',
        via: 'engine',
      });
    }
    return { created: true, routeId: insertedId, modelId };
  });
}
