// 外部看门狗（#292 第 3 片）来查 /healthz：请求头 x-fleet-watch 和配置 FLEET_EDGE_WATCH_ID 一致，
// 才给登记表 external-watchdog 记一轮成功。编号对不上、头缺失：不记，响应和没这回事一样。
// 没配、空的、只有空白：不启用（和引擎登记那半同一个判法），不记、不报错，健康页这一项写「未接」。
// 编号不进响应：/healthz 公网打得到。记不上（登记行还没有、库写失败）也不能把这一次打成 500——
// 外部看门狗把不是 200/503 的回应当成法国挂了。
import { timingSafeEqual } from 'node:crypto';
import { type Db, finishScheduleRun, startScheduleRun } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { readEdgeWatchId } from './config.ts';
import type { HealthCheck, Logger } from './ports.ts';

/** 健康页上的项名。没配时 status 是 not_wired，页面写「未接」，不是一条普通的 ok。 */
export const EXTERNAL_WATCH_CHECK = 'external_watchdog';
/** 登记表上的那一行（第 2 片写入）。一轮记在 schedule_runs，外键挂这行。 */
export const EXTERNAL_WATCH_JOB_ID = 'external-watchdog';
/** 没配编号时对外那句话（公网看得到，不带配置键的名字和值）。 */
export const EXTERNAL_WATCH_NOT_WIRED = '没配外部看门狗（#292）';

export const WATCH_HEADER = 'x-fleet-watch';

export function externalWatchHealthItem(watchId: string | null): HealthCheck {
  if (readEdgeWatchId(watchId) === null) {
    return {
      name: EXTERNAL_WATCH_CHECK,
      check: async () => {},
      notWired: EXTERNAL_WATCH_NOT_WIRED,
    };
  }
  return { name: EXTERNAL_WATCH_CHECK, check: async () => {} };
}

function headerMatches(header: string | undefined, watchId: string): boolean {
  if (header === undefined) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(watchId);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/**
 * 记一轮成功。scanned 必须大于 0 才能写成 ok：来查了这一次，没有要报的问题。
 * 登记行不在（引擎还没登记）或写库失败时抛错，调用方接住，不改 /healthz 的响应。
 */
export async function recordExternalWatchRound(db: Db, at: Date = new Date()): Promise<void> {
  const id = await startScheduleRun(db, EXTERNAL_WATCH_JOB_ID, at);
  await finishScheduleRun(db, id, { outcome: 'ok', scanned: 1, found: 0 }, at);
}

/** 头和编号一致就记一轮。没启用、对不上、没有记的入口：什么都不做。记失败只写日志。 */
export async function noteExternalWatch(input: {
  watchId: string | null;
  header: string | undefined;
  record: (() => Promise<void>) | undefined;
  log: Logger;
}): Promise<void> {
  const watchId = readEdgeWatchId(input.watchId);
  if (watchId === null || input.record === undefined) return;
  if (!headerMatches(input.header, watchId)) return;
  try {
    await input.record();
  } catch (err) {
    input.log.warn('外部看门狗这一轮没记上', { error: errMessage(err) });
  }
}
