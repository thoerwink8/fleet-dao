// 定时任务查出来的一条条问题，和往单子上留言（欠账检查 debt.ts、GitHub 对账 github-audit.ts 共用）。
// 留言只留一次：留言里带着这一条的记号，下次再查到同一条看到记号就不再留。
import { createHash } from 'node:crypto';
import type { GitHubCommenter } from './github-api.ts';

/** 定时任务查出来的一条。issue 是要留言的那张单；没有能留言的单时是 undefined。 */
export interface Finding {
  issue: number | undefined;
  /** 同一条的稳定标识：留言里带着它，下次查到同一条就不再重复留言。 */
  key: string;
  text: string;
}

/** 留言里的记号：同一条只留一次。前缀沿用 fleet-debt：单子上已经留过的留言照样认得。 */
export function findingMarker(key: string): string {
  return `<!-- fleet-debt:${createHash('sha256').update(key).digest('hex').slice(0, 16)} -->`;
}

/**
 * 把查出来的问题留言到对应的单上：一张单一条留言（header 是开头那句，说是谁查的），已经留过的（带着同一个记号）不再留。
 * 没处留言的（没挂单、只挂着 PR 或查不到的号）原样交回；读留言、写留言失败记进 errors，不当成留过了。
 */
export async function reportFindings(
  findings: readonly Finding[],
  gh: GitHubCommenter,
  header: string,
): Promise<{ posted: number[]; already: number; unattached: Finding[]; errors: string[] }> {
  const byIssue = new Map<number, Finding[]>();
  const unattached: Finding[] = [];
  for (const f of findings) {
    if (f.issue === undefined) unattached.push(f);
    else byIssue.set(f.issue, [...(byIssue.get(f.issue) ?? []), f]);
  }
  const posted: number[] = [];
  const errors: string[] = [];
  let already = 0;
  for (const [n, list] of [...byIssue].sort((a, b) => a[0] - b[0])) {
    try {
      const existing = (await gh.comments(n)).join('\n');
      const fresh = list.filter((f) => !existing.includes(findingMarker(f.key)));
      already += list.length - fresh.length;
      if (fresh.length === 0) continue;
      const body = [header, '', ...fresh.map((f) => `- ${f.text}${findingMarker(f.key)}`)].join('\n');
      await gh.comment(n, body);
      posted.push(n);
    } catch (e) {
      errors.push(`#${n} 上留言没留成（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return { posted, already, unattached, errors };
}
