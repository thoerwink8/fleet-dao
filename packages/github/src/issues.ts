// issue：进度段原地更新、关单（都用「引擎」机器人）。
// 进度段：只动标记之间的那一段，人写的部分原样保留；同一张单的写入加锁串行；旧快照不盖新快照（as-of）；
// 内容没变就不写（省 GitHub 的内容创建配额）。GitHub 的写没有「版本不对就拒」，所以写完用编辑历史核对：
// 我们读和写之间要是插进了人手编辑（被我们这次盖掉了），把人写的那一版找回来、重新放进进度段，并报警。
// 关单：先发一条写明去向的评论（带标记，幂等），再关（带 state_reason），回读 state 与 state_reason 才算成（A8）。
// 每次写完都把回执里的 updated_at 记成「自家的回声」（echo.ts），轮询补收时据此不叫醒自己。
import { z } from 'zod';
import { enc, type RepoRef, repoSlug, unexpected } from './client.ts';
import type { ActivityContext, Deps } from './deps.ts';
import { recordEcho } from './echo.ts';
import { GitHubError } from './errors.ts';
import { digest, idempotencyKey, once } from './idempotency.ts';
import {
  type IssueProgress,
  isNewer,
  normalize,
  parseBody,
  renderProgress,
  spliceProgress,
} from './progress.ts';
import { assertBodySize } from './text.ts';

const User = z.object({ login: z.string(), id: z.number(), type: z.string() });

export const IssueSchema = z.object({
  number: z.number(),
  node_id: z.string(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullable().optional(),
  title: z.string(),
  body: z.string().nullable(),
  user: User.nullable(),
  pull_request: z.unknown().optional(),
  updated_at: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const CommentSchema = z.object({
  id: z.number(),
  html_url: z.string(),
  body: z.string().nullable(),
  user: User.nullable(),
  updated_at: z.string(),
});

/** issue 这个版本是「引擎」写出来的（updated_at 取写入回执）。 */
function issueEcho(deps: Deps, repo: RepoRef, number: number, updatedAt: string) {
  return recordEcho(
    deps.ledger.idempotency,
    { repo, kind: 'issue', number, updatedAt, role: 'engine' },
    deps.client.now(),
  );
}

export async function readIssue(
  deps: Deps,
  repo: RepoRef,
  number: number,
  signal?: AbortSignal,
): Promise<Issue> {
  const res = await deps.client.request({
    method: 'GET',
    path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${number}`,
    auth: { as: 'engine', repo },
    signal,
  });
  const parsed = IssueSchema.safeParse(res.data);
  if (!parsed.success) throw unexpected(`读 issue #${number}`, res.data);
  return parsed.data;
}

function assertIssue(issue: Issue, repo: RepoRef): void {
  if (issue.pull_request !== undefined && issue.pull_request !== null) {
    throw new GitHubError('NOT_AN_ISSUE', `${repoSlug(repo)} #${issue.number} 是 PR，不是 issue`);
  }
}

// —— 进度段 ——

export interface UpdateIssueProgressInput {
  repo: RepoRef;
  issueNumber: number;
  progress: IssueProgress;
  /** 这份进度的快照时刻；默认现在。比正文里已有的旧就不写。 */
  asOf?: string | Date | undefined;
}

export interface UpdateIssueProgressResult {
  outcome: 'written' | 'unchanged' | 'stale';
  /** 写的时候撞上了人手编辑，已经把人写的那一版放回来（同时报警）。 */
  restoredHumanEdit: boolean;
  /** 写后核对做完了；false = 没查成（写是写成了）。 */
  verified: boolean;
}

export async function updateIssueProgress(
  deps: Deps,
  input: UpdateIssueProgressInput,
  ctx: ActivityContext = {},
): Promise<UpdateIssueProgressResult> {
  const { repo, issueNumber } = input;
  const slug = repoSlug(repo);
  const asOf = (
    input.asOf instanceof Date ? input.asOf : new Date(input.asOf ?? deps.client.now())
  ).toISOString();
  return deps.locker.withLock(`issue:${slug.toLowerCase()}#${issueNumber}`, async () => {
    const facts = await deps.facts.get(repo, 'engine', ctx.signal);
    const issue = await readIssue(deps, repo, issueNumber, ctx.signal);
    assertIssue(issue, repo);
    const current = issue.body ?? '';
    const parsed = parseBody(current);
    if (isNewer(parsed.asOf, asOf)) {
      deps.log.info('进度快照比正文里的旧，不写', { repo: slug, issueNumber, asOf, existing: parsed.asOf });
      return { outcome: 'stale', restoredHumanEdit: false, verified: true };
    }
    const section = renderProgress(input.progress, { repo, defaultBranch: facts.defaultBranch }, asOf);
    if (parsed.section !== null && sameContent(parsed.section, section)) {
      return { outcome: 'unchanged', restoredHumanEdit: false, verified: true };
    }
    const next = spliceProgress(current, section);
    assertBodySize(`issue #${issueNumber} 的正文`, next);
    await patchBody(deps, repo, issueNumber, next, ctx.signal);

    const check = await findLostEdit(deps, repo, issueNumber, current, next, ctx.signal);
    if (check.lost !== null) {
      const restored = spliceProgress(check.lost, section);
      assertBodySize(`issue #${issueNumber} 的正文`, restored);
      await patchBody(deps, repo, issueNumber, restored, ctx.signal);
      deps.log.error('写进度段时撞上了人手编辑：已把人写的那一版放回来', {
        repo: slug,
        issueNumber,
        editor: check.editor,
      });
      return { outcome: 'written', restoredHumanEdit: true, verified: true };
    }
    return { outcome: 'written', restoredHumanEdit: false, verified: check.verified };
  });
}

/** 比进度段内容时不看 as-of（同样的进度换个时刻不算变化）。 */
function sameContent(a: string, b: string): boolean {
  const strip = (s: string) => normalize(s.replace(/as-of=[^\s>]+/, ''));
  return strip(a) === strip(b);
}

async function patchBody(deps: Deps, repo: RepoRef, issueNumber: number, body: string, signal?: AbortSignal) {
  const res = await deps.client.request({
    method: 'PATCH',
    path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${issueNumber}`,
    auth: { as: 'engine', repo },
    body: { body },
    signal,
  });
  const parsed = IssueSchema.safeParse(res.data);
  if (!parsed.success || normalize(parsed.data.body ?? '') !== normalize(body)) {
    throw new GitHubError(
      'READBACK_MISMATCH',
      `改 issue #${issueNumber} 的正文后，回执里的正文和写的不一样`,
      {
        retryable: true,
      },
    );
  }
  await issueEcho(deps, repo, issueNumber, parsed.data.updated_at);
}

const EditsQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      userContentEdits(first: 10) {
        nodes { diff deletedAt editor { __typename login ... on Bot { databaseId } ... on User { databaseId } } }
      }
    }
  }
}`;

export const EditsSchema = z.object({
  repository: z.object({
    issue: z
      .object({
        userContentEdits: z.object({
          nodes: z.array(
            z
              .object({
                diff: z.string().nullable(),
                deletedAt: z.string().nullable().optional(),
                editor: z
                  .object({
                    __typename: z.string(),
                    login: z.string(),
                    databaseId: z.number().nullable().optional(),
                  })
                  .nullable(),
              })
              .nullable(),
          ),
        }),
      })
      .nullable(),
  }),
});

/**
 * 用编辑历史（新的在前，每条的 diff 是那一版的全文）核对：我们这次写的那一版之前，紧挨着的应当是我们读到的那一版。
 * 中间要是夹着别人的编辑，那一版被我们盖掉了——返回它的全文。查不成返回 verified=false，不当成「没问题」。
 */
async function findLostEdit(
  deps: Deps,
  repo: RepoRef,
  issueNumber: number,
  readBody: string,
  wroteBody: string,
  signal?: AbortSignal,
): Promise<{ verified: boolean; lost: string | null; editor?: string | undefined }> {
  const engine = (e: { __typename: string; login: string; databaseId?: number | null | undefined } | null) =>
    !!e && deps.bots.is('engine', { login: e.login, type: e.__typename, id: e.databaseId ?? null });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let data: z.infer<typeof EditsSchema>;
    try {
      const raw = await deps.client.graphql<unknown>(
        { as: 'engine', repo },
        EditsQuery,
        { owner: repo.owner, name: repo.name, number: issueNumber },
        { signal },
      );
      const parsed = EditsSchema.safeParse(raw);
      if (!parsed.success) throw unexpected('读 issue 的编辑历史', raw);
      data = parsed.data;
    } catch (err) {
      deps.log.warn('写进度段后读编辑历史失败：这次没核对成', { issueNumber, error: String(err) });
      return { verified: false, lost: null };
    }
    const nodes = (data.repository.issue?.userContentEdits.nodes ?? []).filter(
      (n): n is NonNullable<typeof n> => !!n && !n.deletedAt && n.diff !== null,
    );
    const wrote = normalize(wroteBody);
    const read = normalize(readBody);
    const ours = nodes.findIndex((n) => engine(n.editor) && normalize(n.diff ?? '') === wrote);
    if (ours < 0) {
      // 编辑历史可能还没更新：等一下再看一次
      if (attempt === 0) {
        await deps.client.sleep(1500, signal);
        continue;
      }
      return { verified: false, lost: null };
    }
    const older = nodes.slice(ours + 1);
    const base = older.findIndex((n) => normalize(n.diff ?? '') === read);
    const between = base < 0 ? older.slice(0, 1) : older.slice(0, base);
    const human = between.find((n) => !engine(n.editor) && normalize(n.diff ?? '') !== read);
    if (human) return { verified: true, lost: human.diff, editor: human.editor?.login };
    // 找不到读到的那一版、前面也没有别人的编辑：只剩「那一版是原始正文、GitHub 没单独记」这种情况
    return { verified: base >= 0 || older.length === 0 || engine(older[0]?.editor ?? null), lost: null };
  }
  return { verified: false, lost: null };
}

// —— 关单 ——

export interface CloseIssueInput {
  repo: RepoRef;
  issueNumber: number;
  reason: 'completed' | 'not_planned';
  /** 关单时写明去向（做完了：合了哪些 PR、结果文档在哪；不做了：并到哪张单、为什么）。 */
  comment?: string | undefined;
}

export interface CloseIssueResult {
  alreadyClosed: boolean;
  commentId: number;
  commentUrl: string;
  /** false = 去向评论以前发过（这次没再发）。 */
  commentCreated: boolean;
}

interface CommentReceipt {
  id: number;
  url: string;
  /** 回执里评论的 updated_at（按标记找回的旧评论也带；老账上可能没有）。 */
  updatedAt?: string | undefined;
}

export async function closeIssue(
  deps: Deps,
  input: CloseIssueInput,
  ctx: ActivityContext = {},
): Promise<CloseIssueResult> {
  const { repo, issueNumber, reason } = input;
  const slug = repoSlug(repo);
  const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${issueNumber}`;
  const auth = { as: 'engine' as const, repo };
  const issue = await readIssue(deps, repo, issueNumber, ctx.signal);
  assertIssue(issue, repo);

  const text = (
    input.comment ?? (reason === 'completed' ? '已完成，引擎关单。' : '不做了，引擎关单。')
  ).trim();
  const tag = digest({ reason, text });
  const marker = `<!-- fleet:close:${tag} -->`;
  const body = `${text}\n\n${marker}`;
  assertBodySize('关单评论', body);

  const { value, replay } = await once<CommentReceipt>(deps.ledger.idempotency, {
    key: idempotencyKey('close_comment', `${slug.toLowerCase()}#${issueNumber}`, { reason, text }),
    action: 'github.close_comment',
    target: `${slug}#${issueNumber}`,
    now: deps.client.now,
    renewEveryMs: deps.leaseRenewMs,
    lookup: async () => {
      // 评论可能过百：一页页翻完（旧网关只翻第一页，评论多了就会再发一条）
      for await (const page of deps.client.pages({
        method: 'GET',
        path: `${base}/comments`,
        auth,
        query: { per_page: 100 },
        signal: ctx.signal,
      })) {
        const parsed = z.array(CommentSchema).safeParse(page.data);
        if (!parsed.success) throw unexpected(`翻 #${issueNumber} 的评论`, page.data);
        const hit = parsed.data.find(
          (c) => (c.body ?? '').includes(marker) && deps.bots.is('engine', c.user),
        );
        if (hit) return { id: hit.id, url: hit.html_url, updatedAt: hit.updated_at };
      }
      return null;
    },
    write: async () => {
      const res = await deps.client.request({
        method: 'POST',
        path: `${base}/comments`,
        auth,
        body: { body },
        signal: ctx.signal,
      });
      const parsed = CommentSchema.safeParse(res.data);
      if (!parsed.success) {
        throw new GitHubError('AMBIGUOUS_WRITE', `发评论的回执读不懂（#${issueNumber}）`, {
          retryable: true,
          maybeLanded: true,
        });
      }
      if (!deps.bots.is('engine', parsed.data.user)) {
        throw new GitHubError(
          'AUTHOR_MISMATCH',
          `评论发出去了，作者却是 ${parsed.data.user?.login ?? '（读不到）'}`,
          {
            details: { commentId: parsed.data.id },
          },
        );
      }
      return { id: parsed.data.id, url: parsed.data.html_url, updatedAt: parsed.data.updated_at };
    },
  });
  // 新评论会把 issue 的 updated_at 推到评论的时刻：这一版也是自家的回声（重记一遍无妨）
  if (value.updatedAt) await issueEcho(deps, repo, issueNumber, value.updatedAt);

  const alreadyClosed = issue.state === 'closed' && issue.state_reason === reason;
  if (!alreadyClosed) {
    const res = await deps.client.request({
      method: 'PATCH',
      path: base,
      auth,
      body: { state: 'closed', state_reason: reason },
      signal: ctx.signal,
    });
    const closed = IssueSchema.safeParse(res.data);
    if (!closed.success) throw unexpected(`关 #${issueNumber} 的回执`, res.data);
    await issueEcho(deps, repo, issueNumber, closed.data.updated_at);
  }
  const after = await readIssue(deps, repo, issueNumber, ctx.signal);
  if (after.state !== 'closed' || after.state_reason !== reason) {
    throw new GitHubError(
      'READBACK_MISMATCH',
      `关 ${slug} #${issueNumber} 后回读：state=${after.state}、state_reason=${after.state_reason ?? '（空）'}，不是 closed/${reason}`,
      { retryable: true },
    );
  }
  return { alreadyClosed, commentId: value.id, commentUrl: value.url, commentCreated: !replay };
}
