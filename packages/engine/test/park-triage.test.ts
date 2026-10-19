// 法国指挥官会话（#3294 第 2 片）：停了 15 分钟规则没解开的单交 commander 会话看，会话只交裁决，引擎白名单核了再执行。
// 这里用假依赖测任务本身的判断：选哪些单、护栏（每次停下一次、每天上限、开关、没配模型报警）、
// 白名单放行/拒绝、会话交白名单外的裁决不执行、诊断文字带进提醒；真装配的开关、操作记录名下另在 real/park-triage.test.ts。
import type { ScheduleResult } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import type { SpinRound } from '../src/decisions/spin.ts';
import type { GroomSessionInput, GroomSessionOutcome } from '../src/jobs/groom.ts';
import type { IntakeRepo } from '../src/jobs/intake.ts';
import {
  COMMANDER_AUDIT_CLAIM,
  type CommanderActEntry,
  type CommanderAuditView,
  type CommanderNotice,
  PARK_TRIAGE_AFTER_MINUTES,
  PARK_TRIAGE_DAILY_CAP,
  type ParkTriageDeps,
  parseCommanderAnswer,
  renderParkTriagePrompt,
  runParkTriageJob,
  triageParkedTasks,
} from '../src/jobs/park-triage.ts';
import type { ParkedRetryRow, ParkedSnapshot } from '../src/jobs/parked-retry.ts';
import {
  COMMANDER_ACTOR,
  type ContinueCommand,
  type ParkKind,
  ROUNDS_HANDOFF_TITLE,
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
const REPO: IntakeRepo = {
  id: 'r1',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
  autoDispatchSince: null,
  profile: null,
} as IntakeRepo;

const snap = (
  kind: ParkKind,
  over: Partial<NonNullable<ParkedSnapshot['park']>> = {},
  phase = 'parked',
): ParkedSnapshot => ({
  phase,
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
const PROGRESSING: SpinRound[] = [
  round({ outcome: 'verify_rejected', head: 'a'.repeat(40), addedLines: 10, reworkSummary: '验收缺测试' }),
  round({ outcome: 'ci_red', head: 'b'.repeat(40), addedLines: 40, reworkSummary: '类型检查报错' }),
  round({
    outcome: 'leftover',
    head: 'c'.repeat(40),
    addedLines: 90,
    reworkSummary: '工作树留了没提交的文件',
  }),
];
const SPINNING: SpinRound[] = [
  round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
  round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
  round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
];

const fence = (obj: unknown) => `好的。\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const verdict = (
  action: string,
  extra: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) => ({
  summary: '看完了',
  verdicts: [{ issue: 3296, parkSeq: 2, action, reason: '理由：测试里的诊断文字', ...extra, ...over }],
  ...{},
});

interface Rig {
  deps: ParkTriageDeps;
  sessions: GroomSessionInput[];
  sent: { workflowId: string; command: ContinueCommand }[];
  abandoned: { workflowId: string; reason: string }[];
  redone: string[];
  opened: { key: string; title: string; body: string; labels: string[] }[];
  acts: CommanderActEntry[];
  claims: { workflowId: string; seq: number }[];
  notices: CommanderNotice[];
  resolved: string[];
  audits: CommanderAuditView[];
  finished: ScheduleResult[];
}

function rig(
  opts: {
    snap?: ParkedSnapshot | 'gone';
    answer?: string | GroomSessionOutcome;
    rounds?: SpinRound[] | null;
    enabled?: boolean;
    configured?: boolean;
    audits?: CommanderAuditView[];
    rows?: ParkedRetryRow[];
    over?: Partial<ParkTriageDeps>;
  } = {},
): Rig {
  const r: Rig = {
    sessions: [],
    sent: [],
    abandoned: [],
    redone: [],
    opened: [],
    acts: [],
    claims: [],
    notices: [],
    resolved: [],
    audits: opts.audits ?? [],
    finished: [],
    deps: undefined as never,
  };
  const answer = opts.answer ?? fence(verdict('leave'));
  r.deps = {
    enabled: async () => (opts.enabled === false ? { on: false, why: '设置关着' } : { on: true }),
    purposeConfigured: async () => opts.configured !== false,
    tasks: async () => opts.rows ?? [ROW],
    status: async () => opts.snap ?? snap('rounds'),
    audits: async () => r.audits,
    claim: async ({ workflowId, park }) => {
      r.claims.push({ workflowId, seq: park.seq });
      // 真装配把认领记进操作记录，下一轮读得到
      r.audits.push({ at: NOW, action: COMMANDER_AUDIT_CLAIM, after: { workflowId, parkSeq: park.seq } });
    },
    detail: async () => '动手 3 轮仍没过',
    rounds: async () => (opts.rounds === undefined ? PROGRESSING : opts.rounds),
    findRepo: async () => REPO,
    mainHead: async () => 'f'.repeat(40),
    runSession: async (input) => {
      r.sessions.push(input);
      return typeof answer === 'string' ? { ok: true, answer, model: 'grok-4.7' } : answer;
    },
    continueTask: async (workflowId, command) => {
      r.sent.push({ workflowId, command });
      return 'sent';
    },
    abandonTask: async (workflowId, reason) => {
      r.abandoned.push({ workflowId, reason });
      return 'sent';
    },
    redoTask: async (_row, workflowId) => {
      r.redone.push(workflowId);
      return { ok: true, workflowId: `${workflowId}-2`, generation: 2 };
    },
    openIssue: async (_repo, input) => {
      r.opened.push(input);
      return { number: 4000 + r.opened.length };
    },
    audit: async (entry) => {
      r.acts.push(entry);
    },
    notify: async (n) => {
      r.notices.push(n);
    },
    resolveAlert: async ({ workflowId }) => {
      r.resolved.push(workflowId);
    },
    runs: {
      start: async () => 9,
      finish: async (_id, result) => {
        r.finished.push(result);
      },
    },
    now: () => NOW,
    log: () => {},
    ...opts.over,
  };
  return r;
}

const SUBS = [
  { title: '拆出来的第一张', scene: '先做白名单', done: ['白名单有测试'] },
  { title: '拆出来的第二张', scene: '再做执行', done: ['执行有测试'] },
];

describe('哪些单交指挥官会话', () => {
  it(`停下超过 ${PARK_TRIAGE_AFTER_MINUTES} 分钟的才看；没到的不起会话`, async () => {
    const young = rig({ snap: snap('rounds', { at: minutesAgo(PARK_TRIAGE_AFTER_MINUTES - 1) }) });
    const out = await triageParkedTasks(young.deps);
    expect(out.candidates).toBe(0);
    expect(young.sessions).toHaveLength(0);

    const old = rig({ snap: snap('rounds', { at: minutesAgo(PARK_TRIAGE_AFTER_MINUTES + 1) }) });
    expect((await triageParkedTasks(old.deps)).candidates).toBe(1);
    expect(old.sessions).toHaveLength(1);
  });

  it('「已继续三次仍没过，交指挥官」的不用等 15 分钟', async () => {
    const r = rig({ snap: snap('rounds', { at: minutesAgo(1), title: ROUNDS_HANDOFF_TITLE }) });
    expect((await triageParkedTasks(r.deps)).candidates).toBe(1);
    expect(r.sessions).toHaveLength(1);
  });

  it('不在停着的（没停、工作流没了、人暂停）不看', async () => {
    for (const s of [snap('rounds', {}, 'implement'), snap('rounds', {}, 'paused'), 'gone' as const]) {
      const r = rig({ snap: s });
      expect((await triageParkedTasks(r.deps)).candidates).toBe(0);
    }
  });

  it('会话拿不到 GitHub 令牌：交给会话的入参里只有仓、提示词、主线头、时限，没有令牌', async () => {
    const r = rig();
    await triageParkedTasks(r.deps);
    const input = r.sessions[0];
    expect(Object.keys(input ?? {}).sort()).toEqual([
      'mainHead',
      'prompt',
      'repo',
      'requestId',
      'timeoutMinutes',
    ]);
    expect(input?.prompt).not.toMatch(/token|令牌值|ghp_|ghs_/i);
    expect(input?.prompt).toContain('#3296');
    expect(input?.prompt).toContain('parkSeq 2');
  });
});

describe('护栏', () => {
  it('每张单每次停下最多处理一次：同一次停下再跑一轮，不再起会话、不再执行', async () => {
    const r = rig({ answer: fence(verdict('continue')) });
    await triageParkedTasks(r.deps);
    expect(r.sessions).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    // 同一次停下（seq 2）又被扫到：认领记录在，不处理
    const again = await triageParkedTasks(r.deps);
    expect(again.candidates).toBe(0);
    expect(r.sessions).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    expect(r.claims).toHaveLength(1);
    // 下一次停下（seq 3）是新的一次，可以处理
    const next = rig({
      audits: r.audits,
      snap: snap('rounds', { seq: 3 }),
      answer: fence(verdict('leave', {}, { parkSeq: 3 })),
    });
    expect((await triageParkedTasks(next.deps)).candidates).toBe(1);
  });

  it('会话没跑成也算处理过一次：不再来第二次，提醒里写明交人', async () => {
    const r = rig({ answer: { ok: false, why: '会话超时' } });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([]);
    expect(out.left).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({ level: 'alert', taskId: 't-3296' });
    expect(r.notices[0]?.body).toContain('会话超时');
    expect(r.notices[0]?.body).toContain('不会再自动来第二次');
    await triageParkedTasks(r.deps);
    expect(r.sessions).toHaveLength(1);
  });

  it(`每天总次数有上限：24 小时内已认领 ${PARK_TRIAGE_DAILY_CAP} 张，不再起会话`, async () => {
    const audits = Array.from({ length: PARK_TRIAGE_DAILY_CAP }, (_, i) => ({
      at: new Date(NOW.getTime() - 3_600_000),
      action: COMMANDER_AUDIT_CLAIM,
      after: { workflowId: `task-other-${i}`, parkSeq: 1 },
    }));
    const r = rig({ audits });
    const out = await triageParkedTasks(r.deps);
    expect(out.skipped).toContain('上限');
    expect(r.sessions).toHaveLength(0);
    expect(r.claims).toHaveLength(0);
  });

  it('超过 24 小时的认领不占今天的次数，但仍挡住同一次停下', async () => {
    const old = new Date(NOW.getTime() - 3 * 24 * 3_600_000);
    const audits = Array.from({ length: PARK_TRIAGE_DAILY_CAP }, (_, i) => ({
      at: old,
      action: COMMANDER_AUDIT_CLAIM,
      after: { workflowId: `task-old-${i}`, parkSeq: 1 },
    }));
    const r = rig({ audits });
    expect((await triageParkedTasks(r.deps)).candidates).toBe(1);
    expect(r.sessions).toHaveLength(1);
    const same = rig({
      audits: [{ at: old, action: COMMANDER_AUDIT_CLAIM, after: { workflowId: WF, parkSeq: 2 } }],
    });
    expect((await triageParkedTasks(same.deps)).candidates).toBe(0);
  });

  it('设置里的开关关着：不看、不起会话、不认领', async () => {
    const r = rig({ enabled: false });
    const out = await triageParkedTasks(r.deps);
    expect(out.skipped).toContain('开关关着');
    expect(r.sessions).toHaveLength(0);
    expect(r.claims).toHaveLength(0);
  });

  it('用途 commander 没配模型：明说「没配模型」并报警，不悄悄不跑；这一轮记 partial', async () => {
    const r = rig({ configured: false });
    const result = await runParkTriageJob(r.deps);
    expect(r.sessions).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({ level: 'alert', key: 'commander:no-model' });
    expect(r.notices[0]?.title).toContain('没配模型');
    expect(result.outcome).toBe('partial');
    expect(result.outcome === 'partial' && result.why).toContain('没配模型');
  });
});

describe('裁决：引擎白名单核过才执行', () => {
  it('轮数用尽·继续：发继续（by 是 engine:commander，带停下编号），撤这一次停下的提醒，诊断文字带进提醒', async () => {
    const r = rig({ answer: fence(verdict('continue')) });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'continue' }]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.command).toMatchObject({ by: COMMANDER_ACTOR, parkSeq: 2 });
    expect(r.sent[0]?.command.widenBudget).toBeUndefined();
    expect(r.resolved).toEqual([WF]);
    expect(r.acts.filter((a) => a.ok).map((a) => a.action)).toEqual(['continue']);
    const notice = r.notices[0];
    expect(notice?.level).toBe('daily');
    expect(notice?.key).toBe(`commander:${WF}:park:2`);
    expect(notice?.body).toContain('理由：测试里的诊断文字');
    expect(notice?.body).toContain('grok-4.7');
    expect(notice?.body).toContain('已执行：继续');
  });

  it('轮数用尽·重做：叫停另起，不发继续', async () => {
    const r = rig({ answer: fence(verdict('redo')) });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted[0]?.action).toBe('redo');
    expect(r.redone).toEqual([WF]);
    expect(r.sent).toHaveLength(0);
    expect(r.notices[0]?.body).toContain('新一代');
  });

  it('额度超预算·有进展：放行继续，并把预算放宽一档（widenBudget）', async () => {
    const r = rig({
      snap: snap('quota', { title: 'token 额度超预算' }),
      rounds: PROGRESSING,
      answer: fence(verdict('continue')),
    });
    await triageParkedTasks(r.deps);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.command).toMatchObject({ by: COMMANDER_ACTOR, parkSeq: 2, widenBudget: true });
    expect(r.notices[0]?.body).toContain('放宽一档');
    expect(r.notices[0]?.body).toContain('空转判断：没有空转');
  });

  it('额度超预算·同一原因连续失败、没有新提交：判空转，拒绝原样继续；不发继续，诊断带进提醒', async () => {
    const r = rig({
      snap: snap('quota', { title: 'token 额度超预算' }),
      rounds: SPINNING,
      answer: fence(verdict('continue')),
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([]);
    expect(r.sent).toHaveLength(0);
    expect(r.acts).toHaveLength(0);
    expect(r.notices[0]?.level).toBe('alert');
    expect(r.notices[0]?.body).toContain('不许原样继续');
    expect(r.notices[0]?.body).toContain('判成空转');
    expect(r.notices[0]?.body).toContain('理由：测试里的诊断文字');
  });

  it('额度超预算·空转：重做、停掉放行（停掉发放弃，写明原因）', async () => {
    const redo = rig({ snap: snap('quota'), rounds: SPINNING, answer: fence(verdict('redo')) });
    await triageParkedTasks(redo.deps);
    expect(redo.redone).toEqual([WF]);

    const stop = rig({ snap: snap('quota'), rounds: SPINNING, answer: fence(verdict('stop')) });
    const out = await triageParkedTasks(stop.deps);
    expect(out.acted[0]?.action).toBe('stop');
    expect(stop.abandoned).toHaveLength(1);
    expect(stop.abandoned[0]?.reason).toContain('空转');
  });

  it('额度超预算·回合没读到：不当成没空转，继续不放行，只写诊断', async () => {
    const r = rig({ snap: snap('quota'), rounds: null, answer: fence(verdict('continue')) });
    await triageParkedTasks(r.deps);
    expect(r.sent).toHaveLength(0);
    expect(r.notices[0]?.body).toContain('判不了空转');
  });

  it('体量超预算·拆单：开 2 张子单（带需求标签、写明从原单拆出）、原来这一代收尾；拆单数不对拒绝', async () => {
    const ok = rig({
      snap: snap('size', { title: '体量超预算' }),
      answer: fence(verdict('split', { subtasks: SUBS })),
    });
    const out = await triageParkedTasks(ok.deps);
    expect(out.acted[0]?.action).toBe('split');
    expect(ok.opened).toHaveLength(2);
    expect(ok.opened[0]?.labels).toEqual(['需求']);
    expect(ok.opened[0]?.body).toContain('#3296');
    expect(ok.abandoned).toHaveLength(1);
    expect(ok.abandoned[0]?.reason).toContain('#4001');
    expect(ok.notices[0]?.body).toContain('#4001、#4002');

    const one = rig({
      snap: snap('size', { title: '体量超预算' }),
      answer: fence(verdict('split', { subtasks: SUBS.slice(0, 1) })),
    });
    await triageParkedTasks(one.deps);
    expect(one.opened).toHaveLength(0);
    expect(one.abandoned).toHaveLength(0);
    expect(one.notices[0]?.body).toContain('2~5');
  });

  it('拆单里有子单格式不对（缺 done）：整个不执行，不开一张', async () => {
    const r = rig({
      snap: snap('size'),
      answer: fence(verdict('split', { subtasks: [SUBS[0], { title: '缺东西', scene: '没有 done' }] })),
    });
    await triageParkedTasks(r.deps);
    expect(r.opened).toHaveLength(0);
    expect(r.abandoned).toHaveLength(0);
    expect(r.notices[0]?.body).toContain('格式不对');
  });

  it('改标准、没权限这类人闸：继续、重做都不执行，只写诊断建议；留给人放行', async () => {
    for (const kind of ['standard', 'other'] as const) {
      for (const action of ['continue', 'redo', 'split', 'stop']) {
        const r = rig({
          snap: snap(kind, { title: '改标准路径要人拍' }),
          answer: fence(verdict(action, { subtasks: SUBS })),
        });
        const out = await triageParkedTasks(r.deps);
        expect(out.acted, `${kind}/${action}`).toEqual([]);
        expect(r.sent).toHaveLength(0);
        expect(r.redone).toHaveLength(0);
        expect(r.abandoned).toHaveLength(0);
        expect(r.opened).toHaveLength(0);
        expect(r.notices[0]?.body).toContain('不放行');
        expect(r.notices[0]?.body).toContain('理由：测试里的诊断文字');
      }
      const leave = rig({ snap: snap(kind), answer: fence(verdict('leave')) });
      const out = await triageParkedTasks(leave.deps);
      expect(out.left).toHaveLength(1);
      expect(leave.notices[0]?.level).toBe('alert');
      expect(leave.notices[0]?.body).toContain('请人看一眼');
    }
  });

  it('会话交了白名单外的裁决：不执行，提醒写明不在白名单', async () => {
    for (const action of ['merge', 'close', 'force-push', 'delete']) {
      const r = rig({ answer: fence(verdict(action)) });
      const out = await triageParkedTasks(r.deps);
      expect(out.acted, action).toEqual([]);
      expect(r.sent).toHaveLength(0);
      expect(r.redone).toHaveLength(0);
      expect(r.abandoned).toHaveLength(0);
      expect(r.acts).toHaveLength(0);
      expect(r.notices[0]?.body).toContain('不在白名单里');
    }
  });

  it('会话没给这张单裁决、回答里没有清单、裁决带的停下编号对不上：都不执行', async () => {
    const none = rig({ answer: fence({ summary: '没看', verdicts: [] }) });
    await triageParkedTasks(none.deps);
    expect(none.sent).toHaveLength(0);
    expect(none.notices[0]?.body).toContain('没给裁决');

    const noFence = rig({ answer: '我觉得继续吧' });
    await triageParkedTasks(noFence.deps);
    expect(noFence.sent).toHaveLength(0);
    expect(noFence.notices[0]?.body).toContain('找不到裁决清单');

    const stale = rig({ answer: fence(verdict('continue', {}, { parkSeq: 1 })) });
    await triageParkedTasks(stale.deps);
    expect(stale.sent).toHaveLength(0);
    expect(stale.notices[0]?.body).toContain('对不上');
  });

  it('每张单只许一个裁决：会话对同一张单交了两个，一个都不执行', async () => {
    const two = {
      summary: '',
      verdicts: [
        { issue: 3296, parkSeq: 2, action: 'continue', reason: '先继续' },
        { issue: 3296, parkSeq: 2, action: 'redo', reason: '又重做' },
      ],
    };
    const r = rig({ answer: fence(two) });
    await triageParkedTasks(r.deps);
    expect(r.sent).toHaveLength(0);
    expect(r.redone).toHaveLength(0);
    expect(r.notices[0]?.body).toContain('只许交一个裁决');
  });

  it('执行前再问一次：会话跑的时候人已经点了继续（不再停着），不执行', async () => {
    let calls = 0;
    const r = rig({
      answer: fence(verdict('continue')),
      over: {
        status: async () => {
          calls += 1;
          return calls === 1 ? snap('rounds') : snap('rounds', { seq: 3 });
        },
      },
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([]);
    expect(r.sent).toHaveLength(0);
  });

  it('操作记录先于动手：记不进就不发继续，交人', async () => {
    const r = rig({
      answer: fence(verdict('continue')),
      over: {
        audit: async () => {
          throw new Error('库连不上');
        },
      },
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([]);
    expect(r.sent).toHaveLength(0);
    expect(r.notices[0]?.body).toContain('操作记录没写进');
  });

  it('执行没成（重做被拒）：记一条失败的操作记录，任务不动，提醒写明', async () => {
    const r = rig({
      answer: fence(verdict('redo')),
      over: { redoTask: async () => ({ ok: false, why: '上一代还在跑' }) },
    });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([]);
    expect(r.acts.map((a) => [a.action, a.ok])).toEqual([
      ['redo', true],
      ['redo', false],
    ]);
    expect(r.notices[0]?.body).toContain('上一代还在跑');
  });
});

describe('会话的回答和提示词', () => {
  it('parseCommanderAnswer：格式不对的条目进 rejected，别的照办', () => {
    const got = parseCommanderAnswer(
      fence({
        summary: '总结',
        verdicts: [
          { issue: 1, parkSeq: 1, action: 'continue', reason: '好' },
          { issue: 'x', parkSeq: 1, action: 'continue', reason: '坏' },
          { issue: 2, parkSeq: 1, action: 'redo' },
        ],
      }),
    );
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.verdicts.map((v) => v.issue)).toEqual([1]);
      expect(got.rejected).toHaveLength(2);
      expect(got.summary).toBe('总结');
    }
  });

  it('提示词写明每张单每个动作放不放行（空转的不放行继续），并带上引擎的空转判断', async () => {
    const r = rig({ snap: snap('quota', { title: 'token 额度超预算' }), rounds: SPINNING });
    await triageParkedTasks(r.deps);
    const prompt = r.sessions[0]?.prompt ?? '';
    expect(prompt).toContain('continue（继续）：不放行');
    expect(prompt).toContain('redo（重做）：放行');
    expect(prompt).toContain('判成空转');
    expect(prompt).toContain('没有 GitHub 令牌');
    expect(renderParkTriagePrompt({ repo: 'a/b', items: [], mainHead: 'f'.repeat(40), now: NOW })).toContain(
      'a/b',
    );
  });
});

describe('定时任务这一轮的记账', () => {
  it('跑完记 ok，执行几张、留给人几张写在 why 里', async () => {
    const r = rig({ answer: fence(verdict('continue')) });
    const result = await runParkTriageJob(r.deps);
    expect(result.outcome).toBe('ok');
    expect(r.finished).toEqual([result]);
    expect(result.outcome === 'ok' && result.why).toContain('执行 1 张');
  });

  it('列不出停着的任务：记 failed 再抛', async () => {
    const r = rig({
      over: {
        tasks: async () => {
          throw new Error('库连不上');
        },
      },
    });
    await expect(runParkTriageJob(r.deps)).rejects.toThrow('库连不上');
    expect(r.finished[0]?.outcome).toBe('failed');
  });
});
