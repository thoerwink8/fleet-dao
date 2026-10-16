// 提醒推飞书（决定 0090「飞书只留登录和手机通知」）：驾驶舱后端每半分钟把该推的提醒用飞书应用机器人发进团队群，
// 每条推的结局记进 notification_deliveries（去处 feishu / team，拿到 message_id 才算送到）。
// 2026-10-05 #1022 删旧飞书流程时把「推送 outbox → 网关发卡 → 回执写送达记录」整条删了、没有接替，推送断了 9 天没人发现；
// 这里是接替，看门狗（引擎 jobs/watchdog-push.ts）和指挥官巡检按同一份判据看它通不通。
// 改这里之前必须知道：
// - 推送分级是白名单（创始人规矩：只为要人动手的事打扰他）。该推的（pushable）：没处理、24 小时内建的，而且键或级别在这份名单里：
//   ① 要你拍（decision）、每日简报（feishu:brief:）、推送测试（feishu:test:）：马上推；
//   ② 主线红（feishu:main-red:）：开满 FEISHU_MAIN_RED_ESCALATE_MS（60 分钟）还没撤才推；
//   ③ 任务挂起（task:…:park:）、deploy-lag:、auto-release:、watchdog:healthz:、watchdog:release:、github-app:、reconcile:pr:：
//     开满 FEISHU_PUSH_ESCALATE_MS（120 分钟）还没撤才推。
//   其余一律不推（含 watchdog:job:、watchdog:red:、quota-read:、reconcile:quota:、再提醒 remind:、主线已恢复、日报）。
//   以前是「alert 默认推，再一条条列例外」，每出一类新报警就多一次误推。
// - 一条只推一次：送到了不再推（重开的报警不重推）。没送成的按 2、4、8、16 分钟退避再试，试满 5 次不再试（留着没送到，看门狗报）。
//   开满多久按 created_at 算：同一个键撤了又重开，created_at 不变，重开那一刻若已过线、之前又没推过，会马上推（反复冒出来不算自愈）。
// - 看门狗判「推送不通」用 feishuPushFacts：有该推的过了 1 小时还没送到，而且这 1 小时里一条都没送成；或者后端记下的推送状态是「没配」。
// - 推送状态（设置表 feishu.push）由后端写：configured=false 时 why 写清缺什么。没这一行 = 后端还没跑过推送（不单独当成坏了）。
// - 指挥官巡检（agents/skills/commander/scripts/patrol-lib.mjs 的 PUSHABLE_SINCE）照这里写了一份 SQL，改判法两边一起改。
import { and, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { notificationDeliveries, notifications, settings } from '../schema/index.ts';

export const FEISHU_PUSH_CHANNEL = 'feishu';
export const FEISHU_PUSH_TARGET = 'team';
/** 只推这么久以内建的（推送断了很久再接上，不把几天前的旧事一股脑推出去）。 */
export const FEISHU_PUSH_WINDOW_MS = 24 * 60 * 60_000;
/**
 * 卡住报警开着满这么久还没撤（没自愈）才推。为什么是 120 分钟（#2212，法国 2026-10-08～15 七天的卡住报警回放）：
 * - 先修了让报警晚撤、误报的根：挂起解除、接着干了当场撤（以前等每小时对账）；刚推完就验读到旧头不再判「头被别人改了」；
 *   引擎自己开自己合的数据 PR 不再报「没经合并队列」；降智探测不推。按修后的撤法回放，开满 60 分钟没撤的从 51 条降到 33 条。
 * - 剩下的几乎都是停下等人的挂起。指挥官接手的那些（14 天 60 次点继续、放弃、重做）是两团：45 次在 60 分钟内，
 *   4 次在 60～120 分钟，11 次过了 120 分钟（多是夜里没人在）。修后开满 60～120 分钟才撤的 14 条里，12 条是指挥官或系统
 *   自己收的（点继续、放弃、单关了、定时任务自己好了），1 条创始人自己在驾驶舱点了继续，1 条回放时还开着；过了 120 分钟
 *   还开着的，才多半是没人在管、要人看的。
 * - 回放：60 分钟每天约 4.7 条、90 分钟约 3.3 条、120 分钟约 2.7 条（19 条）、180 分钟约 2.3 条。真没人管的报警晚推一小时，
 *   这几条本来就要开好几个小时，晚一小时不改它们的结局。
 */
export const FEISHU_PUSH_ESCALATE_MS = 120 * 60_000;
/**
 * 主线红开着满这么久还没撤（没转绿）才推。主线红挡住所有合并，又没有历史数据（#2208 才开始记），留在 60 分钟，不跟卡住报警一起放宽。
 */
export const FEISHU_MAIN_RED_ESCALATE_MS = 60 * 60_000;
/** 一条最多试几次。 */
export const FEISHU_PUSH_MAX_ATTEMPTS = 5;
/** 该推的过了这么久还没送到、这段时间里一条都没送成：推送不通。 */
export const FEISHU_PUSH_STALE_MS = 60 * 60_000;
/** 每日简报（引擎 jobs/daily-brief.ts，每天一条）：feishu:brief:<北京日期>，马上推。 */
export const FEISHU_BRIEF_KEY_PREFIX = 'feishu:brief:';
/** 推送测试（fleet-api feishu-push test 建的）：feishu:test:<时刻>，马上推。 */
export const FEISHU_TEST_KEY_PREFIX = 'feishu:test:';
/** 主线红（引擎 jobs/main-red-push.ts）：开满 FEISHU_MAIN_RED_ESCALATE_MS 没撤才推；主线转绿时引擎把开着的都撤掉。 */
export const FEISHU_MAIN_RED_KEY_PREFIX = 'feishu:main-red:';
/** 再提醒的键前缀。不再生成（迁移 0074 把开着的标已撤）；简报读卡住报警时仍排除，免得迁移前混进去。 */
export const REMIND_KEY_PREFIX = 'remind:';
/**
 * 开满 120 分钟才推的键前缀。任务挂起不在这列：键是 task:<仓>#<号>:park:<n>，用 feishuTaskParkKey 认。
 * 和下面 SQL 的 starts_with 是同一份名单。
 */
export const FEISHU_ESCALATE_KEY_PREFIXES = [
  'deploy-lag:',
  'auto-release:',
  'watchdog:healthz:',
  'watchdog:release:',
  'github-app:',
  'reconcile:pr:',
] as const;

/** 任务挂起（要人点继续）：task:…:park:。旧的 req:/sub: 挂起不在白名单里。 */
export function feishuTaskParkKey(dedupeKey: string): boolean {
  return dedupeKey.startsWith('task:') && dedupeKey.includes(':park:');
}
/** 后端记推送状态的设置行。 */
export const FEISHU_PUSH_SETTING = 'feishu.push';

/** 第 n 次没送成之后等多久再试：2、4、8、16 分钟。 */
export function feishuPushBackoffMs(attempts: number): number {
  return 2 ** Math.max(1, Math.min(attempts, 4)) * 60_000;
}

/**
 * 这条提醒从什么时候起该推了（不该推回 null）。纯函数，查询里的 SQL 和它一个判法（白名单）。
 */
export function feishuPushableSince(n: {
  level: 'decision' | 'alert' | 'daily';
  dedupeKey: string;
  createdAt: Date;
}): Date | null {
  const after = (ms: number) => new Date(n.createdAt.getTime() + ms);
  if (n.dedupeKey.startsWith(FEISHU_BRIEF_KEY_PREFIX) || n.dedupeKey.startsWith(FEISHU_TEST_KEY_PREFIX))
    return n.createdAt;
  if (n.level === 'decision') return n.createdAt;
  if (n.dedupeKey.startsWith(FEISHU_MAIN_RED_KEY_PREFIX)) return after(FEISHU_MAIN_RED_ESCALATE_MS);
  if (feishuTaskParkKey(n.dedupeKey) || FEISHU_ESCALATE_KEY_PREFIXES.some((p) => n.dedupeKey.startsWith(p)))
    return after(FEISHU_PUSH_ESCALATE_MS);
  return null;
}

const escalateInterval = `${FEISHU_PUSH_ESCALATE_MS / 1000} seconds`;
const mainRedInterval = `${FEISHU_MAIN_RED_ESCALATE_MS / 1000} seconds`;

/** SQL 版的「从什么时候起该推」（不该推是 null），和 feishuPushableSince 一个判法。前缀名单就是 FEISHU_ESCALATE_KEY_PREFIXES。 */
const escalateKeySql = sql.join(
  FEISHU_ESCALATE_KEY_PREFIXES.map((p) => sql`starts_with(${notifications.dedupeKey}, ${p})`),
  sql` or `,
);
const pushableSince = sql<Date | null>`case
  when starts_with(${notifications.dedupeKey}, ${FEISHU_BRIEF_KEY_PREFIX}) or starts_with(${notifications.dedupeKey}, ${FEISHU_TEST_KEY_PREFIX}) then ${notifications.createdAt}
  when ${notifications.level} = 'decision' then ${notifications.createdAt}
  when starts_with(${notifications.dedupeKey}, ${FEISHU_MAIN_RED_KEY_PREFIX}) then ${notifications.createdAt} + ${mainRedInterval}::interval
  when (starts_with(${notifications.dedupeKey}, 'task:') and ${notifications.dedupeKey} like '%:park:%') or ${escalateKeySql} then ${notifications.createdAt} + ${escalateInterval}::interval
  else null end`;

export interface FeishuPushItem {
  id: string;
  level: 'decision' | 'alert' | 'daily';
  dedupeKey: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: Date;
  /** 之前试过几次（没试过是 0）。 */
  attempts: number;
}

const deliveryJoin = and(
  eq(notificationDeliveries.notificationId, notifications.id),
  eq(notificationDeliveries.channel, FEISHU_PUSH_CHANNEL),
  eq(notificationDeliveries.target, FEISHU_PUSH_TARGET),
);

/**
 * 这一轮要推的：该推、到点了、没送到过、没试满、过了退避。老的在前，最多 limit 条。
 */
export async function pendingFeishuPushes(db: Db, now: Date, limit: number): Promise<FeishuPushItem[]> {
  const since = new Date(now.getTime() - FEISHU_PUSH_WINDOW_MS);
  const rows = await db
    .select({
      id: notifications.id,
      level: notifications.level,
      dedupeKey: notifications.dedupeKey,
      title: notifications.title,
      body: notifications.body,
      link: notifications.link,
      createdAt: notifications.createdAt,
      attempts: sql<number>`coalesce(${notificationDeliveries.attempts}, 0)`,
      lastAttemptAt: notificationDeliveries.lastAttemptAt,
    })
    .from(notifications)
    .leftJoin(notificationDeliveries, deliveryJoin)
    .where(
      and(
        isNull(notifications.resolvedAt),
        gte(notifications.createdAt, since),
        isNull(notificationDeliveries.deliveredAt),
        sql`${pushableSince} is not null and ${pushableSince} <= ${now.toISOString()}::timestamptz`,
        sql`coalesce(${notificationDeliveries.attempts}, 0) < ${FEISHU_PUSH_MAX_ATTEMPTS}`,
      ),
    )
    .orderBy(notifications.createdAt, notifications.id)
    .limit(limit * 4);
  const out: FeishuPushItem[] = [];
  for (const r of rows) {
    const attempts = Number(r.attempts);
    if (attempts > 0 && r.lastAttemptAt) {
      if (r.lastAttemptAt.getTime() + feishuPushBackoffMs(attempts) > now.getTime()) continue;
    }
    out.push({
      id: r.id,
      level: r.level,
      dedupeKey: r.dedupeKey,
      title: r.title,
      body: r.body,
      link: r.link,
      createdAt: r.createdAt,
      attempts,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 记一次推的结局：送到了写 message_id 和送到时刻；没送成写原因。次数加 1。 */
export async function recordFeishuDelivery(
  db: Db,
  input: { notificationId: string; at: Date } & ({ messageId: string } | { error: string }),
): Promise<void> {
  const messageId = 'messageId' in input ? input.messageId : null;
  const lastError = 'error' in input ? input.error.slice(0, 500) : null;
  await db
    .insert(notificationDeliveries)
    .values({
      notificationId: input.notificationId,
      channel: FEISHU_PUSH_CHANNEL,
      target: FEISHU_PUSH_TARGET,
      messageId,
      attempts: 1,
      lastError,
      lastAttemptAt: input.at,
      deliveredAt: messageId === null ? null : input.at,
    })
    .onConflictDoUpdate({
      target: [
        notificationDeliveries.notificationId,
        notificationDeliveries.channel,
        notificationDeliveries.target,
      ],
      set: {
        ...(messageId === null ? {} : { messageId, deliveredAt: input.at }),
        attempts: sql`${notificationDeliveries.attempts} + 1`,
        lastError,
        lastAttemptAt: input.at,
      },
    });
}

/** 后端记下的推送状态。 */
export interface FeishuPushStatus {
  configured: boolean;
  /** 没配时缺什么、为什么；配好了是 null。 */
  why: string | null;
  at: Date;
}

/** 读推送状态；没这一行回 null。形状认不出照抛（不当成配好了）。 */
export async function readFeishuPushStatus(db: Db): Promise<FeishuPushStatus | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, FEISHU_PUSH_SETTING));
  if (!row) return null;
  const v = row.value as { configured?: unknown; why?: unknown; at?: unknown } | null;
  const at = typeof v?.at === 'string' ? new Date(v.at) : null;
  if (
    typeof v?.configured !== 'boolean' ||
    !(v.why === null || typeof v.why === 'string') ||
    at === null ||
    Number.isNaN(at.getTime())
  ) {
    throw new Error(
      `设置 ${FEISHU_PUSH_SETTING} 的值认不出（要 {configured: 真假, why: 文字或 null, at: 时间}）：${JSON.stringify(row.value)}`,
    );
  }
  return { configured: v.configured, why: v.why as string | null, at };
}

/** 写推送状态（有就换、没有就建）。 */
export async function writeFeishuPushStatus(db: Db, status: FeishuPushStatus): Promise<void> {
  const value = { configured: status.configured, why: status.why, at: status.at.toISOString() };
  await db
    .insert(settings)
    .values({ key: FEISHU_PUSH_SETTING, value, updatedBy: 'api:feishu-push' })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value,
        version: sql`${settings.version} + 1`,
        updatedAt: status.at,
        updatedBy: 'api:feishu-push',
      },
    });
}

/** 看门狗判推送通不通要的事实。 */
export interface FeishuPushFacts {
  status: FeishuPushStatus | null;
  /** 该推、到点超过 1 小时、还没送到的里最老的那条；没有是 null。 */
  stale: { id: string; title: string; since: Date; attempts: number; lastError: string | null } | null;
  /** 该推还没送到的一共几条（不管到点多久）。 */
  undelivered: number;
  /** 最近一次送到的时刻；从没送到过是 null。 */
  lastDeliveredAt: Date | null;
}

export async function feishuPushFacts(db: Db, now: Date): Promise<FeishuPushFacts> {
  const since = new Date(now.getTime() - FEISHU_PUSH_WINDOW_MS);
  const staleBefore = new Date(now.getTime() - FEISHU_PUSH_STALE_MS);
  const [status, waiting, [last]] = await Promise.all([
    readFeishuPushStatus(db),
    db
      .select({
        id: notifications.id,
        title: notifications.title,
        since: sql<Date>`${pushableSince}`.mapWith(notifications.createdAt),
        attempts: sql<number>`coalesce(${notificationDeliveries.attempts}, 0)`,
        lastError: notificationDeliveries.lastError,
      })
      .from(notifications)
      .leftJoin(notificationDeliveries, deliveryJoin)
      .where(
        and(
          isNull(notifications.resolvedAt),
          gte(notifications.createdAt, since),
          isNull(notificationDeliveries.deliveredAt),
          sql`${pushableSince} is not null and ${pushableSince} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(sql`${pushableSince}`, notifications.id),
    db
      .select({
        at: sql<Date | null>`max(${notificationDeliveries.deliveredAt})`.mapWith(
          notificationDeliveries.deliveredAt,
        ),
      })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.channel, FEISHU_PUSH_CHANNEL),
          isNotNull(notificationDeliveries.deliveredAt),
        ),
      ),
  ]);
  const oldest = waiting[0];
  const stale =
    oldest && oldest.since.getTime() <= staleBefore.getTime()
      ? {
          id: oldest.id,
          title: oldest.title,
          since: oldest.since,
          attempts: Number(oldest.attempts),
          lastError: oldest.lastError,
        }
      : null;
  return { status, stale, undelivered: waiting.length, lastDeliveredAt: last?.at ?? null };
}

/**
 * 推送不通的判法（看门狗和指挥官巡检同一份；巡检脚本在仓外跑不了这里的代码，它的 SQL 照这里写）：
 * 后端记下「没配」；或者有该推的到点超过 1 小时没送到、而且最近 1 小时一条都没送成。回给人看的一句话，通着回 null。
 */
export function feishuPushProblem(f: FeishuPushFacts, now: Date): string | null {
  if (f.status && !f.status.configured) return `飞书推送没配：${f.status.why ?? '后端没说缺什么'}`;
  if (!f.stale) return null;
  if (f.lastDeliveredAt && f.lastDeliveredAt.getTime() > now.getTime() - FEISHU_PUSH_STALE_MS) return null;
  return `飞书推送不通：${f.undelivered} 条该推的没送到，最老的一条「${f.stale.title}」从 ${f.stale.since.toISOString()} 起就该推（试了 ${f.stale.attempts} 次${f.stale.lastError ? `，最近一次没送成：${f.stale.lastError}` : '，一次都没试过'}）；${f.lastDeliveredAt ? `最近一次送到是 ${f.lastDeliveredAt.toISOString()}` : '从没送到过'}`;
}
