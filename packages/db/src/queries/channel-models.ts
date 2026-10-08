// 渠道模型名册（#1302）：只记、只比。不改目录，不派活。
// 最近一次读失败的渠道不拿更早的名单去报「新增 / 消失」：那会把没读成说成渠道里已经没有。
import { MIRASIM_EXECUTOR_UNKNOWN, resolveMirasimExecutor } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, channelModelReads, channelSeenModels, channels, routes } from '../schema/index.ts';

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
  { kind: 'claude', reader: 'claude-usage', channelId: 'claude-sub', manual: true },
] as const;

export type ModelRosterChannel = (typeof MODEL_ROSTER_CHANNELS)[number];

/** 没有只读名册命令、靠手工登记的渠道。额度任务不读它，差集也不拿「没读成」说它。 */
export function isManualRosterChannel(channelId: string): boolean {
  const row = MODEL_ROSTER_CHANNELS.find((c) => c.channelId === channelId);
  return row !== undefined && 'manual' in row && row.manual === true;
}

/** 到点要去读名册的渠道。手工登记的不在里面，免得它永远读不成、把另外几家每轮都拖去重读。 */
export function autoModelRosterChannels(): ModelRosterChannel[] {
  return MODEL_ROSTER_CHANNELS.filter((c) => !isManualRosterChannel(c.channelId));
}

/** 一次读的结果。空名单不算读成：调用方和写入方都会改写成失败。executors 是名册帧上的执行体。 */
export type ChannelModelReadInput =
  | {
      ok: true;
      channelId: string;
      models: readonly string[];
      executors?: readonly { modelKey: string; executor: string }[];
    }
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
  return {
    ok: true,
    channelId: input.channelId,
    models,
    ...(input.executors && input.executors.length > 0 ? { executors: input.executors } : {}),
  };
}

/** 有名册命令的渠道里有一个没读过、或最近一次尝试早于间隔，这一轮就读这些。手工登记的不算。一个都没列入时不当成到点。 */
export async function modelRosterDue(db: Db, now: Date, everyMs = MODEL_ROSTER_EVERY_MS): Promise<boolean> {
  const ids = autoModelRosterChannels().map((c) => c.channelId);
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
 * 每个渠道自己一笔事务。读成：名册里的模型 last_seen 盖成这一次，不在名册里的旧行留着。
 * 读失败：只盖「最近一次读」，不动见过的模型。比库里那次还早的结果整笔丢掉。
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
              // 来源不改：手工登记的串后来被自动读到，仍算手工。
              set: { lastSeenAt: now },
            });
        }
        if (isMirasimRoster(result.channelId)) await stampMirasimExecutors(tx, result);
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
  /** 没有名册命令、靠手工登记的渠道。不进 failed / notYet。 */
  manual: { channelId: string; channelName: string; count: number }[];
}

interface DiffRoute {
  routeId: string;
  modelId: string;
  upstreamModel: string | null;
  upstreamAliases: readonly string[];
}

export interface DiffChannel {
  channelId: string;
  channelName: string;
  read: { ok: true } | { ok: false; code: string; message: string } | null;
  /** 只在最近一次读成、且 last_seen 对得上那次时才有。读失败、没读过不要拿旧名单来填。 */
  models: readonly { modelKey: string; firstSeenAt: Date; lastSeenAt: Date }[];
  routes: readonly DiffRoute[];
  /** 给了就是手工登记渠道。0 个时不跟目录比（空的不算「渠道已经不认这些路由」）。 */
  manualCount?: number;
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
  const diff: ModelRosterDiff = {
    missingFromCatalog: [],
    goneRoutes: [],
    failed: [],
    notYet: [],
    manual: [],
  };
  for (const row of rows) {
    const channelName = row.channelName.trim() || row.channelId;
    if (row.manualCount !== undefined) {
      diff.manual.push({ channelId: row.channelId, channelName, count: row.manualCount });
      if (row.manualCount === 0) continue;
    }
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

/** 跟目录比。只比这四个渠道；别的渠道（jev）不在这张表的范围里。手工登记的渠道不看读记录。 */
export async function channelModelDiff(db: Db): Promise<ModelRosterDiff> {
  const ids = MODEL_ROSTER_CHANNELS.map((c) => c.channelId);
  const autoIds = autoModelRosterChannels().map((c) => c.channelId);
  const manualIds = ids.filter((id) => isManualRosterChannel(id));
  const [nameRows, readRows, seenRows, manualRows, routeRows] = await Promise.all([
    db.select({ id: channels.id, name: channels.name }).from(channels).where(inArray(channels.id, ids)),
    db.select().from(channelModelReads).where(inArray(channelModelReads.channelId, autoIds)),
    autoIds.length === 0
      ? Promise.resolve([])
      : db
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
          .where(inArray(channelSeenModels.channelId, autoIds)),
    manualIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            channelId: channelSeenModels.channelId,
            modelKey: channelSeenModels.modelKey,
            firstSeenAt: channelSeenModels.firstSeenAt,
            lastSeenAt: channelSeenModels.lastSeenAt,
          })
          .from(channelSeenModels)
          .where(and(inArray(channelSeenModels.channelId, manualIds), eq(channelSeenModels.source, '手工'))),
    db
      .select({
        id: routes.id,
        channelId: routes.channelId,
        modelId: routes.modelId,
        upstreamModel: routes.upstreamModel,
        upstreamAliases: routes.upstreamAliases,
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
  const manualModels = new Map<string, DiffChannel['models'][number][]>();
  for (const row of manualRows) {
    const list = manualModels.get(row.channelId) ?? [];
    list.push(row);
    manualModels.set(row.channelId, list);
  }
  const byChannel = new Map<string, DiffRoute[]>();
  for (const row of routeRows) {
    const list = byChannel.get(row.channelId) ?? [];
    list.push({
      routeId: row.id,
      modelId: row.modelId,
      upstreamModel: row.upstreamModel,
      upstreamAliases: row.upstreamAliases ?? [],
    });
    byChannel.set(row.channelId, list);
  }
  return diffChannelModels(
    MODEL_ROSTER_CHANNELS.map((c) => {
      const channelName = names.get(c.channelId) ?? c.channelId;
      if (isManualRosterChannel(c.channelId)) {
        const listed = manualModels.get(c.channelId) ?? [];
        return {
          channelId: c.channelId,
          channelName,
          read: { ok: true as const },
          models: listed,
          routes: listed.length > 0 ? (byChannel.get(c.channelId) ?? []) : [],
          manualCount: listed.length,
        };
      }
      const read = reads.get(c.channelId);
      return {
        channelId: c.channelId,
        channelName,
        read: read
          ? read.ok
            ? { ok: true as const }
            : { ok: false as const, code: read.errorCode ?? '', message: read.errorMessage ?? '' }
          : null,
        models: read?.ok ? (models.get(c.channelId) ?? []) : [],
        routes: read?.ok ? (byChannel.get(c.channelId) ?? []) : [],
      };
    }),
  );
}

function isMirasimRoster(channelId: string): boolean {
  return MODEL_ROSTER_CHANNELS.some((c) => c.channelId === channelId && c.kind === 'mirasim');
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** 读成的 Mirasim 名册盖到这个渠道每条路由的 executor。对不上的写下「执行体未知」，不留空去落到默认执行体。 */
async function stampMirasimExecutors(
  tx: Tx,
  result: Extract<ChannelModelReadInput, { ok: true }>,
): Promise<void> {
  const byKey = new Map<string, string>();
  for (const row of result.executors ?? []) {
    const key = row.modelKey.trim();
    const executor = row.executor.trim();
    if (!key || !executor || executor === MIRASIM_EXECUTOR_UNKNOWN || byKey.has(key)) continue;
    byKey.set(key, executor);
  }
  const routeRows = await tx
    .select({
      id: routes.id,
      modelId: routes.modelId,
      upstreamModel: routes.upstreamModel,
      upstreamAliases: routes.upstreamAliases,
    })
    .from(routes)
    .where(eq(routes.channelId, result.channelId));
  for (const route of routeRows) {
    const keys = catalogStrings({
      routeId: route.id,
      modelId: route.modelId,
      upstreamModel: route.upstreamModel,
      upstreamAliases: route.upstreamAliases ?? [],
    });
    let rosterExecutor: string | null = null;
    for (const key of keys) {
      const found = byKey.get(key);
      if (found) {
        rosterExecutor = found;
        break;
      }
    }
    const upstream = route.upstreamModel?.trim() || route.modelId;
    const resolved = resolveMirasimExecutor({ rosterExecutor, upstreamModel: upstream });
    await tx
      .update(routes)
      .set({ executor: resolved.ok ? resolved.agent : MIRASIM_EXECUTOR_UNKNOWN })
      .where(eq(routes.id, route.id));
  }
}

export type ManualModelCode =
  | 'empty_model'
  | 'channel_not_found'
  | 'not_manual'
  | 'already_registered'
  | 'not_registered'
  | 'not_hand';

export class ManualModelError extends Error {
  readonly code: ManualModelCode;
  constructor(code: ManualModelCode, message: string) {
    super(message);
    this.name = 'ManualModelError';
    this.code = code;
  }
}

export interface ManualModelInput {
  channelId: string;
  modelKey: string;
  now: Date;
  actorKind: 'user' | 'ai' | 'engine' | 'agent';
  actorId: string;
  via: 'cockpit' | 'feishu' | 'github' | 'engine' | 'agent';
  reason?: string;
}

export interface ManualModelView {
  channelId: string;
  modelKey: string;
  source: '手工';
  count: number;
}

const MANUAL_MODEL_TEXT: Record<ManualModelCode, string> = {
  empty_model: '模型串是空的',
  channel_not_found: '没有这个渠道',
  not_manual: '这个渠道有名册命令，不用手工登记',
  already_registered: '这个模型串已经登记过',
  not_registered: '没有这条手工登记',
  not_hand: '这条不是手工登记的，撤不了',
};

function manualModelKey(raw: string): string {
  const modelKey = raw.trim();
  if (!modelKey || modelKey.length > 2000)
    throw new ManualModelError('empty_model', MANUAL_MODEL_TEXT.empty_model);
  return modelKey;
}

function assertManualChannel(channelId: string): void {
  const known = MODEL_ROSTER_CHANNELS.some((c) => c.channelId === channelId);
  if (!known) throw new ManualModelError('channel_not_found', MANUAL_MODEL_TEXT.channel_not_found);
  if (!isManualRosterChannel(channelId)) {
    throw new ManualModelError('not_manual', MANUAL_MODEL_TEXT.not_manual);
  }
}

async function manualCount(tx: Tx, channelId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(channelSeenModels)
    .where(and(eq(channelSeenModels.channelId, channelId), eq(channelSeenModels.source, '手工')));
  return row?.n ?? 0;
}

/** 往没有名册命令的渠道登记一个模型串。已有的行（含自动读到的）算重复，不改、不记成功的操作记录。 */
export async function registerManualModel(db: Db, input: ManualModelInput): Promise<ManualModelView> {
  const modelKey = manualModelKey(input.modelKey);
  assertManualChannel(input.channelId);
  try {
    return await db.transaction(async (tx) => {
      const [channel] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, input.channelId));
      if (!channel) throw new ManualModelError('channel_not_found', MANUAL_MODEL_TEXT.channel_not_found);
      const existing = await tx
        .select({ modelKey: channelSeenModels.modelKey })
        .from(channelSeenModels)
        .where(
          and(eq(channelSeenModels.channelId, input.channelId), eq(channelSeenModels.modelKey, modelKey)),
        );
      if (existing.length > 0) {
        throw new ManualModelError('already_registered', MANUAL_MODEL_TEXT.already_registered);
      }
      await tx.insert(channelSeenModels).values({
        channelId: input.channelId,
        modelKey,
        source: '手工',
        firstSeenAt: input.now,
        lastSeenAt: input.now,
      });
      const count = await manualCount(tx, input.channelId);
      await tx.insert(auditLog).values({
        at: input.now,
        actorKind: input.actorKind,
        actorId: input.actorId,
        action: 'model-roster.register',
        target: `channel:${input.channelId}`,
        after: { channelId: input.channelId, modelKey, source: '手工', count },
        reason: input.reason?.trim() || null,
        via: input.via,
        ok: true,
      });
      return { channelId: input.channelId, modelKey, source: '手工' as const, count };
    });
  } catch (err) {
    if (err instanceof ManualModelError) throw err;
    if (errMessage(err).includes('channel_seen_models_pk')) {
      throw new ManualModelError('already_registered', MANUAL_MODEL_TEXT.already_registered);
    }
    throw err;
  }
}

/** 撤掉手工登记的那一行。不删目录里的路由。名册读到的行撤不了。 */
export async function revokeManualModel(db: Db, input: ManualModelInput): Promise<ManualModelView> {
  const modelKey = manualModelKey(input.modelKey);
  assertManualChannel(input.channelId);
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, input.channelId));
    if (!channel) throw new ManualModelError('channel_not_found', MANUAL_MODEL_TEXT.channel_not_found);
    const [existing] = await tx
      .select({ source: channelSeenModels.source })
      .from(channelSeenModels)
      .where(and(eq(channelSeenModels.channelId, input.channelId), eq(channelSeenModels.modelKey, modelKey)));
    if (!existing) throw new ManualModelError('not_registered', MANUAL_MODEL_TEXT.not_registered);
    if (existing.source !== '手工') throw new ManualModelError('not_hand', MANUAL_MODEL_TEXT.not_hand);
    await tx
      .delete(channelSeenModels)
      .where(and(eq(channelSeenModels.channelId, input.channelId), eq(channelSeenModels.modelKey, modelKey)));
    const count = await manualCount(tx, input.channelId);
    await tx.insert(auditLog).values({
      at: input.now,
      actorKind: input.actorKind,
      actorId: input.actorId,
      action: 'model-roster.revoke',
      target: `channel:${input.channelId}`,
      before: { channelId: input.channelId, modelKey, source: '手工' },
      after: { channelId: input.channelId, modelKey, source: '手工', count },
      reason: input.reason?.trim() || null,
      via: input.via,
      ok: true,
    });
    return { channelId: input.channelId, modelKey, source: '手工' as const, count };
  });
}
