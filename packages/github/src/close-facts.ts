// 关单对账（#241）要读的仓现状，「引擎」机器人经 GraphQL 读：主线（默认分支头）上 specs/ 下有哪些文件、开着的单连同
// 子单、最近关掉的单、开着的 PR（号、标题、正文）、最近合并的 PR（号、标题、正文，判「填了是却没关」用，#460）。判哪张
// 该关、哪张挂的 PR 填了是却没关、哪张关了没结果在 @fleet-dao/conventions 的 close-sweep.ts，引擎的
// jobs/close-sweep.ts 把两边接起来。
// 读不到、形状认不出、翻到上限没翻完一律抛错（调用方记没查成），不拿「一张都没有」顶；仓里压根没有 specs/ 目录是
// specsFiles: null（这个仓不按「关单要有结果」查），和没读到分开。子单超过一页照实交回 total，由判的那边记没查成。
// 合并的 PR 没有 issues 那样的 filterBy 可用：按 updatedAt 从新到旧翻页，翻到一条更新时刻早于 since 的就停——合并本身
// 会带动 updatedAt，停下那页之后的 PR 一定更早合并（或压根没合并），不会漏掉 since 之后合并的；停之前多读到几条
// updatedAt 较新但 mergedAt 较早的（合并后又被评论）不算错，交给 close-sweep.ts 精判。
import { z } from 'zod';
import type { GitHubClient, RepoRef } from './client.ts';
import { unexpected } from './client.ts';
import { GitHubError } from './errors.ts';

export interface ReadCloseFactsInput {
  repo: RepoRef;
  /** 关掉的单、合并的 PR 都从这一刻往后看（按更新时刻筛；关单时刻、合并时刻由判的那边再挑）。 */
  since: Date;
  signal?: AbortSignal | undefined;
}

export interface CloseFacts {
  /** 主线上 specs/ 下两层的文件（specs/<目录>/<文件>）；仓里没有 specs/ 是 null。 */
  specsFiles: string[] | null;
  /** 开着的单（不含 PR）。subIssues.total 是 GitHub 报的子单总数，open、closed 是读到的那些（最多一页）。 */
  openIssues: {
    number: number;
    title: string;
    subIssues: { total: number; open: number[]; closed: number[] };
  }[];
  /** since 之后更新过的、关着的单（不含 PR）：关的原因（completed、not_planned、duplicate……，小写）、关单时刻。 */
  closedIssues: { number: number; title: string; stateReason: string | null; closedAt: string }[];
  /** 开着的 PR。 */
  openPulls: { number: number; title: string; body: string }[];
  /** since 之后更新过的、合并了的 PR。 */
  mergedPulls: { number: number; title: string; body: string }[];
}

/** 一种列表最多翻几页：到了还有下一页就算没查全（抛错）。 */
export const CLOSE_FACTS_MAX_PAGES = 20;
/** 一张单最多读几张子单（一页）。 */
export const SUB_ISSUES_PAGE = 50;

export const CLOSE_SPECS_QUERY = `query CloseSpecs($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: "HEAD:specs") {
      __typename
      ... on Tree { entries { name type object { __typename ... on Tree { entries { name type } } } } }
    }
  }
}`;

export const CLOSE_OPEN_ISSUES_QUERY = `query CloseOpenIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: [OPEN], first: 50, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title subIssues(first: ${SUB_ISSUES_PAGE}) { totalCount nodes { number state } } }
    }
  }
}`;

export const CLOSE_CLOSED_ISSUES_QUERY = `query CloseClosedIssues($owner: String!, $name: String!, $after: String, $since: DateTime!) {
  repository(owner: $owner, name: $name) {
    issues(states: [CLOSED], first: 100, after: $after, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title stateReason closedAt }
    }
  }
}`;

export const CLOSE_OPEN_PULLS_QUERY = `query CloseOpenPulls($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN], first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { number title body }
    }
  }
}`;

/** updatedAt 从新到旧：翻页时按它找该停在哪（PullRequest 没有 issues 那样的 filterBy: since）。 */
export const CLOSE_MERGED_PULLS_QUERY = `query CloseMergedPulls($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED], first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title body updatedAt }
    }
  }
}`;

const Entry = z.object({ name: z.string().min(1), type: z.string() });
const SubTree = z.object({ __typename: z.literal('Tree'), entries: z.array(Entry) });
const SpecsTree = z.object({
  __typename: z.literal('Tree'),
  entries: z.array(
    Entry.extend({ object: z.union([SubTree, z.object({ __typename: z.string() })]).nullable() }),
  ),
});
const SpecsData = z.object({
  repository: z
    .object({ object: z.union([SpecsTree, z.object({ __typename: z.string() })]).nullable() })
    .nullable(),
});

const Conn = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.unknown()),
});
const IssuesPage = z.object({ repository: z.object({ issues: Conn }).nullable() });
const PullsPage = z.object({ repository: z.object({ pullRequests: Conn }).nullable() });

const OpenIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  subIssues: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(z.object({ number: z.number().int().positive(), state: z.enum(['OPEN', 'CLOSED']) })),
  }),
});
const ClosedIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  stateReason: z.string().nullable(),
  closedAt: z.string().nullable(),
});
const OpenPull = z.object({ number: z.number().int().positive(), title: z.string(), body: z.string() });
const MergedPull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.string(),
});

type Client = Pick<GitHubClient, 'graphql'>;
type Auth = { as: 'engine'; repo: RepoRef };

export async function readCloseFacts(client: Client, input: ReadCloseFactsInput): Promise<CloseFacts> {
  const { repo, signal } = input;
  const slug = `${repo.owner}/${repo.name}`;
  const vars = { owner: repo.owner, name: repo.name };
  const auth: Auth = { as: 'engine', repo };

  const raw = await client.graphql<unknown>(auth, CLOSE_SPECS_QUERY, vars, { signal });
  const specs = SpecsData.safeParse(raw);
  if (!specs.success) throw unexpected(`读 ${slug} 主线上的 specs/`, raw);
  if (!specs.data.repository) throw notFound(slug);
  const tree = specs.data.repository.object;
  let specsFiles: string[] | null = null;
  if (tree !== null) {
    if (!('entries' in tree)) {
      throw new GitHubError(
        'UNEXPECTED_RESPONSE',
        `${slug} 主线上的 specs 不是目录（是 ${tree.__typename}）：没查成`,
      );
    }
    specsFiles = [];
    for (const dir of tree.entries) {
      if (dir.type !== 'tree') continue;
      if (!dir.object || !('entries' in dir.object)) {
        throw new GitHubError(
          'UNEXPECTED_RESPONSE',
          `${slug} 主线上 specs/${dir.name}/ 里有什么没读回来：没查成`,
        );
      }
      for (const f of dir.object.entries) {
        if (f.type === 'blob') specsFiles.push(`specs/${dir.name}/${f.name}`);
      }
    }
  }

  // 认不出回 undefined、仓不在回 null：两样分开报（不能写成可选链，那样仓不在也成了 undefined）
  const issuesOf = (d: unknown) => {
    const p = IssuesPage.safeParse(d);
    if (!p.success) return undefined;
    return p.data.repository === null ? null : p.data.repository.issues;
  };
  const pullsOf = (d: unknown) => {
    const p = PullsPage.safeParse(d);
    if (!p.success) return undefined;
    return p.data.repository === null ? null : p.data.repository.pullRequests;
  };
  const openIssues = (
    await pages(client, auth, CLOSE_OPEN_ISSUES_QUERY, vars, issuesOf, OpenIssue, `${slug} 开着的单`, signal)
  ).map((i) => ({
    number: i.number,
    title: i.title,
    subIssues: {
      total: i.subIssues.totalCount,
      open: i.subIssues.nodes.filter((s) => s.state === 'OPEN').map((s) => s.number),
      closed: i.subIssues.nodes.filter((s) => s.state === 'CLOSED').map((s) => s.number),
    },
  }));
  const closedVars = { ...vars, since: input.since.toISOString() };
  const closedIssues = (
    await pages(
      client,
      auth,
      CLOSE_CLOSED_ISSUES_QUERY,
      closedVars,
      issuesOf,
      ClosedIssue,
      `${slug} 最近关掉的单`,
      signal,
    )
  ).map((i) => {
    if (!i.closedAt) {
      throw new GitHubError('UNEXPECTED_RESPONSE', `${slug}#${i.number} 关着却没有关单时刻：没查成`);
    }
    return {
      number: i.number,
      title: i.title,
      stateReason: i.stateReason === null ? null : i.stateReason.toLowerCase(),
      closedAt: i.closedAt,
    };
  });
  const openPulls = await pages(
    client,
    auth,
    CLOSE_OPEN_PULLS_QUERY,
    vars,
    pullsOf,
    OpenPull,
    `${slug} 开着的 PR`,
    signal,
  );
  const sinceMs = input.since.getTime();
  const mergedPulls = (
    await pages(
      client,
      auth,
      CLOSE_MERGED_PULLS_QUERY,
      vars,
      pullsOf,
      MergedPull,
      `${slug} 最近合并的 PR`,
      signal,
      (p) => {
        const t = Date.parse(p.updatedAt);
        if (Number.isNaN(t)) {
          throw new GitHubError(
            'UNEXPECTED_RESPONSE',
            `${slug}#${p.number} 的更新时刻认不出（${p.updatedAt}）：没查成`,
          );
        }
        return t < sinceMs;
      },
    )
  ).map((p) => ({ number: p.number, title: p.title, body: p.body }));
  return { specsFiles, openIssues, closedIssues, openPulls, mergedPulls };
}

/**
 * 按游标翻完一种列表。connOf：认不出回 undefined，仓不在回 null。stop 给了就每条先判一遍：真了就此打住（这一条和
 * 后面的都不要）——CLOSE_MERGED_PULLS_QUERY 用它按 updatedAt 停在 since 之前，别的列表不给、翻到没有下一页为止。
 */
async function pages<N>(
  client: Client,
  auth: Auth,
  query: string,
  vars: Record<string, unknown>,
  connOf: (data: unknown) => z.infer<typeof Conn> | null | undefined,
  node: z.ZodType<N>,
  what: string,
  signal: AbortSignal | undefined,
  stop?: (n: N) => boolean,
): Promise<N[]> {
  const out: N[] = [];
  let after: string | null = null;
  for (let n = 0; n < CLOSE_FACTS_MAX_PAGES; n += 1) {
    const data = await client.graphql<unknown>(auth, query, { ...vars, after }, { signal });
    const conn = connOf(data);
    if (conn === undefined) throw unexpected(`读 ${what}`, data);
    if (conn === null) throw notFound(what);
    const nodes = z.array(node).safeParse(conn.nodes);
    if (!nodes.success) throw unexpected(`读 ${what}（有一条认不出）`, data);
    for (const item of nodes.data) {
      if (stop?.(item)) return out;
      out.push(item);
    }
    if (!conn.pageInfo.hasNextPage) return out;
    if (!conn.pageInfo.endCursor) throw unexpected(`读 ${what}（说有下一页却没给游标）`, data);
    after = conn.pageInfo.endCursor;
  }
  throw new GitHubError(
    'TOO_MANY_PAGES',
    `${what}翻了 ${CLOSE_FACTS_MAX_PAGES} 页还没翻完：没查全（没查成）`,
  );
}

function notFound(what: string): GitHubError {
  return new GitHubError('NOT_FOUND', `读不到 ${what}（App 没装到这个仓？）`);
}
