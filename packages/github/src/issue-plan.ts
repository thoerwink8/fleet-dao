// 一张 issue 此刻挂在哪个版本、开没开着（「引擎」机器人现读，计划以 GitHub 为准）：后端接活判「挂没挂在当前版本上」、
// fleet-api handover 判「开着没有、重开过没有」都用它（判法在 @fleet-dao/core 的 dispatch.ts，0003 第 2、8 条）。
// 读不到、形状认不出一律抛错（UNEXPECTED_RESPONSE 这类），不拿「没挂里程碑」「开着」顶：那样未排期和没查成就分不开了。
import { z } from 'zod';
import { enc, type GitHubClient, type RepoRef, unexpected } from './client.ts';

const Milestone = z.object({ number: z.number().int().positive(), title: z.string() });

const PlanIssue = z.object({
  number: z.number(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable(),
  pull_request: z.unknown().optional(),
  // GitHub 一直带这一栏，没挂是 null；整栏缺了是形状不对，不当成没挂
  milestone: Milestone.nullable(),
});

export interface ReadIssuePlanInput {
  repo: RepoRef;
  issueNumber: number;
  signal?: AbortSignal | undefined;
}

export interface IssuePlan {
  state: 'open' | 'closed';
  /** 开着、而且是关了又重开的（state_reason 是 reopened）。 */
  reopened: boolean;
  /** 这个号其实是 PR（issue 接口也回 PR，带 pull_request 一栏）。 */
  pullRequest: boolean;
  /** 作者的 GitHub 登录名；账号删了是 null。 */
  author: string | null;
  /** 此刻挂的里程碑；没挂（未排期）是 null。 */
  milestone: { number: number; title: string } | null;
  /** 仓里此刻还开着的全部里程碑。 */
  openMilestones: { number: number; title: string }[];
}

/** 两次读：这张 issue（挂的里程碑、开关状态）、仓里还开着的里程碑（翻完所有页，翻不完抛错）。 */
export async function readIssuePlan(client: GitHubClient, input: ReadIssuePlanInput): Promise<IssuePlan> {
  const { repo, issueNumber, signal } = input;
  const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
  const auth = { as: 'engine' as const, repo };
  const res = await client.request({ method: 'GET', path: `${base}/issues/${issueNumber}`, auth, signal });
  const issue = PlanIssue.safeParse(res.data);
  if (!issue.success) throw unexpected(`读 issue #${issueNumber} 挂在哪个里程碑`, res.data);
  const raw = await client.all({
    method: 'GET',
    path: `${base}/milestones`,
    auth,
    query: { state: 'open', per_page: 100 },
    signal,
  });
  const open = z.array(Milestone).safeParse(raw);
  if (!open.success) throw unexpected('列还开着的里程碑', raw);
  const i = issue.data;
  return {
    state: i.state,
    reopened: i.state === 'open' && i.state_reason === 'reopened',
    pullRequest: i.pull_request !== undefined && i.pull_request !== null,
    author: i.user?.login ?? null,
    milestone: i.milestone && { number: i.milestone.number, title: i.milestone.title },
    openMilestones: open.data.map((m) => ({ number: m.number, title: m.title })),
  };
}
