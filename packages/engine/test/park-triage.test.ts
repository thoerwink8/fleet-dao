// 法国指挥官会话（#3294 第 2 片）：停了 15 分钟规则没解开的单交 commander 会话看，会话只交裁决，引擎白名单核了再执行。
// 假依赖测任务本身：选哪些单、护栏（每次停下一次、每天上限、开关、没配模型报警）、白名单放行/拒绝、诊断文字带进提醒；
// 真装配的开关、操作记录名下在 real/park-triage.test.ts。

import { implementRoundsDone, offDiffHoldOf, totalRoundsHoldOf } from '@fleet-dao/conventions';
import { WorkflowNotFoundError } from '@temporalio/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  parseCommanderAnswer,
  REDO_FAILURE_PHASES,
  runParkTriageJob,
  triageParkedTasks,
} from '../src/jobs/park-triage.ts';
import type { ParkedRetryRow, ParkedSnapshot } from '../src/jobs/parked-retry.ts';
import { stamp } from '../src/jobs/reconcile-common.ts';
import { parkTriageJob } from '../src/real/park-triage.ts';
import {
  type ContinueCommand,
  MAX_TOTAL_ROUNDS,
  PARK_CODE_ROUTE_SWITCH,
  PARK_CODE_TOTAL_ROUNDS,
  type ParkKind,
} from '../src/task-contract.ts';

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

describe('验收责任不再交指挥官（#3630，决定 0113 第二片）', () => {
  it('没有停下的单时不起会话；回答里即使带旧格式的验收裁决也不认、不执行，不出任何验收提醒或拍板卡', async () => {
    const stale = fence({
      summary: '旧格式',
      verdicts: [],
      acceptanceVerdicts: [{ issue: 3296, dutyId: 7, generation: 1, action: 'leave', reason: '旧的' }],
    });
    const idle = rig({ answer: stale, over: { tasks: async () => [] } });
    const out = await triageParkedTasks(idle.deps);
    expect(out).toMatchObject({ candidates: 0, claimed: 0, acted: [], left: [], retrying: [] });
    expect(idle.sessions).toHaveLength(0);
    expect(idle.notices).toEqual([]);

    const parked = rig({ answer: stale });
    await triageParkedTasks(parked.deps);
    expect(parked.sessions).toHaveLength(1);
    expect(parked.sessions[0]?.prompt).not.toContain('acceptanceVerdicts');
    for (const n of parked.notices) {
      expect(n.key).not.toContain(':acceptance:');
      expect(n.title).not.toContain('验收责任');
    }
    const parsed = parseCommanderAnswer(stale);
    expect(parsed.ok && Object.keys(parsed).sort()).toEqual(['ok', 'rejected', 'summary', 'verdicts']);
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

  it('轮数用尽·重做遇到诊断型验收条的单（#3602）：不叫停、不另起，留言并贴「本机做」交回本机；普通单照常重做', async () => {
    const DIAGNOSTIC = [
      '- diff与测试输出能核实原场景卡在哪个COMMIT/等待/收尾边界；新增失败诊断只记录合成数据、阶段与必要资源读数，成功静默，缺采样明确unknown。不能把teardown错误直接当根因。',
      '- 原完整256条样本、固定字节峰值、真实事务/崩溃边界和15000ms限制保持，不能加重试、跳过或rerun碰绿；定位到原因时增加能击中原因的回归并修对应实现。',
    ];
    const handed: { issue: number; key: string; comment: string }[] = [];
    const wired = (items: string[]) => ({
      offDiffHold: {
        check: async () => offDiffHoldOf(items, 'commander.redo'),
        handBack: async (_repo: IntakeRepo, issue: number, hold: { key: string; comment: string }) => {
          handed.push({ issue, key: hold.key, comment: hold.comment });
        },
      },
    });
    const held = rig({ answer: verdict('redo'), over: wired(DIAGNOSTIC) });
    const out = await triageParkedTasks(held.deps);
    expect(held.redone).toEqual([]);
    expect(held.sent).toHaveLength(0);
    expect(held.abandoned).toHaveLength(0);
    expect(out.acted).toEqual([]);
    expect(out.left).toEqual([expect.objectContaining({ why: expect.stringContaining('交回本机') })]);
    expect(handed).toHaveLength(1);
    expect(handed[0]?.issue).toBe(ROW.issueNumber);
    expect(handed[0]?.comment).toContain('核实原场景卡在哪个COMMIT');

    const plain = rig({
      answer: verdict('redo'),
      over: wired(['- 新增 packages/engine/test/foo.test.ts，断言 bar 返回 3。']),
    });
    await triageParkedTasks(plain.deps);
    expect(plain.redone).toEqual([WF]);
    expect(handed).toHaveLength(1);
  });

  it('轮数用尽·重做按历代累计动手轮数封顶（#3625）：累计到 6 不另起新一代，留言并贴「本机做」；没到照常重做', async () => {
    const handed: { issue: number; key: string; comment: string }[] = [];
    const wired = (done: number) => ({
      totalRoundsHold: {
        check: async () =>
          totalRoundsHoldOf(
            implementRoundsDone(Array.from({ length: done }, () => ({ segment: 'manual', outcome: 'done' }))),
            'commander.redo',
            MAX_TOTAL_ROUNDS,
          ),
        handBack: async (_repo: IntakeRepo, issue: number, hold: { key: string; comment: string }) => {
          handed.push({ issue, key: hold.key, comment: hold.comment });
        },
      },
    });
    const full = rig({ answer: verdict('redo'), over: wired(MAX_TOTAL_ROUNDS) });
    const out = await triageParkedTasks(full.deps);
    expect(full.redone).toEqual([]);
    expect(full.sent).toHaveLength(0);
    expect(out.acted).toEqual([]);
    expect(out.left).toEqual([
      expect.objectContaining({ why: expect.stringContaining('历代累计动手 6 轮') }),
    ]);
    expect(handed).toHaveLength(1);
    expect(handed[0]?.issue).toBe(ROW.issueNumber);
    expect(handed[0]?.comment).toContain('另起一代会把轮数清零');

    const under = rig({ answer: verdict('redo'), over: wired(MAX_TOTAL_ROUNDS - 1) });
    await triageParkedTasks(under.deps);
    expect(under.redone).toEqual([WF]);
    expect(handed).toHaveLength(1);
  });

  it('【故意造出的失败】数不了历代动手轮数（读库失败）：不重做，记失败，不当成没到上限', async () => {
    const r = rig({
      answer: verdict('redo'),
      over: {
        totalRoundsHold: {
          check: async () => {
            throw new Error('库连不上');
          },
          handBack: async () => {},
        },
      },
    });
    const out = await triageParkedTasks(r.deps);
    expect(r.redone).toEqual([]);
    expect(out.acted).toEqual([]);
    expect(r.acts.at(-1)).toMatchObject({ action: 'redo', ok: false });
  });

  it('总轮数到顶、已交回本机的停下（total_rounds）：指挥官不接——不起会话、不认领、不写任何通知（尤其没有 decision 级拍板卡）（#3625）', async () => {
    const r = rig({
      snap: snap('other', { title: '动手累计 6 轮仍没合，交还本机', code: PARK_CODE_TOTAL_ROUNDS }),
      answer: verdict('leave'),
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.candidates).toBe(0);
    expect(out.acted).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.acts).toEqual([]);
    expect(r.redone).toEqual([]);
    expect(r.sent).toHaveLength(0);
    // 对照：同一种停法（别的）换成没权限那类的码，照旧交指挥官，说明上面的空是因为码，不是夹具没装好
    const other = rig({ snap: snap('other', { title: '没权限', code: 'workflows_permission' }) });
    const seen = await triageParkedTasks(other.deps);
    expect(seen.candidates).toBe(1);
  });

  it('对照：other 停法的默认动作是留给人并写「只有人能做」的卡，所以 total_rounds 必须在选单时就跳过，不能指望后面的裁决', async () => {
    const d = defaultAction({ kind: 'other', handoff: false, continuedBefore: false }, null);
    expect(d).toMatchObject({ action: 'leave', leaveReason: 'human-only' });
  });

  it('【故意造出的失败】判不了验收条（读库失败）：不重做，记失败，不当成没命中', async () => {
    const r = rig({
      answer: verdict('redo'),
      over: {
        offDiffHold: {
          check: async () => {
            throw new Error('库连不上');
          },
          handBack: async () => {},
        },
      },
    });
    const out = await triageParkedTasks(r.deps);
    expect(r.redone).toEqual([]);
    expect(out.acted).toEqual([]);
    expect(r.acts.at(-1)).toMatchObject({ action: 'redo', ok: false });
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

// #3670：假连接负责按期限取消 RPC，不能让已失败的 promise 脱离作业继续跑。
function deadlineRig(queryAfter: number | null, signalAfter: number | null = 0, failure?: Error) {
  const calls: string[] = [];
  const deadlines: number[] = [];
  let cancel: ((error: Error) => void) | undefined;
  function rpc<T>(kind: string, afterMs: number | null, value: T): Promise<T> {
    calls.push(kind);
    return new Promise((resolve, reject) => {
      const timer =
        afterMs === null
          ? undefined
          : setTimeout(() => {
              if (failure) reject(failure);
              else resolve(value);
            }, afterMs);
      cancel = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }
  const client = {
    connection: {
      async withDeadline<T>(deadline: number | Date, fn: () => Promise<T>): Promise<T> {
        const ms = Number(deadline) - Date.now();
        deadlines.push(ms);
        const timer = setTimeout(
          () =>
            cancel?.(
              new Error('Failed to query Workflow', {
                cause: new Error('4 DEADLINE_EXCEEDED'),
              }),
            ),
          ms,
        );
        try {
          return await fn();
        } finally {
          clearTimeout(timer);
          cancel = undefined;
        }
      },
    },
    workflow: {
      getHandle: () => ({
        query: () => rpc('query', queryAfter, { phase: 'ci', prNumber: 7 }),
        signal: () => rpc('signal', signalAfter, undefined),
      }),
    },
  };
  const deps = parkTriageJob({
    db: {} as never,
    gh: {} as never,
    trees: {} as never,
    exec: {} as never,
    tmpDir: '/unused',
    spawner: {} as never,
    pickRoute: {} as never,
    sessions: {} as never,
    temporal: { use: async (fn) => fn(client as never) },
    taskQueue: 'fleet',
  })();
  return { deps, calls, deadlines };
}

describe('parkTriageJob：状态查询与信号使用各自的期限', () => {
  afterEach(() => vi.useRealTimers());

  it('#3670：超过旧5秒期限的状态查询仍能读成，不启动会话或发送信号', async () => {
    vi.useFakeTimers();
    const transport = deadlineRig(6324);
    const f = rig({ over: { status: transport.deps.status } });
    const result = runParkTriageJob(f.deps);
    await vi.advanceTimersByTimeAsync(6324);
    expect(await result).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(f.sessions).toEqual([]);
    expect(f.acts).toEqual([]);
    expect(transport.calls).toEqual(['query']);
    expect(transport.deadlines).toEqual([30_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('永久查询在30秒取消，作业保持partial并保留cause，不执行任务', async () => {
    vi.useFakeTimers();
    const transport = deadlineRig(null);
    const f = rig({ over: { status: transport.deps.status } });
    let finished = false;
    const result = runParkTriageJob(f.deps).then((value) => {
      finished = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      outcome: 'partial',
      why: expect.stringContaining('4 DEADLINE_EXCEEDED'),
    });
    expect(f.sessions).toEqual([]);
    expect(f.acts).toEqual([]);
    expect(transport.calls).toEqual(['query']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['continue', 'abandon'] as const)('%s信号仍在5秒取消', async (action) => {
    vi.useFakeTimers();
    const transport = deadlineRig(0, null);
    const result =
      action === 'continue'
        ? transport.deps.continueTask(WF, { by: COMMANDER_ACTOR, note: '测试', parkSeq: 2 })
        : transport.deps.abandonTask(WF, '测试');
    const rejected = expect(result).rejects.toThrow('Failed to query Workflow');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(transport.deadlines).toEqual([5_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('真正WorkflowNotFoundError仍为gone，普通RPC的NOT_FOUND cause保持partial', async () => {
    vi.useFakeTimers();
    const gone = deadlineRig(0, 0, new WorkflowNotFoundError('not found', WF, undefined));
    const status = gone.deps.status(WF);
    await vi.advanceTimersByTimeAsync(0);
    expect(await status).toBe('gone');
    const transport = deadlineRig(
      0,
      0,
      new Error('Failed to query Workflow', {
        cause: Object.assign(new Error('query task not found, or already expired'), { code: 'NOT_FOUND' }),
      }),
    );
    const f = rig({ over: { status: transport.deps.status } });
    const result = runParkTriageJob(f.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({
      outcome: 'partial',
      why: expect.stringContaining('already expired'),
    });
    expect(f.sessions).toEqual([]);
    expect(f.acts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
