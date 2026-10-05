// 推快照测试用的一份能过契约的主页 + 环境页（shared 的 NodeReportSchema 认得）。
import type { NodeSnapshot } from '@fleet-dao/shared';

export function sampleSnapshot(asOf = '2026-09-25T08:00:00.000Z'): NodeSnapshot {
  return {
    home: {
      decisions: [],
      running: [],
      done: [],
      health: {
        quota: { state: 'ok', detail: '够用' },
        routes: { state: 'ok', detail: '都通' },
        engine: { state: 'on' },
      },
      flow: [
        { segment: 'scope', inFlight: 0, samples: 0 },
        { segment: 'manual', inFlight: 1, samples: 0 },
        { segment: 'verify', inFlight: 0, samples: 0 },
      ],
      asOf,
    },
    env: {
      name: { name: '本机' },
      asOf,
      facts: {
        engine: { ok: true, value: { state: 'on' } },
        version: { ok: false, reason: '没有发布标记' },
        sessions: { ok: true, value: { total: 0, byStage: {} } },
        pools: { ok: true, value: { count: 1, running: 0, unread: 0, stale: 0 } },
        health: { ok: true, value: { ok: true, total: 3, failing: [], notWired: [] } },
        schedule: { ok: true, value: { status: 'never' } },
      },
    },
  };
}
