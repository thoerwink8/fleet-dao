// 派不派一张单的边界表（design 第九节「在哪能做与接活开关」）：版本这一道（只派当前版本：未排期、别的版本、关了的里程碑、
// 认不出版本号都不派）、母单子单这一道（#252 之前母单、子单都不自动派）、本机做这一道（#299 止血：贴了「本机做」的不自动派）。
// 「开关、开单时间」和「人明说交给 fleet」两道随旧接活删了（#901 审查：只有测试在引用）。
import { describe, expect, it } from 'vitest';
import {
  autoDispatchGate,
  currentVersion,
  familyGate,
  type IssueFamily,
  localGate,
  type MilestoneRef,
  milestoneVersion,
  versionGate,
} from '../src/dispatch.ts';

const V1: MilestoneRef = { number: 8, title: 'v1 Fusion 接活' };
const V2: MilestoneRef = { number: 9, title: 'v2 引擎打磨：环节可配、检验制度、经验库' };
const P1: MilestoneRef = { number: 2, title: 'P1 核心闭环' };
const BACKLOG: MilestoneRef = { number: 11, title: 'backlog 攒着的' };

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
      expect(got.why).toContain('重开成挂在当前版本上的独立单');
      expect(got.why).toContain('指挥官重开');
      expect(got.why).not.toContain('fleet-api handover');
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

describe('本机做这一道（#299 止血：帅位留给本机做的，认领进库之前靠标签挡）', () => {
  const plan = { milestone: V1, openMilestones: [V1, V2], parent: null, subIssues: 0 };

  it('没贴「本机做」：过（别的标签不算）', () => {
    expect(localGate({ labels: ['需求'] })).toEqual({ ok: true });
    expect(localGate({ labels: [] })).toEqual({ ok: true });
    expect(localGate({ labels: ['本机'] })).toEqual({ ok: true });
  });

  it('【故意造出的失败】贴了「本机做」、挂在当前版本上的独立单：自动派不派，原因 reserved_local，写明先去掉标签，仍不拉就重开一张新单', () => {
    const got = autoDispatchGate({ ...plan, labels: ['需求', '本机做'] });
    expect(got).toMatchObject({ ok: false, reason: 'reserved_local' });
    if (got.ok) throw new Error('贴了「本机做」的单不该自动派');
    expect(got.why).toBe(
      '帅位留给本机做（贴着「本机做」）；要交给引擎，先去掉标签。去掉了仍不拉的（开关打开以前开的），重开一张新单（驾驶舱「交给 fleet」上线前由指挥官重开）',
    );
    expect(got.why).not.toContain('fleet-api handover');
  });

  it('不贴的照派；先看版本、母单子单，再看本机做', () => {
    expect(autoDispatchGate({ ...plan, labels: ['需求'] })).toEqual({
      ok: true,
      version: 1,
      milestone: V1.title,
    });
    expect(autoDispatchGate({ ...plan, milestone: null, labels: ['本机做'] })).toMatchObject({
      reason: 'unscheduled',
    });
    expect(autoDispatchGate({ ...plan, parent: 192, labels: ['本机做'] })).toMatchObject({
      reason: 'sub_issue',
    });
  });
});
