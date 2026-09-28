// 提醒是一件活（design 15.3「谁在处理」）：谁在处理 = 跟进单上的认领，状态从认领、PR、发布记录现算（只给驾驶舱看，
// #445 起 `alert show` 不显示，也不会再没人认领、停太久就自动升级或开单——那一层已经删掉）。
import { describe, expect, it } from 'vitest';
import {
  type AlertRef,
  type AlertSilence,
  type AlertWorkFacts,
  activeSilence,
  alertHandling,
  type DeployFacts,
  deployStateOf,
  type FixPr,
  silenceMinutes,
  silenceProblem,
  type WorkIssue,
} from '../src/alert-work.ts';
import type { IssueClaim } from '../src/seat.ts';

const T0 = '2026-09-27T12:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const ID = '11111111-2222-4333-8444-555555555555';

const alert = (over: Partial<AlertRef> = {}): AlertRef => ({
  id: ID,
  dedupeKey: 'watchdog:job:backup:after-12',
  level: 'alert',
  taskId: null,
  title: '定时任务「备份」没跑成',
  body: '最近一次没跑成：磁盘满了',
  link: '/schedules',
  createdAt: at(0),
  updatedAt: at(0),
  resolvedAt: null,
  resolvedBy: null,
  ...over,
});

const work: WorkIssue = {
  repoId: 'r1',
  repo: 'owner/fleet-dao',
  issueNumber: 342,
  source: 'engine',
  linkedBy: 'engine:alert-dispatch',
  linkedAt: at(21),
};

const claim = (over: Partial<IssueClaim> = {}): IssueClaim => ({
  repoId: 'r1',
  issueNumber: 342,
  claimId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  ownerKind: 'worker',
  ownerMachine: '本机',
  ownerLabel: '工人A',
  seatScope: 'main',
  seatTerm: 3,
  state: 'doing',
  workflowId: null,
  prNumbers: [],
  graceMinutes: 120,
  claimedAt: at(10),
  heartbeatAt: at(30),
  updatedAt: at(30),
  endedAt: null,
  endReason: null,
  note: '在查磁盘',
  ...over,
});

const pr = (over: Partial<FixPr> = {}): FixPr => ({
  repo: 'owner/fleet-dao',
  number: 350,
  state: 'open',
  openedAt: at(40),
  mergedAt: null,
  mergeSha: null,
  updatedAt: at(41),
  via: ['alert'],
  ...over,
});

const facts = (over: Partial<AlertWorkFacts> = {}): AlertWorkFacts => ({
  alert: alert(),
  work: null,
  claim: null,
  prs: [],
  silences: [],
  ...over,
});

const SHA = (c: string) => c.repeat(40);
const deploy = (over: Partial<Extract<DeployFacts, { ok: true }>> = {}): DeployFacts => ({
  ok: true,
  currentSha: SHA('b'),
  // 新的在前（git log --first-parent）
  commits: [
    [SHA('c'), at(90)],
    [SHA('b'), at(80)],
    [SHA('a'), at(70)],
  ],
  checkedAt: at(95),
  deployedAt: at(85),
  ...over,
});

describe('静默（Alertmanager 式：谁、为什么、必带到期）', () => {
  const silence = (over: Partial<AlertSilence> = {}): AlertSilence => ({
    id: 's1',
    matchKind: 'key',
    match: 'pool-hold:claude-solo',
    comment: '创始人 09-27 晚拍：法国暂时不用独享号',
    createdBy: '本机/帅位',
    createdAt: at(0),
    endsAt: at(60),
    expiredAt: null,
    expiredBy: null,
    ...over,
  });

  it('对得上键、在期内的才管用；几条取到期最晚的', () => {
    const a = silence();
    const b = silence({ id: 's2', matchKind: 'prefix', match: 'pool-hold:', endsAt: at(120) });
    expect(activeSilence([a, b], 'pool-hold:claude-solo', at(30))?.id).toBe('s2');
    expect(activeSilence([a], 'pool-hold:claude-team', at(30))).toBeNull();
    expect(activeSilence([a], 'pool-hold:claude-solo', at(60))).toBeNull();
    expect(
      activeSilence(
        [silence({ expiredAt: at(10), expiredBy: '本机/帅位' })],
        'pool-hold:claude-solo',
        at(30),
      ),
    ).toBeNull();
  });

  it('【故意造出的失败】不带到期、超过 7 天、没写为什么、前缀太宽：一律拒，写明为什么', () => {
    const ok = { matchKind: 'key' as const, match: 'pool-hold:x', comment: '创始人拍的', minutes: 60 };
    expect(silenceProblem(ok)).toBeNull();
    expect(silenceProblem({ ...ok, minutes: 7 * 24 * 60 + 1 })).toMatch(/最长 7 天/);
    expect(silenceProblem({ ...ok, minutes: 0 })).toMatch(/要带到期/);
    expect(silenceProblem({ ...ok, comment: '  ' })).toMatch(/要写为什么/);
    expect(silenceProblem({ ...ok, matchKind: 'prefix', match: 'p:' })).toMatch(/不许把全部提醒都静默了/);
    expect(silenceProblem({ ...ok, matchKind: 'prefix', match: 'pool-hold' })).toMatch(/要以冒号结尾/);
    expect(silenceProblem({ ...ok, match: 'a b' })).toMatch(/不带空白/);
  });

  it('到期：+30m、+2h、+3d 从库的现在算；带时区的时刻；认不出、已经过了的明说', () => {
    expect(silenceMinutes('+30m', T0)).toBe(30);
    expect(silenceMinutes('2h', T0)).toBe(120);
    expect(silenceMinutes('+3d', T0)).toBe(3 * 24 * 60);
    expect(silenceMinutes('2026-09-27T21:00+08:00', T0)).toBe(60);
    expect(silenceMinutes('明天', T0)).toMatch(/认不出到期/);
    expect(silenceMinutes('2026-09-27T20:00', T0)).toMatch(/带时区/);
    expect(silenceMinutes('2026-09-27T19:00+08:00', T0)).toMatch(/已经过了/);
  });
});

describe('发布了没有：合并提交在不在在用的那版里（主线第一父链，新的在前）', () => {
  it('比在用的老或就是它：已发布；比它新：还没发布', () => {
    expect(deployStateOf(SHA('a'), at(70), deploy(), at(100))).toEqual({ state: 'deployed', at: at(85) });
    expect(deployStateOf(SHA('b'), at(80), deploy(), at(100))).toEqual({ state: 'deployed', at: at(85) });
    expect(deployStateOf(SHA('c'), at(90), deploy(), at(100))).toEqual({ state: 'not_yet' });
  });

  it('合并提交比列表里最老的还老：在用的那版一定包含它', () => {
    expect(deployStateOf(SHA('0'), at(10), deploy(), at(100))).toEqual({ state: 'deployed', at: at(85) });
  });

  it('【故意造出的失败】读不到、读数旧了、在用的不在列表里、合并提交对不上：判不了，写明为什么，不猜', () => {
    expect(deployStateOf(SHA('a'), at(70), null, at(100))).toMatchObject({
      state: 'unknown',
      why: expect.stringMatching(/只在法国/),
    });
    expect(deployStateOf(SHA('a'), at(70), { ok: false, why: '状态文件读不出来' }, at(100))).toEqual({
      state: 'unknown',
      why: '状态文件读不出来',
    });
    expect(deployStateOf(SHA('a'), at(70), deploy(), at(200))).toMatchObject({
      state: 'unknown',
      why: expect.stringMatching(/没更新了/),
    });
    expect(deployStateOf(SHA('a'), at(70), deploy({ currentSha: SHA('9') }), at(100))).toMatchObject({
      state: 'unknown',
      why: expect.stringMatching(/不在主线最近的提交里/),
    });
    expect(deployStateOf(SHA('d'), at(95), deploy(), at(100))).toMatchObject({
      state: 'unknown',
      why: expect.stringMatching(/没合进默认分支/),
    });
    expect(deployStateOf(null, at(95), deploy(), at(100))).toMatchObject({ state: 'unknown' });
  });
});

describe('谁在处理、到哪一步了（读时现算）', () => {
  it('没挂单、没人在修：没人在修，从报的时刻算起', () => {
    const h = alertHandling(facts(), null, at(25));
    expect(h).toMatchObject({ stage: 'unclaimed', since: at(0), who: null, episode: 'first' });
    expect(h.line).toBe('没人在修 · 25 分钟');
  });

  it('本机认领了跟进单：谁、哪张单、一句进度、多久了', () => {
    const h = alertHandling(facts({ work, claim: claim() }), null, at(40));
    expect(h).toMatchObject({
      stage: 'claimed',
      who: '本机/工人A',
      since: at(10),
      stageRef: 'claimed-aaaaaaaa',
    });
    expect(h.line).toBe('本机/工人A 在处理 · owner/fleet-dao#342 · 在查磁盘 · 30 分钟');
  });

  it('【故意造出的失败】跟进单的认领在引擎手里（引擎自己卡住才报的）：不算有人在处理，单列 engine_stuck', () => {
    const engineClaim = claim({
      ownerKind: 'engine',
      ownerMachine: null,
      ownerLabel: null,
      workflowId: 'req:x#293',
    });
    const h = alertHandling(
      facts({ alert: alert({ taskId: 't1' }), work: { ...work, source: 'task' }, claim: engineClaim }),
      null,
      at(47),
    );
    expect(h.stage).toBe('engine_stuck');
    expect(h.who).toBe('引擎');
    expect(h.line).toMatch(/^没人接手：引擎拿着/);
  });

  it('认领作废了：回到没人在修，从作废那一刻算新的一段', () => {
    const voided = claim({ state: 'voided', endedAt: at(130), endReason: '过了宽限期（120 分钟）没心跳' });
    const h = alertHandling(facts({ work, claim: voided }), null, at(140));
    expect(h).toMatchObject({ stage: 'unclaimed', since: at(130), episode: 'after-aaaaaaaa' });
    expect(h.line).toMatch(/上一份认领作废了：过了宽限期/);
  });

  it('PR 开着先于认领；合了看发布；开着的先于合了的（还在往下修）', () => {
    expect(alertHandling(facts({ work, claim: claim(), prs: [pr()] }), null, at(50))).toMatchObject({
      stage: 'pr_open',
      who: '本机/工人A',
      since: at(40),
      stageRef: 'pr_open-350',
    });
    const merged = pr({ state: 'merged', mergedAt: at(75), mergeSha: SHA('a') });
    expect(alertHandling(facts({ prs: [merged] }), deploy(), at(100))).toMatchObject({
      stage: 'deployed',
      who: 'PR #350',
      since: at(85),
      stageRef: `deployed-${SHA('a').slice(0, 12)}`,
    });
    const notYet = pr({ state: 'merged', mergedAt: at(88), mergeSha: SHA('c') });
    expect(alertHandling(facts({ prs: [notYet] }), deploy(), at(100))).toMatchObject({
      stage: 'merged',
      since: at(88),
    });
    expect(alertHandling(facts({ prs: [merged, pr({ number: 351 })] }), deploy(), at(100))).toMatchObject({
      stage: 'pr_open',
      pr: { number: 351 },
    });
  });

  it('【故意造出的失败】合了、发布判不了：停在「合进主线」，写明没查成，不当成已发布', () => {
    const merged = pr({ state: 'merged', mergedAt: at(75), mergeSha: SHA('a') });
    const h = alertHandling(facts({ prs: [merged] }), { ok: false, why: '状态文件认不出' }, at(100));
    expect(h.stage).toBe('merged');
    expect(h.problems).toEqual(['发布判不了：状态文件认不出']);
    expect(h.line).toMatch(/发布没查成/);
  });

  it('要创始人拍的：等创始人拍；静默压过一切；已撤写谁撤的', () => {
    expect(alertHandling(facts({ alert: alert({ level: 'decision' }) }), null, at(5)).stage).toBe(
      'waiting_founder',
    );
    const s: AlertSilence = {
      id: 's1',
      matchKind: 'prefix',
      match: 'watchdog:job:backup:',
      comment: '备份盘在换',
      createdBy: '本机/帅位',
      createdAt: at(1),
      endsAt: at(600),
      expiredAt: null,
      expiredBy: null,
    };
    expect(alertHandling(facts({ silences: [s], claim: claim(), work }), null, at(30))).toMatchObject({
      stage: 'silenced',
      who: '本机/帅位',
    });
    expect(
      alertHandling(
        facts({ alert: alert({ resolvedAt: at(9), resolvedBy: 'engine:watchdog' }) }),
        null,
        at(30),
      ),
    ).toMatchObject({ stage: 'resolved', who: 'engine:watchdog' });
  });
});
