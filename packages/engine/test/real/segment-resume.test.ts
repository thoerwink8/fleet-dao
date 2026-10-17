// real/segment-resume.ts：动手这一段能不能续上一段的会话（决定 0088）。假路由、假 runs 行，不碰库。
// 续上、没会话号退回新会话、换了执行方式退回新会话，加上换池、换会话用户、还没收场、找不到上一段各造一次。
import type { SessionUser } from '@fleet-dao/adapters';
import type { RouteLaunchFacts, RunRow } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import type { PortContext } from '../../src/ports.ts';
import type { HostDriver, WiredHost } from '../../src/real/hosts.ts';
import {
  createPlanSegmentResume,
  createSegmentSettled,
  resumeVerdict,
} from '../../src/real/segment-resume.ts';
import type { PlanSegmentResumeInput } from '../../src/task-contract.ts';

const CARPOOL = 'fleet-agent-carpool' as SessionUser;
const TASK = '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69';
const ENDED = new Date('2026-10-14T08:00:00Z');

const route = (over: Partial<RouteLaunchFacts> = {}): RouteLaunchFacts => ({
  routeId: 'r1',
  channelId: 'claude-subscription',
  poolId: 'p1',
  modelId: 'claude-opus-5-5',
  hostId: 'claude-code',
  upstreamModel: null,
  runAsUser: CARPOOL,
  orgKind: null,
  effort: null,
  ...over,
});

const ROUTES: Record<string, RouteLaunchFacts> = {
  r1: route(),
  // 同一个池、同一个会话用户，换了模型：照样能续
  r1b: route({ routeId: 'r1b', modelId: 'claude-sonnet-5-5' }),
  // 换了执行方式（cursor 不绑池，跑在唯一的会话用户下）
  cur: route({ routeId: 'cur', hostId: 'cursor-agent', poolId: 'cursor-p', runAsUser: null }),
  // 同一家、换了账号池
  r2: route({ routeId: 'r2', poolId: 'p2' }),
};

const row = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-0007',
    segment: 'manual',
    taskId: TASK,
    routeId: 'r1',
    startedAt: new Date('2026-10-14T07:50:00Z'),
    endedAt: ENDED,
    outcome: 'killed',
    sessionId: 'aaaaaaaa-1111-4222-8333-444444444444',
    ...over,
  }) as RunRow;

const driver = (hostId: WiredHost, userFrom: HostDriver['userFrom']): HostDriver => ({
  hostId,
  userFrom,
  canFork: hostId === 'claude-code',
  newSessionId: () => ({ id: 'x', known: true }),
  run: async () => {
    throw new Error('不该起会话');
  },
  loginFix: () => '去登录',
});

const ctx: PortContext = {
  signal: new AbortController().signal,
  heartbeat: () => undefined,
  attempt: 1,
  lastHeartbeat: undefined,
};

function plan(rows: (RunRow | null)[], opts: { settleMs?: number } = {}) {
  const reads: string[] = [];
  let i = 0;
  const next = () => {
    const r = rows[Math.min(i, rows.length - 1)] ?? null;
    i += 1;
    return r;
  };
  const run = createPlanSegmentResume({
    spawner: {
      routeFacts: async (id) => ROUTES[id] ?? null,
      drivers: {
        'claude-code': driver('claude-code', 'pool'),
        'cursor-agent': driver('cursor-agent', 'sole'),
        grok: driver('grok', 'sole'),
        mirasim: driver('mirasim', 'sole'),
      } as Record<WiredHost, HostDriver>,
    },
    getRun: async (id) => {
      reads.push(`run:${id}`);
      return next();
    },
    latestManualRun: async (taskId, after) => {
      reads.push(`latest:${taskId}:${after.toISOString()}`);
      return next();
    },
    settleMs: opts.settleMs ?? 1_000,
    pollMs: 1,
    sleep: async () => undefined,
  });
  return { run, reads };
}

const input = (over: Partial<PlanSegmentResumeInput> = {}): PlanSegmentResumeInput => ({
  schemaVersion: 1,
  taskId: TASK,
  routeId: 'r1',
  previous: { startedAfter: '2026-10-14T07:49:55.000Z' },
  ...over,
});

describe('判续会话', () => {
  it('续上：同一个执行方式、同一个池、同一个会话用户，上一段记了会话号；按起跑时刻找被取消的那一段', async () => {
    const p = plan([row()]);
    await expect(p.run(input(), ctx)).resolves.toEqual({
      kind: 'resume',
      sessionId: 'aaaaaaaa-1111-4222-8333-444444444444',
      runId: 'run-0007',
    });
    expect(p.reads).toEqual([`latest:${TASK}:2026-10-14T07:49:55.000Z`]);
  });

  it('续上：跑完了的那一段按编号找；同池换了模型照样续（#2742：opus 会话被发版叫停后，点名 sonnet 仍续上它）', async () => {
    const p = plan([row()]);
    await expect(
      p.run(input({ routeId: 'r1b', previous: { runId: 'run-0007' } }), ctx),
    ).resolves.toMatchObject({
      kind: 'resume',
    });
    expect(p.reads).toEqual(['run:run-0007']);
  });

  it('没会话号：退回新会话，写明原因', async () => {
    await expect(plan([row({ sessionId: null })]).run(input(), ctx)).resolves.toEqual({
      kind: 'new',
      reason: '上一段没记下会话号',
    });
    await expect(plan([row({ sessionId: 'cursor-pending:run-0007' })]).run(input(), ctx)).resolves.toEqual({
      kind: 'new',
      reason: '上一段只有起会话前的临时号',
    });
  });

  it('换了执行方式：退回新会话，写明从哪家换到哪家', async () => {
    await expect(plan([row()]).run(input({ routeId: 'cur' }), ctx)).resolves.toEqual({
      kind: 'new',
      reason: '换了执行方式（claude-code → cursor-agent）',
    });
  });

  it('换了账号池：退回新会话（Claude 的会话绑着账号）', async () => {
    await expect(plan([row()]).run(input({ routeId: 'r2' }), ctx)).resolves.toEqual({
      kind: 'new',
      reason: '换了账号池（p1 → p2）',
    });
  });

  it('上一段还没收场：等它收场再判；等到顶还没收场就不续', async () => {
    const settled = plan([row({ endedAt: null, sessionId: null }), row()]);
    await expect(settled.run(input(), ctx)).resolves.toMatchObject({ kind: 'resume' });
    expect(settled.reads).toHaveLength(2);
    await expect(plan([row({ endedAt: null })], { settleMs: 0 }).run(input(), ctx)).resolves.toEqual({
      kind: 'new',
      reason: '上一段的会话还没收场',
    });
  });

  it('库里找不到上一段、上一段的路由没了：退回新会话', async () => {
    await expect(plan([null]).run(input(), ctx)).resolves.toEqual({
      kind: 'new',
      reason: '库里找不到上一段',
    });
    const gone = await plan([row({ routeId: 'deleted' })]).run(input(), ctx);
    expect(gone.kind).toBe('new');
    expect(gone.kind === 'new' && gone.reason).toContain('上一段的路由现在起不了会话');
  });

  it('入参认不出：明确报错，不当成续不上', async () => {
    await expect(
      plan([row()]).run(input({ previous: { startedAfter: '不是时间' } }), ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('纯判法：换了会话用户也不续', () => {
    const side = { hostId: 'cursor-agent', poolId: 'cursor-p', user: 'fleet-agent-a' };
    expect(
      resumeVerdict(
        { runId: 'r', endedAt: ENDED, sessionId: 's-1', side },
        { ...side, user: 'fleet-agent-b' },
      ),
    ).toEqual({ kind: 'new', reason: '换了会话用户（fleet-agent-a → fleet-agent-b）' });
  });
});

describe('segmentSettled：重试、重派之前上一段收场了没有（决定 0093，同一张单不并发两段）', () => {
  const ask = { schemaVersion: 1 as const, taskId: TASK, startedAfter: '2026-10-14T07:00:00Z' };
  const settled = (rows: (RunRow | null)[]) => {
    let i = 0;
    return createSegmentSettled({
      latestManualRun: async () => rows[Math.min(i++, rows.length - 1)] ?? null,
      settleMs: 50,
      pollMs: 1,
      sleep: async () => {},
    });
  };

  it('收场了的、库里压根没有那一段（没起来）：算收场', async () => {
    expect(await settled([row()])(ask, ctx)).toEqual({ settled: true });
    expect(await settled([null])(ask, ctx)).toEqual({ settled: true });
  });

  it('一开始没收场、等着等着收场了：算收场', async () => {
    expect(await settled([row({ endedAt: null }), row()])(ask, ctx)).toEqual({ settled: true });
  });

  it('【故意造出的失败】一直没收场：回没收场和那一行的编号，不当成收场了', async () => {
    const got = await settled([row({ id: 'run-live', endedAt: null })])(ask, ctx);
    expect(got).toMatchObject({ settled: false, runId: 'run-live' });
  });

  it('【故意造出的失败】库读不了原样抛、入参认不出抛，不回「收场了」', async () => {
    const broken = createSegmentSettled({
      latestManualRun: async () => {
        throw new Error('db down');
      },
    });
    await expect(broken(ask, ctx)).rejects.toThrow('db down');
    await expect(settled([row()])({ ...ask, startedAfter: 'nope' }, ctx)).rejects.toThrow('startedAfter');
  });
});
