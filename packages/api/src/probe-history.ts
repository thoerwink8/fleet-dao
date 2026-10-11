// 探针真历史（#1139）：渠道状态页读 route_probe_history。引擎开没开不影响这一页——读的是库。
// 老结论还没进历史表时先回填一条。读不到抛错，由接口写成「没查成」，不回空列表。
import { backfillProbeHistoryFromRoutes, type Db, readProbeHistoryJoined } from '@fleet-dao/db';
import { type ProbeHistoryCell, probeHistoryStrips } from '@fleet-dao/shared';

export interface ProbeHistoryPort {
  /** 全部还在的路由的探针历史（已回填老结论）。读不到抛错。 */
  read(): Promise<ProbeHistoryCell[]>;
}

export function pgProbeHistory(db: Db): ProbeHistoryPort {
  return {
    async read() {
      await backfillProbeHistoryFromRoutes(db);
      const rows = await readProbeHistoryJoined(db);
      return rows.map((row) => ({
        id: row.id,
        routeId: row.routeId,
        channelId: row.channelId,
        probedAt: row.probedAt.toISOString(),
        result: row.result,
        durationMs: row.durationMs,
        failureReason: row.failureReason,
        requestText: row.requestText,
        responseText: row.responseText,
        checkQuestion: row.checkQuestion,
        checkExpected: row.checkExpected,
        checkAnswer: row.checkAnswer,
        checkPassed: row.checkPassed,
        selfIdentity: row.selfIdentity,
        // 种类 / 触发者（#1798 片 6）：库里写了的原样给；老行空的不给，不拿默认值顶。
        ...(row.kind != null ? { kind: row.kind } : {}),
        ...(row.trigger != null ? { trigger: row.trigger } : {}),
      }));
    },
  };
}

/** 读到的行收成接口要的条带。 */
export function probeHistoryBody(rows: readonly ProbeHistoryCell[]) {
  return probeHistoryStrips(rows);
}
