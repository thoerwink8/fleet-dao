// 驾驶舱路由页的「动手战绩」：和选路读的 modelTierTracks 同一份（近 14 天、只算第一段、按档）。
// 下界用 shared 的 tierQuality，和引擎 rank.ts 同一份算法、同一个先验强度。读不到抛，接口写明没读成，不拿空表冒充都没战绩。
import { type Db, type ModelTierTrack, modelTierTracks } from '@fleet-dao/db';
import {
  type ManualTrackRowSchema,
  type Model,
  type SegmentTier,
  TRACK_PRIOR_TASKS,
  tierQuality,
} from '@fleet-dao/shared';
import type { z } from 'zod';

/** 和引擎选路读动手战绩的窗口一样（store-ports 的 RECORD_DAYS）。 */
const TRACK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ManualTracksPort {
  read(now: Date): Promise<ModelTierTrack[]>;
}

export function pgManualTracks(db: Db): ManualTracksPort {
  return {
    read: (now) => modelTierTracks(db, new Date(now.getTime() - TRACK_DAYS * DAY_MS)),
  };
}

export type ManualTrackRow = z.input<typeof ManualTrackRowSchema>;

/** 换成驾驶舱的一行：名字从模型目录查，查不到就写编号。下界按这一档全部模型一起收缩。 */
export function manualTracksView(
  tracks: readonly ModelTierTrack[],
  models: readonly Model[],
): ManualTrackRow[] {
  const names = new Map(models.map((m) => [m.id, m.displayName]));
  const groups = new Map<SegmentTier, ModelTierTrack[]>();
  for (const t of tracks) {
    const list = groups.get(t.tier) ?? [];
    list.push(t);
    groups.set(t.tier, list);
  }
  const lowerOf = new Map<string, number>();
  for (const [tier, rows] of groups) {
    let pass = 0;
    let total = 0;
    for (const r of rows) {
      pass += r.onePass;
      total += r.firstSegs;
    }
    const average = total > 0 ? pass / total : 0;
    for (const r of rows) {
      if (r.firstSegs <= 0) continue;
      lowerOf.set(`${r.modelId}\0${tier}`, tierQuality(r.onePass, r.firstSegs, average, TRACK_PRIOR_TASKS));
    }
  }
  return tracks.flatMap((r) => {
    const lower = lowerOf.get(`${r.modelId}\0${r.tier}`);
    if (lower === undefined || r.firstSegs <= 0) return [];
    return [
      {
        modelId: r.modelId,
        modelName: names.get(r.modelId) ?? r.modelId,
        tier: r.tier,
        onePass: r.onePass,
        tasks: r.firstSegs,
        lower,
        notDone: r.notDone,
        avgMinutes: r.minutes / r.firstSegs,
      },
    ];
  });
}
