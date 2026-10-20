// 法国指挥官会话（#3294 第 2 片）：停了 15 分钟规则没解开的单交 commander 会话看，会话只交裁决，引擎白名单核了再执行。
// 假依赖测任务本身：选哪些单、护栏（每次停下一次、每天上限、开关、没配模型报警）、白名单放行/拒绝、诊断文字带进提醒；
// 真装配的开关、操作记录名下在 real/park-triage.test.ts。
import { describe, expect, it, vi } from 'vitest';
import { COMMANDER_ACTOR, COMMANDER_LEGACY_ACTOR, ROUNDS_HANDOFF_TITLE } from '../src/commander-contract.ts';
import type { SpinRound } from '../src/decisions/spin.ts';
import type { GroomSessionOutcome } from '../src/jobs/groom.ts';
import type { IntakeRepo } from '../src/jobs/intake.ts';
import {
  COMMANDER_AUDIT_ACT,
  COMMANDER_AUDIT_CLAIM,
  COMMANDER_AUDIT_RETRY,
  type CommanderNotice,
  type OpenParkAlert,
  PARK_TRIAGE_DAILY_CAP,
  PARK_TRIAGE_SESSION_TRIES,
  type ParkTriageDeps,
  runParkTriageJob,
  triageParkedTasks,
} from '../src/jobs/park-triage.ts';
import type { ParkedRetryRow, ParkedSnapshot } from '../src/jobs/parked-retry.ts';
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
    tasks: async () => [ROW],
    status: async () => opts.snap ?? snap('rounds'),
    openPark: async () => opts.openPark ?? null,
    audits: async () => r.audits,
    claim: async ({ workflowId, park, kind }) => {
      r.audits.push({
        at: NOW,
        action: COMMANDER_AUDIT_CLAIM,
        after: { workflowId, parkSeq: park.seq, kind },
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

  it(`每天总次数有上限：24 小时内已认领 ${PARK_TRIAGE_DAILY_CAP} 张，不再起会话`, async () => {
    const audits = Array.from({ length: PARK_TRIAGE_DAILY_CAP }, (_, i) => ({
      at: new Date(NOW.getTime() - 3_600_000),
      action: COMMANDER_AUDIT_CLAIM,
      after: { workflowId: `task-other-${i}`, parkSeq: 1 },
    }));
    const r = rig({ audits });
    expect((await triageParkedTasks(r.deps)).skipped).toContain('上限');
    expect(r.sessions).toHaveLength(0);
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
