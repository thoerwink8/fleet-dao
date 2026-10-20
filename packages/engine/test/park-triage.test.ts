// 法国指挥官会话（#3294 第 2 片）：停了 15 分钟规则没解开的单交 commander 会话看，会话只交裁决，引擎白名单核了再执行。
// 假依赖测任务本身：选哪些单、护栏（每次停下一次、每天上限、开关、没配模型报警）、白名单放行/拒绝、诊断文字带进提醒；
// 真装配的开关、操作记录名下在 real/park-triage.test.ts。
import { describe, expect, it, vi } from 'vitest';
import { COMMANDER_ACTOR, ROUNDS_HANDOFF_TITLE } from '../src/commander-contract.ts';
import type { SpinRound } from '../src/decisions/spin.ts';
import type { GroomSessionOutcome } from '../src/jobs/groom.ts';
import type { IntakeRepo } from '../src/jobs/intake.ts';
import {
  COMMANDER_AUDIT_CLAIM,
  COMMANDER_WHITELIST_VERSION,
  type CommanderNotice,
  PARK_TRIAGE_DAILY_CAP,
  type ParkTriageDeps,
  runParkTriageJob,
  triageParkedTasks,
} from '../src/jobs/park-triage.ts';
import type { ParkedRetryRow, ParkedSnapshot } from '../src/jobs/parked-retry.ts';
import type { ContinueCommand, ParkKind } from '../src/task-contract.ts';

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
    audits?: { at: Date; action: string; after: unknown }[];
    over?: Partial<ParkTriageDeps>;
  } = {},
) {
  const r = {
    sessions: [] as Parameters<ParkTriageDeps['runSession']>[0][],
    sent: [] as ContinueCommand[],
    abandoned: [] as string[],
    redone: [] as string[],
    opened: [] as { title: string; body: string; labels: string[] }[],
    acts: [] as { action: string; ok: boolean }[],
    notices: [] as CommanderNotice[],
    audits: opts.audits ?? [],
    deps: undefined as unknown as ParkTriageDeps,
  };
  const answer = opts.answer ?? verdict('leave');
  r.deps = {
    enabled: async () => (opts.enabled === false ? { on: false, why: '设置关着' } : { on: true }),
    purposeConfigured: async () => opts.configured !== false,
    resolveNoModelAlert: vi.fn(async () => {}),
    tasks: async () => [ROW],
    status: async () => opts.snap ?? snap('rounds'),
    audits: async () => r.audits,
    claim: async ({ workflowId, park, whitelist }) => {
      r.audits.push({
        at: NOW,
        action: COMMANDER_AUDIT_CLAIM,
        after: { workflowId, parkSeq: park.seq, kind: park.kind, whitelist },
      });
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
      r.acts.push({ action: e.action, ok: e.ok });
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

  it('旧白名单下认领过的体量停点（#3207 park:1）再看一回：成果已在主线就停掉、撤停点；重看之后不再来第三次', async () => {
    const oldClaim = (kind: ParkKind, whitelist?: number) => ({
      at: new Date(NOW.getTime() - 2 * 24 * 3_600_000),
      action: COMMANDER_AUDIT_CLAIM,
      after: { workflowId: WF, parkSeq: 2, kind, ...(whitelist === undefined ? {} : { whitelist }) },
    });
    const r = rig({
      audits: [oldClaim('size')],
      snap: snap('size', { title: '改动超出体量预算：新增 9550 行，预算 3000 行，收窄过一次仍超' }),
      answer: verdict('stop', { mergedIn: '378af18f04b6e82c8a99ad8cb1f850edb0c34269' }),
    });
    const first = await triageParkedTasks(r.deps);
    expect(first.claimed).toBe(1);
    expect(first.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'stop' }]);
    expect(r.sessions[0]?.prompt).toContain('按旧白名单看过一次');
    expect(r.abandoned[0]).toContain('成果已在主线（378af18f04b6e82c8a99ad8cb1f850edb0c34269）');
    expect(r.audits.at(-1)?.after).toMatchObject({ kind: 'size', whitelist: COMMANDER_WHITELIST_VERSION });
    expect((await triageParkedTasks(r.deps)).candidates).toBe(0);
    expect(r.sessions).toHaveLength(1);
    // 新版本认领过的体量停点、旧认领的别的停法：照旧每次停下只看一回
    for (const audits of [[oldClaim('size', COMMANDER_WHITELIST_VERSION)], [oldClaim('rounds')]]) {
      const again = rig({ audits, snap: snap('size') });
      expect((await triageParkedTasks(again.deps)).candidates).toBe(0);
    }
  });

  it('会话没跑成也算处理过：提醒写明交人、不再来第二次', async () => {
    const r = rig({ answer: { ok: false, why: '会话超时' } });
    const out = await triageParkedTasks(r.deps);
    expect(out.left).toHaveLength(1);
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
    expect(out.acted).toEqual([{ ref: 'thoerwink8/fleet-dao#3296', action: 'continue' }]);
    expect(r.sent[0]).toMatchObject({ by: COMMANDER_ACTOR, parkSeq: 2 });
    expect(r.sent[0]?.widenBudget).toBeUndefined();
    expect(r.acts).toEqual([{ action: 'continue', ok: true }]);
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

  it('额度超预算·同一原因连续失败、没有新提交：判空转，拒绝原样继续，诊断带进提醒', async () => {
    const r = rig({ snap: snap('quota'), rounds: SPINNING, answer: verdict('continue') });
    const out = await triageParkedTasks(r.deps);
    expect(out.acted).toEqual([]);
    expect(r.sent).toHaveLength(0);
    expect(r.acts).toHaveLength(0);
    expect(r.notices[0]?.level).toBe('alert');
    expect(r.notices[0]?.body).toContain('不许原样继续');
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
  });

  it('体量超预算·成果已在主线（#3207）：带主线提交号的停掉放行，只放弃这一代、不开子单；没带提交号不执行', async () => {
    const ok = rig({ snap: snap('size'), answer: verdict('stop', { mergedIn: '378af18f' }) });
    expect((await triageParkedTasks(ok.deps)).acted).toHaveLength(1);
    expect(ok.opened).toHaveLength(0);
    expect(ok.abandoned).toHaveLength(1);
    expect(ok.abandoned[0]).toContain('成果已在主线（378af18f）');
    expect(ok.notices[0]?.body).toContain('成果已在主线 378af18f');
    const bare = rig({ snap: snap('size'), answer: verdict('stop') });
    expect((await triageParkedTasks(bare.deps)).acted).toEqual([]);
    expect(bare.abandoned).toHaveLength(0);
    expect(bare.notices[0]?.body).toContain('mergedIn');
  });

  it('改标准、没权限这类人闸：继续、重做、拆单、停掉都不执行，只写诊断建议；留给人放行', async () => {
    for (const kind of ['standard', 'other'] as const) {
      for (const action of ['continue', 'redo', 'split', 'stop']) {
        const r = rig({ snap: snap(kind), answer: verdict(action, { subtasks: SUBS }) });
        expect((await triageParkedTasks(r.deps)).acted, `${kind}/${action}`).toEqual([]);
        expect(r.sent.length + r.redone.length + r.abandoned.length + r.opened.length).toBe(0);
        expect(r.notices[0]?.body).toContain('不放行');
      }
      const leave = rig({ snap: snap(kind), answer: verdict('leave') });
      expect((await triageParkedTasks(leave.deps)).left).toHaveLength(1);
      expect(leave.notices[0]?.body).toContain('请人看一眼');
    }
  });

  it('会话交了白名单外的裁决：不执行，提醒写明不在白名单', async () => {
    for (const action of ['merge', 'close', 'force-push']) {
      const r = rig({ answer: verdict(action) });
      expect((await triageParkedTasks(r.deps)).acted, action).toEqual([]);
      expect(r.sent.length + r.redone.length + r.abandoned.length + r.acts.length).toBe(0);
      expect(r.notices[0]?.body).toContain('不在白名单里');
    }
  });

  it('会话没给裁决、停下编号对不上、对同一张单交了两个：都不执行', async () => {
    const none = rig({ answer: fence({ summary: '没看', verdicts: [] }) });
    await triageParkedTasks(none.deps);
    expect(none.notices[0]?.body).toContain('没给裁决');
    const stale = rig({ answer: verdict('continue', { parkSeq: 1 }) });
    await triageParkedTasks(stale.deps);
    expect(stale.notices[0]?.body).toContain('对不上');
    const two = [
      { issue: 3296, parkSeq: 2, action: 'continue', reason: '先继续' },
      { issue: 3296, parkSeq: 2, action: 'redo', reason: '又重做' },
    ];
    const dup = rig({ answer: fence({ summary: '', verdicts: two }) });
    await triageParkedTasks(dup.deps);
    expect(dup.notices[0]?.body).toContain('只许交一个裁决');
    expect(none.sent.length + stale.sent.length + dup.sent.length + dup.redone.length).toBe(0);
  });

  it('执行没成（重做被拒）：记一条失败的操作记录，任务不动，提醒写明', async () => {
    const r = rig({
      answer: verdict('redo'),
      over: { redoTask: async () => ({ ok: false, why: '上一代还在跑' }) },
    });
    expect((await triageParkedTasks(r.deps)).acted).toEqual([]);
    expect(r.acts).toEqual([
      { action: 'redo', ok: true },
      { action: 'redo', ok: false },
    ]);
    expect(r.notices[0]?.body).toContain('上一代还在跑');
  });
});
