// 名册读成之后，把看见的上游串补进目录（#1355）。只补没有的行。已有的模型、路由不改，只清或打「渠道已下架」。
import type { HostId } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { discoveredModelId, nameUpstreamModel } from '../model-naming.ts';
import { auditLog, families, models, pools, routes, routingCatalog } from '../schema/index.ts';

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
  modelsAdded: number;
  routesAdded: number;
  goneMarked: number;
  goneCleared: number;
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
 * 新路由不进任何用途，routing_catalog.enabled 写 false。变体写在路由上，不写进起会话的档位列。
 */
export async function discoverChannelModels(
  db: Db,
  channelId: string,
  modelKeys: readonly string[],
  now: Date,
): Promise<DiscoverResult> {
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
  let routesAdded = 0;
  let goneCleared = 0;

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

  for (const key of modelKeys) {
    const hits = existing.filter((route) => listedKeys(route).includes(key));
    if (hits.length > 0) {
      for (const hit of hits) {
        matched.add(hit.id);
        if (!hit.goneAt) continue;
        await db.update(routes).set({ goneAt: null }).where(eq(routes.id, hit.id));
        hit.goneAt = null;
        goneCleared += 1;
      }
      continue;
    }

    const named = nameUpstreamModel(channelId, key);
    const unclassified = 'unclassified' in named;
    const modelId = discoveredModelId(channelId, key);
    const familyId = unclassified ? 'unclassified' : named.family;
    await ensureFamily(familyId);
    const insertedModel = await db
      .insert(models)
      .values({ id: modelId, family: familyId, displayName: unclassified ? key : modelId })
      .onConflictDoNothing({ target: models.id })
      .returning({ id: models.id });
    if (insertedModel.length > 0) {
      modelsAdded += 1;
      newModelIds.push(modelId);
    }

    const routeId = `auto:${channelId}:${key}`;
    const insertedRoute = await db
      .insert(routes)
      .values({
        id: routeId,
        channelId,
        poolId,
        modelId,
        hostId,
        alive: false,
        upstreamModel: key,
        variantEffort: unclassified ? null : named.effort,
        variantFast: unclassified ? null : named.fast,
        variantThinking: unclassified ? null : named.thinking,
        variantContext: unclassified ? null : named.context,
      })
      .returning({ id: routes.id });
    const insertedId = insertedRoute[0]?.id;
    if (!insertedId) throw new Error(`路由 ${routeId} 没写进去`);
    routesAdded += 1;
    matched.add(insertedId);

    const position = nextPos.get(modelId) ?? 0;
    nextPos.set(modelId, position + 1);
    await db.insert(routingCatalog).values({ modelId, routeId: insertedId, position, enabled: false });
  }

  let goneMarked = 0;
  for (const route of existing) {
    if (matched.has(route.id) || route.goneAt) continue;
    await db.update(routes).set({ goneAt: now }).where(eq(routes.id, route.id));
    goneMarked += 1;
  }

  const counts = { modelsAdded, routesAdded, goneMarked, goneCleared };
  await db.insert(auditLog).values({
    at: now,
    actorKind: 'engine',
    actorId: 'model-roster',
    action: 'catalog.discover',
    target: `channel:${channelId}`,
    after: counts,
    reason: '名册读成，自动入库',
    via: 'engine',
  });
  return { ...counts, newModelIds };
}
