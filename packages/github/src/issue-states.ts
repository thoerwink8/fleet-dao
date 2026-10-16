// 一批单号（issue 或 PR）此刻开没开着（单 #2783：拉单查正文「前置：」里写的单，前置没关就不拉）。
// 「引擎」机器人一次 GraphQL 问一批（别名 + 变量），不一张单一次请求；号很多时才分批（每批 STATES_BATCH 个）。
// 读不到、形状认不出、有号查不到（GraphQL 回 NOT_FOUND）一律抛错，不拿「关了」顶：前置单开没开着不知道，调用方按「等前置」算。
import { z } from 'zod';
import type { GitHubClient, RepoRef } from './client.ts';
import { unexpected } from './client.ts';
import { GitHubError } from './errors.ts';

/** 一次请求最多问几个号 */
export const STATES_BATCH = 50;

const Node = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('Issue'), state: z.enum(['OPEN', 'CLOSED']) }),
  z.object({ __typename: z.literal('PullRequest'), prState: z.enum(['OPEN', 'CLOSED', 'MERGED']) }),
]);

const StatesData = z.object({ repository: z.record(z.string(), Node.nullable()).nullable() });

/** 一批号的开关状态（PR 的合并、关闭都算 closed）。号按传入先后（去重）；没有号不发请求。 */
export async function readIssueStates(
  client: GitHubClient,
  input: { repo: RepoRef; numbers: readonly number[]; signal?: AbortSignal | undefined },
): Promise<Map<number, 'open' | 'closed'>> {
  const { repo, signal } = input;
  const numbers = [...new Set(input.numbers)];
  for (const n of numbers) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new GitHubError('INVALID_INPUT', `单号 ${n} 不是正整数`);
  }
  const out = new Map<number, 'open' | 'closed'>();
  for (let from = 0; from < numbers.length; from += STATES_BATCH) {
    const batch = numbers.slice(from, from + STATES_BATCH);
    const vars = batch.map((_, i) => `$n${i}: Int!`).join(', ');
    const fields = batch
      .map(
        (_, i) =>
          `a${i}: issueOrPullRequest(number: $n${i}) { __typename ... on Issue { state } ... on PullRequest { prState: state } }`,
      )
      .join('\n    ');
    const query = `query IssueStates($owner: String!, $name: String!, ${vars}) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}`;
    const variables: Record<string, unknown> = { owner: repo.owner, name: repo.name };
    batch.forEach((n, i) => {
      variables[`n${i}`] = n;
    });
    const data = await client.graphql<unknown>({ as: 'engine', repo }, query, variables, { signal });
    const parsed = StatesData.safeParse(data);
    if (!parsed.success) throw unexpected(`读 ${repo.owner}/${repo.name} 一批单的开关状态`, data);
    const r = parsed.data.repository;
    if (!r) throw new GitHubError('NOT_FOUND', `读不到仓 ${repo.owner}/${repo.name}（App 没装到这个仓？）`);
    batch.forEach((n, i) => {
      const node = r[`a${i}`];
      if (!node) throw new GitHubError('NOT_FOUND', `${repo.owner}/${repo.name}#${n} 不在`);
      const open = node.__typename === 'Issue' ? node.state === 'OPEN' : node.prState === 'OPEN';
      out.set(n, open ? 'open' : 'closed');
    });
  }
  return out;
}
