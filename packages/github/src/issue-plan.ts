// 一张 issue 此刻挂在哪个版本、开没开着、是不是母单或子单（「引擎」机器人现读，计划以 GitHub 为准）：后端接活判「挂没挂在
// 当前版本上、是不是母单子单」、开着没有、重开过没有都用它（判法在 @fleet-dao/core 的 dispatch.ts，
// 0003 第 2、8 条）。一次 GraphQL 查全：REST 的 issue 只在有父单时才带 parent_issue_url、查父单的接口没父单时回 404（和
// 「没装到这个仓」分不开），GraphQL 的 parent 没有父单是明确的 null。
// 读不到、形状认不出、没翻完一律抛错（NOT_FOUND、UNEXPECTED_RESPONSE 这类），不拿「没挂里程碑」「不是子单」「开着」顶：
// 那样未排期、独立的单和没查成就分不开了。
import { z } from 'zod';
import type { GitHubClient, RepoRef } from './client.ts';
import { unexpected } from './client.ts';
import { GitHubError } from './errors.ts';

/** 一次查一张单和仓里还开着的里程碑。标签、里程碑各查前 100 个，超过就算没翻完（抛错），不拿前 100 个当全部。 */
export const ISSUE_PLAN_QUERY = `query IssuePlan($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        state
        stateReason
        author { login }
        milestone { number title }
        labels(first: 100) { totalCount nodes { name } }
        parent { number }
        subIssuesSummary { total }
      }
      ... on PullRequest { prState: state }
    }
    milestones(states: [OPEN], first: 100) { totalCount nodes { number title } }
  }
}`;

const Milestone = z.object({ number: z.number().int().positive(), title: z.string() });

// 每一栏都要有（没有的是 null）：整栏缺了是形状不对，不当成「没挂」「不是子单」
const PlanData = z.object({
  repository: z
    .object({
      issueOrPullRequest: z
        .discriminatedUnion('__typename', [
          z.object({
            __typename: z.literal('Issue'),
            state: z.enum(['OPEN', 'CLOSED']),
            stateReason: z.string().nullable(),
            author: z.object({ login: z.string() }).nullable(),
            milestone: Milestone.nullable(),
            labels: z.object({
              totalCount: z.number().int().nonnegative(),
              nodes: z.array(z.object({ name: z.string() })),
            }),
            parent: z.object({ number: z.number().int().positive() }).nullable(),
            subIssuesSummary: z.object({ total: z.number().int().nonnegative() }),
          }),
          z.object({
            __typename: z.literal('PullRequest'),
            prState: z.enum(['OPEN', 'CLOSED', 'MERGED']),
          }),
        ])
        .nullable(),
      milestones: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(Milestone) }),
    })
    .nullable(),
});

export interface ReadIssuePlanInput {
  repo: RepoRef;
  issueNumber: number;
  signal?: AbortSignal | undefined;
}

export interface IssuePlan {
  state: 'open' | 'closed';
  /** 开着、而且是关了又重开的（stateReason 是 REOPENED）。 */
  reopened: boolean;
  /** 这个号其实是 PR。 */
  pullRequest: boolean;
  /** 作者的 GitHub 登录名；账号删了是 null。 */
  author: string | null;
  /** 此刻挂的里程碑；没挂（未排期）是 null。 */
  milestone: { number: number; title: string } | null;
  /** 仓里此刻还开着的全部里程碑。 */
  openMilestones: { number: number; title: string }[];
  /** 贴着的标签名。 */
  labels: string[];
  /** 挂在哪张单下面（GitHub 子议题的父单号）；不是子单是 null。 */
  parent: number | null;
  /** 下面挂着几张子单。 */
  subIssues: number;
}

/** 只查仓里还开着的里程碑（巡检开单前找巡检仓的当前版本，引擎 jobs/canary.ts）。 */
export const OPEN_MILESTONES_QUERY = `query OpenMilestones($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    milestones(states: [OPEN], first: 100) { totalCount nodes { number title } }
  }
}`;

const MilestonesData = z.object({
  repository: z
    .object({
      milestones: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(Milestone) }),
    })
    .nullable(),
});

/** 仓里此刻还开着的全部里程碑（「引擎」机器人现读）。读不到、认不出、没翻完一律抛错，不拿「一个都没有」顶。 */
export async function readOpenMilestones(
  client: GitHubClient,
  input: { repo: RepoRef; signal?: AbortSignal | undefined },
): Promise<{ number: number; title: string }[]> {
  const { repo, signal } = input;
  const data = await client.graphql<unknown>(
    { as: 'engine', repo },
    OPEN_MILESTONES_QUERY,
    { owner: repo.owner, name: repo.name },
    { signal },
  );
  const parsed = MilestonesData.safeParse(data);
  if (!parsed.success) throw unexpected(`读 ${repo.owner}/${repo.name} 还开着的里程碑`, data);
  const r = parsed.data.repository;
  if (!r) throw new GitHubError('NOT_FOUND', `读不到仓 ${repo.owner}/${repo.name}（App 没装到这个仓？）`);
  if (r.milestones.totalCount > r.milestones.nodes.length) {
    throw new GitHubError(
      'TOO_MANY_PAGES',
      `还开着的里程碑有 ${r.milestones.totalCount} 个，只读了前 ${r.milestones.nodes.length} 个：没查全（没查成）`,
    );
  }
  return r.milestones.nodes.map((m) => ({ number: m.number, title: m.title }));
}

export async function readIssuePlan(client: GitHubClient, input: ReadIssuePlanInput): Promise<IssuePlan> {
  const { repo, issueNumber, signal } = input;
  const data = await client.graphql<unknown>(
    { as: 'engine', repo },
    ISSUE_PLAN_QUERY,
    { owner: repo.owner, name: repo.name, number: issueNumber },
    { signal },
  );
  const parsed = PlanData.safeParse(data);
  if (!parsed.success) throw unexpected(`读 #${issueNumber} 挂在哪个版本、是不是母单子单`, data);
  const r = parsed.data.repository;
  if (!r) throw new GitHubError('NOT_FOUND', `读不到仓 ${repo.owner}/${repo.name}（App 没装到这个仓？）`);
  const open = r.milestones;
  if (open.totalCount > open.nodes.length) {
    throw new GitHubError(
      'TOO_MANY_PAGES',
      `还开着的里程碑有 ${open.totalCount} 个，只读了前 ${open.nodes.length} 个：没查全（没查成）`,
    );
  }
  const openMilestones = open.nodes.map((m) => ({ number: m.number, title: m.title }));
  const i = r.issueOrPullRequest;
  if (!i) throw new GitHubError('NOT_FOUND', `${repo.owner}/${repo.name}#${issueNumber} 不在`);
  if (i.__typename === 'PullRequest') {
    return {
      state: i.prState === 'OPEN' ? 'open' : 'closed',
      reopened: false,
      pullRequest: true,
      author: null,
      milestone: null,
      openMilestones,
      labels: [],
      parent: null,
      subIssues: 0,
    };
  }
  if (i.labels.totalCount > i.labels.nodes.length) {
    throw new GitHubError(
      'TOO_MANY_PAGES',
      `#${issueNumber} 的标签有 ${i.labels.totalCount} 个，只读了前 ${i.labels.nodes.length} 个：认不全是不是母单（没查成）`,
    );
  }
  return {
    state: i.state === 'OPEN' ? 'open' : 'closed',
    reopened: i.state === 'OPEN' && i.stateReason === 'REOPENED',
    pullRequest: false,
    author: i.author?.login ?? null,
    milestone: i.milestone && { number: i.milestone.number, title: i.milestone.title },
    openMilestones,
    labels: i.labels.nodes.map((l) => l.name),
    parent: i.parent?.number ?? null,
    subIssues: i.subIssuesSummary.total,
  };
}
