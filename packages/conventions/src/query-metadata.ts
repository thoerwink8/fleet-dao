import type { IssueInfo } from './github-api.ts';
import { issueOfBranch } from './issue-branch.ts';
import { issueColumnLinks } from './pr-columns.ts';
import { resolveQueryAxes } from './query-axis.ts';

export interface QueryMetadataPort {
  issue(n: number): Promise<IssueInfo | undefined>;
  pull(n: number): Promise<{ headRef: string; body: string }>;
  addLabels(n: number, labels: readonly string[]): Promise<void>;
}

/** 读现状、只补缺失的明确值、再回读。事件只是叫醒，不能拿旧 payload 当现状。 */
export async function reconcileQueryMetadata(
  gh: QueryMetadataPort,
  number: number,
): Promise<{ changed: boolean; problems: string[] }> {
  const item = await gh.issue(number);
  if (!item) throw new Error(`#${number} 读不到，没查成`);
  let source: number | undefined;
  if (item.isPr) {
    const pull = await gh.pull(number);
    item.body = pull.body;
    if (resolveQueryAxes(item.labels, item.body).problems.length > 0) {
      const branch = issueOfBranch(pull.headRef)?.issue;
      const sources = [
        ...new Set(
          [branch, ...issueColumnLinks(pull.body).map((link) => link.number)].filter(
            (n): n is number => n !== undefined,
          ),
        ),
      ];
      if (sources.length > 1) throw new Error('PR 来源单不唯一，未猜查询轴');
      source = sources[0];
    }
  }
  const from = item.isPr && source !== undefined ? await gh.issue(source) : undefined;
  if (item.isPr && source !== undefined && (!from || from.isPr))
    throw new Error(`来源单 #${source} 读不到或实际是 PR`);
  const inherited = from?.labels ?? [];
  const axis = resolveQueryAxes(item.labels, item.body, inherited);
  if (axis.problems.length > 0) return { changed: false, problems: axis.problems };
  const missing = axis.labels.filter((label) => !item.labels.includes(label));
  if (missing.length > 0) await gh.addLabels(number, missing);
  const back = await gh.issue(number);
  if (!back) throw new Error(`#${number} 写后读不到，没查成`);
  const checked = resolveQueryAxes(back.labels);
  if (checked.problems.length > 0 || axis.labels.some((label) => !back.labels.includes(label)))
    throw new Error(`#${number} 补标签后回读不一致：${checked.problems.join('；')}`);
  return { changed: missing.length > 0, problems: [] };
}
