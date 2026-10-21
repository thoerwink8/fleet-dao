// 法国指挥官会话（#3294 第 2 片）：停了 15 分钟规则没解开的单交 commander 会话看，会话只交裁决，引擎白名单核了再执行。
// 假依赖测任务本身：选哪些单、护栏（每次停下一次、每天上限、开关、没配模型报警）、白名单放行/拒绝、诊断文字带进提醒；
// 真装配的开关、操作记录名下在 real/park-triage.test.ts。

import type { AcceptanceDutyRow, CommanderAcceptanceTask } from '@fleet-dao/db';
import { describe, expect, it, vi } from 'vitest';
import { COMMANDER_ACTOR, COMMANDER_LEGACY_ACTOR, ROUNDS_HANDOFF_TITLE } from '../src/commander-contract.ts';
import { allowedActions, defaultAction } from '../src/decisions/park-triage.ts';
import type { SpinRound } from '../src/decisions/spin.ts';
import type { GroomSessionOutcome } from '../src/jobs/groom.ts';
import type { IntakeRepo } from '../src/jobs/intake.ts';
import {
  COMMANDER_AUDIT_ACT,
  COMMANDER_AUDIT_CLAIM,
  COMMANDER_AUDIT_RETRY,
  type CommanderNotice,
  detailHashOf,
  type OpenParkAlert,
  PARK_TRIAGE_DAILY_CAP,
  PARK_TRIAGE_SESSION_TRIES,
  type ParkTriageDeps,
  REDO_RECEIPT,
  type RedoFollowIntent,
  type RedoResumeContext,
  redoIntentId,
  runParkTriageJob,
  triageParkedTasks,
} from '../src/jobs/park-triage.ts';
import type { ParkedRetryRow, ParkedSnapshot } from '../src/jobs/parked-retry.ts';
import { stamp } from '../src/jobs/reconcile-common.ts';
import { type ContinueCommand, PARK_CODE_ROUTE_SWITCH, type ParkKind } from '../src/task-contract.ts';

const NOW = new Date('2026-10-19T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const WF = 'task-thoerwink8-fleet-dao-3296';
const ROW: ParkedRetryRow = {
  taskId: 't-3296',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  issueNumber: 3296,
  workflowId: WF,
};
const REPO = { id: 'r1', owner: 'thoerwink8', name: 'fleet-dao', defaultBranch: 'main' } as IntakeRepo;

const ACCEPTANCE_HEAD = 'a'.repeat(40);
const ACCEPTANCE_MERGE = 'b'.repeat(40);
const acceptanceDuty = (over: Partial<AcceptanceDutyRow> = {}): AcceptanceDutyRow =>
  ({
    id: 7,
    taskId: 't-acceptance',
    repo: 'thoerwink8/fleet-dao',
    issueNumber: 3296,
    prNumber: 3300,
    head: ACCEPTANCE_HEAD,
    generation: 1,
    items: ['线上审计记录'],
    source: 'cold_verify',
    mergeCommit: ACCEPTANCE_MERGE,
    mergedAt: new Date(NOW.getTime() - 60 * 60_000),
    createdAt: NOW,
    settledAt: null,
    settledBy: null,
    settleEvidence: null,
    supersededAt: null,
    supersededBy: null,
    supersedeEvidence: null,
    successorId: null,
    successorGeneration: null,
    supersedeCoverage: null,
    ...over,
  }) as AcceptanceDutyRow;
const acceptanceTask = (duties: AcceptanceDutyRow[] = [acceptanceDuty()]): CommanderAcceptanceTask => ({
  taskId: 't-acceptance',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  issueNumber: 3296,
  title: '验收责任',
  workflowId: 'task-thoerwink8-fleet-dao-3296',
  prNumber: 3300,
  head: ACCEPTANCE_HEAD,
  mergedAt: new Date(NOW.getTime() - 60 * 60_000),
  mergeCommit: ACCEPTANCE_MERGE,
  duties,
});

const snap = (kind: ParkKind, over: Partial<NonNullable<ParkedSnapshot['park']>> = {}): ParkedSnapshot => ({
  phase: 'parked',
  prNumber: 3300,
  park: {
    kind,
    seq: 2,
    at: minutesAgo(30),
    title: '轮数用尽',
    head: 'a'.repeat(40),
    retriedBefore: false,
    ...over,
  },
});
const round = (over: Partial<SpinRound> = {}): SpinRound => ({
  outcome: 'ci_red',
  head: null,
  addedLines: 10,
  reworkSummary: null,
  ...over,
});
/** 有进展：每回合有新提交、失败原因在变。 */
const PROGRESSING = [
  round({ outcome: 'verify_rejected', head: 'a'.repeat(40), addedLines: 10, reworkSummary: '验收缺测试' }),
  round({ outcome: 'ci_red', head: 'b'.repeat(40), addedLines: 40, reworkSummary: '类型检查报错' }),
  round({
    outcome: 'leftover',
    head: 'c'.repeat(40),
    addedLines: 90,
    reworkSummary: '工作树留了没提交的文件',
  }),
];
/** 空转：同一原因连续失败、没有新提交。 */
const SPINNING = [1, 2, 3].map(() => round({ outcome: 'ci_red', head: 'a'.repeat(40) }));

const fence = (obj: unknown) => `好的。\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const verdict = (action: string, extra: Record<string, unknown> = {}) =>
  fence({
    summary: '看完了',
    verdicts: [{ issue: 3296, parkSeq: 2, action, reason: '理由：测试里的诊断文字', ...extra }],
  });
const SUBS = [
  { title: '拆出来的第一张', scene: '先做白名单', done: ['白名单有测试'] },
  { title: '拆出来的第二张', scene: '再做执行', done: ['执行有测试'] },
];

function rig(
  opts: {
    snap?: ParkedSnapshot;
    answer?: string | GroomSessionOutcome;
    rounds?: SpinRound[] | null;
    enabled?: boolean;
    configured?: boolean;
    audits?: { at: Date; action: string; after: unknown; ok?: boolean }[];
    openPark?: OpenParkAlert | null;
    over?: Partial<ParkTriageDeps>;
  } = {},
) {
  const r = {
    sessions: [] as Parameters<ParkTriageDeps['runSession']>[0][],
    sent: [] as ContinueCommand[],
    abandoned: [] as string[],
    redone: [] as string[],
    opened: [] as { title: string; body: string; labels: string[] }[],
    labels: [] as { issue: number; label: string }[],
    acts: [] as { action: string; ok: boolean; source?: string }[],
    notices: [] as CommanderNotice[],
    audits: opts.audits ?? [],
    deps: undefined as unknown as ParkTriageDeps,
  };
  const answer = opts.answer ?? verdict('leave', { leaveReason: 'new-money' });
  r.deps = {
    enabled: async () => (opts.enabled === false ? { on: false, why: '设置关着' } : { on: true }),
    purposeConfigured: async () => opts.configured !== false,
    resolveNoModelAlert: vi.fn(async () => {}),
    resolveCapAlert: vi.fn(async () => {}),
    tasks: async () => [ROW],
    status: async () => opts.snap ?? snap('rounds'),
    openPark: async () => opts.openPark ?? null,
    audits: async () => r.audits,
    claim: async ({ row, workflowId, park, kind }) => {
      r.audits.push({
        at: NOW,
        action: COMMANDER_AUDIT_CLAIM,
        after: { workflowId, parkSeq: park.seq, kind, ref: `${row.owner}/${row.name}#${row.issueNumber}` },
      });
    },
    retry: async ({ workflowId, park, attempt }) => {
      r.audits.push({
        at: NOW,
        action: COMMANDER_AUDIT_RETRY,
        after: { workflowId, parkSeq: park.seq, attempt },
        ok: false,
      });
    },
    addLabel: async (_repo, issue, label) => {
      r.labels.push({ issue, label });
    },
    detail: async () => '动手 3 轮仍没过',
    rounds: async () => (opts.rounds === undefined ? PROGRESSING : opts.rounds),
    findRepo: async () => REPO,
    mainHead: async () => 'f'.repeat(40),
    runSession: async (input) => {
      r.sessions.push(input);
      return typeof answer === 'string' ? { ok: true, answer, model: 'grok-4.7' } : answer;
    },
    continueTask: async (_id, command) => {
      r.sent.push(command);
      return 'sent';
    },
    abandonTask: async (_id, reason) => {
      r.abandoned.push(reason);
      return 'sent';
    },
    redoTask: async (_row, id) => {
      r.redone.push(id);
      return { ok: true, workflowId: `${id}-2`, generation: 2 };
    },
    openIssue: async (_repo, input) => {
      r.opened.push(input);
      return { number: 4000 + r.opened.length };
    },
    audit: async (e) => {
      r.acts.push({ action: e.action, ok: e.ok, ...(e.source ? { source: e.source } : {}) });
      const follow = e.detail?.redoFollow;
      if (follow && typeof follow === 'object') {
        r.audits.push({
          at: new Date(NOW.getTime() + r.audits.length + 1),
          action: COMMANDER_AUDIT_ACT,
          ok: e.ok,
          after: {
            taskId: e.item.row.taskId,
            ref: `${e.item.row.owner}/${e.item.row.name}#${e.item.row.issueNumber}`,
            workflowId: e.item.workflowId,
            parkSeq: e.item.park.seq,
            action: e.action,
            ...(e.source ? { source: e.source } : {}),
            owner: e.item.row.owner,
            name: e.item.row.name,
            issueNumber: e.item.row.issueNumber,
            redoFollow: follow,
          },
        });
      }
    },
    notify: async (n) => {
      r.notices.push(n);
    },
    resolveAlert: async () => {},
    runs: { start: async () => 9, finish: async () => {} },
    now: () => NOW,
    log: () => {},
    ...opts.over,
  };
  return r;
}

describe('哪些单交指挥官会话', () => {
  it('停下超过 15 分钟的才看；没到的不起会话；交指挥官的不用等', async () => {
    const young = rig({ snap: snap('rounds', { at: minutesAgo(14) }) });
    expect((await triageParkedTasks(young.deps)).candidates).toBe(0);
    expect(young.sessions).toHaveLength(0);
    const handoff = rig({ snap: snap('rounds', { at: minutesAgo(1), title: ROUNDS_HANDOFF_TITLE }) });
    expect((await triageParkedTasks(handoff.deps)).candidates).toBe(1);
    expect(handoff.sessions).toHaveLength(1);
  });

  it('会话拿不到 GitHub 令牌：入参里只有仓、提示词、主线头、时限；提示词写明每个动作放不放行', async () => {
    const r = rig({ snap: snap('quota', { title: 'token 额度超预算' }), rounds: SPINNING });
    await triageParkedTasks(r.deps);
    expect(Object.keys(r.sessions[0] ?? {}).sort()).toEqual([
      'mainHead',
      'prompt',
      'repo',
      'requestId',
      'timeoutMinutes',
    ]);
    const prompt = r.sessions[0]?.prompt ?? '';
    expect(prompt).toContain('没有 GitHub 令牌');
    expect(prompt).toContain('continue（继续）：不放行');
    expect(prompt).toContain('判成空转');
  });
});

describe('合并后的验收责任交给指挥官', () => {
  const acceptanceAnswer = (action: 'settle' | 'supersede' | 'leave', extra: Record<string, unknown> = {}) =>
    fence({
      summary: '按证据核过',
      acceptanceVerdicts: [
        {
          issue: 3296,
          dutyId: 7,
          generation: 1,
          prNumber: 3300,
          head: ACCEPTANCE_HEAD,
          action,
          reason: '逐条核对后的结论',
          ...extra,
        },
      ],
    });
  const acceptanceRig = (answer: string, over: Partial<ParkTriageDeps> = {}) =>
    rig({
      answer,
      over: {
        tasks: async () => [],
        acceptanceTasks: async () => [acceptanceTask()],
        claimAcceptance: vi.fn(async () => {}),
        acceptanceAudit: vi.fn(async () => {}),
        ...over,
      },
    });

  it('结清全部责任后调用精确关单闸', async () => {
    const settle = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const r = acceptanceRig(
      acceptanceAnswer('settle', { evidence: 'GitHub 合并回执、check-runs 和主机日志均通过' }),
      { settleAcceptance: settle, closeAcceptanceTask: close },
    );
    const out = await triageParkedTasks(r.deps);
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ taskId: 't-acceptance' }) }),
    );
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't-acceptance' }), ACCEPTANCE_MERGE);
    expect(out.left).toEqual([]);
    expect(r.notices[0]).toMatchObject({ level: 'daily' });
  });

  it('supersede 使用已结清终头和逐条 coverage，不另写一套收口逻辑', async () => {
    const source = acceptanceDuty({ id: 7, head: 'c'.repeat(40), mergeCommit: null });
    const target = acceptanceDuty({
      id: 8,
      head: ACCEPTANCE_HEAD,
      settledAt: new Date(NOW.getTime() - 10 * 60_000),
      settledBy: 'cold-verify',
      settleEvidence: '最终头已验收',
    });
    const supersede = vi.fn(async () => {});
    const r = rig({
      answer: acceptanceAnswer('supersede', {
        generation: 1,
        head: 'c'.repeat(40),
        evidence: '最终头已覆盖旧头',
        target: { id: 8, generation: 1, prNumber: 3300, head: ACCEPTANCE_HEAD },
        coverage: [{ source: '线上审计记录', target: '线上审计记录', basis: '最终头同项' }],
      }),
      over: {
        tasks: async () => [],
        acceptanceTasks: async () => [acceptanceTask([source, target])],
        claimAcceptance: vi.fn(async () => {}),
        acceptanceAudit: vi.fn(async () => {}),
        supersedeAcceptance: supersede,
        closeAcceptanceTask: vi.fn(async () => {}),
      },
    });
    await triageParkedTasks(r.deps);
    expect(supersede).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        target,
        evidence: '最终头已覆盖旧头',
        coverage: [{ source: '线上审计记录', target: '线上审计记录', basis: '最终头同项' }],
      }),
    );
  });

  it('留给创始人时不关单，只发 decision 级通知列出缺的证据', async () => {
    const close = vi.fn(async () => {});
    const r = acceptanceRig(
      acceptanceAnswer('leave', { humanOnly: '只有 Contabo 控制台审计能提供这条证据' }),
      { closeAcceptanceTask: close },
    );
    const out = await triageParkedTasks(r.deps);
    expect(out).toMatchObject({ candidates: 1, claimed: 1 });
    expect(r.sessions).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    expect(r.notices[0]).toMatchObject({ level: 'decision', reason: 'human-only' });
    expect(r.notices[0]?.body).toContain('Contabo');
  });

  it('同一验收候选已有认领后不重复起会话，和停下任务共用全局上限', async () => {
    const task = acceptanceTask();
    const already = {
      at: NOW,
      action: COMMANDER_AUDIT_CLAIM,
      after: {
        workflowId: `acceptance:${task.taskId}:${task.prNumber}:${task.head}`,
        parkSeq: 0,
      },
    };
    const deduped = acceptanceRig(acceptanceAnswer('settle'), {
      acceptanceTasks: async () => [task],
      audits: async () => [already],
    });
    expect((await triageParkedTasks(deduped.deps)).candidates).toBe(0);
    expect(deduped.sessions).toHaveLength(0);

    const capped = acceptanceRig(acceptanceAnswer('settle'), {
      audits: async () =>
        Array.from({ length: PARK_TRIAGE_DAILY_CAP }, (_, i) => ({
          at: new Date(NOW.getTime() - (i + 1) * 60_000),
          action: COMMANDER_AUDIT_CLAIM,
          after: { workflowId: `parked-${i}`, parkSeq: 1, ref: `acme/app#${i + 1}` },
        })),
    });
    const cappedOut = await triageParkedTasks(capped.deps);
    expect(cappedOut.claimed).toBe(0);
    expect(capped.notices.find((n) => n.key === 'commander:daily-cap')?.body).toContain('验收责任 PR #3300');
  });
});

describe('护栏', () => {
  it('每张单每次停下最多处理一次；下一次停下（新编号）才能再处理', async () => {
    const r = rig({ answer: verdict('continue') });
    await triageParkedTasks(r.deps);
    expect((await triageParkedTasks(r.deps)).candidates).toBe(0);
    expect(r.sessions).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    const next = rig({ audits: r.audits, snap: snap('rounds', { seq: 3 }) });
    expect((await triageParkedTasks(next.deps)).candidates).toBe(1);
  });

  it('停点挂过 30 天也不重复认领：去重看完整的指挥官认领记录', async () => {
    const oldClaim = {
      at: new Date(NOW.getTime() - 31 * 24 * 3_600_000),
      action: COMMANDER_AUDIT_CLAIM,
      after: { workflowId: WF, parkSeq: 2 },
    };
    const r = rig({ audits: [oldClaim] });
    const out = await triageParkedTasks(r.deps);
    expect(out.candidates).toBe(0);
    expect(out.claimed).toBe(0);
    expect(r.sessions).toHaveLength(0);
  });

  it('选不到路由（会话没起成）不消耗这一次停下：下一轮同一 parkSeq 仍进候选；满 3 次按默认动作执行', async () => {
    const why = '选不到路由（用途 commander）：拼车并发满了（4/4）';
    const r = rig({ answer: { ok: false, why } });
    const first = await triageParkedTasks(r.deps);
    expect(first.retrying).toEqual([
      { ref: 'thoerwink8/fleet-dao#3296', why: `第 1 次没起成：指挥官会话没跑成：${why}` },
    ]);
    expect(first.left).toEqual([]);
    expect(r.notices[0]?.body).toContain('拼车并发满了');
    expect(r.notices[0]?.body).toContain('不算处理过');
    expect(r.audits.filter((a) => a.action === COMMANDER_AUDIT_RETRY)).toHaveLength(1);
    // 下一轮：同一次停下（parkSeq 2）还是候选，又起了一次会话
    const second = await triageParkedTasks(r.deps);
    expect(second.candidates).toBe(1);
    expect(r.sessions).toHaveLength(2);
    expect(r.redone).toHaveLength(0);
    // 第 3 次还没起成：按轮数用尽的默认动作（重做）执行，之后不再看
    const third = await triageParkedTasks(r.deps);
    expect(r.sessions).toHaveLength(PARK_TRIAGE_SESSION_TRIES);
    expect(third.retrying).toEqual([]);
    expect(third.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'redo', source: 'default' }]);
    expect(r.redone).toEqual([WF]);
    expect(r.acts).toEqual([{ action: 'redo', ok: true, source: 'default' }]);
    expect(r.notices.at(-1)?.body).toContain(`第 ${PARK_TRIAGE_SESSION_TRIES} 次没起成`);
    expect((await triageParkedTasks(r.deps)).candidates).toBe(0);
  });

  it('回答里找不到裁决清单、主线头没读到：也算没起成，下一轮再看', async () => {
    const bad = rig({ answer: '我看完了，但没写清单' });
    expect((await triageParkedTasks(bad.deps)).retrying).toHaveLength(1);
    expect((await triageParkedTasks(bad.deps)).candidates).toBe(1);
    const head = rig({
      over: {
        mainHead: async () => {
          throw new Error('GitHub 读不到');
        },
      },
    });
    expect((await triageParkedTasks(head.deps)).retrying[0]?.why).toContain('没读到主线头');
    expect((await triageParkedTasks(head.deps)).candidates).toBe(1);
  });

  const validClaims = (n: number, at: (i: number) => Date) =>
    Array.from({ length: n }, (_, i) => ({
      at: at(i),
      action: COMMANDER_AUDIT_CLAIM,
      after: { workflowId: `task-other-${i}`, parkSeq: 1, ref: `thoerwink8/fleet-dao#${5000 + i}` },
    }));

  it(`全局熔断：24 小时内已有 ${PARK_TRIAGE_DAILY_CAP} 张有效认领，不再起会话，这一轮记 partial，发 commander:daily-cap 并写明等的单和下一个名额`, async () => {
    // 最早那条在 3 小时前，其余在 1 小时前
    const audits = validClaims(
      PARK_TRIAGE_DAILY_CAP,
      (i) => new Date(NOW.getTime() - (i === 0 ? 3 : 1) * 3_600_000),
    );
    const log = vi.fn();
    const r = rig({ audits, over: { log } });
    const result = await runParkTriageJob(r.deps);
    expect(r.sessions).toHaveLength(0);
    expect(result.outcome).toBe('partial');
    expect(result.why).toContain('上限');
    const card = r.notices.find((n) => n.key === 'commander:daily-cap');
    expect(card).toMatchObject({ level: 'alert', taskId: null });
    expect(card?.body).toContain('thoerwink8/fleet-dao#3296');
    // 下一个名额＝窗口里最早那条认领 + 24 小时
    expect(card?.body).toContain(stamp(new Date(NOW.getTime() - 3 * 3_600_000 + 24 * 3_600_000)));
    expect(r.deps.resolveCapAlert).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.any(String),
      expect.objectContaining({
        skipped: expect.stringContaining('上限'),
        candidates: 1,
        claimed: 0,
        retrying: [],
        problems: [],
      }),
    );
  });

  it('回到上限以下：不再发 commander:daily-cap，并撤掉旧卡', async () => {
    const audits = validClaims(PARK_TRIAGE_DAILY_CAP - 1, () => new Date(NOW.getTime() - 3_600_000));
    const r = rig({ audits, answer: verdict('continue') });
    const result = await runParkTriageJob(r.deps);
    expect(result.outcome).toBe('ok');
    expect(r.sessions).toHaveLength(1);
    expect(r.notices.some((n) => n.key === 'commander:daily-cap')).toBe(false);
    expect(r.deps.resolveCapAlert).toHaveBeenCalledOnce();
  });

  it('这一轮自己把名额用满、还有单没轮上：也算被上限挡住，发 commander:daily-cap', async () => {
    const audits = validClaims(PARK_TRIAGE_DAILY_CAP - 1, () => new Date(NOW.getTime() - 3_600_000));
    const second: ParkedRetryRow = { ...ROW, taskId: 't-3297', issueNumber: 3297, workflowId: 'wf-3297' };
    const r = rig({
      audits,
      answer: verdict('continue'),
      over: { tasks: async () => [ROW, second], status: async () => snap('rounds') },
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.claimed).toBe(1);
    expect(r.notices.find((n) => n.key === 'commander:daily-cap')?.body).toContain(
      'thoerwink8/fleet-dao#3297',
    );
  });

  it('没起成的认领不占上限：各配一条没起成的重试，候选照常进会话', async () => {
    const claims = validClaims(PARK_TRIAGE_DAILY_CAP, () => new Date(NOW.getTime() - 3_600_000));
    const audits = claims.flatMap((c) => [
      c,
      {
        at: new Date(NOW.getTime() - 3_000_000),
        action: COMMANDER_AUDIT_RETRY,
        after: { workflowId: c.after.workflowId, parkSeq: 1, attempt: 1 },
        ok: false,
      },
    ]);
    const r = rig({ audits, answer: verdict('continue') });
    const out = await triageParkedTasks(r.deps);
    expect(out.skipped).toBeUndefined();
    expect(r.sessions).toHaveLength(1);
    expect(r.notices.some((n) => n.key === 'commander:daily-cap')).toBe(false);
  });

  it('上限是 60：熔断，不是日常配额', () => {
    expect(PARK_TRIAGE_DAILY_CAP).toBe(60);
  });

  it('设置里的开关关着：不看、不起会话', async () => {
    const r = rig({ enabled: false });
    expect((await triageParkedTasks(r.deps)).skipped).toContain('开关关着');
    expect(r.sessions).toHaveLength(0);
  });

  it('用途 commander 没配模型：明说「没配模型」并报警，不悄悄不跑；这一轮记 partial', async () => {
    const r = rig({ configured: false });
    const result = await runParkTriageJob(r.deps);
    expect(r.sessions).toHaveLength(0);
    expect(r.notices[0]).toMatchObject({ level: 'alert', key: 'commander:no-model' });
    expect(r.notices[0]?.title).toContain('没配模型');
    expect(result.outcome).toBe('partial');
    expect(r.deps.resolveNoModelAlert).not.toHaveBeenCalled();
  });

  it('明确配有模型才解除缺配置提醒，不依赖本轮是否找到活路由', async () => {
    const r = rig({ answer: { ok: false, why: '没有可用路由' } });
    await triageParkedTasks(r.deps);
    expect(r.deps.resolveNoModelAlert).toHaveBeenCalledOnce();
    expect(r.notices[0]?.body).toContain('没有可用路由');
  });

  it('配置读取异常保留未知，不解除旧卡、不起会话', async () => {
    const r = rig({
      over: {
        purposeConfigured: async () => {
          throw new Error('配置读失败');
        },
      },
    });
    await expect(runParkTriageJob(r.deps)).rejects.toThrow('配置读失败');
    expect(r.deps.resolveNoModelAlert).not.toHaveBeenCalled();
    expect(r.sessions).toHaveLength(0);
  });

  it('解除失败明确记 partial，仍处理任务并保留原业务诊断', async () => {
    const log = vi.fn();
    const r = rig({
      over: {
        resolveNoModelAlert: async () => {
          throw new Error('解除写库失败');
        },
        status: async () => {
          throw new Error('原工作流读取失败');
        },
        log,
      },
    });
    const out = await runParkTriageJob(r.deps);
    expect(out.outcome).toBe('partial');
    expect(out.why).toContain('解除写库失败');
    expect(out.why).toContain('原工作流读取失败');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('解除写库失败'));
  });

  it('解除与后续业务同时失败时，业务失败不被覆盖且解除失败已留日志', async () => {
    const log = vi.fn();
    const r = rig({
      over: {
        resolveNoModelAlert: async () => {
          throw new Error('解除写库失败');
        },
        tasks: async () => {
          throw new Error('原任务列表读失败');
        },
        log,
      },
    });
    await expect(runParkTriageJob(r.deps)).rejects.toThrow('原任务列表读失败');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('解除写库失败'));
  });
});

describe('裁决：引擎白名单核过才执行', () => {
  it('轮数用尽·继续：发继续（by 是 engine:commander，带停下编号），记执行，诊断文字带进提醒', async () => {
    const r = rig({ answer: verdict('continue') });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'continue', source: 'verdict' }]);
    expect(r.sent[0]).toMatchObject({ by: COMMANDER_ACTOR, parkSeq: 2 });
    expect(r.sent[0]?.widenBudget).toBeUndefined();
    expect(r.acts).toEqual([{ action: 'continue', ok: true, source: 'verdict' }]);
    expect(r.notices[0]).toMatchObject({ level: 'daily', key: `commander:${WF}:park:2` });
    expect(r.notices[0]?.body).toContain('理由：测试里的诊断文字');
    expect(r.notices[0]?.body).toContain('grok-4.7');
  });

  it('轮数用尽·重做：叫停另起，不发继续', async () => {
    const r = rig({ answer: verdict('redo') });
    await triageParkedTasks(r.deps);
    expect(r.redone).toEqual([WF]);
    expect(r.sent).toHaveLength(0);
  });

  it('额度超预算·有进展：放行继续并把预算放宽一档', async () => {
    const r = rig({ snap: snap('quota'), rounds: PROGRESSING, answer: verdict('continue') });
    await triageParkedTasks(r.deps);
    expect(r.sent[0]).toMatchObject({ by: COMMANDER_ACTOR, parkSeq: 2, widenBudget: true });
    expect(r.notices[0]?.body).toContain('空转判断：没有空转');
  });

  it('额度超预算·同一原因连续失败、没有新提交：判空转，拒绝原样继续，改按默认动作重做，诊断带进提醒', async () => {
    const r = rig({ snap: snap('quota'), rounds: SPINNING, answer: verdict('continue') });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'redo', source: 'default' }]);
    expect(r.sent).toHaveLength(0);
    expect(r.redone).toEqual([WF]);
    expect(r.notices[0]?.body).toContain('不许原样继续');
    expect(r.notices[0]?.body).toContain('默认动作');
    expect(r.notices[0]?.body).toContain('理由：测试里的诊断文字');
  });

  it('额度超预算·空转：重做、停掉放行（停掉发放弃，写明原因）', async () => {
    const redo = rig({ snap: snap('quota'), rounds: SPINNING, answer: verdict('redo') });
    await triageParkedTasks(redo.deps);
    expect(redo.redone).toEqual([WF]);
    const stop = rig({ snap: snap('quota'), rounds: SPINNING, answer: verdict('stop') });
    await triageParkedTasks(stop.deps);
    expect(stop.abandoned[0]).toContain('空转');
  });

  it('体量超预算·拆单：开子单（带需求标签、写明从原单拆出）、原来这一代收尾；子单数不对拒绝', async () => {
    const ok = rig({ snap: snap('size'), answer: verdict('split', { subtasks: SUBS }) });
    await triageParkedTasks(ok.deps);
    expect(ok.opened).toHaveLength(2);
    expect(ok.opened[0]?.labels).toEqual(['需求']);
    expect(ok.opened[0]?.body).toContain('#3296');
    expect(ok.abandoned[0]).toContain('#4001');
    const one = rig({ snap: snap('size'), answer: verdict('split', { subtasks: SUBS.slice(0, 1) }) });
    await triageParkedTasks(one.deps);
    expect(one.opened).toHaveLength(0);
    expect(one.notices[0]?.body).toContain('2~5');
    // 拆单不放行：体量超预算的默认动作是照这一版继续推
    expect(one.sent).toHaveLength(1);
    expect(one.notices[0]?.body).toContain('照这一版继续推');
  });

  it('改标准、没权限这类人闸：继续、重做、拆单、停掉都不执行，改按默认动作（改标准贴「本机做」，没权限写卡）', async () => {
    for (const action of ['continue', 'redo', 'split', 'stop']) {
      const standard = rig({ snap: snap('standard'), answer: verdict(action, { subtasks: SUBS }) });
      expect((await triageParkedTasks(standard.deps)).acted, `standard/${action}`).toEqual([]);
      expect(
        standard.sent.length + standard.redone.length + standard.abandoned.length + standard.opened.length,
      ).toBe(0);
      expect(standard.labels).toEqual([{ issue: 3296, label: '本机做' }]);
      expect(standard.notices[0]?.body).toContain('不放行');
      expect(standard.notices[0]?.level).toBe('daily');
      const other = rig({ snap: snap('other'), answer: verdict(action, { subtasks: SUBS }) });
      expect((await triageParkedTasks(other.deps)).acted, `other/${action}`).toEqual([]);
      expect(other.sent.length + other.redone.length + other.abandoned.length + other.opened.length).toBe(0);
      expect(other.labels).toEqual([]);
      expect(other.notices[0]).toMatchObject({ level: 'decision', reason: 'human-only' });
      expect(other.notices[0]?.options?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('会话交了白名单外的裁决：不认，按默认动作执行（轮数用尽 → 重做），提醒写明不在白名单', async () => {
    for (const action of ['merge', 'close', 'force-push']) {
      const r = rig({ answer: verdict(action) });
      expect((await triageParkedTasks(r.deps)).acted, action).toEqual([
        { ref: 'thoerwink8/fleet-dao#3296', action: 'redo', source: 'default' },
      ]);
      expect(r.sent.length + r.abandoned.length).toBe(0);
      expect(r.redone).toEqual([WF]);
      expect(r.notices[0]?.body).toContain('不在白名单里');
    }
  });

  it('会话没给裁决、停下编号对不上、对同一张单交了两个：都不认会话的，按默认动作执行', async () => {
    const none = rig({ answer: fence({ summary: '没看', verdicts: [] }) });
    await triageParkedTasks(none.deps);
    expect(none.notices[0]?.body).toContain('没给这张单裁决');
    const stale = rig({ answer: verdict('continue', { parkSeq: 1 }) });
    await triageParkedTasks(stale.deps);
    expect(stale.notices[0]?.body).toContain('对不上');
    const two = [
      { issue: 3296, parkSeq: 2, action: 'continue', reason: '先继续' },
      { issue: 3296, parkSeq: 2, action: 'redo', reason: '又重做' },
    ];
    const dup = rig({ answer: fence({ summary: '', verdicts: two }) });
    await triageParkedTasks(dup.deps);
    expect(dup.notices[0]?.body).toContain('不止一个裁决');
    expect(none.sent.length + stale.sent.length + dup.sent.length).toBe(0);
    expect([...none.redone, ...stale.redone, ...dup.redone]).toEqual([WF, WF, WF]);
  });

  it('执行没成（重做被拒）：记一条失败的操作记录，任务不动，提醒写明', async () => {
    const r = rig({
      answer: verdict('redo'),
      over: { redoTask: async () => ({ ok: false, why: '上一代还在跑' }) },
    });
    expect((await triageParkedTasks(r.deps)).acted).toEqual([]);
    expect(r.acts).toEqual([
      { action: 'redo', ok: true, source: 'verdict' },
      { action: 'redo', ok: false, source: 'verdict' },
    ]);
    expect(r.notices[0]?.body).toContain('上一代还在跑');
    expect(r.notices[0]?.body).toContain('任务没动');
  });
});

describe('留给人只剩三种理由类别', () => {
  it('不带类别的留给人：不认，按这种停法的默认动作执行（轮数用尽 → 重做）', async () => {
    const r = rig({ answer: verdict('leave') });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'redo', source: 'default' }]);
    expect(r.redone).toEqual([WF]);
    expect(r.notices[0]?.body).toContain('要带理由类别');
    const unsure = rig({ answer: verdict('leave', { leaveReason: '拿不准' }), snap: snap('size') });
    await triageParkedTasks(unsure.deps);
    expect(unsure.sent).toHaveLength(1);
    expect(unsure.labels.length + unsure.redone.length).toBe(0);
  });

  it('带「掏新钱」类别的留给人：写「要你拍」卡（带会话给的选项和原因），任务不动', async () => {
    const options = [
      { label: '开按量计费', detail: '每月多花约 20 美元', recommended: true },
      { label: '先不开', detail: '这张单先停着' },
    ];
    const r = rig({ answer: verdict('leave', { leaveReason: 'new-money', options }) });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([]);
    expect(out.left[0]?.why).toContain('要掏新钱');
    expect(r.sent.length + r.redone.length + r.abandoned.length + r.opened.length + r.labels.length).toBe(0);
    expect(r.acts).toEqual([{ action: 'leave', ok: true, source: 'verdict' }]);
    const card = r.notices[0];
    expect(card).toMatchObject({ level: 'decision', reason: 'new-money', key: `commander:${WF}:park:2` });
    expect(card?.options?.map((o) => o.label)).toEqual(['开按量计费', '先不开']);
    expect(card?.options?.filter((o) => o.recommended !== undefined)).toHaveLength(1);
  });

  it('「删了找不回」类别没给够选项：照样写卡，用只留言的两项', async () => {
    const r = rig({ answer: verdict('leave', { leaveReason: 'irreversible' }) });
    await triageParkedTasks(r.deps);
    expect(r.notices[0]).toMatchObject({ level: 'decision', reason: 'irreversible-delete' });
    expect(r.notices[0]?.options).toHaveLength(2);
    expect(r.sent.length + r.redone.length).toBe(0);
  });

  it('改标准类别的留给人：给单子贴「本机做」交本机指挥官，不写要你拍，任务不动', async () => {
    const r = rig({ answer: verdict('leave', { leaveReason: 'standard' }) });
    const out = await triageParkedTasks(r.deps);
    expect(r.labels).toEqual([{ issue: 3296, label: '本机做' }]);
    expect(out.left[0]?.why).toContain('改标准');
    expect(r.notices[0]?.level).toBe('daily');
    expect(r.notices[0]?.body).toContain('本机做');
    expect(r.sent.length + r.redone.length + r.abandoned.length).toBe(0);
  });
});

describe('运行环境类停法：按失败码认，放行继续和重做', () => {
  const runtimeSnaps = {
    换路由续不上: snap('other', { title: '换路由续不上', code: PARK_CODE_ROUTE_SWITCH }),
    会话总时长到顶: snap('other', { title: '会话总时长到顶', code: 'wall_clock_timeout', rule: 'WT1' }),
    进程被信号杀掉: snap('other', { title: '进程被信号杀掉，没查到是谁杀的', code: 'exit_143', rule: 'KL4' }),
    连不上执行机: snap('other', { title: '网络不通', code: 'econnrefused', rule: 'NT1' }),
  };

  it('每一种都放行继续和重做', async () => {
    for (const [name, s] of Object.entries(runtimeSnaps)) {
      const c = rig({ snap: s, answer: verdict('continue') });
      expect((await triageParkedTasks(c.deps)).acted, name).toEqual([
        { ref: 'thoerwink8/fleet-dao#3296', action: 'continue', source: 'verdict' },
      ]);
      expect(c.sent[0]).toMatchObject({ by: COMMANDER_ACTOR, parkSeq: 2 });
      const d = rig({ snap: s, answer: verdict('redo') });
      await triageParkedTasks(d.deps);
      expect(d.redone, name).toEqual([WF]);
    }
  });

  it('提示词里写运行环境停法和失败码', async () => {
    const r = rig({ snap: runtimeSnaps.会话总时长到顶, answer: verdict('continue') });
    await triageParkedTasks(r.deps);
    const prompt = r.sessions[0]?.prompt ?? '';
    expect(prompt).toContain('停法：运行环境');
    expect(prompt).toContain('失败码：wall_clock_timeout，规则：WT1');
    expect(prompt).toContain('默认动作：继续');
  });

  it('没给裁决：默认继续；同一张单之前判过继续、又停在同一种上 → 重做', async () => {
    const first = rig({ snap: runtimeSnaps.进程被信号杀掉, answer: fence({ summary: '', verdicts: [] }) });
    await triageParkedTasks(first.deps);
    expect(first.sent).toHaveLength(1);
    const earlier = [
      { at: NOW, action: COMMANDER_AUDIT_CLAIM, after: { workflowId: WF, parkSeq: 1, kind: 'runtime' } },
      {
        at: NOW,
        action: COMMANDER_AUDIT_ACT,
        after: { workflowId: WF, parkSeq: 1, action: 'continue', kind: 'runtime' },
        ok: true,
      },
    ];
    const again = rig({
      snap: runtimeSnaps.进程被信号杀掉,
      answer: fence({ summary: '', verdicts: [] }),
      audits: earlier,
    });
    await triageParkedTasks(again.deps);
    expect(again.sent).toHaveLength(0);
    expect(again.redone).toEqual([WF]);
    // 引擎续停续过同一原文（retriedBefore）也算继续过
    const retried = rig({
      snap: snap('other', { code: 'wall_clock_timeout', retriedBefore: true }),
      answer: fence({ summary: '', verdicts: [] }),
    });
    await triageParkedTasks(retried.deps);
    expect(retried.redone).toEqual([WF]);
  });
});

describe('老历史（查询里没有 status.park）不再静默跳过', () => {
  const legacySnap: ParkedSnapshot = { phase: 'parked', prNumber: 3300 };
  const sizeAlert: OpenParkAlert = {
    seq: 1,
    title: '改动超出体量预算：新增 9550 行，预算 3000 行，收窄过一次仍超',
    body: '点「继续」照这一版推（这张单后面不再按预算打回）',
    at: new Date(NOW.getTime() - 26 * 3_600_000),
  };

  it('提醒是体量超预算的停着任务进候选，交会话看；继续用老历史的 by', async () => {
    const r = rig({ snap: legacySnap, openPark: sizeAlert, answer: verdict('continue', { parkSeq: 1 }) });
    const out = await triageParkedTasks(r.deps);
    expect(out.candidates).toBe(1);
    expect(out.problems).toEqual([]);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]?.prompt).toContain('停法：体量超预算');
    expect(r.sessions[0]?.prompt).toContain('老历史');
    expect(r.sent[0]).toMatchObject({ by: COMMANDER_LEGACY_ACTOR });
    expect(out.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'continue', source: 'verdict' }]);
  });

  it('认不出的写进 problems，按「按临时的办」处理（没给裁决就继续）', async () => {
    const r = rig({
      snap: legacySnap,
      openPark: { ...sizeAlert, title: 'CI 的结果没查成', body: '没有检查，或超时读不到' },
      answer: fence({ summary: '', verdicts: [] }),
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.candidates).toBe(1);
    expect(out.problems.some((p) => p.includes('认不出停法') && p.includes('按临时的办'))).toBe(true);
    expect(r.sessions[0]?.prompt).toContain('停法：认不出、按临时的办');
    expect(r.sent[0]).toMatchObject({ by: COMMANDER_LEGACY_ACTOR });
  });

  it('连开着的停下提醒都没有：写进 problems，不交会话', async () => {
    const r = rig({ snap: legacySnap, openPark: null });
    const out = await triageParkedTasks(r.deps);
    expect(out.candidates).toBe(0);
    expect(out.problems[0]).toContain('认不出停在哪一次');
  });
});

describe('单张单防空转：同一张单反复停、反复继续，不再放行继续', () => {
  const REF = 'thoerwink8/fleet-dao#3296';
  const claimed = (seq: number, hoursAgo: number, n: number) => ({
    at: new Date(NOW.getTime() - hoursAgo * 3_600_000),
    action: COMMANDER_AUDIT_CLAIM,
    after: { workflowId: `task-old-${n}`, parkSeq: seq, ref: REF },
  });
  const continuedAct = (seq: number, detail: string | null) => ({
    at: new Date(NOW.getTime() - 3_600_000),
    action: COMMANDER_AUDIT_ACT,
    after: {
      workflowId: WF,
      parkSeq: seq,
      action: 'continue',
      ref: REF,
      ...(detail === null ? {} : { detailHash: detailHashOf(detail) }),
    },
    ok: true,
  });

  it('放行表：防空转生效时继续不放行，重做、拆单、停掉放行；默认动作改成重做', () => {
    const facts = { kind: 'size' as const, handoff: false };
    expect(allowedActions(facts, null).continue).toBe(true);
    const guarded = { ...facts, noContinue: '24 小时内指挥官已处理这张单 3 次' };
    const table = allowedActions(guarded, null);
    expect(table.continue).toContain('3 次');
    expect([table.redo, table.split, table.stop]).toEqual([true, true, true]);
    expect(defaultAction({ ...facts, continuedBefore: false }, null).action).toBe('continue');
    expect(defaultAction({ ...guarded, continuedBefore: false }, null)).toMatchObject({ action: 'redo' });
    // 本来就不放行继续的，防空转不会把别的动作放开
    const unknownSpin = { kind: 'quota' as const, handoff: false, noContinue: '防空转' };
    expect(allowedActions(unknownSpin, null).split).not.toBe(true);
  });

  it('24 小时内指挥官已经处理满 3 次：会话判继续也不放行，改按默认动作重做', async () => {
    const r = rig({
      audits: [claimed(1, 5, 0), claimed(3, 3, 1), claimed(4, 2, 2)],
      answer: verdict('continue'),
      snap: snap('size'),
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([{ ref: REF, action: 'redo', source: 'default' }]);
    expect(r.sent).toHaveLength(0);
    expect(r.notices[0]?.body).toContain('不放行');
    expect(r.notices[0]?.body).toContain('3 次');
  });

  it('只处理过 2 次：继续照常放行；超过 24 小时的处理不算', async () => {
    const two = rig({
      audits: [claimed(1, 5, 0), claimed(3, 2, 1)],
      answer: verdict('continue'),
      snap: snap('size'),
    });
    await triageParkedTasks(two.deps);
    expect(two.sent).toHaveLength(1);
    const old = rig({
      audits: [claimed(1, 30, 0), claimed(3, 26, 1), claimed(4, 25, 2), claimed(5, 2, 3)],
      answer: verdict('continue'),
      snap: snap('size'),
    });
    await triageParkedTasks(old.deps);
    expect(old.sent).toHaveLength(1);
  });

  it('没起成的认领不算处理过', async () => {
    const claims = [claimed(1, 3, 0), claimed(3, 3, 1), claimed(4, 3, 2)];
    const retries = claims.slice(0, 2).map((c) => ({
      at: new Date(NOW.getTime() - 2 * 3_600_000),
      action: COMMANDER_AUDIT_RETRY,
      after: { workflowId: c.after.workflowId, parkSeq: c.after.parkSeq },
      ok: false,
    }));
    const r = rig({ audits: [...claims, ...retries], answer: verdict('continue'), snap: snap('size') });
    await triageParkedTasks(r.deps);
    expect(r.sent).toHaveLength(1);
  });

  it('这次停下的原文和上一次判继续时一字不差：第二次判继续被改成默认动作', async () => {
    const same = rig({
      audits: [continuedAct(1, '动手 3 轮仍没过')],
      answer: verdict('continue'),
      snap: snap('size'),
    });
    const out = await triageParkedTasks(same.deps);
    expect(out.acted).toEqual([{ ref: REF, action: 'redo', source: 'default' }]);
    expect(same.sent).toHaveLength(0);
    expect(same.notices[0]?.body).toContain('一字不差');
  });

  it('原文有变化、或上一次的记录里没存原文：不拦继续', async () => {
    const changed = rig({
      audits: [continuedAct(1, '另一句话')],
      answer: verdict('continue'),
      snap: snap('size'),
    });
    await triageParkedTasks(changed.deps);
    expect(changed.sent).toHaveLength(1);
    const unknown = rig({ audits: [continuedAct(1, null)], answer: verdict('continue'), snap: snap('size') });
    await triageParkedTasks(unknown.deps);
    expect(unknown.sent).toHaveLength(1);
  });

  it('继续的执行记录带原文指纹，下一次停下才比得上', async () => {
    const r = rig({ answer: verdict('continue'), snap: snap('size') });
    const seen: (string | undefined)[] = [];
    r.deps.audit = async (e) => {
      seen.push(e.item.detailHash);
    };
    await triageParkedTasks(r.deps);
    expect(seen[0]).toBe(detailHashOf('动手 3 轮仍没过'));
  });
});

describe('重做叫停迟到：假存储上的执行意图和回执', () => {
  const WHY = `叫停 ${WF} 后还没停，没有另起`;
  const REF = 'thoerwink8/fleet-dao#3296';
  type Mode = 'running' | 'terminal' | 'unknown' | 'identity' | 'exists' | 'pending' | 'start_fail';

  function followOf(
    over: Partial<RedoFollowIntent> & Pick<RedoFollowIntent, 'phase' | 'why'>,
  ): RedoFollowIntent {
    return {
      intentId: redoIntentId(WF, 2),
      identities: [{ workflowId: WF, generation: 1, runId: 'run-1' }],
      source: 'verdict',
      reason: '理由：测试里的诊断文字',
      seq: 1,
      ...over,
    };
  }

  function actRow(follow: RedoFollowIntent, ok: boolean, at = NOW) {
    return {
      at,
      action: COMMANDER_AUDIT_ACT,
      ok,
      after: {
        taskId: ROW.taskId,
        ref: REF,
        workflowId: WF,
        parkSeq: 2,
        action: 'redo',
        source: follow.source,
        owner: ROW.owner,
        name: ROW.name,
        issueNumber: ROW.issueNumber,
        redoFollow: follow,
      },
    };
  }

  function machine() {
    let mode: Mode = 'running';
    const calls: RedoResumeContext[] = [];
    let starts = 0;
    const redoTask: ParkTriageDeps['redoTask'] = async (_row, id, resume) => {
      if (resume) calls.push(resume);
      if (!resume?.follow) {
        return {
          ok: false,
          why: WHY,
          follow: followOf({ phase: 'stop_sent_unconfirmed', why: WHY, block: 'running' }),
        };
      }
      const prior = resume.follow;
      if (mode === 'running') {
        return {
          ok: false,
          why: WHY,
          follow: { ...prior, phase: 'stop_sent_unconfirmed', block: 'running' },
        };
      }
      if (mode === 'unknown') {
        return {
          ok: false,
          why: `查不到上一代是不是还在跑（${id}），没有另起`,
          follow: { ...prior, phase: 'stop_sent_unconfirmed', block: 'unknown' },
        };
      }
      if (mode === 'identity') {
        return {
          ok: false,
          why: `执行身份变了（${id} 的 runId 从 run-1 变成 run-2），没有另起`,
          follow: { ...prior, phase: 'stop_sent_unconfirmed', block: 'identity' },
        };
      }
      if (mode === 'exists') {
        return {
          ok: false,
          why: `编号 ${id}:r2 已经有记录，没有覆盖旧代，也没另起`,
          follow: { ...prior, phase: 'start_failed', block: 'exists' },
        };
      }
      if (mode === 'pending') {
        const { block: _block, ...rest } = prior;
        return {
          ok: false,
          why: '旧代已终态，新代还没确认启动',
          follow: { ...rest, phase: 'old_terminal_pending_start' },
        };
      }
      if (mode === 'start_fail') {
        return {
          ok: false,
          why: `新代 ${id}:r2 没有确认到执行，不算重做完成`,
          follow: { ...prior, phase: 'start_failed', block: 'start' },
        };
      }
      starts += 1;
      const { block: _block, ...rest } = prior;
      return {
        ok: true,
        workflowId: `${id}:r2`,
        generation: 2,
        follow: { ...rest, phase: 'started' },
      };
    };
    const r = rig({ answer: verdict('redo'), over: { redoTask } });
    return {
      r,
      redoTask,
      calls,
      starts: () => starts,
      setMode: (next: Mode) => {
        mode = next;
      },
    };
  }

  function latestFollow(audits: { after: unknown }[]): RedoFollowIntent | undefined {
    const rows = audits.flatMap((a) => {
      const follow = (a.after as { redoFollow?: RedoFollowIntent } | null)?.redoFollow;
      return follow ? [follow] : [];
    });
    return rows.sort((a, b) => a.seq - b.seq).at(-1);
  }

  it('叫停未确认不写任务没动；进程重启和重复调度沿原意图最多起一个新代', async () => {
    const m = machine();
    const first = await triageParkedTasks(m.r.deps);
    expect(first.acted).toEqual([]);
    expect(m.r.sessions).toHaveLength(1);
    expect(m.starts()).toBe(0);
    expect(m.r.notices[0]?.body).toContain(REDO_RECEIPT.stopUnconfirmed);
    expect(m.r.notices[0]?.body).toContain(WHY);
    expect(m.r.notices[0]?.body).not.toContain('任务没动');
    expect(m.r.notices[0]?.body).not.toContain(REDO_RECEIPT.started);
    expect(latestFollow(m.r.audits)).toMatchObject({
      phase: 'stop_sent_unconfirmed',
      why: WHY,
      identities: [{ workflowId: WF, generation: 1, runId: 'run-1' }],
      intentId: redoIntentId(WF, 2),
    });

    const again = await triageParkedTasks(m.r.deps);
    expect(m.r.sessions).toHaveLength(1);
    expect(m.starts()).toBe(0);
    expect(again.claimed).toBe(0);
    expect(again.left[0]?.why).toContain(REDO_RECEIPT.stopUnconfirmed);
    expect(again.left[0]?.why).toContain(WHY);
    expect(m.calls.at(-1)?.intentId).toBe(redoIntentId(WF, 2));
    expect(m.calls.at(-1)?.follow?.identities).toEqual([{ workflowId: WF, generation: 1, runId: 'run-1' }]);

    const restarted = rig({ audits: m.r.audits, over: { tasks: async () => [], redoTask: m.redoTask } });
    const resumed = await triageParkedTasks(restarted.deps);
    expect(restarted.sessions).toHaveLength(0);
    expect(m.starts()).toBe(0);
    expect(resumed.claimed).toBe(0);
    expect(resumed.left[0]?.why).toContain(WHY);
    expect(resumed.left[0]?.why).not.toContain('任务没动');

    m.setMode('terminal');
    const started = await triageParkedTasks(restarted.deps);
    expect(m.starts()).toBe(1);
    expect(started.acted).toEqual([{ ref: REF, action: 'redo', source: 'verdict' }]);
    expect(restarted.notices.at(-1)?.body).toContain(REDO_RECEIPT.started);
    expect(restarted.notices.at(-1)?.body).toContain(`先前的失败仍在：${WHY}`);
    expect(restarted.notices.at(-1)?.body).not.toContain('任务没动');
    expect(latestFollow(m.r.audits)?.phase).toBe('started');

    const callsBefore = m.calls.length;
    const duplicated = await triageParkedTasks(restarted.deps);
    expect(m.starts()).toBe(1);
    expect(m.calls).toHaveLength(callsBefore);
    expect(restarted.sessions).toHaveLength(0);
    expect(duplicated.acted).toEqual([]);
  });

  it('旧代已终态但新代还没启动：回执是待启动，下一轮才确认启动', async () => {
    const m = machine();
    await triageParkedTasks(m.r.deps);
    m.setMode('pending');
    const pending = await triageParkedTasks(m.r.deps);
    expect(m.starts()).toBe(0);
    expect(pending.left[0]?.why).toContain(REDO_RECEIPT.pendingStart);
    expect(pending.left[0]?.why).toContain('旧代已终态，新代还没确认启动');
    expect(pending.left[0]?.why).toContain(`原失败：${WHY}`);
    expect(pending.left[0]?.why).not.toContain(REDO_RECEIPT.started);
    expect(pending.acted).toEqual([]);
    m.setMode('terminal');
    const started = await triageParkedTasks(m.r.deps);
    expect(m.starts()).toBe(1);
    expect(started.acted).toEqual([{ ref: REF, action: 'redo', source: 'verdict' }]);
    expect(m.r.notices.at(-1)?.body).toContain(REDO_RECEIPT.started);
    expect(m.r.notices.at(-1)?.body).toContain(`先前的失败仍在：${WHY}`);
  });

  it('查询失败、身份变化、新代已存在、启动没确认：都不另起，并留下原失败', async () => {
    const unknown = machine();
    await triageParkedTasks(unknown.r.deps);
    unknown.setMode('unknown');
    const missed = await triageParkedTasks(unknown.r.deps);
    expect(unknown.starts()).toBe(0);
    expect(missed.problems.join('\n')).toContain('没查清上一代');
    expect(missed.problems.join('\n')).toContain('查不到上一代是不是还在跑');
    expect(missed.left[0]?.why).toContain(REDO_RECEIPT.stopUnconfirmed);
    expect(missed.left[0]?.why).toContain(`原失败：${WHY}`);
    expect(missed.left[0]?.why).not.toContain(REDO_RECEIPT.started);
    expect(missed.left[0]?.why).not.toContain('任务没动');

    const identity = machine();
    await triageParkedTasks(identity.r.deps);
    identity.setMode('identity');
    const changed = await triageParkedTasks(identity.r.deps);
    expect(identity.starts()).toBe(0);
    expect(changed.left[0]?.why).toContain('执行身份变了');
    expect(changed.left[0]?.why).toContain('run-1');
    expect(changed.left[0]?.why).toContain('run-2');
    expect(changed.left[0]?.why).toContain(`原失败：${WHY}`);
    expect(changed.acted).toEqual([]);

    const exists = machine();
    await triageParkedTasks(exists.r.deps);
    exists.setMode('exists');
    const occupied = await triageParkedTasks(exists.r.deps);
    expect(exists.starts()).toBe(0);
    expect(occupied.left[0]?.why).toContain(REDO_RECEIPT.startFailed);
    expect(occupied.left[0]?.why).toContain('已经有记录');
    expect(occupied.left[0]?.why).toContain(`原失败：${WHY}`);
    expect(occupied.left[0]?.why).not.toContain(REDO_RECEIPT.started);

    const failed = machine();
    await triageParkedTasks(failed.r.deps);
    failed.setMode('start_fail');
    const unconfirmed = await triageParkedTasks(failed.r.deps);
    expect(failed.starts()).toBe(0);
    expect(unconfirmed.left[0]?.why).toContain(REDO_RECEIPT.startFailed);
    expect(unconfirmed.left[0]?.why).toContain('没有确认到执行，不算重做完成');
    expect(unconfirmed.left[0]?.why).toContain(`原失败：${WHY}`);
    expect(unconfirmed.acted).toEqual([]);
  });

  it('同一时刻以 seq 分先后：后写的未确认不因更早的已启动被当成做完', async () => {
    const open = followOf({ phase: 'stop_sent_unconfirmed', why: WHY, seq: 4, block: 'running' });
    const older = followOf({ phase: 'started', why: WHY, seq: 1 });
    let starts = 0;
    const r = rig({
      audits: [actRow(older, true), actRow(open, false)],
      over: {
        tasks: async () => [],
        redoTask: async (_row, _id, resume) => {
          expect(resume?.follow?.seq).toBe(4);
          expect(resume?.follow?.phase).toBe('stop_sent_unconfirmed');
          starts += 1;
          return {
            ok: true,
            workflowId: `${WF}:r2`,
            generation: 2,
            follow: { ...open, phase: 'started' },
          };
        },
      },
    });
    const out = await triageParkedTasks(r.deps);
    expect(starts).toBe(1);
    expect(out.acted).toEqual([{ ref: REF, action: 'redo', source: 'verdict' }]);
    expect(r.sessions).toHaveLength(0);
  });

  it('接续记录认不出，或意图编号对不上：不当成完成，也不启动', async () => {
    let starts = 0;
    const r = rig({
      audits: [
        {
          at: NOW,
          action: COMMANDER_AUDIT_ACT,
          ok: false,
          after: { ref: REF, workflowId: WF, parkSeq: 2, action: 'redo', redoFollow: { phase: 'started' } },
        },
        actRow(
          followOf({ phase: 'stop_sent_unconfirmed', why: WHY, intentId: 'redo:other#2' }),
          false,
          new Date(NOW.getTime() + 1),
        ),
      ],
      over: {
        tasks: async () => [],
        redoTask: async () => {
          starts += 1;
          return { ok: true, workflowId: `${WF}:r2`, generation: 2 };
        },
      },
    });
    const out = await triageParkedTasks(r.deps);
    expect(starts).toBe(0);
    expect(out.problems.filter((p) => p.includes('认不出'))).toHaveLength(2);
    expect(out.acted).toEqual([]);
  });

  it('没有接续记录的叫停原文仍保留，但不把没记下来的身份当成可以另起', async () => {
    const r = rig({
      answer: verdict('redo'),
      over: { redoTask: async () => ({ ok: false, why: WHY }) },
    });
    await triageParkedTasks(r.deps);
    expect(r.notices[0]?.body).toContain(REDO_RECEIPT.stopUnconfirmed);
    expect(r.notices[0]?.body).toContain(WHY);
    expect(r.notices[0]?.body).not.toContain('任务没动');
    const next = rig({
      audits: r.audits,
      over: { tasks: async () => [], redoTask: async () => ({ ok: true, workflowId: 'x', generation: 2 }) },
    });
    const out = await triageParkedTasks(next.deps);
    expect(out.acted).toEqual([]);
    expect(next.sessions).toHaveLength(0);
  });

  it('开关关着或没配模型：不沿开着的重做接续另起', async () => {
    const follow = followOf({ phase: 'stop_sent_unconfirmed', why: WHY, block: 'running' });
    const audits = [actRow(follow, false)];
    let starts = 0;
    const off = rig({
      enabled: false,
      audits,
      over: {
        tasks: async () => [],
        redoTask: async () => {
          starts += 1;
          return { ok: true, workflowId: `${WF}:r2`, generation: 2 };
        },
      },
    });
    const closed = await triageParkedTasks(off.deps);
    expect(closed.skipped).toContain('关着');
    const bare = rig({
      configured: false,
      audits,
      over: {
        tasks: async () => [],
        redoTask: async () => {
          starts += 1;
          return { ok: true, workflowId: `${WF}:r2`, generation: 2 };
        },
      },
    });
    const noModel = await triageParkedTasks(bare.deps);
    expect(noModel.noModel).toBe(true);
    expect(starts).toBe(0);
  });
});
