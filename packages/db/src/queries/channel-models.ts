// 渠道模型名册（#1302）：记下看见的模型。读成的同一笔事务里把新串补进目录（#1355），读失败不动目录。
// 最近一次读失败的渠道不拿更早的名单去报「新增 / 消失」：那会把没读成说成渠道里已经没有。
import { errMessage } from '@fleet-dao/shared/util';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { channelModelReads, channelSeenModels, channels, routes } from '../schema/index.ts';
import { discoverChannelModels } from './catalog-discover.ts';

/** 一天四次左右：额度任务每 15 分钟醒一次，名册没到这个间隔就跳过。四个渠道一起读。 */
export const MODEL_ROSTER_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * 只读这四个。渠道编号是目录（deploy/catalog.json）里的，不是种子数据那套旧编号。
 * kind 决定用哪家的读法；reader 是额度配置里对应的读取器，测试拿它跟 deploy/quota.json 对。
 */
export const MODEL_ROSTER_CHANNELS = [
  { kind: 'mirasim', reader: 'mirasim-relay', channelId: 'mirasim' },
  { kind: 'cursor', reader: 'cursor-dashboard', channelId: 'cursor' },
  { kind: 'grok', reader: 'grok-billing', channelId: 'xai' },
  { kind: 'claude', reader: 'claude-usage', channelId: 'claude-sub' },
] as const;

export type ModelRosterChannel = (typeof MODEL_ROSTER_CHANNELS)[number];

/** 一次读的结果。空名单不算读成：调用方和写入方都会改写成失败。 */
export type ChannelModelReadInput =
  | { ok: true; channelId: string; models: readonly string[] }
  | { ok: false; channelId: string; error: { code: string; message: string } };

const EMPTY_ROSTER = '渠道回了空名单，不当成一个模型都没有';

/** 读成但一个模型都没有，改写成 bad_response。失败却没写原因的，也补上，不让空原因混进「读成了」。 */
export function normalizeChannelModelRead(input: ChannelModelReadInput): ChannelModelReadInput {
  if (!input.ok) {
    const code = input.error.code.trim();
    const message = input.error.message.trim();
    if (code && message) return { ok: false, channelId: input.channelId, error: { code, message } };
    return {
      ok: false,
      channelId: input.channelId,
      error: { code: code || 'bad_response', message: message || '读失败但没有写原因' },
    };
  }
  const models: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.models) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    models.push(key);
  }
  if (models.length === 0) {
    return { ok: false, channelId: input.channelId, error: { code: 'bad_response', message: EMPTY_ROSTER } };
  }
  return { ok: true, channelId: input.channelId, models };
}

/** 四个里有一个没读过、或最近一次尝试早于间隔，这一轮就四个都读。一个都没列入时不当成到点。 */
export async function modelRosterDue(db: Db, now: Date, everyMs = MODEL_ROSTER_EVERY_MS): Promise<boolean> {
  const ids = MODEL_ROSTER_CHANNELS.map((c) => c.channelId);
  if (ids.length === 0) return false;
  const rows = await db
    .select({ channelId: channelModelReads.channelId, attemptedAt: channelModelReads.attemptedAt })
    .from(channelModelReads)
    .where(inArray(channelModelReads.channelId, ids));
  const at = new Map(rows.map((r) => [r.channelId, r.attemptedAt.getTime()]));
  return ids.some((id) => {
    const seen = at.get(id);
    return seen === undefined || now.getTime() - seen >= everyMs;
  });
}

export interface SaveChannelModelReadsResult {
  /** 渠道行不在、约束没过：这一渠这轮没记上，页面上它仍是「还没读过」或留着上一次。 */
  unstored: { channelId: string; error: string }[];
}

/**
 * 每个渠道自己一笔事务。读成：名册里的模型 last_seen 盖成这一次，并在同一笔里把新串补进目录、给消失的路由标下架。
 * 读失败：只盖「最近一次读」，不动见过的模型，也不动目录。比库里那次还早的结果整笔丢掉。
 */
export async function saveChannelModelReads(
  db: Db,
  results: readonly ChannelModelReadInput[],
  now: Date,
): Promise<SaveChannelModelReadsResult> {
  const unstored: { channelId: string; error: string }[] = [];
  for (const raw of results) {
    const result = normalizeChannelModelRead(raw);
    try {
      await db.transaction(async (tx) => {
        const written = await tx
          .insert(channelModelReads)
          .values({
            channelId: result.channelId,
            attemptedAt: now,
            ok: result.ok,
            errorCode: result.ok ? null : result.error.code,
            errorMessage: result.ok ? null : result.error.message,
          })
          .onConflictDoUpdate({
            target: channelModelReads.channelId,
            set: {
              attemptedAt: now,
              ok: result.ok,
              errorCode: result.ok ? null : result.error.code,
              errorMessage: result.ok ? null : result.error.message,
            },
            setWhere: sql`${channelModelReads.attemptedAt} <= excluded.attempted_at`,
          })
          .returning({ channelId: channelModelReads.channelId });
        if (written.length === 0 || !result.ok) return;
        for (const modelKey of result.models) {
          await tx
            .insert(channelSeenModels)
            .values({ channelId: result.channelId, modelKey, firstSeenAt: now, lastSeenAt: now })
            .onConflictDoUpdate({
              target: [channelSeenModels.channelId, channelSeenModels.modelKey],
              set: { lastSeenAt: now },
            });
        }
        await discoverChannelModels(tx, result.channelId, result.models, now);
      });
    } catch (err) {
      unstored.push({ channelId: result.channelId, error: errMessage(err) });
    }
  }
  return { unstored };
}

export interface ModelRosterDiff {
  missingFromCatalog: {
    channelId: string;
    channelName: string;
    modelKey: string;
    firstSeenAt: string;
    lastSeenAt: string;
  }[];
  goneRoutes: {
    channelId: string;
    channelName: string;
    routeId: string;
    modelId: string;
    /** 目录写的上游串；别名顶上；都没写就是空串（页面说目录没写上游串，不当成对得上）。 */
    upstreamModel: string;
  }[];
  failed: { channelId: string; channelName: string; code: string; message: string }[];
  notYet: { channelId: string; channelName: string }[];
}

interface DiffRoute {
  routeId: string;
  modelId: string;
  upstreamModel: string | null;
  upstreamAliases: readonly string[];
  /** 已经标了「渠道已下架」的不再列进消失：标本身就是那次入库记下的。 */
  goneAt: Date | null;
}

export interface DiffChannel {
  channelId: string;
  channelName: string;
  read: { ok: true } | { ok: false; code: string; message: string } | null;
  /** 只在最近一次读成、且 last_seen 对得上那次时才有。读失败、没读过不要拿旧名单来填。 */
  models: readonly { modelKey: string; firstSeenAt: Date; lastSeenAt: Date }[];
  routes: readonly DiffRoute[];
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (!t) return '没有写原因';
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function catalogStrings(route: DiffRoute): string[] {
  const out: string[] = [];
  const upstream = route.upstreamModel?.trim() ?? '';
  if (upstream) out.push(upstream);
  for (const alias of route.upstreamAliases) {
    const text = alias.trim();
    if (text) out.push(text);
  }
  return out;
}

/** 原样相等才算目录里有。方括号、大小写都不归一。上游串和别名都空的路由算对不上。 */
export function diffChannelModels(rows: readonly DiffChannel[]): ModelRosterDiff {
  const diff: ModelRosterDiff = { missingFromCatalog: [], goneRoutes: [], failed: [], notYet: [] };
  for (const row of rows) {
    const channelName = row.channelName.trim() || row.channelId;
    if (row.read === null) {
      diff.notYet.push({ channelId: row.channelId, channelName });
      continue;
    }
    if (!row.read.ok) {
      diff.failed.push({
        channelId: row.channelId,
        channelName,
        code: clip(row.read.code, 80),
        message: clip(row.read.message, 1500),
      });
      continue;
    }
    const known = new Set<string>();
    for (const route of row.routes) for (const key of catalogStrings(route)) known.add(key);
    const seen = new Set(row.models.map((m) => m.modelKey));
    const models = [...row.models].sort((a, b) =>
      a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0,
    );
    for (const model of models) {
      if (known.has(model.modelKey)) continue;
      diff.missingFromCatalog.push({
        channelId: row.channelId,
        channelName,
        modelKey: model.modelKey,
        firstSeenAt: model.firstSeenAt.toISOString(),
        lastSeenAt: model.lastSeenAt.toISOString(),
      });
    }
    const gone = [...row.routes].sort((a, b) => (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0));
    for (const route of gone) {
      if (route.goneAt) continue;
      const keys = catalogStrings(route);
      if (keys.length > 0 && keys.some((key) => seen.has(key))) continue;
      const upstream = route.upstreamModel?.trim() ?? '';
      const aliases = route.upstreamAliases.map((a) => a.trim()).filter(Boolean);
      diff.goneRoutes.push({
        channelId: row.channelId,
        channelName,
        routeId: route.routeId,
        modelId: route.modelId,
        upstreamModel: upstream || aliases.join('、'),
      });
    }
  }
  return diff;
}

/** 跟目录比。只比这四个渠道；别的渠道（jev）不在这张表的范围里。 */
export async function channelModelDiff(db: Db): Promise<ModelRosterDiff> {
  const ids = MODEL_ROSTER_CHANNELS.map((c) => c.channelId);
  const [nameRows, readRows, seenRows, routeRows] = await Promise.all([
    db.select({ id: channels.id, name: channels.name }).from(channels).where(inArray(channels.id, ids)),
    db.select().from(channelModelReads).where(inArray(channelModelReads.channelId, ids)),
    db
      .select({
        channelId: channelSeenModels.channelId,
        modelKey: channelSeenModels.modelKey,
        firstSeenAt: channelSeenModels.firstSeenAt,
        lastSeenAt: channelSeenModels.lastSeenAt,
      })
      .from(channelSeenModels)
      .innerJoin(
        channelModelReads,
        and(
          eq(channelSeenModels.channelId, channelModelReads.channelId),
          eq(channelSeenModels.lastSeenAt, channelModelReads.attemptedAt),
          eq(channelModelReads.ok, true),
        ),
      )
      .where(inArray(channelSeenModels.channelId, ids)),
    db
      .select({
        id: routes.id,
        channelId: routes.channelId,
        modelId: routes.modelId,
        upstreamModel: routes.upstreamModel,
        upstreamAliases: routes.upstreamAliases,
        goneAt: routes.goneAt,
      })
      .from(routes)
      .where(inArray(routes.channelId, ids)),
  ]);
  const names = new Map(nameRows.map((r) => [r.id, r.name]));
  const reads = new Map(readRows.map((r) => [r.channelId, r]));
  const models = new Map<string, DiffChannel['models'][number][]>();
  for (const row of seenRows) {
    const list = models.get(row.channelId) ?? [];
    list.push(row);
    models.set(row.channelId, list);
  }
  const byChannel = new Map<string, DiffRoute[]>();
  for (const row of routeRows) {
    const list = byChannel.get(row.channelId) ?? [];
    list.push({
      routeId: row.id,
      modelId: row.modelId,
      upstreamModel: row.upstreamModel,
      upstreamAliases: row.upstreamAliases ?? [],
      goneAt: row.goneAt,
    });
    byChannel.set(row.channelId, list);
  }
  return diffChannelModels(
    MODEL_ROSTER_CHANNELS.map((c) => {
      const read = reads.get(c.channelId);
      return {
        channelId: c.channelId,
        channelName: names.get(c.channelId) ?? c.channelId,
        read: read
          ? read.ok
            ? { ok: true }
            : { ok: false, code: read.errorCode ?? '', message: read.errorMessage ?? '' }
          : null,
        models: read?.ok ? (models.get(c.channelId) ?? []) : [],
        routes: read?.ok ? (byChannel.get(c.channelId) ?? []) : [],
      };
    }),
  );
}
