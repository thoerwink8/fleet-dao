// 派不派一张单的边界表（design 第九节「在哪能做与接活开关」）：认版本（当前版本 = 还开着的 v<N> 里程碑里 N 最小的）、
// 母单子单这一道（#252 之前母单、子单都不自动派）、本机做这一道（#299 止血：贴了「本机做」的不自动派）。
// 「挂在当前版本上」「未排期不碰」两道随 #1336 删了（引擎自己挑单，版本只影响排序）；「开关、开单时间」和「人明说交给 fleet」
// 两道随旧接活删了（#901 审查：只有测试在引用）。
import { describe, expect, it } from 'vitest';
import {
  currentVersion,
  familyGate,
  type IssueFamily,
  localGate,
  type MilestoneRef,
  milestoneVersion,
} from '../src/dispatch.ts';

const V1: MilestoneRef = { number: 8, title: 'v1 Fusion 接活' };
const V2: MilestoneRef = { number: 9, title: 'v2 引擎打磨：环节可配、检验制度、经验库' };
const BACKLOG: MilestoneRef = { number: 11, title: 'backlog 攒着的' };

describe('认版本：当前版本 = 还开着的 v<N> 里程碑里 N 最小的那个', () => {
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
      expect(got.why).toContain('重开一张新单，不贴「本机做」、不是母单也不是子单');
      expect(got.why).toContain('#252');
    }
  });

  it('【故意造出的失败】挂在别的单下面的子单：不派，原因 sub_issue，写明挂在哪张下面', () => {
    const got = familyGate({ ...alone, parent: 192 });
    expect(got).toMatchObject({ ok: false, reason: 'sub_issue' });
    if (got.ok) throw new Error('子单不该派');
    expect(got.why).toMatch(/^是 #192 下面的子单/);
  });
});

describe('本机做这一道（#299 止血：帅位留给本机做的，认领进库之前靠标签挡）', () => {
  it('没贴「本机做」：过（别的标签不算）', () => {
    expect(localGate({ labels: ['需求'] })).toEqual({ ok: true });
    expect(localGate({ labels: [] })).toEqual({ ok: true });
    expect(localGate({ labels: ['本机'] })).toEqual({ ok: true });
  });

  it('【故意造出的失败】贴了「本机做」的独立单：自动派不派，原因 reserved_local，写明要重开一张新单交给引擎', () => {
    const got = localGate({ labels: ['需求', '本机做'] });
    expect(got).toMatchObject({ ok: false, reason: 'reserved_local' });
    if (got.ok) throw new Error('贴了「本机做」的单不该自动派');
    expect(got.why).toBe(
      '帅位留给本机做（贴着「本机做」）；要交给引擎，重开一张新单，不贴「本机做」、不是母单也不是子单',
    );
  });
});
