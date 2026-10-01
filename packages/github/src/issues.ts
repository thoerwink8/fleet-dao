// issue：进度段原地更新、关单、开单、发评论（都用「引擎」机器人）。
// 进度段：只动标记之间的那一段，人写的部分原样保留；同一张单的写入加锁串行；旧快照不盖新快照（as-of）；
// 内容没变就不写（省 GitHub 的内容创建配额）。GitHub 的写没有「版本不对就拒」，所以写完用编辑历史核对：
// 我们读和写之间要是插进了人手编辑（被我们这次盖掉了），把人写的那一版找回来、重新放进进度段，并报警。
// 关单：先发一条写明去向的评论（带标记，幂等），再关（带 state_reason），回读 state 与 state_reason 才算成（A8）。
// 开单、发评论（巡检开单，关单对账、单子打标挂版本留言；最早是 #259 对账给提问另开单写的，#530 删了那一步）：
// 正文都是标记 + 幂等键防重复写，账丢了按正文里的隐藏标记翻页回查；正文可能来自 AI，写之前先中和 @ 提醒和能伪造/截断
// 标记的 <!-- -->、再过卫生检查——这两步进度段、关单评论都不用（进度段的字段、关单去向不是 AI 自由写的正文）。
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
import { assertPublishable, type PublishName, type PublishText } from './publish-check.ts';
import { assertBodySize, neutralizeMentions, oneLine } from './text.ts';

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

/** 号是 PR 的号：GitHub 眼里 PR 也是一张 issue，`pull_request` 字段有没有是唯一的分辨法。 */
function isPullRequest(issue: Pick<Issue, 'pull_request'>): boolean {
  return issue.pull_request !== undefined && issue.pull_request !== null;
}

function assertIssue(issue: Issue, repo: RepoRef): void {
  if (isPullRequest(issue)) {
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

/**
 * 进度段里要公开的字：会话写的子任务标题（方案拆出来的）、「正在」那句话（可能带着分诊追问的原话）；
 * 文档路径是名字（引擎按 issue 标题定的，和写文档时一样按名单比）。
 * 位置名只用序号，不用子任务的 key（key 也是会话写的，报错只带位置、不带值）。
 */
function progressTexts(
  issueNumber: number,
  progress: IssueProgress,
): { texts: PublishText[]; names: PublishName[] } {
  const where = `#${issueNumber} 的进度段`;
  const docs = Object.entries(progress.docs).filter((e): e is [string, string] => typeof e[1] === 'string');
  return {
    texts: [
      { path: `${where}：正在`, text: progress.current },
      ...progress.subtasks.map((s, i) => ({
        path: `${where}：第 ${i + 1} 个子任务`,
        text: `${s.key} ${s.title}`,
      })),
    ],
    names: docs.map(([kind, path]) => ({ label: `${where}：文档（${kind}）`, name: path })),
  };
}

export async function updateIssueProgress(
  deps: Deps,
  input: UpdateIssueProgressInput,
  ctx: ActivityContext = {},
): Promise<UpdateIssueProgressResult> {
  const { repo, issueNumber } = input;
  const slug = repoSlug(repo);
  // 进度段写进公开的 issue 正文，不经 git 推送、推前扫描拦不到：一个请求都不发之前先过卫生检查（publish-check.ts）
  const publish = progressTexts(issueNumber, input.progress);
  assertPublishable(
    `写 ${slug} #${issueNumber} 的进度段`,
    publish.texts,
    deps.sensitiveValues,
    publish.names,
  );
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

/** 账上记的评论回执（幂等账里的 result 是 JSON，认不出就当没记，照常回查）。 */
const CommentReceiptSchema = z.object({ id: z.number(), url: z.string() });

/**
 * 发一条带隐藏标记的评论，幂等：按标记翻页回查（评论可能过百，旧网关只翻第一页会重发），没有才写；
 * 写成后核对作者是引擎机器人。关单去向、开单/评论的回答都走这条路，标记和幂等键由调用方定（各自的键、行为不同）。
 */
async function postMarkedComment(
  deps: Deps,
  repo: RepoRef,
  issueNumber: number,
  spec: { body: string; marker: string; key: string; action: string },
  ctx: ActivityContext,
): Promise<{ value: CommentReceipt; replay: boolean }> {
  const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues/${issueNumber}`;
  const auth = { as: 'engine' as const, repo };
  return once<CommentReceipt>(deps.ledger.idempotency, {
    key: spec.key,
    action: spec.action,
    target: `${repoSlug(repo)}#${issueNumber}`,
    now: deps.client.now,
    renewEveryMs: deps.leaseRenewMs,
    lookup: async () => {
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
          (c) => (c.body ?? '').includes(spec.marker) && deps.bots.is('engine', c.user),
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
        body: { body: spec.body },
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

  const { value, replay } = await postMarkedComment(
    deps,
    repo,
    issueNumber,
    {
      body,
      marker,
      key: idempotencyKey('close_comment', `${slug.toLowerCase()}#${issueNumber}`, { reason, text }),
      action: 'github.close_comment',
    },
    ctx,
  );
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

// —— 开单 ——

/** GitHub 单子标题的上限（字符）。 */
export const ISSUE_TITLE_LIMIT = 256;

export interface OpenIssueInput {
  repo: RepoRef;
  /** 幂等键：同一个仓、同一个 key 只开一张（引擎拿提问编号当 key）。正文末尾带隐藏标记，账丢了按标记回查。 */
  key: string;
  title: string;
  body: string;
  /** 开单时一起贴的标签（类别）。 */
  labels: readonly string[];
  /** 开单时一起挂的里程碑编号；null = 不挂（未排期）。 */
  milestone: number | null;
}

export interface OpenIssueResult {
  number: number;
  url: string;
  /** false = 以前开过（账上有，或按标记找到了），这次没开新的。 */
  created: boolean;
}

interface IssueReceipt {
  number: number;
  url: string;
  updatedAt: string;
}

export async function openIssue(
  deps: Deps,
  input: OpenIssueInput,
  ctx: ActivityContext = {},
): Promise<OpenIssueResult> {
  const { repo, key } = input;
  const slug = repoSlug(repo);
  const auth = { as: 'engine' as const, repo };
  const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}/issues`;

  // 一个请求都不发之前：标题压成一行，空的或超过 GitHub 的上限直接拒——这一步不中和，避免中和加的字符
  // （零宽空格、变体连字符）把一个刚好卡在上限的标题误判成超限
  const title = oneLine(input.title);
  if (!title) throw new GitHubError('INVALID_INPUT', '单子标题是空的');
  const titleLen = [...title].length;
  if (titleLen > ISSUE_TITLE_LIMIT) {
    throw new GitHubError(
      'INVALID_INPUT',
      `单子标题有 ${titleLen} 个字符，超过 GitHub 的上限 ${ISSUE_TITLE_LIMIT}`,
      { details: { length: titleLen, limit: ISSUE_TITLE_LIMIT } },
    );
  }
  // 标题、正文都可能是 AI 写的：中和 @ 提醒（别打扰人）和 <!-- -->（别让它伪造或截断我们下面拼的标记）
  const safeTitle = neutralizeMentions(title);
  const safeBody = neutralizeMentions(input.body);
  assertPublishable(
    `开 ${slug} 的单子`,
    [
      { path: '单子标题', text: safeTitle },
      { path: '单子正文', text: safeBody },
    ],
    deps.sensitiveValues,
  );
  const marker = `<!-- fleet:issue:${digest({ key })} -->`;
  const body = `${safeBody}\n\n${marker}`;
  assertBodySize('单子正文', body);

  const { value, replay } = await once<IssueReceipt>(deps.ledger.idempotency, {
    key: idempotencyKey('open_issue', `${slug.toLowerCase()}:${key}`),
    action: 'github.open_issue',
    target: `${slug}:${key}`,
    now: deps.client.now,
    renewEveryMs: deps.leaseRenewMs,
    lookup: async () => {
      // 我们的单刚开不久：占用 2 分钟没续就过期重写（CLAIM_STALE_AFTER_MS）。300 张够不够：开单要过卫生检查、
      // 一个个发请求，这个仓 2 分钟内开不出 300 张单（哪怕所有工人一起开也到不了这个量级）——最近 300 张
      // （100 条一页、翻 3 页）里一定能看到 2 分钟前开的那张；3 页翻完没找到就当没开过。
      // 页数自己数、够了就返回 null（等效 break，让 pages() 的生成器正常收尾），不把 3 传给 pages() 的
      // maxPages——那是它自己的翻页安全网（次数很大，兜底真正翻不到头的情况），跟这里「只看最近 300 张」
      // 的业务决定是两回事：传 3 会让它把「第 4 页还有数据」也当成「没翻完」抛 TOO_MANY_PAGES，
      // 单子一过 300 张开单就全部失败（法国生产 2026-09-27 踩过）。
      let pageCount = 0;
      for await (const page of deps.client.pages({
        method: 'GET',
        path: base,
        auth,
        query: { state: 'all', sort: 'created', direction: 'desc', per_page: 100 },
        signal: ctx.signal,
      })) {
        const parsed = z.array(IssueSchema).safeParse(page.data);
        if (!parsed.success) throw unexpected(`翻 ${slug} 的 issue 列表`, page.data);
        const hit = parsed.data.find(
          (i) => !isPullRequest(i) && (i.body ?? '').includes(marker) && deps.bots.is('engine', i.user),
        );
        if (hit) return { number: hit.number, url: hit.html_url, updatedAt: hit.updated_at };
        pageCount += 1;
        if (pageCount >= 3) return null;
      }
      return null;
    },
    write: async () => {
      const res = await deps.client.request({
        method: 'POST',
        path: base,
        auth,
        body: {
          title: safeTitle,
          body,
          labels: input.labels,
          ...(input.milestone === null ? {} : { milestone: input.milestone }),
        },
        signal: ctx.signal,
      });
      const parsed = IssueSchema.safeParse(res.data);
      if (!parsed.success) {
        throw new GitHubError('AMBIGUOUS_WRITE', `开单的回执读不懂（${slug}）`, {
          retryable: true,
          maybeLanded: true,
        });
      }
      if (!deps.bots.is('engine', parsed.data.user)) {
        throw new GitHubError(
          'AUTHOR_MISMATCH',
          `单开出去了，作者却是 ${parsed.data.user?.login ?? '（读不到）'}`,
          { details: { number: parsed.data.number } },
        );
      }
      return { number: parsed.data.number, url: parsed.data.html_url, updatedAt: parsed.data.updated_at };
    },
  });
  // 写成、回查找到的都是这个号此刻的样子：记成自家的回声（重记一遍无妨）
  await issueEcho(deps, repo, value.number, value.updatedAt);
  return { number: value.number, url: value.url, created: !replay };
}

// —— 在 issue 上留一条评论（不关单、不改进度段：关单对账、单子打标挂版本留言用）——

export interface CommentIssueInput {
  repo: RepoRef;
  issueNumber: number;
  /** 幂等键：同一张单、同一个 key 只发一条评论（换 key 是另一条）。 */
  key: string;
  body: string;
}

export interface CommentIssueResult {
  commentId: number;
  url: string;
  /** false = 这个 key 以前发过（账上有，或按标记找到了），这次没再发。 */
  created: boolean;
}

export async function commentIssue(
  deps: Deps,
  input: CommentIssueInput,
  ctx: ActivityContext = {},
): Promise<CommentIssueResult> {
  return commentOn(deps, input, ctx, 'issue');
}

/**
 * 在一个 PR 上留一条评论（幂等，按 key 认）：认领作废、强制改派时给旧 PR 留话（#348）。号不是 PR 的抛错，不往 issue 上写。
 * issueNumber 填 PR 号（GitHub 眼里 PR 也是一张 issue，评论走同一个接口）。
 */
export async function commentPull(
  deps: Deps,
  input: CommentIssueInput,
  ctx: ActivityContext = {},
): Promise<CommentIssueResult> {
  return commentOn(deps, input, ctx, 'pull');
}

async function commentOn(
  deps: Deps,
  input: CommentIssueInput,
  ctx: ActivityContext,
  kind: 'issue' | 'pull',
): Promise<CommentIssueResult> {
  const { repo, issueNumber, key } = input;
  const slug = repoSlug(repo);
  const idemKey = idempotencyKey('issue_comment', `${slug.toLowerCase()}#${issueNumber}`, { key });
  // 账上记着发过了就不再碰 GitHub：对账每轮都会拿同一个 key 来认一遍（回答写没写上），不能每轮读一次单子
  const done = await deps.ledger.idempotency.peek(idemKey);
  const recorded = CommentReceiptSchema.safeParse(done?.result);
  if (done?.completedAt && recorded.success) {
    return { commentId: recorded.data.id, url: recorded.data.url, created: false };
  }
  const issue = await readIssue(deps, repo, issueNumber, ctx.signal);
  if (kind === 'issue') assertIssue(issue, repo);
  else if (!isPullRequest(issue)) throw new GitHubError('NOT_A_PULL', `${slug} #${issueNumber} 不是 PR`);

  // 正文是 AI 写的（提问或回答）：中和之后照开单一样过卫生检查
  const safeBody = neutralizeMentions(input.body);
  assertPublishable(
    `写 ${slug} #${issueNumber} 的评论`,
    [{ path: '评论正文', text: safeBody }],
    deps.sensitiveValues,
  );
  const marker = `<!-- fleet:comment:${digest({ key })} -->`;
  const body = `${safeBody}\n\n${marker}`;
  assertBodySize(`#${issueNumber} 的评论`, body);

  const { value, replay } = await postMarkedComment(
    deps,
    repo,
    issueNumber,
    { body, marker, key: idemKey, action: 'github.issue_comment' },
    ctx,
  );
  if (value.updatedAt) {
    if (kind === 'issue') await issueEcho(deps, repo, issueNumber, value.updatedAt);
    else
      await recordEcho(
        deps.ledger.idempotency,
        { repo, kind: 'pull', number: issueNumber, updatedAt: value.updatedAt, role: 'engine' },
        deps.client.now(),
      );
  }
  return { commentId: value.id, url: value.url, created: !replay };
}
