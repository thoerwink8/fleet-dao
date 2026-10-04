// 测试用的假 GitHub（内存里的里程碑、单子、子单）：计划（plan-view）和对账（github-audit）的测试共用，不打真接口。
import type { GitHubReader, MilestoneDetail, PlanIssue } from '../src/github-api.ts';

export const V1 = 'v1 Fusion 接活';
export const V0 = 'v0 试跑';

export function issue(number: number, extra: Partial<PlanIssue> = {}): PlanIssue {
  return {
    number,
    title: `单 ${number}`,
    state: 'open',
    isPr: false,
    createdAt: '2026-09-26T00:00:00Z',
    labels: ['需求'],
    milestone: null,
    stateReason: null,
    subIssues: 0,
    subIssuesDone: 0,
    ...extra,
  };
}

export function milestone(
  number: number,
  title: string,
  description: string,
  extra: Partial<MilestoneDetail> = {},
): MilestoneDetail {
  return { number, title, state: 'open', description, closedAt: null, ...extra };
}

/** 版本里程碑说明里的先后段。 */
export const order = (...ns: number[]) =>
  ['<!-- fleet:order -->', ...ns.map((n, i) => `${i + 1}. #${n}`), '<!-- /fleet:order -->'].join('\n');

export interface World {
  milestones: MilestoneDetail[];
  issues: PlanIssue[];
  /** 母单 → 子单号，按 GitHub 上排的先后。 */
  subs: Record<number, number[]>;
}

export type Method = keyof GitHubReader;

/** 假 GitHub：按 world 回；fail 里的那几样一调就抛；reverse 时把没有先后意义的列表倒过来回（子单的顺序不动）。 */
export function fakeReader(
  w: World,
  opts: { fail?: Partial<Record<Method, Error>>; reverse?: boolean } = {},
) {
  const calls: Method[] = [];
  const flip = <T>(xs: T[]) => (opts.reverse ? [...xs].reverse() : xs);
  const hit = (m: Method) => {
    calls.push(m);
    const e = opts.fail?.[m];
    if (e) throw e;
  };
  const find = (n: number) => {
    const found = w.issues.find((i) => i.number === n);
    if (!found) throw new Error(`假数据里没有 #${n}`);
    return found;
  };
  const reader: GitHubReader = {
    async openIssues() {
      hit('openIssues');
      return flip(w.issues.filter((i) => i.state === 'open'));
    },
    async issue(n) {
      hit('issue');
      return w.issues.find((i) => i.number === n);
    },
    async milestones() {
      hit('milestones');
      return flip(w.milestones);
    },
    async milestoneIssues(n) {
      hit('milestoneIssues');
      const title = w.milestones.find((m) => m.number === n)?.title;
      return flip(w.issues.filter((i) => i.milestone === title));
    },
    async subIssues(n) {
      hit('subIssues');
      return (w.subs[n] ?? []).map(find);
    },
  };
  return { reader, calls };
}
