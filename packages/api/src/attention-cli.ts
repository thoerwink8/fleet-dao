// fleet-api attention --json（#2370）：引擎自己出一份「现在要人看的事」的结论，指挥官本机巡检（agents/skills/commander/scripts/patrol-lib.mjs）只读它，
// 不再自己抄一套判法。只读，不写库、不发消息。输出一行 JSON：
//   { ok: true, at, healthz: { code, red }, notes: [{ key, level, title, since, delivered }], feishuPushProblem, dailyBriefProblem, localOrphans, runningIdle }
// 改这里之前必须知道：
// - healthz：本机问一次驾驶舱的 /healthz（地址取 api.env 的 FLEET_COCKPIT_LISTEN）。code 0 = 连不上；red 是 ok:false 的检查名。
// - notes：开着、而且按推送白名单该推的通知（到点了的）。白名单判法不在这里抄：用 @fleet-dao/db 的 feishuPushableSince（feishu-push.ts），
//   「主线已恢复」要的「之前真推出去过主线红」由这里查送达记录喂给它。delivered 是飞书团队群那条送达记录有没有送到。
// - feishuPushProblem、dailyBriefProblem：就是 @fleet-dao/db 的 feishuPushProblem、dailyBriefProblem 的结论（通着、好着是 null）。
// - localOrphans：每小时对账写在设置表里的「贴了本机做超过 24 小时、又没有本机租约」的单。这里不另判，读到什么就是什么。
//   还没写过这一行是空数组。写过、形状认不出照抛（退出码 1），不拿空数组顶。
// - runningIdle：即时 running/engine 原条件；完整任务/会话计数由 listRunningEngineTasks 读，唯一判据是 core/isIdleRunningStale。
//   与按时点/白名单推送的 notes 口径不同；不扫 Temporal，不从展示列表或 heartbeat 推断恢复。
// - 读不到就报没读成（ok:false，退出码 1），不拿空列表、null 顶。参数不对退出码 2。
import { isIdleRunningStale } from '@fleet-dao/core/idle-running';
import {
  beijingDay,
  commanderStalledSummary,
  type Db,
  dailyBriefProblem,
  dailyBriefStatus,
  FEISHU_MAIN_RECOVERED_KEY_PREFIX,
  FEISHU_MAIN_RED_KEY_PREFIX,
  FEISHU_PUSH_CHANNEL,
  FEISHU_PUSH_TARGET,
  FEISHU_PUSH_WINDOW_MS,
  feishuPushableSince,
  feishuPushFacts,
  feishuPushProblem,
  type LocalOrphan,
  listRunningEngineTasks,
  notificationDeliveries,
  notifications,
  readLocalOrphans,
} from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { and, eq, gte, isNotNull, isNull, like } from 'drizzle-orm';

export const ATTENTION_USAGE =
  '用法：fleet-api attention --json（只读：healthz 状态码和红的项、开着且按推送白名单该推的通知、飞书推送不通的话、今天每日简报没送到的话、贴了「本机做」超过 24 小时还没人领的单；打一行 JSON）';

export class AttentionCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'AttentionCliError';
    this.exitCode = exitCode;
  }
}

export function parseAttentionArgs(argv: readonly string[]): void {
  if (argv.length !== 1 || argv[0] !== '--json')
    throw new AttentionCliError(`只认 --json。${ATTENTION_USAGE}`);
}

export interface AttentionNote {
  key: string;
  level: 'decision' | 'alert' | 'daily';
  title: string;
  /** 从什么时候起该推（ISO）。 */
  since: string;
  delivered: boolean;
}

export interface Attention {
  ok: true;
  at: string;
  healthz: { code: number; red: string[] };
  notes: AttentionNote[];
  feishuPushProblem: string | null;
  dailyBriefProblem: string | null;
  /** 对账写下的没人领的「本机做」。空数组是没有，或对账还没写过。 */
  localOrphans: LocalOrphan[];
  /** 即时原条件；不等于推送白名单里的通知，也不受展示 runs 的条数限制。 */
  runningIdle: Awaited<ReturnType<typeof runningIdleFacts>>;
  /** 当前仍停着的任务：指挥官已经认领的和还留给人的。 */
  commander: Awaited<ReturnType<typeof commanderStalledSummary>>;
}

export async function runningIdleFacts(db: Db, at: Date) {
  const rows = await listRunningEngineTasks(db);
  return {
    version: 1 as const,
    at: at.toISOString(),
    complete: true as const,
    rows: rows.map((row) => ({
      ...row,
      updatedAt: row.updatedAt?.toISOString() ?? null,
      stale: isIdleRunningStale({ ...row, state: 'running', executor: 'engine' }, at),
    })),
  };
}

/** 问一次 /healthz：回状态码（连不上是 0）和红的检查名。 */
export async function readHealthz(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ code: number; red: string[] }> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    let red: string[] = [];
    try {
      const body = (await res.json()) as { checks?: Record<string, { ok?: unknown }> };
      red = Object.entries(body.checks ?? {})
        .filter(([, c]) => c?.ok === false)
        .map(([name]) => name);
    } catch {
      // 回的不是健康报告：状态码照报，红的列表空
    }
    return { code: res.status, red };
  } catch {
    return { code: 0, red: [] };
  }
}

/** 开着、到点该推的通知（白名单判法用 feishuPushableSince）。 */
export async function pushableOpenNotes(db: Db, now: Date): Promise<AttentionNote[]> {
  const since = new Date(now.getTime() - FEISHU_PUSH_WINDOW_MS);
  const rows = await db
    .select({
      key: notifications.dedupeKey,
      level: notifications.level,
      title: notifications.title,
      createdAt: notifications.createdAt,
      deliveredAt: notificationDeliveries.deliveredAt,
    })
    .from(notifications)
    .leftJoin(
      notificationDeliveries,
      and(
        eq(notificationDeliveries.notificationId, notifications.id),
        eq(notificationDeliveries.channel, FEISHU_PUSH_CHANNEL),
        eq(notificationDeliveries.target, FEISHU_PUSH_TARGET),
      ),
    )
    .where(and(isNull(notifications.resolvedAt), gte(notifications.createdAt, since)))
    .orderBy(notifications.createdAt, notifications.id);
  // 主线已恢复：它之前 24 小时内有没有一条主线红真推出去了
  const reds = rows.some((r) => r.key.startsWith(FEISHU_MAIN_RECOVERED_KEY_PREFIX))
    ? await db
        .select({ createdAt: notifications.createdAt })
        .from(notifications)
        .innerJoin(
          notificationDeliveries,
          and(
            eq(notificationDeliveries.notificationId, notifications.id),
            eq(notificationDeliveries.channel, FEISHU_PUSH_CHANNEL),
            isNotNull(notificationDeliveries.deliveredAt),
          ),
        )
        .where(like(notifications.dedupeKey, `${FEISHU_MAIN_RED_KEY_PREFIX}%`))
    : [];
  const out: AttentionNote[] = [];
  for (const r of rows) {
    const redPushedBefore = reds.some(
      (red) =>
        red.createdAt.getTime() < r.createdAt.getTime() &&
        red.createdAt.getTime() >= r.createdAt.getTime() - FEISHU_PUSH_WINDOW_MS,
    );
    const due = feishuPushableSince({
      level: r.level,
      dedupeKey: r.key,
      createdAt: r.createdAt,
      redPushedBefore,
    });
    if (due === null || due.getTime() > now.getTime()) continue;
    out.push({
      key: r.key,
      level: r.level,
      title: r.title,
      since: due.toISOString(),
      delivered: r.deliveredAt !== null,
    });
  }
  return out;
}

export async function runAttention(deps: {
  db: Db;
  now: () => Date;
  healthz: () => Promise<{ code: number; red: string[] }>;
}): Promise<Attention> {
  const at = deps.now();
  const { day, start } = beijingDay(at);
  const [healthz, notes, pushFacts, briefStatus, localOrphans, runningIdle, commander] = await Promise.all([
    deps.healthz(),
    pushableOpenNotes(deps.db, at),
    feishuPushFacts(deps.db, at),
    dailyBriefStatus(deps.db, day, start),
    readLocalOrphans(deps.db),
    runningIdleFacts(deps.db, at),
    commanderStalledSummary(deps.db),
  ]);
  return {
    ok: true,
    at: at.toISOString(),
    healthz,
    notes,
    feishuPushProblem: feishuPushProblem(pushFacts, at),
    dailyBriefProblem: dailyBriefProblem(briefStatus, at),
    localOrphans,
    runningIdle,
    commander,
  };
}

/** cli.ts 调的入口：打一行 JSON，退出码 0 / 1（没读成）。 */
export async function attentionJson(deps: {
  db: Db;
  now: () => Date;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): Promise<{ code: number; text: string }> {
  const listen = deps.env.FLEET_COCKPIT_LISTEN;
  try {
    const result = await runAttention({
      db: deps.db,
      now: deps.now,
      healthz: async () =>
        listen ? readHealthz(`http://${listen}/healthz`, deps.fetch) : { code: 0, red: [] },
    });
    return { code: 0, text: JSON.stringify(result) };
  } catch (err) {
    return { code: 1, text: JSON.stringify({ ok: false, reason: 'error', why: errMessage(err) }) };
  }
}
