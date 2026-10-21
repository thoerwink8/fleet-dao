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
  COMMANDER_AUDIT_REDO,
  COMMANDER_AUDIT_RETRY,
  type CommanderNotice,
  type CommanderRedoOutcome,
  detailHashOf,
  type OpenParkAlert,
  PARK_TRIAGE_DAILY_CAP,
  PARK_TRIAGE_REDO_START_TRIES,
  PARK_TRIAGE_REDO_STOP_TRIES,
  PARK_TRIAGE_SESSION_TRIES,
  type ParkTriageDeps,
  REDO_FAILURE_PHASES,
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
    /** 接续时 resumeRedo 回什么；缺省是「这一轮还不能动」。 */
    resume?: CommanderRedoOutcome;
    resumeThrows?: string;
  } = {},
) {
  const r = {
    journal: [] as { phase: string; why?: string | undefined }[],
    resumed: [] as { phase: string; canStart: boolean }[],
    canSignal: [] as boolean[],
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
    redoJournal: async ({ row, workflowId, parkSeq, rec }) => {
      r.journal.push({ phase: rec.phase, why: rec.why });
      r.audits.push({
        at: NOW,
        action: COMMANDER_AUDIT_REDO,
        after: {
          taskId: row.taskId,
          owner: row.owner,
          name: row.name,
          issueNumber: row.issueNumber,
          workflowId,
          parkSeq,
          phase: rec.phase,
          ...(rec.trail ? { trail: rec.trail } : {}),
          ...(rec.why ? { why: rec.why } : {}),
        },
        ok: !REDO_FAILURE_PHASES.includes(rec.phase),
      });
    },
    resumeRedo: async (pending, o) => {
      r.resumed.push({ phase: pending.phase, canStart: o.canStart });
      r.canSignal.push(o.canSignal);
      if (opts.resumeThrows) throw new Error(opts.resumeThrows);
      return opts.resume ?? { ok: false, stage: 'waiting', why: '默认：不动' };
    },
    openIssue: async (_repo, input) => {
      r.opened.push(input);
      return { number: 4000 + r.opened.length };
    },
    audit: async (e) => {
      r.acts.push({ action: e.action, ok: e.ok, ...(e.source ? { source: e.source } : {}) });
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
      {
        closeAcceptanceTask: close,
        // 转人的依据是引擎可信来源的精确事实，不是模型的自述（#3497）
        acceptanceFounderFacts: async () => [
          {
            dutyId: 7,
            generation: 1,
            prNumber: 3300,
            head: ACCEPTANCE_HEAD,
            kind: 'founder-onsite-check' as const,
            what: '只有 Contabo 控制台审计能提供这条证据',
          },
        ],
      },
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

  // —— #3497：机读/执行失败不能变成「要你拍」的人工批准 ——
  describe('机读或执行失败不算人工批准（#3497）', () => {
    const REF = 'thoerwink8/fleet-dao#3296';
    const SETTLE_OK = { evidence: 'GitHub 合并回执、check-runs 和主机日志均通过' };
    /** 模型的 leave：只是自述，转不转人看引擎可信来源。 */
    const LEAVE = { humanOnly: '只有创始人能提供：线下合同签章确认' };
    /** 引擎可信来源给出的创始人证据事实（精确 duty/代次/PR/head）。 */
    const founderFactOf = (dutyId: number, what = '线下合同签章确认') => ({
      dutyId,
      generation: 1,
      prNumber: 3300,
      head: ACCEPTANCE_HEAD,
      kind: 'founder-decision' as const,
      what,
    });
    const withFounderFacts = (...ids: number[]): Partial<ParkTriageDeps> => ({
      acceptanceFounderFacts: async () => ids.map((id) => founderFactOf(id)),
    });
    const claimIdOf = (t: CommanderAcceptanceTask) => `acceptance:${t.taskId}:${t.prNumber}:${t.head}`;
    const acceptanceFence = (verdicts: Record<string, unknown>[]) =>
      fence({ summary: '按证据核过', acceptanceVerdicts: verdicts });
    const base = (duty: number, extra: Record<string, unknown>) => ({
      issue: 3296,
      dutyId: duty,
      generation: 1,
      prNumber: 3300,
      head: ACCEPTANCE_HEAD,
      reason: '逐条核对后的结论',
      ...extra,
    });
    /** 认领和重试写进同一本操作记录，和真装配一样：重试抵销认领，下一轮同一 head 还在候选里。 */
    const tracked = (
      answer: string,
      over: Partial<ParkTriageDeps> = {},
      task: CommanderAcceptanceTask = acceptanceTask(),
    ) => {
      const r = rig({
        answer,
        over: {
          tasks: async () => [],
          acceptanceTasks: async () => [task],
          claimAcceptance: async ({ task: t, attempt }) => {
            r.audits.push({
              at: NOW,
              action: COMMANDER_AUDIT_CLAIM,
              after: { workflowId: claimIdOf(t), parkSeq: 0, kind: 'acceptance', attempt },
            });
          },
          acceptanceRetry: async ({ task: t, attempt, why, cause }) => {
            r.audits.push({
              at: NOW,
              action: COMMANDER_AUDIT_RETRY,
              after: { workflowId: claimIdOf(t), parkSeq: 0, kind: 'acceptance', attempt, cause, why },
              ok: false,
            });
          },
          acceptanceAudit: async ({ task: t, duty, action, ok }) => {
            r.audits.push({
              at: NOW,
              action: COMMANDER_AUDIT_ACT,
              after: {
                workflowId: claimIdOf(t),
                parkSeq: 0,
                kind: 'acceptance',
                action,
                dutyId: duty.id,
                generation: duty.generation,
                prNumber: duty.prNumber,
                head: duty.head,
              },
              ok,
            });
          },
          settleAcceptance: vi.fn(async () => {}),
          supersedeAcceptance: vi.fn(async () => {}),
          closeAcceptanceTask: vi.fn(async () => {}),
          ...over,
        },
      });
      return r;
    };
    const retriesOf = (r: ReturnType<typeof tracked>) =>
      r.audits.filter((a) => a.action === COMMANDER_AUDIT_RETRY);
    const expectNoHumanApproval = (r: ReturnType<typeof tracked>) => {
      expect(r.notices.filter((n) => n.level === 'decision')).toEqual([]);
      for (const n of r.notices) {
        expect(n.reason).toBeUndefined();
        expect(n.options).toBeUndefined();
        expect(n.title).not.toContain('要你拍');
        expect(n.body).not.toContain('仍留给创始人的证据');
      }
    };
    const open = (id: number, over: Partial<AcceptanceDutyRow> = {}) =>
      acceptanceDuty({ id, items: [`验收项 ${id}`], ...over });
    const settledTarget = acceptanceDuty({
      id: 8,
      items: ['验收项 7'],
      settledAt: new Date(NOW.getTime() - 10 * 60_000),
      settledBy: 'cold-verify',
      settleEvidence: '最终头已验收',
    });
    const oldHead = 'c'.repeat(40);
    const targetRef = { id: 8, generation: 1, prNumber: 3300, head: ACCEPTANCE_HEAD };

    const failures: {
      name: string;
      answer: string;
      why: string;
      over?: Partial<ParkTriageDeps>;
      /** 没装配的口子（操作没执行）。 */
      omit?: 'settleAcceptance' | 'supersedeAcceptance';
      task?: CommanderAcceptanceTask;
    }[] = [
      { name: '缺唯一裁决', answer: acceptanceFence([]), why: '没有唯一验收裁决' },
      {
        name: '同一责任交了不止一个裁决',
        answer: acceptanceFence([
          base(7, { action: 'settle', ...SETTLE_OK }),
          base(7, { action: 'settle', ...SETTLE_OK }),
        ]),
        why: '没有唯一验收裁决',
      },
      {
        name: '裁决格式不对（缺必填字段）',
        answer: acceptanceFence([{ issue: 3296, dutyId: 7 }]),
        why: '没有唯一验收裁决',
      },
      {
        name: '身份不符（head 对不上）',
        answer: acceptanceFence([base(7, { action: 'settle', head: 'd'.repeat(40), ...SETTLE_OK })]),
        why: '与现读不符',
      },
      {
        name: '代次不符',
        answer: acceptanceFence([base(7, { action: 'settle', generation: 2, ...SETTLE_OK })]),
        why: '与现读不符',
      },
      {
        name: '缺合并回执',
        answer: acceptanceFence([base(7, { action: 'settle', ...SETTLE_OK })]),
        task: acceptanceTask([acceptanceDuty({ mergeCommit: null })]),
        why: 'PR 没有合并回执',
      },
      {
        name: '结清没写证据',
        answer: acceptanceFence([base(7, { action: 'settle' })]),
        why: '必须写非空证据',
      },
      {
        name: '结清口子抛异常',
        answer: acceptanceFence([base(7, { action: 'settle', ...SETTLE_OK })]),
        over: {
          settleAcceptance: vi.fn(async () => {
            throw new Error('库连不上：ECONNRESET');
          }),
        },
        why: '库连不上',
      },
      {
        name: '结清口子没装配（操作没执行）',
        answer: acceptanceFence([base(7, { action: 'settle', ...SETTLE_OK })]),
        omit: 'settleAcceptance',
        why: '结清口子未装配',
      },
      {
        name: 'leave 只有自由文本、没有可信来源（字样再像创始人也不算）',
        answer: acceptanceFence([
          base(7, { action: 'leave', humanOnly: '只有创始人能提供：Contabo 控制台审计' }),
        ]),
        why: '没有可信事实证明只有创始人能提供',
      },
      {
        name: '模型自己加 founder-only 声明、说明是受限会话读不到 Temporal/journal',
        answer: acceptanceFence([
          base(7, {
            action: 'leave',
            leaveKind: 'founder-only',
            humanOnly: '受限会话不能访问Temporal/journal，请人帮忙',
          }),
        ]),
        why: '没有可信事实证明只有创始人能提供',
      },
      {
        name: '可信来源在，但没有精确对应这条责任的事实（别的 duty / 代次不符）',
        answer: acceptanceFence([base(7, { action: 'leave', ...LEAVE })]),
        over: {
          acceptanceFounderFacts: async () => [founderFactOf(9), { ...founderFactOf(7), generation: 2 }],
        },
        why: '可信来源里没有精确对应这条责任的创始人证据',
      },
      {
        name: '可信来源读不到：不能判成人工项',
        answer: acceptanceFence([base(7, { action: 'leave', ...LEAVE })]),
        over: {
          acceptanceFounderFacts: async () => {
            throw new Error('来源库暂时读不到');
          },
        },
        why: '来源库暂时读不到',
      },
      {
        name: 'supersede 的目标不是已读到的已结清责任',
        answer: acceptanceFence([
          base(7, {
            action: 'supersede',
            evidence: '最终头已覆盖旧头',
            target: targetRef,
            coverage: [{ source: '验收项 7', target: '验收项 7', basis: '同项' }],
          }),
        ]),
        why: 'supersede 必须指向',
      },
      {
        name: 'supersede 没有逐项 coverage',
        answer: acceptanceFence([
          base(7, { action: 'supersede', head: oldHead, evidence: '最终头已覆盖旧头', target: targetRef }),
        ]),
        task: acceptanceTask([open(7, { head: oldHead, mergeCommit: null }), settledTarget]),
        why: '逐条写 coverage',
      },
      {
        name: '旧头没有合并回执，不能冒充当前头直接结清',
        answer: acceptanceFence([base(7, { action: 'settle', head: oldHead, ...SETTLE_OK })]),
        task: acceptanceTask([open(7, { head: oldHead, mergeCommit: null })]),
        why: 'PR 没有合并回执',
      },
    ];

    it.each(failures)('$name：不发「要你拍」，责任保持 open，记重试，下一轮能再处理', async (c) => {
      const settle = vi.fn(async () => {});
      const supersede = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const over = { settleAcceptance: settle, supersedeAcceptance: supersede, closeAcceptanceTask: close };
      const r = tracked(c.answer, { ...over, ...c.over }, c.task);
      if (c.omit) delete r.deps[c.omit];
      const out = await triageParkedTasks(r.deps);
      expect(out.left).toEqual([]);
      expect(out.acted).toEqual([]);
      expect(out.retrying).toEqual([{ ref: REF, why: expect.stringContaining(c.why) }]);
      expectNoHumanApproval(r);
      expect(r.notices).toHaveLength(1);
      expect(r.notices[0]).toMatchObject({ level: 'alert' });
      expect(r.notices[0]?.body).toContain(c.why);
      expect(r.notices[0]?.body).toContain('仍未收口');
      expect(settle).not.toHaveBeenCalled();
      expect(supersede).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      // 重试记账：抵销这一次认领，标明是核验没成（不是会话没起成），下一轮同一 head 仍在候选里
      expect(retriesOf(r)).toHaveLength(1);
      expect(retriesOf(r)[0]?.after).toMatchObject({ attempt: 1, cause: 'unverified' });
      const second = await triageParkedTasks(r.deps);
      expect(second.candidates).toBe(1);
      expect(r.sessions).toHaveLength(2);
      expectNoHumanApproval(r);
    });

    it('执行异常：先记失败审计，再不关单', async () => {
      const audit = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const r = tracked(acceptanceFence([base(7, { action: 'settle', ...SETTLE_OK })]), {
        acceptanceAudit: audit,
        closeAcceptanceTask: close,
        settleAcceptance: vi.fn(async () => {
          throw new Error('库连不上：ECONNRESET');
        }),
      });
      await triageParkedTasks(r.deps);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: '库连不上：ECONNRESET' }),
      );
      expect(close).not.toHaveBeenCalled();
    });

    it('核验一直没成：同一 head 24 小时内最多自动试 PARK_TRIAGE_SESSION_TRIES 次，用满后不再起会话，但每轮仍报未核实责任和真实原因', async () => {
      const close = vi.fn(async () => {});
      const r = tracked(acceptanceFence([]), { closeAcceptanceTask: close });
      for (let i = 1; i <= PARK_TRIAGE_SESSION_TRIES; i++) {
        const out = await triageParkedTasks(r.deps);
        expect(out.retrying).toHaveLength(1);
        expect(retriesOf(r)).toHaveLength(i);
      }
      expect(r.sessions).toHaveLength(PARK_TRIAGE_SESSION_TRIES);
      expect(r.notices.at(-1)).toMatchObject({ level: 'alert' });
      expect(r.notices.at(-1)?.body).toContain('已试满');
      expect(r.notices.at(-1)?.body).toContain('仍 open');
      // 之后每一轮：不起会话、不关单、不转人，但未核实责任带着最近一次原因报出来
      for (let i = 0; i < 3; i++) {
        const after = await triageParkedTasks(r.deps);
        expect(after.candidates).toBe(0);
        expect(after.left).toEqual([]);
        expect(after.problems).toEqual([expect.stringContaining('没有唯一验收裁决')]);
        expect(after.problems[0]).toContain(`${REF} 验收责任仍未核实`);
        expect(after.problems[0]).toContain(`${PARK_TRIAGE_SESSION_TRIES}/${PARK_TRIAGE_SESSION_TRIES}`);
        expect(r.sessions).toHaveLength(PARK_TRIAGE_SESSION_TRIES);
      }
      expect(retriesOf(r)).toHaveLength(PARK_TRIAGE_SESSION_TRIES);
      expect(close).not.toHaveBeenCalled();
      expectNoHumanApproval(r);
    });

    it('24 小时窗口滚过后预算重新开始（每天有界，不是永久停摆也不是无限重试）', async () => {
      const r = tracked(acceptanceFence([]));
      for (let i = 0; i < PARK_TRIAGE_SESSION_TRIES; i++) await triageParkedTasks(r.deps);
      expect((await triageParkedTasks(r.deps)).candidates).toBe(0);
      r.deps.now = () => new Date(NOW.getTime() + 25 * 3_600_000);
      const later = await triageParkedTasks(r.deps);
      expect(later.candidates).toBe(1);
      expect(r.sessions).toHaveLength(PARK_TRIAGE_SESSION_TRIES + 1);
    });

    it('会话没起成（读取失败）仍重试，不发人工批准，记成 session 原因', async () => {
      const r = tracked('unused', {});
      r.deps.runSession = async () => ({ ok: false, why: '选不到路由（用途 commander）：并发满了' });
      const out = await triageParkedTasks(r.deps);
      expect(out.left).toEqual([]);
      expect(out.retrying).toEqual([{ ref: REF, why: expect.stringContaining('并发满了') }]);
      expectNoHumanApproval(r);
      expect(retriesOf(r)).toHaveLength(1);
      expect(retriesOf(r)[0]?.after).toMatchObject({ cause: 'session' });
      expect((await triageParkedTasks(r.deps)).candidates).toBe(1);
    });

    it('持续的读取失败（会话没起成、主线头读不到）同样受 PARK_TRIAGE_SESSION_TRIES 约束，不无限重新认领', async () => {
      let reads = 0;
      const r = tracked('unused');
      r.deps.mainHead = async () => {
        reads += 1;
        throw new Error('持续读取失败');
      };
      for (let i = 0; i < PARK_TRIAGE_SESSION_TRIES + 2; i++) {
        const out = await triageParkedTasks(r.deps);
        expect(out.left).toEqual([]);
        expect(out.retrying.length + out.problems.length).toBeGreaterThan(0);
      }
      expect(reads).toBe(PARK_TRIAGE_SESSION_TRIES);
      expect(r.sessions).toHaveLength(0);
      expect(retriesOf(r)).toHaveLength(PARK_TRIAGE_SESSION_TRIES);
      // 用满后：不再认领，但每轮仍报原因
      const stuck = await triageParkedTasks(r.deps);
      expect(stuck.problems).toEqual([expect.stringContaining('持续读取失败')]);
      expect(r.notices.at(-1)).toMatchObject({ level: 'alert' });
      expectNoHumanApproval(r);

      const s = tracked('unused');
      s.deps.runSession = async () => ({ ok: false, why: '会话报错' });
      for (let i = 0; i < PARK_TRIAGE_SESSION_TRIES + 2; i++) await triageParkedTasks(s.deps);
      expect(s.sessions).toHaveLength(0);
      expect(retriesOf(s)).toHaveLength(PARK_TRIAGE_SESSION_TRIES);
    });

    it('读取失败和核验失败混合共用一份预算，不分原因绕过总上限', async () => {
      const r = tracked(acceptanceFence([]));
      const good = r.deps.runSession;
      let calls = 0;
      r.deps.mainHead = async () => {
        calls += 1;
        if (calls === 1) throw new Error('主线读不到');
        return 'f'.repeat(40);
      };
      r.deps.runSession = async (input) => (calls === 2 ? { ok: false, why: '选不到路由' } : good(input));
      for (let i = 0; i < PARK_TRIAGE_SESSION_TRIES + 3; i++) await triageParkedTasks(r.deps);
      // 3 次预算：主线读失败 1 + 会话没起成 1 + 核验没成 1，之后不再认领
      expect(retriesOf(r)).toHaveLength(PARK_TRIAGE_SESSION_TRIES);
      expect(retriesOf(r).map((a) => (a.after as { cause: string }).cause)).toEqual([
        'session',
        'session',
        'unverified',
      ]);
      expect(calls).toBe(PARK_TRIAGE_SESSION_TRIES);
      // 真正拿到会话回答的只有第 3 轮那一次
      expect(r.sessions).toHaveLength(1);
    });

    it('重试记录写不进：试第二次；仍写不进就报出来，不当成已处理', async () => {
      const r = tracked(acceptanceFence([]));
      let tries = 0;
      r.deps.acceptanceRetry = async () => {
        tries += 1;
        throw new Error('库写入失败');
      };
      const out = await triageParkedTasks(r.deps);
      expect(tries).toBe(2);
      expect(out.retrying).toEqual([]);
      expect(out.problems).toEqual([expect.stringContaining('重试记录没写进（库写入失败）')]);
      expect(out.problems[0]).toContain('责任仍 open');
      expect(r.notices[0]).toMatchObject({ level: 'alert' });
      expect(r.notices[0]?.body).toContain('重试记录没写进');
      expectNoHumanApproval(r);
    });

    it('只有引擎可信来源证明只有创始人能提供，leave 才发「要你拍」，责任保持 open、不重复起会话', async () => {
      const close = vi.fn(async () => {});
      const r = tracked(acceptanceFence([base(7, { action: 'leave', ...LEAVE })]), {
        closeAcceptanceTask: close,
        ...withFounderFacts(7),
      });
      const out = await triageParkedTasks(r.deps);
      // 说明来自可信事实，不是模型自述
      expect(out.left).toEqual([{ ref: REF, why: expect.stringContaining('线下合同签章确认') }]);
      expect(out.left[0]?.why).toContain('可信来源：founder-decision');
      expect(out.retrying).toEqual([]);
      expect(r.notices[0]).toMatchObject({ level: 'decision', reason: 'human-only' });
      expect(r.notices[0]?.body).toContain('仍留给创始人的证据');
      expect(r.notices[0]?.body).toContain('仍未收口');
      expect(close).not.toHaveBeenCalled();
      expect(retriesOf(r)).toEqual([]);
      // 转人记录 = 有结论：之后每轮不再起会话，也不当成「没结论」重复报
      const again = await triageParkedTasks(r.deps);
      expect(again.candidates).toBe(0);
      expect(again.problems).toEqual([]);
      expect(r.sessions).toHaveLength(1);
    });

    it('重试记账一直写不进：认领留着没有结论，之后每一轮仍报这条未核实的 open 责任，不再起会话、不冒充已处理', async () => {
      const r = tracked(acceptanceFence([]));
      r.deps.acceptanceRetry = async () => {
        throw new Error('重试账写失败');
      };
      const first = await triageParkedTasks(r.deps);
      expect(first.problems[0]).toContain('重试记录没写进');
      for (let i = 0; i < PARK_TRIAGE_SESSION_TRIES + 1; i++) {
        const out = await triageParkedTasks(r.deps);
        expect(out.candidates).toBe(0);
        expect(out.left).toEqual([]);
        expect(out.problems).toEqual([expect.stringContaining('验收责任仍未核实：已认领')]);
      }
      expect(r.sessions).toHaveLength(1);
      expectNoHumanApproval(r);
    });

    it('一条真转人加另一条机读失败且重试记账写不进：转人只覆盖它自己，另一条每轮仍报，不能全单跳过', async () => {
      const close = vi.fn(async () => {});
      const task = acceptanceTask([open(7), open(9)]);
      const r = tracked(
        acceptanceFence([base(7, { action: 'leave', ...LEAVE }), base(9, { action: 'settle' })]),
        { closeAcceptanceTask: close, ...withFounderFacts(7) },
        task,
      );
      r.deps.acceptanceRetry = async () => {
        throw new Error('retry写账失败');
      };
      const first = await triageParkedTasks(r.deps);
      expect(first.left).toHaveLength(1);
      expect(first.problems.join('；')).toContain('重试记录没写进');
      for (let i = 0; i < PARK_TRIAGE_SESSION_TRIES + 1; i++) {
        const next = await triageParkedTasks(r.deps);
        expect(next.candidates).toBe(0);
        expect(next.problems).toEqual([expect.stringContaining('duty 9（第 1 代）既没有重试记录')]);
        expect(next.problems[0]).not.toContain('duty 7');
      }
      expect(r.sessions).toHaveLength(1);
      expect(close).not.toHaveBeenCalled();
    });

    it('同一头认领并转人之后新增的 open 责任，不能被旧转人记录遮掉', async () => {
      let duties = [open(7)];
      const r = tracked(acceptanceFence([base(7, { action: 'leave', ...LEAVE })]), withFounderFacts(7));
      r.deps.acceptanceTasks = async () => [acceptanceTask(duties)];
      const first = await triageParkedTasks(r.deps);
      expect(first.left).toHaveLength(1);
      // 所有 open 责任都有精确凭据：整单在等创始人，不报
      expect((await triageParkedTasks(r.deps)).problems).toEqual([]);
      duties = [open(7), open(9)];
      const next = await triageParkedTasks(r.deps);
      expect(next.problems).toEqual([expect.stringContaining('duty 9（第 1 代）')]);
      expect(r.sessions).toHaveLength(1);
    });

    it('转人记录缺字段或身份、代次不符：不算凭据，不遮住该责任', async () => {
      const bad = [
        { dutyId: 7 }, // 缺代次/PR/head
        { dutyId: 7, generation: 2, prNumber: 3300, head: ACCEPTANCE_HEAD }, // 代次不符
        { dutyId: 7, generation: 1, prNumber: 3301, head: ACCEPTANCE_HEAD }, // PR 不符
        { dutyId: 7, generation: 1, prNumber: 3300, head: 'd'.repeat(40) }, // head 不符
        { dutyId: 8, generation: 1, prNumber: 3300, head: ACCEPTANCE_HEAD }, // 别的责任
      ];
      for (const extra of bad) {
        const r = tracked(acceptanceFence([]));
        r.audits.push({
          at: NOW,
          action: COMMANDER_AUDIT_CLAIM,
          after: { workflowId: claimIdOf(acceptanceTask()), parkSeq: 0, kind: 'acceptance' },
        });
        r.audits.push({
          at: NOW,
          action: COMMANDER_AUDIT_ACT,
          ok: true,
          after: {
            workflowId: claimIdOf(acceptanceTask()),
            parkSeq: 0,
            kind: 'acceptance',
            action: 'leave',
            ...extra,
          },
        });
        const out = await triageParkedTasks(r.deps);
        expect(out.problems, JSON.stringify(extra)).toEqual([expect.stringContaining('duty 7（第 1 代）')]);
        expect(r.sessions).toHaveLength(0);
      }
    });

    it('已认领、没有结论的验收责任所在单已关闭：不再报（只报还开着的单）', async () => {
      let issueOpen = true;
      const r = tracked(acceptanceFence([]), { acceptanceIssueOpen: async () => issueOpen });
      r.deps.acceptanceRetry = async () => {
        throw new Error('重试账写失败');
      };
      await triageParkedTasks(r.deps);
      expect((await triageParkedTasks(r.deps)).problems).toHaveLength(1);
      issueOpen = false;
      expect((await triageParkedTasks(r.deps)).problems).toEqual([]);
    });

    it('可信事实在，但模型这条不是 leave（例如证据不全的 settle）：仍按核验失败处理，不凭事实转人', async () => {
      const r = tracked(acceptanceFence([base(7, { action: 'settle' })]), withFounderFacts(7));
      const out = await triageParkedTasks(r.deps);
      expect(out.left).toEqual([]);
      expect(out.retrying).toHaveLength(1);
      expectNoHumanApproval(r);
    });

    it('可信来源只在需要时读一次：没有 leave 就不读', async () => {
      const facts = vi.fn(async () => [founderFactOf(7)]);
      const r = tracked(acceptanceFence([base(7, { action: 'settle', ...SETTLE_OK })]), {
        acceptanceFounderFacts: facts,
      });
      await triageParkedTasks(r.deps);
      expect(facts).not.toHaveBeenCalled();
    });

    it('部分结清、部分机读失败：只报已核的那一部分，不关单，失败的不改成人批准', async () => {
      const settle = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const task = acceptanceTask([open(7), open(9)]);
      const r = tracked(
        acceptanceFence([
          base(7, { action: 'settle', ...SETTLE_OK }),
          base(9, { action: 'settle', evidence: '' }),
        ]),
        { settleAcceptance: settle, closeAcceptanceTask: close },
        task,
      );
      const out = await triageParkedTasks(r.deps);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(
        expect.objectContaining({ duty: expect.objectContaining({ id: 7 }) }),
      );
      expect(close).not.toHaveBeenCalled();
      expect(out.acted).toEqual([{ ref: `${REF}/duty-7`, action: 'continue', source: 'verdict' }]);
      expect(out.left).toEqual([]);
      expect(out.retrying).toEqual([{ ref: REF, why: expect.stringContaining('duty 9') }]);
      expectNoHumanApproval(r);
      expect(r.notices[0]).toMatchObject({ level: 'alert' });
      const body = r.notices[0]?.body ?? '';
      expect(body).toContain('duty 7（第 1 代，PR #3300');
      expect(body).toMatch(/duty 7[^\n]*已按裁决收口/);
      expect(body).toMatch(/duty 9[^\n]*仍未收口/);
      expect(retriesOf(r)).toHaveLength(1);
    });

    it('部分结清、部分是创始人证据：人工批准只列创始人那一条，已结清的照实报告', async () => {
      const close = vi.fn(async () => {});
      const task = acceptanceTask([open(7), open(9)]);
      const r = tracked(
        acceptanceFence([
          base(7, { action: 'settle', ...SETTLE_OK }),
          base(9, { action: 'leave', ...LEAVE }),
        ]),
        { closeAcceptanceTask: close, ...withFounderFacts(9) },
        task,
      );
      const out = await triageParkedTasks(r.deps);
      expect(out.left).toHaveLength(1);
      expect(out.retrying).toEqual([]);
      expect(r.notices[0]).toMatchObject({ level: 'decision', reason: 'human-only' });
      const body = r.notices[0]?.body ?? '';
      expect(body).toMatch(/duty 7[^\n]*已按裁决收口/);
      expect(body).toMatch(/duty 9[^\n]*仍未收口/);
      expect(close).not.toHaveBeenCalled();
    });

    it('创始人证据和机读失败并存：只有创始人那条进人工批准，失败那条单独保留并重试', async () => {
      const task = acceptanceTask([open(7), open(9)]);
      const r = tracked(
        acceptanceFence([base(7, { action: 'leave', ...LEAVE }), base(9, { action: 'settle' })]),
        withFounderFacts(7),
        task,
      );
      const out = await triageParkedTasks(r.deps);
      expect(out.left).toEqual([{ ref: REF, why: expect.stringContaining('线下合同签章确认') }]);
      expect(out.retrying).toEqual([{ ref: REF, why: expect.stringContaining('duty 9') }]);
      expect(r.notices[0]).toMatchObject({ level: 'decision', reason: 'human-only' });
      const body = r.notices[0]?.body ?? '';
      const humanPart = body.slice(body.indexOf('仍留给创始人的证据'));
      expect(humanPart).toContain('线下合同签章确认');
      expect(humanPart.split('机读或执行没核完')[0]).not.toContain('必须写非空证据');
      expect(body).toContain('机读或执行没核完');
      expect(retriesOf(r)).toHaveLength(1);
    });

    it('supersede 仍要求同单同 PR 已结清目标和逐项 coverage：目标满足才调用，旧头不会被当成当前头', async () => {
      const supersede = vi.fn(async () => {});
      const source = open(7, { head: oldHead, mergeCommit: null });
      const task = acceptanceTask([source, settledTarget]);
      const good = tracked(
        acceptanceFence([
          base(7, {
            action: 'supersede',
            head: oldHead,
            evidence: '最终头已覆盖旧头',
            target: targetRef,
            coverage: [{ source: '验收项 7', target: '验收项 7', basis: '最终头同项' }],
          }),
        ]),
        { supersedeAcceptance: supersede },
        task,
      );
      const out = await triageParkedTasks(good.deps);
      expect(supersede).toHaveBeenCalledTimes(1);
      expect(out.retrying).toEqual([]);
      expect(out.left).toEqual([]);
    });

    it('证据仍欠或结清/替代入口没装配：结果明确未核实（保留责任重试），不调结清入口', async () => {
      const close = vi.fn(async () => {});
      const noSupersede = tracked(
        acceptanceFence([
          base(7, {
            action: 'supersede',
            head: oldHead,
            evidence: '最终头已覆盖旧头',
            target: targetRef,
            coverage: [{ source: '验收项 7', target: '验收项 7', basis: '同项' }],
          }),
        ]),
        { closeAcceptanceTask: close },
        acceptanceTask([open(7, { head: oldHead, mergeCommit: null }), settledTarget]),
      );
      delete noSupersede.deps.supersedeAcceptance;
      const out = await triageParkedTasks(noSupersede.deps);
      expect(out.retrying).toEqual([{ ref: REF, why: expect.stringContaining('未装配') }]);
      expect(close).not.toHaveBeenCalled();
      expectNoHumanApproval(noSupersede);
    });

    it('主线头读不到：会话没起，抵销认领留待下一轮，不是静默丢掉、也不发人工批准', async () => {
      const r = tracked('unused');
      r.deps.mainHead = async () => {
        throw new Error('GitHub 暂时不可用');
      };
      const out = await triageParkedTasks(r.deps);
      expect(r.sessions).toHaveLength(0);
      expect(out.retrying).toEqual([{ ref: REF, why: expect.stringContaining('GitHub 暂时不可用') }]);
      expect(retriesOf(r)[0]?.after).toMatchObject({ cause: 'session' });
      expectNoHumanApproval(r);
      r.deps.mainHead = async () => 'f'.repeat(40);
      expect((await triageParkedTasks(r.deps)).candidates).toBe(1);
      expect(r.sessions).toHaveLength(1);
    });

    it('提示词只发有限的精确事实：责任身份、合并回执、leave 不转人的约定，不含凭据或可执行命令', async () => {
      const r = tracked(acceptanceFence([]), {}, acceptanceTask([open(7, { mergeCommit: null })]));
      await triageParkedTasks(r.deps);
      const prompt = r.sessions[0]?.prompt ?? '';
      expect(prompt).toContain('duty 7（第 1 代）');
      expect(prompt).toContain(`责任 head：${ACCEPTANCE_HEAD}`);
      expect(prompt).toContain('合并回执：没有');
      expect(prompt).toContain('leave 不会把责任转给创始人');
      expect(prompt).toContain('只由引擎自己的可信来源认定');
      expect(prompt).not.toContain('leaveKind');
      expect(prompt).not.toMatch(/token|密钥|ssh |sudo|DROP |DELETE /i);
      expect(Object.keys(r.sessions[0] ?? {}).sort()).toEqual([
        'mainHead',
        'prompt',
        'repo',
        'requestId',
        'timeoutMinutes',
      ]);
    });
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

// —— #3496：重做的受管接续。可信意图 = 接续账（commander.redo）里已记下的阶段，实际阶段由 resumeRedo 现读 ——
describe('重做接续账：叫停后终态迟到，沿原裁决接续', () => {
  /** 接续账里的工作流编号必须是这张单的第 n 代标准编号（账解析按它严格核）。 */
  const CANON = 'task:thoerwink8/fleet-dao#3296';
  const CANON2 = `${CANON}:r2`;
  const TRAIL = { fromGeneration: 1, runs: [{ workflowId: CANON, runId: 'run-1' }] };
  const redoRow = (
    phase: string,
    extra: Record<string, unknown> = {},
    minutesBefore = 40,
  ): { at: Date; action: string; after: unknown; ok: boolean } => ({
    at: new Date(NOW.getTime() - minutesBefore * 60_000),
    action: COMMANDER_AUDIT_REDO,
    ok: !(REDO_FAILURE_PHASES as readonly string[]).includes(phase),
    after: {
      taskId: ROW.taskId,
      owner: ROW.owner,
      name: ROW.name,
      issueNumber: ROW.issueNumber,
      workflowId: CANON,
      parkSeq: 2,
      phase,
      ...extra,
    },
  });
  const STOPPED = redoRow('stop-requested', { trail: TRAIL });
  /** 任务行已不在停着的候选里（线上 #3258：旧代迟到结束后被放弃）。 */
  const GONE = { tasks: async () => [] as ParkedRetryRow[] };

  it('进程在叫停后断了（账上只有 stop-requested）：下一轮调度接续一次，新代已确认就写回执', async () => {
    const r = rig({
      audits: [STOPPED],
      over: GONE,
      resume: { ok: true, workflowId: CANON2, generation: 2 },
    });
    const out = await triageParkedTasks(r.deps);
    expect(r.resumed).toEqual([{ phase: 'stop-requested', canStart: true }]);
    expect(out.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'redo', source: 'verdict' }]);
    expect(r.sessions).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({
      level: 'daily',
      key: `commander:${CANON}:park:2`,
      taskId: ROW.taskId,
    });
    expect(r.notices[0]?.body).toContain('已确认启动');
  });

  it('账上已是 started / exists / given-up：重复调度不再接续', async () => {
    for (const end of ['started', 'exists', 'given-up']) {
      const r = rig({
        audits: [STOPPED, redoRow(end, end === 'given-up' ? { why: '放弃' } : {}, 30)],
        over: GONE,
      });
      await triageParkedTasks(r.deps);
      await triageParkedTasks(r.deps);
      expect(r.resumed, end).toEqual([]);
      expect(r.notices, end).toEqual([]);
    }
  });

  it('旧代还在跑/读不到：这一轮不动，不写账、不发提醒，下一轮仍接续（不无限发提醒）', async () => {
    const r = rig({ audits: [STOPPED], over: GONE });
    const first = await triageParkedTasks(r.deps);
    await triageParkedTasks(r.deps);
    expect(r.resumed).toHaveLength(2);
    expect(r.journal).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(first.acted).toEqual([]);
    expect(first.left).toEqual([]);
    expect(first.problems).toEqual([]);
  });

  it('查询失败（resumeRedo 抛错）：保持待接续，记 problems，不写完成', async () => {
    const r = rig({ audits: [STOPPED], over: GONE, resumeThrows: 'Temporal 暂时不可用' });
    const out = await triageParkedTasks(r.deps);
    expect(out.problems.join('\n')).toContain('Temporal 暂时不可用');
    expect(out.acted).toEqual([]);
    expect(r.journal).toEqual([]);
    await triageParkedTasks(r.deps);
    expect(r.resumed).toHaveLength(2);
  });

  it('已经存在新代：回执写「已经存在、没有再启动」，不算这次启动的', async () => {
    const r = rig({
      audits: [
        STOPPED,
        redoRow('start-requested', { trail: TRAIL, newWorkflowId: CANON2, generation: 2 }, 35),
      ],
      over: GONE,
      resume: { ok: true, workflowId: CANON2, generation: 2, existing: true },
    });
    const out = await triageParkedTasks(r.deps);
    expect(r.resumed).toEqual([{ phase: 'start-requested', canStart: true }]);
    expect(out.acted).toHaveLength(1);
    expect(r.notices[0]?.body).toContain('已经存在');
    expect(r.notices[0]?.body).toContain('没有再启动');
    expect(r.notices[0]?.body).not.toContain('已确认启动');
  });

  it('旧代终态已确认、新代启动没得到确认：回执写这一阶段并保留最早的失败原文', async () => {
    const r = rig({
      audits: [
        STOPPED,
        redoRow('stop-unconfirmed', { why: '叫停 task:x 后还没停，没有另起' }, 39),
        redoRow('start-requested', { trail: TRAIL, newWorkflowId: CANON2, generation: 2 }, 20),
      ],
      over: GONE,
      resume: { ok: false, stage: 'start-unconfirmed', why: 'DEADLINE_EXCEEDED：start 的响应丢了' },
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.left).toHaveLength(1);
    expect(r.notices[0]?.level).toBe('alert');
    expect(r.notices[0]?.title).toContain('新代启动未确认');
    expect(r.notices[0]?.body).toContain('DEADLINE_EXCEEDED');
    expect(r.notices[0]?.body).toContain('叫停 task:x 后还没停，没有另起');
    expect(r.notices[0]?.body).not.toContain('任务没动');
  });

  it('身份变化（旧代 run 对不上）：不再接续，记 given-up 并交人看，之后不再重试', async () => {
    const r = rig({
      audits: [STOPPED],
      over: GONE,
      resume: {
        ok: false,
        stage: 'final',
        why: '旧代 x 的 run 身份变了（记下的 run-1，现在 run-9），不再接续',
      },
    });
    const out = await triageParkedTasks(r.deps);
    expect(r.journal).toEqual([{ phase: 'given-up', why: expect.stringContaining('run 身份变了') }]);
    expect(out.left).toHaveLength(1);
    expect(r.notices[0]?.level).toBe('alert');
    expect(r.notices[0]?.title).toContain('不再接续');
    await triageParkedTasks(r.deps);
    expect(r.resumed).toHaveLength(1);
  });

  it('起新代最多试满次数：试满后 canStart=false，只许核存在、不许再起', async () => {
    const tries = Array.from({ length: PARK_TRIAGE_REDO_START_TRIES }, (_, i) =>
      redoRow('start-requested', { trail: TRAIL, newWorkflowId: CANON2, generation: 2 }, 30 - i),
    );
    const r = rig({ audits: [STOPPED, ...tries], over: GONE });
    await triageParkedTasks(r.deps);
    expect(r.resumed).toEqual([{ phase: 'start-requested', canStart: false }]);
  });

  it('补发叫停有界：账上记过 PARK_TRIAGE_REDO_STOP_TRIES 轮 stop-requested 后 canSignal=false；过了窗口也不再补发', async () => {
    const rows = Array.from({ length: PARK_TRIAGE_REDO_STOP_TRIES }, (_, i) =>
      redoRow('stop-requested', { trail: TRAIL }, 30 - i),
    );
    const full = rig({ audits: rows, over: GONE });
    await triageParkedTasks(full.deps);
    expect(full.canSignal).toEqual([false]);
    const some = rig({ audits: rows.slice(0, PARK_TRIAGE_REDO_STOP_TRIES - 1), over: GONE });
    await triageParkedTasks(some.deps);
    expect(some.canSignal).toEqual([true]);
    const old = rig({ audits: [redoRow('stop-requested', { trail: TRAIL }, 25 * 60)], over: GONE });
    await triageParkedTasks(old.deps);
    expect(old.canSignal).toEqual([false]);
  });

  it('接续过了 24 小时仍没核实：只停止发起新的启动，未知责任继续保留、每轮报没查成，不写 given-up', async () => {
    const r = rig({ audits: [redoRow('stop-requested', { trail: TRAIL }, 25 * 60)], over: GONE });
    const first = await triageParkedTasks(r.deps);
    expect(r.resumed).toEqual([{ phase: 'stop-requested', canStart: false }]);
    expect(r.journal.map((j) => j.phase)).toEqual(['unverified']);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]?.level).toBe('alert');
    expect(r.notices[0]?.body).toContain('没查成');
    expect(r.notices[0]?.body).not.toContain('没有在跑的新代');
    expect(first.problems.join('\n')).toContain('未核实');
    // 之后每一轮继续读证、继续报，但不重复写账和提醒
    const second = await triageParkedTasks(r.deps);
    expect(r.resumed).toHaveLength(2);
    expect(r.journal.map((j) => j.phase)).toEqual(['unverified']);
    expect(r.notices).toHaveLength(1);
    expect(second.problems.join('\n')).toContain('未核实');
  });

  it('已核实的事实使重做不能再接续（final）才记 given-up；回执不断言旧代已停或新代不存在', async () => {
    const r = rig({
      audits: [STOPPED],
      over: GONE,
      resume: { ok: false, stage: 'final', why: '任务现在 executor=local，不属于引擎，不再动手' },
    });
    await triageParkedTasks(r.deps);
    expect(r.journal.map((j) => j.phase)).toEqual(['given-up']);
    expect(r.notices[0]?.body).toContain('不属于引擎');
    expect(r.notices[0]?.body).toContain('不证明旧代是否已停、新代是否存在');
    expect(r.notices[0]?.body).not.toContain('没有在跑的新代');
  });

  it('账上缺 trail、读不懂、或同键后来一条坏记录：阻断该意图并报 problems，不沿旧状态继续', async () => {
    const noTrail = rig({ audits: [redoRow('stop-requested')], over: GONE });
    const a = await triageParkedTasks(noTrail.deps);
    expect(noTrail.resumed).toEqual([]);
    expect(a.problems.join('\n')).toContain('已阻断');
    const garbled = rig({
      audits: [{ at: NOW, action: COMMANDER_AUDIT_REDO, ok: true, after: { phase: 'stop-requested' } }],
      over: GONE,
    });
    const b = await triageParkedTasks(garbled.deps);
    expect(garbled.resumed).toEqual([]);
    expect(b.problems.join('\n')).toContain('定位不到');
    const badLater = (extra: Record<string, unknown>) =>
      rig({
        audits: [STOPPED, redoRow('start-requested', { newWorkflowId: CANON2, generation: 2, ...extra }, 30)],
        over: GONE,
        resume: { ok: true, workflowId: CANON2, generation: 2 },
      });
    for (const bad of [
      { trail: { fromGeneration: 1, runs: [] } },
      {
        trail: {
          fromGeneration: 2,
          runs: [
            { workflowId: CANON, runId: 'run-1' },
            { workflowId: CANON2, runId: 'x' },
          ],
        },
      },
      { trail: { fromGeneration: 1, runs: [{ workflowId: CANON, runId: '' }] } },
      { trail: { fromGeneration: 1, runs: [{ workflowId: 'task:other#1', runId: 'run-1' }] } },
      { trail: TRAIL, generation: 7 },
      { trail: TRAIL, newWorkflowId: 'task:thoerwink8/fleet-dao#3296:r9' },
      {},
    ]) {
      const r = badLater(bad);
      const out = await triageParkedTasks(r.deps);
      expect(r.resumed, JSON.stringify(bad)).toEqual([]);
      expect(out.acted, JSON.stringify(bad)).toEqual([]);
      expect(out.problems.join('\n'), JSON.stringify(bad)).toContain('已阻断');
      expect((await triageParkedTasks(r.deps)).problems.join('\n')).toContain('已阻断');
    }
  });

  it('没配模型也接续（已核的裁决不依赖模型）；开关关着则不动', async () => {
    const r = rig({
      audits: [STOPPED],
      configured: false,
      over: GONE,
      resume: { ok: true, workflowId: CANON2, generation: 2 },
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.noModel).toBe(true);
    expect(out.acted).toHaveLength(1);
    const off = rig({ audits: [STOPPED], enabled: false, over: GONE });
    await triageParkedTasks(off.deps);
    expect(off.resumed).toEqual([]);
  });

  it('接续不占每日名额、不起会话：账上有待接续时认领数不变', async () => {
    const r = rig({
      audits: [STOPPED],
      over: GONE,
      resume: { ok: true, workflowId: CANON2, generation: 2 },
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.claimed).toBe(0);
    expect(r.sessions).toHaveLength(0);
  });

  it('首次执行的回执按阶段写：叫停已发送终态未知 / 旧代已终态新代待启动 / 不再接续；什么都没动才写「任务没动」', async () => {
    const run = async (outcome: CommanderRedoOutcome) => {
      const r = rig({ answer: verdict('redo'), over: { redoTask: async () => outcome } });
      await triageParkedTasks(r.deps);
      return r.notices[0]?.body ?? '';
    };
    const stop = await run({ ok: false, stage: 'stop-unconfirmed', why: '叫停 x 后还没停，没有另起' });
    expect(stop).toContain('叫停请求已发送');
    expect(stop).toContain('终态还没确认');
    expect(stop).toContain('叫停 x 后还没停，没有另起');
    expect(stop).not.toContain('任务没动。');
    const start = await run({ ok: false, stage: 'start-unconfirmed', why: 'start 超时' });
    expect(start).toContain('上一代已确认终态');
    expect(start).toContain('start 超时');
    expect(start).not.toContain('任务没动。');
    const final = await run({ ok: false, stage: 'final', why: '已经重做到第 20 代，不再另起' });
    expect(final).toContain('不会再接续');
    expect(final).not.toContain('任务没动。');
    const untouched = await run({ ok: false, why: '读不到仓或任务标题，没有重做' });
    expect(untouched).toContain('任务没动。');
  });

  it('首次执行把接续账的写口交给 redoTask：账带这张单的编号和停下编号，之后的定时调度读得到', async () => {
    const r = rig({
      answer: verdict('redo'),
      over: {
        tasks: async () => [{ ...ROW, workflowId: CANON }],
        redoTask: async (_row, _id, journal) => {
          await journal({ phase: 'stop-requested', trail: TRAIL });
          return { ok: false, stage: 'stop-unconfirmed', why: '叫停 x 后还没停' };
        },
      },
    });
    await triageParkedTasks(r.deps);
    const row = r.audits.find((a) => a.action === COMMANDER_AUDIT_REDO);
    expect(row?.after).toMatchObject({
      workflowId: CANON,
      parkSeq: 2,
      phase: 'stop-requested',
      trail: TRAIL,
    });
    const next = rig({ audits: r.audits, over: GONE });
    await triageParkedTasks(next.deps);
    expect(next.resumed).toEqual([{ phase: 'stop-requested', canStart: true }]);
  });
});
