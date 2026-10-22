// 单子进门自动打标挂版本（#448）要读写的 GitHub 现状：开着的单（标题、正文、作者、标签、里程碑、创建/更新时刻）、
// 全部里程碑（含关了的：挂在已关里程碑上还开着的单，正是版本交接要处理的断链）、一张单的标签时间线（判「类别标签是不是
// 被人摘过」「过时是什么时候贴上的」用，@fleet-dao/conventions 的 issue-groom.ts 只吃这两样纯数据，不关心怎么查来的）、
// 补类别标签、挂里程碑。都走 REST（issue、PR 共用一套号和端点，milestone 字段直接能 PATCH）。
// 读不到、形状认不出、翻页翻不完一律抛错（调用方记没查成），不拿「一张都没有」顶。
import { z } from 'zod';
import { enc, type GitHubClient, type RepoRef, repoSlug, unexpected } from './client.ts';
import type { ActivityContext, Bots } from './deps.ts';
import { GitHubError, isGitHubError } from './errors.ts';

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
  /** 开单人是不是机器人（GitHub 账号类型是 Bot，或是我们的「干活的」「引擎」之一）：milestonePlan 判「机器人开的」用它。 */
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
  return { milestones, issues: groomIssuesOf(deps, slug, '开着的单', issueRows) };
}

/** 列表里的行认成 GroomIssue（PR 不要）；形状认不出抛错。 */
function groomIssuesOf(
  deps: Pick<ReadDeps, 'bots'>,
  slug: string,
  what: string,
  rows: unknown[],
): GroomIssue[] {
  const issues: GroomIssue[] = [];
  for (const raw of rows) {
    const p = IssueRow.safeParse(raw);
    if (!p.success) throw unexpected(`读 ${slug} ${what}`, raw);
    const i = p.data;
    if (i.pull_request !== undefined && i.pull_request !== null) continue; // PR：这个功能不管
    issues.push({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      author: i.user?.login ?? null,
      authorId: i.user?.id ?? null,
      authorType: i.user?.type ?? null,
      // 机器人开的都算（我们自己的两个加 GitHub 标 Bot 的，比如 github-actions[bot] 开的报警单）：AI 发现的进未排期
      authorIsBot: i.user?.type === 'Bot' || deps.bots.is('engine', i.user) || deps.bots.is('agent', i.user),
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      labels: i.labels.map((l) => l.name),
      milestone: i.milestone && { number: i.milestone.number, title: i.milestone.title },
    });
  }
  return issues;
}

/**
 * 窗口 [from, to) 里新开的单（开着的、关了的都算，不含 PR），可按标签筛（「引擎」机器人现读，#3618）：
 * 数「近 7 天新开了几张」要这个，readGroomFacts 只读开着的，开了又关掉的单它数不到。
 * GitHub 的 since 按更新时刻筛，新开的单更新时刻不早于开单时刻，所以不漏；开单时刻在窗口外的（更早开、近期有动静的）在这里滤掉。
 * 读不到、认不出、翻不完抛错。
 */
export async function readIssuesCreatedBetween(
  deps: ReadDeps,
  input: {
    repo: RepoRef;
    from: Date;
    to: Date;
    label?: string | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<GroomIssue[]> {
  const { repo, from, to, label, signal } = input;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('readIssuesCreatedBetween: 时刻不是有效日期');
  }
  const rows = await deps.client.all(
    {
      method: 'GET',
      path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues`,
      auth: { as: 'engine' as const, repo },
      query: {
        state: 'all',
        since: from.toISOString(),
        per_page: 100,
        ...(label !== undefined ? { labels: label } : {}),
      },
      signal,
    },
    (d) => d,
  );
  return groomIssuesOf(deps, repoSlug(repo), '近期新开的单', rows).filter((i) => {
    const created = Date.parse(i.createdAt);
    return created >= from.getTime() && created < to.getTime();
  });
}

// —— 标签时间线：判「人摘过类别标签」「过时是什么时候贴的」都吃这个 ——

export interface GroomLabelEvent {
  label: string;
  action: 'labeled' | 'unlabeled';
  /** 动手的是不是我们自己的机器人。 */
  bot: boolean;
  at: string;
  /** 动手的登录名。账号删了、或旧的调用方没填，是 null / 不给。 */
  actor?: string | null;
}

export interface IssueComment {
  body: string;
  /** created_at，没有就用 updated_at。 */
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
      actor: e.actor?.login ?? null,
    });
  }
  return out;
}

const CommentRow = z.object({
  body: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

/**
 * 一张单上的评论，按 GitHub 给的先后。时刻用 created_at，没有就用 updated_at；两个都没有算形状认不出。
 * 读不到、翻不完抛错。空数组是这张单真的没有评论。
 */
export async function readIssueComments(
  deps: ReadDeps,
  input: { repo: RepoRef; issueNumber: number; signal?: AbortSignal | undefined },
): Promise<IssueComment[]> {
  const { repo, issueNumber, signal } = input;
  const what = `${repoSlug(repo)}#${issueNumber} 的评论`;
  const rows = await deps.client.all(
    {
      method: 'GET',
      path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${issueNumber}/comments`,
      auth: { as: 'engine', repo },
      query: { per_page: 100 },
      signal,
    },
    (d) => d,
  );
  const out: IssueComment[] = [];
  for (const raw of rows) {
    const p = CommentRow.safeParse(raw);
    if (!p.success) throw unexpected(`读${what}`, raw);
    const at = p.data.created_at ?? p.data.updated_at;
    if (!at) {
      throw new GitHubError('UNEXPECTED_RESPONSE', `读${what}，一条评论没带时刻`, { retryable: true });
    }
    out.push({ body: p.data.body ?? '', at });
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

/**
 * 从一张单上摘一个标签（决定 0096：本机领单租约到期，摘「本机做」退回法国队列）。单上本来就没有这个标签（GitHub 回 404）不算错：
 * 摘标签是幂等的，收租约那一步重来时不会因为上一次已经摘掉而失败。
 */
export async function removeIssueLabel(
  deps: WriteDeps,
  input: { repo: RepoRef; issueNumber: number; label: string },
  ctx: ActivityContext = {},
): Promise<void> {
  const { repo, issueNumber, label } = input;
  try {
    await deps.client.request<unknown>({
      method: 'DELETE',
      path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${issueNumber}/labels/${enc(label)}`,
      auth: { as: 'engine', repo },
      signal: ctx.signal,
    });
  } catch (err) {
    if (isGitHubError(err, 'NOT_FOUND')) return;
    throw err;
  }
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
