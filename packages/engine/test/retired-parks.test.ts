// 退役停点（#3407）：名单里成果已合入的停点，每小时对账按精确身份放弃这一代、撤挂起提醒；任何一样对不上都不动。
import { describe, expect, it } from 'vitest';
import type { ClosedIssueHold } from '../src/jobs/closed-issue-tasks.ts';
import {
  abandonRetiredParks,
  RETIRED_PARK_BY,
  RETIRED_PARKS,
  type RetiredPark,
  type RetiredParkDeps,
} from '../src/jobs/retired-parks.ts';
import type { ClosedIssueHoldToken, TaskParkInfo } from '../src/task-contract.ts';

const RUN = '01a151f8-4299-7884-b4c3-ff20c7268305';
const ENTRY: RetiredPark = {
  workflowId: 'task:thoerwink8/fleet-dao#3207',
  runId: RUN,
  parkSeq: 1,
  kind: 'size',
  reason: '成果已合入，停点退役',
};
const PARK: TaskParkInfo = {
  kind: 'size',
  seq: 1,
  at: '2026-10-19T06:00:00.000Z',
  title: '改动超出体量预算：新增 9550 行，预算 3000 行，收窄过一次仍超',
  head: null,
  retriedBefore: false,
};
const token = (over: Partial<ClosedIssueHoldToken> = {}): ClosedIssueHoldToken => ({
  version: 1,
  runId: RUN,
  kind: 'parked',
  generation: 1,
  continued: 0,
  ...over,
});

function rig(
  opts: {
    park?: TaskParkInfo | null | 'gone' | Error;
    hold?: ClosedIssueHold;
    result?: 'accepted' | 'stale' | 'busy' | 'gone';
    noParkOf?: boolean;
  } = {},
) {
  const r = {
    abandoned: [] as { id: string; by: string; reason: string; token?: ClosedIssueHoldToken }[],
    resolved: [] as { id: string; why: string; by?: string }[],
    deps: undefined as unknown as RetiredParkDeps,
  };
  r.deps = {
    closedIssueTasks: {
      ...(opts.noParkOf
        ? {}
        : {
            parkOf: async () => {
              const park = opts.park === undefined ? PARK : opts.park;
              if (park instanceof Error) throw park;
              return park;
            },
          }),
      holdForClose: async () => opts.hold ?? { kind: 'parked', token: token() },
      abandon: async (id, command, t) => {
        r.abandoned.push({ id, by: command.by, reason: command.reason, ...(t ? { token: t } : {}) });
        return opts.result ?? 'accepted';
      },
      resolveParkAlerts: async (id, why, by) => {
        r.resolved.push({ id, why, ...(by ? { by } : {}) });
        return 1;
      },
    },
    log: () => {},
  };
  return r;
}

describe('退役停点', () => {
  it('名单里有 #3207 park:1（体量超预算、停着的那个 run）', () => {
    expect(RETIRED_PARKS).toContainEqual(
      expect.objectContaining({
        workflowId: 'task:thoerwink8/fleet-dao#3207',
        runId: RUN,
        parkSeq: 1,
        kind: 'size',
      }),
    );
    for (const p of RETIRED_PARKS) expect(p.reason).toContain('合入');
  });

  it('身份全对上：用停法凭据放弃这一代（记在 engine:retired-park 名下），accepted 后撤挂起提醒', async () => {
    const r = rig();
    const part = await abandonRetiredParks(r.deps, [ENTRY]);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(r.abandoned).toEqual([
      { id: ENTRY.workflowId, by: RETIRED_PARK_BY, reason: ENTRY.reason, token: token() },
    ]);
    expect(r.resolved).toEqual([{ id: ENTRY.workflowId, why: ENTRY.reason, by: RETIRED_PARK_BY }]);
  });

  it('停点对不上（没在停、工作流没了、第几次停下或停法变了、换了 run、软暂停）：不动、不报', async () => {
    const cases: Parameters<typeof rig>[0][] = [
      { park: null },
      { park: 'gone' },
      { park: { ...PARK, seq: 2 } },
      { park: { ...PARK, kind: 'rounds' } },
      { hold: { kind: 'parked', token: token({ runId: '01a151f8-0000-7884-b4c3-ff20c7268305' }) } },
      { hold: { kind: 'busy' } },
      { hold: { kind: 'paused', openSessions: 0, token: token({ kind: 'paused' }) } },
    ];
    for (const c of cases) {
      const r = rig(c);
      expect(await abandonRetiredParks(r.deps, [ENTRY]), JSON.stringify(c)).toEqual({
        scanned: 1,
        found: 0,
        unchecked: [],
      });
      expect(r.abandoned).toEqual([]);
      expect(r.resolved).toEqual([]);
    }
  });

  it('工作流没受理（stale / busy / 已经没了）：不算收掉、不撤提醒', async () => {
    for (const result of ['stale', 'busy', 'gone'] as const) {
      const r = rig({ result });
      expect((await abandonRetiredParks(r.deps, [ENTRY])).found).toBe(0);
      expect(r.resolved).toEqual([]);
    }
  });

  it('读不到工作流：记没查成，任务不动', async () => {
    const r = rig({ park: new Error('Temporal 连不上') });
    const part = await abandonRetiredParks(r.deps, [ENTRY]);
    expect(part.found).toBe(0);
    expect(part.unchecked).toEqual([expect.stringContaining('Temporal 连不上')]);
    expect(r.abandoned).toEqual([]);
  });

  it('旧装配没有 parkOf：什么都不做', async () => {
    const r = rig({ noParkOf: true });
    expect(await abandonRetiredParks(r.deps, [ENTRY])).toEqual({ scanned: 0, found: 0, unchecked: [] });
    expect(r.abandoned).toEqual([]);
  });
});
