// 派不派一张单的边界表（0003 第 2、4、8 条；design 第九节「在哪能做与接活开关」）：开关这一道（关着、开关打开以前开的、
// 排队中、结束的、重开）、版本这一道（只派当前版本：未排期、别的版本、关了的里程碑、认不出版本号都不派）、母单子单这一道
// （#252 之前母单、子单都不自动派），人明说交给 fleet（在跑的不重复起、结束的只有重开过才再起、关着的和 PR 拒）。
import { describe, expect, it } from 'vitest';
import {
  autoDispatchGate,
  currentVersion,
  dispatchDecision,
  familyGate,
  handoverDecision,
  type IssueFamily,
  type IssueNow,
  type MilestoneRef,
  milestoneVersion,
  versionGate,
} from '../src/dispatch.ts';

const T0 = Date.parse('2026-09-27T08:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const on = { autoDispatchSince: at(-60) };

const V1: MilestoneRef = { number: 8, title: 'v1 Fusion 接活' };
const V2: MilestoneRef = { number: 9, title: 'v2 引擎打磨：环节可配、检验制度、经验库' };
const P1: MilestoneRef = { number: 2, title: 'P1 核心闭环' };
const BACKLOG: MilestoneRef = { number: 11, title: 'backlog 攒着的' };

describe('开关这一道', () => {
  it('关着不派；开关以前开的不派；排队中的派；已结束的只在重开时派；在跑的不再派；建立时刻认不出不派', () => {
    expect(dispatchDecision({ autoDispatchSince: null }, at(0), { state: 'queued' }, false)).toBe(
      'dispatch_off',
    );
    expect(dispatchDecision(on, at(-61), { state: 'queued' }, false)).toBe('opened_before_switch');
    expect(dispatchDecision(on, at(-60), { state: 'queued' }, false)).toBe('start');
    expect(dispatchDecision(on, at(0), { state: 'done' }, false)).toBe('finished');
    expect(dispatchDecision(on, at(0), { state: 'running' }, false)).toBe('in_progress');
    expect(dispatchDecision(on, 'yesterday', { state: 'queued' }, false)).toBe('created_at_unreadable');
  });

  it('重开：已结束的、还在排队的再拉起；正在做的等它结束；开关照样先看', () => {
    expect(dispatchDecision(on, at(0), { state: 'failed' }, true)).toBe('restart');
    expect(dispatchDecision(on, at(0), { state: 'stopped' }, true)).toBe('restart');
    expect(dispatchDecision(on, at(0), { state: 'queued' }, true)).toBe('restart');
    expect(dispatchDecision(on, at(0), { state: 'running' }, true)).toBe('wait_previous_run');
    expect(dispatchDecision(on, at(0), { state: 'triaging' }, true)).toBe('wait_previous_run');
    expect(dispatchDecision(on, at(-61), { state: 'failed' }, true)).toBe('opened_before_switch');
    expect(dispatchDecision({ autoDispatchSince: null }, at(0), { state: 'running' }, true)).toBe(
      'dispatch_off',
    );
  });
});

describe('版本这一道：当前版本 = 还开着的 v<N> 里程碑里 N 最小的那个', () => {
  it('版本号只认「v<N>」开头：旧的 P 阶段、v1.5、大写 V、没有数字的都认不出', () => {
    expect(milestoneVersion('v1 Fusion 接活')).toBe(1);
    expect(milestoneVersion('  v12 以后的  ')).toBe(12);
    expect(milestoneVersion('v3')).toBe(3);
    for (const title of ['P1 核心闭环', 'v1.5 小修', 'V2 大写', 'v 没数字', 'version 2', 'backlog', ''])
      expect(milestoneVersion(title), title).toBeUndefined();
  });

  it('当前版本取 N 最小的开着的那个，不看列表先后；不是版本的里程碑不算；一个都没有是 null', () => {
    expect(currentVersion([V2, BACKLOG, V1])).toEqual({ version: 1, milestone: V1 });
    expect(currentVersion([BACKLOG, V2])).toEqual({ version: 2, milestone: V2 });
    expect(currentVersion([BACKLOG])).toBeNull();
    expect(currentVersion([])).toBeNull();
  });

  it('挂在当前版本上：派，带上按哪个版本派的', () => {
    expect(versionGate({ milestone: V1, openMilestones: [V1, V2] })).toEqual({
      ok: true,
      version: 1,
      milestone: 'v1 Fusion 接活',
    });
    // 里程碑刚改过名：以现读的还开着的那份为准（按编号对上）
    expect(versionGate({ milestone: { number: 8, title: '旧名字' }, openMilestones: [V1] })).toMatchObject({
      ok: true,
      milestone: 'v1 Fusion 接活',
    });
  });

  it('【故意造出的失败】未排期（没挂里程碑）：不派，写明未排期和当前版本是哪个', () => {
    const got = versionGate({ milestone: null, openMilestones: [V1, V2] });
    expect(got).toMatchObject({ ok: false, reason: 'unscheduled' });
    if (got.ok) throw new Error('未排期的单不该派');
    expect(got.why).toContain('未排期');
    expect(got.why).toContain('当前版本是「v1 Fusion 接活」');
  });

  it('【故意造出的失败】挂在 v2 上（v1 还开着）：不派，写明挂在哪、当前版本是哪个', () => {
    const got = versionGate({ milestone: V2, openMilestones: [V1, V2] });
    expect(got).toMatchObject({ ok: false, reason: 'not_current_version' });
    if (got.ok) throw new Error('v2 的单不该派');
    expect(got.why).toContain('「v2 引擎打磨');
    expect(got.why).toContain('当前版本是「v1 Fusion 接活」');
  });

  it('v1 关了以后 v2 就是当前版本：挂在 v2 上的派', () => {
    expect(versionGate({ milestone: V2, openMilestones: [V2, BACKLOG] })).toMatchObject({
      ok: true,
      version: 2,
    });
  });

  it('【故意造出的失败】挂在已经关了的里程碑上（旧的 P1、做完的版本）：不派', () => {
    for (const closed of [P1, V1]) {
      const got = versionGate({ milestone: closed, openMilestones: [V2] });
      expect(got, closed.title).toMatchObject({ ok: false, reason: 'not_current_version' });
      if (got.ok) throw new Error('关了的里程碑上的单不该派');
      expect(got.why).toContain('已经关了');
    }
    // 连一个还开着的版本都没有：写明没有当前版本
    const none = versionGate({ milestone: P1, openMilestones: [] });
    if (none.ok) throw new Error('没有当前版本时不该派');
    expect(none.why).toContain('没有当前版本');
  });

  it('【故意造出的失败】挂的里程碑认不出版本号：不派，说「没查成」，不当成当前版本', () => {
    const got = versionGate({ milestone: BACKLOG, openMilestones: [BACKLOG, V1] });
    expect(got).toMatchObject({ ok: false, reason: 'version_unreadable' });
    if (got.ok) throw new Error('认不出版本号的不该派');
    expect(got.why).toMatch(/^没查成：里程碑「backlog 攒着的」认不出版本号/);
    // 仓里只有它一个开着的里程碑、没有当前版本，也一样不当成当前版本
    expect(versionGate({ milestone: BACKLOG, openMilestones: [BACKLOG] })).toMatchObject({
      ok: false,
      reason: 'version_unreadable',
    });
  });
});

describe('母单、子单这一道（#252 之前：一张单只走一块，母单和子单各起一条会抢同一批文件）', () => {
  const alone: IssueFamily = { labels: ['需求'], parent: null, subIssues: 0 };

  it('独立的单（不是母单、不挂在别的单下面）：过', () => {
    expect(familyGate(alone)).toEqual({ ok: true });
  });

  it('【故意造出的失败】贴了「母单」标签的、下面挂着子单的（标签漏贴也算）：不派，原因 mother_ticket', () => {
    for (const mother of [
      { ...alone, labels: ['需求', '母单'] },
      { ...alone, subIssues: 3 },
    ]) {
      const got = familyGate(mother);
      expect(got, JSON.stringify(mother)).toMatchObject({ ok: false, reason: 'mother_ticket' });
      if (got.ok) throw new Error('母单不该派');
      expect(got.why).toContain('fleet-api handover');
      expect(got.why).toContain('#252');
    }
  });

  it('【故意造出的失败】挂在别的单下面的子单：不派，原因 sub_issue，写明挂在哪张下面', () => {
    const got = familyGate({ ...alone, parent: 192 });
    expect(got).toMatchObject({ ok: false, reason: 'sub_issue' });
    if (got.ok) throw new Error('子单不该派');
    expect(got.why).toMatch(/^是 #192 下面的子单/);
  });

  it('两道合起来：先看版本，再看母单子单；都过了带上按哪个版本派的', () => {
    const plan = { milestone: V1, openMilestones: [V1, V2] };
    expect(autoDispatchGate({ ...plan, ...alone })).toEqual({ ok: true, version: 1, milestone: V1.title });
    expect(autoDispatchGate({ ...plan, ...alone, parent: 192 })).toMatchObject({
      ok: false,
      reason: 'sub_issue',
    });
    // 未排期的母单：先报未排期
    expect(autoDispatchGate({ ...plan, milestone: null, ...alone, labels: ['母单'] })).toMatchObject({
      ok: false,
      reason: 'unscheduled',
    });
  });
});

describe('交给 fleet：人替开关打开以前、别的版本、未排期那两道放行，任务和 issue 的规矩照旧', () => {
  const open: IssueNow = { state: 'open', reopened: false, pullRequest: false };
  const reopened: IssueNow = { state: 'open', reopened: true, pullRequest: false };
  const closed: IssueNow = { state: 'closed', reopened: false, pullRequest: false };

  it('还在排队（从没派过）、GitHub 上开着：拉起', () => {
    expect(handoverDecision({ state: 'queued' }, open)).toEqual({ act: 'start' });
  });

  it('在跑的（哪一步都算）：不重复起；【故意造出的失败】GitHub 上已经关了的，哪怕任务还在跑也拒（关单会叫停它）', () => {
    for (const state of ['triaging', 'asking', 'planning', 'running', 'merging', 'stalled'] as const) {
      expect(handoverDecision({ state }, open), state).toMatchObject({ act: 'noop' });
      expect(handoverDecision({ state }, reopened), state).toMatchObject({ act: 'noop' });
      expect(handoverDecision({ state }, closed), state).toMatchObject({
        act: 'refuse',
        reason: 'issue_closed',
      });
    }
  });

  it('已经结束的：GitHub 上重开过才再起一轮；没重开的拒，写明怎么再做一轮', () => {
    for (const state of ['done', 'stopped', 'failed'] as const) {
      expect(handoverDecision({ state }, reopened), state).toEqual({ act: 'restart' });
      const got = handoverDecision({ state }, open);
      expect(got, state).toMatchObject({ act: 'refuse', reason: 'finished' });
      if (got.act !== 'refuse') throw new Error('没重开的结束任务不该再起');
      expect(got.why).toContain('先在 GitHub 上重开');
    }
  });

  it('GitHub 上关着的：不派；这个号其实是 PR：不派', () => {
    expect(handoverDecision({ state: 'queued' }, closed)).toMatchObject({
      act: 'refuse',
      reason: 'issue_closed',
    });
    expect(handoverDecision({ state: 'done' }, closed)).toMatchObject({
      act: 'refuse',
      reason: 'issue_closed',
    });
    expect(handoverDecision({ state: 'queued' }, { ...open, pullRequest: true })).toMatchObject({
      act: 'refuse',
      reason: 'pull_request',
    });
  });
});
