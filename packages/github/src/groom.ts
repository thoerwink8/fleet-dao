// 单子进门自动打标挂版本（#448）要读写的 GitHub 现状：开着的单（标题、正文、作者、标签、里程碑、创建/更新时刻）、
// 全部里程碑（含关了的：挂在已关里程碑上还开着的单，正是版本交接要处理的断链）、一张单的标签时间线（判「类别标签是不是
// 被人摘过」「过时是什么时候贴上的」用，@fleet-dao/conventions 的 issue-groom.ts 只吃这两样纯数据，不关心怎么查来的）、
// 补类别标签、挂里程碑。都走 REST（issue、PR 共用一套号和端点，milestone 字段直接能 PATCH）。
// 读不到、形状认不出、翻页翻不完一律抛错（调用方记没查成），不拿「一张都没有」顶。
import { z } from 'zod';
import { enc, type GitHubClient, type RepoRef, repoSlug, unexpected } from './client.ts';
import type { ActivityContext, Bots } from './deps.ts';
import { GitHubError } from './errors.ts';

const UserRef = z.object({ login: z.string(), id: z.number(), type: z.string() }).nullable();
const MilestoneField = z
  .object({ number: z.number().int().positive(), title: z.string(), state: z.enum(['open', 'closed']) })
  .nullable();
const LabelField = z.object({ name: z.string() });

const IssueRow = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  user: UserRef,
  created_at: z.string(),
  updated_at: z.string(),
  labels: z.array(LabelField),
  milestone: MilestoneField,
  pull_request: z.unknown().optional(),
});

export interface GroomIssue {
  number: number;
  title: string;
  body: string;
  /** 开单人的 GitHub 登录名；账号删了是 null。 */
  author: string | null;
  /** 开单人的 GitHub 数字编号和类型（User、Bot…）：拉单按作者白名单认人用（白名单有数字编号的只按编号认）；账号删了是 null。 */
  authorId: number | null;
  authorType: string | null;
  /** 开单人是不是我们自己的机器人（「干活的」「引擎」两个之一）：milestonePlan 判「机器人开的」用它。 */
  authorIsBot: boolean;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  milestone: { number: number; title: string } | null;
}

export interface GroomMilestone {
  number: number;
  title: string;
  state: 'open' | 'closed';
  /** 里程碑说明原文（版本里的先后写在 <!-- fleet:order --> 标记之间，拉单排序读它）；没写是空串。 */
  description: string;
}

export interface GroomFacts {
  /** 全部里程碑（开着的、关了的都要：挂在已关里程碑上还开着的单要靠这个认出来）。 */
  milestones: GroomMilestone[];
  /** 开着的单（不含 PR）。 */
  issues: GroomIssue[];
}

const MilestoneRow = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  description: z.string().nullable().optional(),
});

/** 只要用得到的这两下（不要整个 Deps）：测试用假客户端、假机器人判定就能喂，不用搭一整套。 */
type ReadDeps = { client: Pick<GitHubClient, 'request' | 'all'>; bots: Pick<Bots, 'is'> };

/** 仓里开着的单加全部里程碑（「引擎」机器人现读）。读不到、认不出、翻不完一律抛错。 */
export async function readGroomFacts(
  deps: ReadDeps,
  input: { repo: RepoRef; signal?: AbortSignal | undefined },
): Promise<GroomFacts> {
  const { repo, signal } = input;
  const auth = { as: 'engine' as const, repo };
  const slug = repoSlug(repo);

  const milestoneRows = await deps.client.all(
    {
      method: 'GET',
      path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/milestones`,
      auth,
      query: { state: 'all', per_page: 100 },
      signal,
    },
    (d) => d,
  );
  const milestones = milestoneRows.map((raw) => {
    const p = MilestoneRow.safeParse(raw);
    if (!p.success) throw unexpected(`读 ${slug} 的里程碑`, raw);
    return { ...p.data, description: p.data.description ?? '' };
  });

  const issueRows = await deps.client.all(
    {
      method: 'GET',
      path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues`,
      auth,
      query: { state: 'open', per_page: 100 },
      signal,
    },
    (d) => d,
  );
  const issues: GroomIssue[] = [];
  for (const raw of issueRows) {
    const p = IssueRow.safeParse(raw);
    if (!p.success) throw unexpected(`读 ${slug} 开着的单`, raw);
    const i = p.data;
    if (i.pull_request !== undefined && i.pull_request !== null) continue; // PR：这个功能不管
    issues.push({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      author: i.user?.login ?? null,
      authorId: i.user?.id ?? null,
      authorType: i.user?.type ?? null,
      authorIsBot: deps.bots.is('engine', i.user) || deps.bots.is('agent', i.user),
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      labels: i.labels.map((l) => l.name),
      milestone: i.milestone && { number: i.milestone.number, title: i.milestone.title },
    });
  }
  return { milestones, issues };
}

// —— 标签时间线：判「人摘过类别标签」「过时是什么时候贴的」都吃这个 ——

export interface GroomLabelEvent {
  label: string;
  action: 'labeled' | 'unlabeled';
  /** 动手的是不是我们自己的机器人。 */
  bot: boolean;
  at: string;
}

const EventRow = z.object({
  event: z.string(),
  actor: UserRef,
  label: z.object({ name: z.string() }).optional(),
  created_at: z.string().nullable().optional(),
});

/**
 * 一张单标签的加/摘事件，按发生先后排好（GitHub 本来就是这个顺序）。只看 labeled/unlabeled 两种事件，
 * 别的（评论、改里程碑……）不相干、不带回。读不到、翻不完抛错；缺 label 字段的 labeled/unlabeled 事件算形状认不出。
 */
export async function readIssueLabelEvents(
  deps: ReadDeps,
  input: { repo: RepoRef; issueNumber: number; signal?: AbortSignal | undefined },
): Promise<GroomLabelEvent[]> {
  const { repo, issueNumber, signal } = input;
  const auth = { as: 'engine' as const, repo };
  const what = `${repoSlug(repo)}#${issueNumber} 的标签时间线`;
  const rows = await deps.client.all(
    {
      method: 'GET',
      path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${issueNumber}/events`,
      auth,
      query: { per_page: 100 },
      signal,
    },
    (d) => d,
  );
  const out: GroomLabelEvent[] = [];
  for (const raw of rows) {
    const p = EventRow.safeParse(raw);
    if (!p.success) throw unexpected(`读${what}`, raw);
    const e = p.data;
    if (e.event !== 'labeled' && e.event !== 'unlabeled') continue;
    if (!e.label) {
      throw new GitHubError('UNEXPECTED_RESPONSE', `读${what}，一条 ${e.event} 事件没带标签名`, {
        retryable: true,
      });
    }
    if (!e.created_at) {
      throw new GitHubError('UNEXPECTED_RESPONSE', `读${what}，一条事件没带时刻`, { retryable: true });
    }
    out.push({
      label: e.label.name,
      action: e.event,
      bot: deps.bots.is('engine', e.actor) || deps.bots.is('agent', e.actor),
      at: e.created_at,
    });
  }
  return out;
}

// —— 写：补类别标签、挂里程碑（issue、PR 共用同一套端点） ——

type WriteDeps = { client: Pick<GitHubClient, 'request'> };

/** 给一张单加一个标签（幂等：已经有了 GitHub 不会重复加）。返回加完之后单上的全部标签。 */
export async function addIssueLabel(
  deps: WriteDeps,
  input: { repo: RepoRef; issueNumber: number; label: string },
  ctx: ActivityContext = {},
): Promise<string[]> {
  const { repo, issueNumber, label } = input;
  const res = await deps.client.request<unknown>({
    method: 'POST',
    path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${issueNumber}/labels`,
    auth: { as: 'engine', repo },
    body: { labels: [label] },
    signal: ctx.signal,
  });
  const parsed = z.array(z.object({ name: z.string() })).safeParse(res.data);
  if (!parsed.success) {
    throw unexpected(`给 ${repoSlug(repo)}#${issueNumber} 加标签「${label}」`, res.data);
  }
  return parsed.data.map((l) => l.name);
}

const MilestonePatchResponse = z.object({ milestone: MilestoneField }).passthrough();

/** 给一张单挂里程碑（milestone 传 null 是摘掉，这个功能只会传具体号）。返回挂完之后的里程碑（没挂是 null）。 */
export async function setIssueMilestone(
  deps: WriteDeps,
  input: { repo: RepoRef; issueNumber: number; milestone: number },
  ctx: ActivityContext = {},
): Promise<{ number: number; title: string } | null> {
  const { repo, issueNumber, milestone } = input;
  const res = await deps.client.request<unknown>({
    method: 'PATCH',
    path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${issueNumber}`,
    auth: { as: 'engine', repo },
    body: { milestone },
    signal: ctx.signal,
  });
  const parsed = MilestonePatchResponse.safeParse(res.data);
  if (!parsed.success) throw unexpected(`给 ${repoSlug(repo)}#${issueNumber} 挂里程碑`, res.data);
  return (
    parsed.data.milestone && { number: parsed.data.milestone.number, title: parsed.data.milestone.title }
  );
}
