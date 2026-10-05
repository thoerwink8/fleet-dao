// 别的环境推来的快照（web-api/nodes.ts）：认得的版本、两份现成契约齐全才收；新不新鲜按收到的时刻算。
import { describe, expect, it } from 'vitest';
import {
  NODE_FRESH_MS,
  NodeIdSchema,
  type NodeReport,
  NodeReportSchema,
  nodeFreshness,
} from '../src/index.ts';

const AT = '2026-10-05T08:00:00.000Z';

function sampleReport(): NodeReport {
  return {
    schemaVersion: 1,
    reportedAt: AT,
    codeSha: 'a0006685f092154f90b462cc74e8872d32e50c15',
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
      asOf: AT,
    },
    env: {
      name: { name: '本机' },
      asOf: AT,
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

describe('NodeReportSchema', () => {
  it('两份契约齐全、版本认得：收下；没有提交号也收（读不到就不给，不写假值）', () => {
    expect(NodeReportSchema.parse(sampleReport())).toEqual(sampleReport());
    const { codeSha: _sha, ...noSha } = sampleReport();
    expect(NodeReportSchema.safeParse(noSha).success).toBe(true);
  });

  it('【故意造出的失败】认不出的版本、缺版本：拒收，不猜着读', () => {
    expect(NodeReportSchema.safeParse({ ...sampleReport(), schemaVersion: 2 }).success).toBe(false);
    expect(NodeReportSchema.safeParse({ ...sampleReport(), schemaVersion: '1' }).success).toBe(false);
    const { schemaVersion: _v, ...noVersion } = sampleReport();
    expect(NodeReportSchema.safeParse(noVersion).success).toBe(false);
  });

  it('【故意造出的失败】坏载荷：缺主页或环境页、主页形状不对、时刻不是 ISO、提交号不是十六进制，都拒收', () => {
    const { home: _h, ...noHome } = sampleReport();
    const { env: _e, ...noEnv } = sampleReport();
    const report = sampleReport();
    const badFlow = { ...report, home: { ...report.home, flow: report.home.flow.slice(0, 2) } };
    for (const bad of [
      noHome,
      noEnv,
      badFlow,
      { ...report, reportedAt: '昨天' },
      { ...report, codeSha: 'not-a-sha' },
      null,
      'x',
    ]) {
      expect(NodeReportSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('NodeIdSchema', () => {
  it('小写字母开头、只许小写字母数字和横线', () => {
    for (const ok of ['local', 'france', 'wsl-2']) expect(NodeIdSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['', 'Local', '本机', '2wsl', 'a b', 'x'.repeat(41)]) {
      expect(NodeIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('nodeFreshness', () => {
  const now = new Date(AT);
  it('按收到的时刻：不到 3 分钟 fresh，到了就 stale，没收到过 never', () => {
    expect(nodeFreshness(new Date(now.getTime() - NODE_FRESH_MS + 1).toISOString(), now)).toBe('fresh');
    expect(nodeFreshness(new Date(now.getTime() - NODE_FRESH_MS).toISOString(), now)).toBe('stale');
    expect(nodeFreshness(undefined, now)).toBe('never');
  });

  it('【故意造出的失败】时刻读不出：抛错，不当成 fresh 或 stale', () => {
    expect(() => nodeFreshness('不是时刻', now)).toThrow(/读不出/);
  });
});
