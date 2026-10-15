// 一张单有没有开着的 PR 在做（决定 0096）：引擎拉单、引擎开 PR 前、本机领单（pnpm work claim）、本机开 PR 前（pnpm pr:open）同一份认法。
// 挂法两种：「需求」栏（Closes / Refs #号，同仓的，认法是 issueColumnRefs）；分支是这张单的固定前缀 fleet/<单号>-（引擎）、
// local/<单号>-（本机）（issue-branch.ts）。
import { issueOfBranch } from './issue-branch.ts';
import { issueColumnRefs } from './pr-columns.ts';

export interface OpenPullRef {
  number: number;
  body: string;
  headRef?: string | undefined;
}

/** 开着的 PR 挂着哪些单：单号 → 挂着它的 PR 号（同一张单有几个 PR 挂，取号最小的）。 */
export function prClaimedIssues(pulls: readonly OpenPullRef[]): Map<number, number> {
  const claimed = new Map<number, number>();
  for (const pr of [...pulls].sort((a, b) => a.number - b.number)) {
    const { closes, refs } = issueColumnRefs(pr.body);
    const byBranch = pr.headRef ? issueOfBranch(pr.headRef) : null;
    for (const n of [...closes, ...refs, ...(byBranch ? [byBranch.issue] : [])]) {
      if (!claimed.has(n)) claimed.set(n, pr.number);
    }
  }
  return claimed;
}

/**
 * 除了 except 这个分支自己的 PR，开着的、在做这张单的 PR（「需求」栏 Closes 它，或分支是它的固定前缀）。
 * Refs 不算：母单的几个分片 PR 各自 Refs 母单是常态，不是重复做。
 */
export function pullsOnIssue(
  pulls: readonly OpenPullRef[],
  issue: number,
  except: string | null,
): OpenPullRef[] {
  return pulls
    .filter((p) => except === null || p.headRef !== except)
    .filter(
      (p) =>
        issueColumnRefs(p.body).closes.includes(issue) ||
        (p.headRef !== undefined && p.headRef !== '' && issueOfBranch(p.headRef)?.issue === issue),
    );
}

/**
 * 开 PR 前的围栏：除了 except 这个分支自己的 PR，还有没有别的开着的 PR 在做这张单。
 * 有回号最小的那个，没有回 null。租约过期了旧会话照样能推，两条线开 PR 前都按它查一遍，不重复开。
 */
export function otherPrOnIssue(
  pulls: readonly OpenPullRef[],
  issue: number,
  except: string | null,
): number | null {
  const hits = pullsOnIssue(pulls, issue, except).map((p) => p.number);
  return hits.length > 0 ? Math.min(...hits) : null;
}
