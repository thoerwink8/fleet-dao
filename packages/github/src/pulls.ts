// PR：开（「干活的」机器人）、等 CI、合并（「引擎」机器人）。
// - 开 PR 按分支幂等：同一个分支只有一张开着的 PR，重试、回执丢了都回查分支，不会开出第二张（B1）；编号读返回体的 number（B5）。
// - 等 CI 按必过检查的名字等；冲突态的 PR GitHub 不起 CI，单独认出来交回同步主线（C1）；
//   「CI 根本没跑」和「跑了没跑完（超时）」分开报；读不到算没查成，不当零条检查（C16）。
// - 合并前再核一遍：头没变（C8）、基于最新主线、CI 在这个头上是绿的、能合（UNKNOWN 就重读，C10）；
//   squash 带 sha 头约束、显式的提交标题与正文（不让 GitHub 用默认拼出关单词，C13）；失败不看文案，重读 mergeable 再分类（C11）。
import { z } from 'zod';
import {
  type CheckRun,
  CheckRunSchema,
  type CheckVerdict,
  type CiEvaluation,
  type CommitStatus,
  CommitStatusSchema,
  evaluateChecks,
  failureDigest,
} from './checks.ts';
import { enc, encRef, type RepoRef, repoSlug, unexpected } from './client.ts';
import type { ActivityContext, Deps } from './deps.ts';
import { GitHubError, isGitHubError } from './errors.ts';
import { idempotencyKey, once } from './idempotency.ts';
import {
  assertBodySize,
  hasCloseKeywords,
  neutralizeCloseKeywords,
  type PrBodyInput,
  renderPrBody,
} from './text.ts';

const User = z.object({ login: z.string(), id: z.number(), type: z.string() });

export const PullSchema = z.object({
  number: z.number(),
  node_id: z.string(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  body: z.string().nullable(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
  user: User.nullable(),
  merged_by: User.nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }) }),
  updated_at: z.string(),
});
export type Pull = z.infer<typeof PullSchema>;

export async function readPull(
  deps: Deps,
  repo: RepoRef,
  number: number,
  role: 'agent' | 'engine' = 'engine',
  signal?: AbortSignal,
): Promise<Pull> {
  const res = await deps.client.request({
    method: 'GET',
    path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/pulls/${number}`,
    auth: { as: role, repo },
    signal,
  });
  const parsed = PullSchema.safeParse(res.data);
  if (!parsed.success) throw unexpected(`读 PR #${number}`, res.data);
  return parsed.data;
}

/** 这个分支上开着的 PR（同仓分支；fork 的不算）。 */
export async function findOpenPull(deps: Deps, repo: RepoRef, branch: string, signal?: AbortSignal) {
  const res = await deps.client.request({
    method: 'GET',
    path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/pulls`,
    auth: { as: 'agent', repo },
    query: { head: `${repo.owner}:${branch}`, state: 'open', per_page: 10 },
    signal,
  });
  const parsed = z.array(PullSchema).safeParse(res.data);
  if (!parsed.success) throw unexpected(`按分支找 PR（${branch}）`, res.data);
  return (
    parsed.data.find(
      (p) => p.head.ref === branch && p.head.repo?.full_name.toLowerCase() === repoSlug(repo).toLowerCase(),
    ) ?? null
  );
}

// —— 开 PR ——

export interface OpenPrInput {
  repo: RepoRef;
  branch: string;
  /** 刚推上去的头（回读核对用）。 */
  head: string;
  title: string;
  /** 字符串原样用；给结构就按模板渲染（做了什么、怎么验证的、还欠什么、对应的需求编号）。 */
  body: string | PrBodyInput;
  draft?: boolean | undefined;
}

export interface OpenPrResult {
  number: number;
  url: string;
  nodeId: string;
  /** false = 以前开过（账上有或按分支找到了），这次没开新的。 */
  created: boolean;
  /** PR 此刻的头是不是 input.head。 */
  headMatches: boolean;
  /** PR 的作者（按分支找到别人开的 PR 时，不是「干活的」机器人）。 */
  author: string | null;
}

interface PrReceipt {
  number: number;
  url: string;
  nodeId: string;
}

export async function openPr(
  deps: Deps,
  input: OpenPrInput,
  ctx: ActivityContext = {},
): Promise<OpenPrResult> {
  const { repo, branch } = input;
  const slug = repoSlug(repo);
  const facts = await deps.facts.get(repo, 'agent', ctx.signal);
  if (branch.toLowerCase() === facts.defaultBranch.toLowerCase()) {
    throw new GitHubError('BRANCH_FORBIDDEN', `不能拿主线 ${facts.defaultBranch} 开 PR`);
  }
  const rawBody = typeof input.body === 'string' ? input.body : renderPrBody(input.body);
  const body = neutralizeCloseKeywords(rawBody);
  const title = neutralizeCloseKeywords(input.title.trim());
  if (body !== rawBody || title !== input.title.trim()) {
    deps.log.warn('PR 标题或正文里有 GitHub 关单词，已改成「关联」', { repo: slug, branch });
  }
  assertBodySize('PR 正文', body);

  const receipt = (p: Pull): PrReceipt => ({ number: p.number, url: p.html_url, nodeId: p.node_id });
  const lookup = async (): Promise<PrReceipt | null> => {
    const found = await findOpenPull(deps, repo, branch, ctx.signal);
    if (!found) return null;
    if (found.base.ref !== facts.defaultBranch) {
      throw new GitHubError(
        'PR_BASE_MISMATCH',
        `${slug} 上 ${branch} 已经有一张开着的 PR #${found.number}，但它的目标是 ${found.base.ref} 不是 ${facts.defaultBranch}`,
        { details: { number: found.number, base: found.base.ref } },
      );
    }
    return receipt(found);
  };

  const { value, replay } = await once<PrReceipt>(deps.ledger.idempotency, {
    key: idempotencyKey('open_pr', `${slug.toLowerCase()}:${branch}`),
    action: 'github.open_pr',
    target: `${slug}:${branch}`,
    now: deps.client.now,
    lookup,
    write: async () => {
      try {
        const res = await deps.client.request({
          method: 'POST',
          path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/pulls`,
          auth: { as: 'agent', repo },
          body: {
            title,
            head: branch,
            base: facts.defaultBranch,
            body,
            draft: input.draft ?? false,
            maintainer_can_modify: false,
          },
          signal: ctx.signal,
        });
        const parsed = PullSchema.safeParse(res.data);
        if (!parsed.success) {
          // 建成了但回执读不懂：当「可能已写成」，下次按分支找回来
          throw new GitHubError('AMBIGUOUS_WRITE', `开 PR 的回执读不懂（${slug} ${branch}）`, {
            retryable: true,
            maybeLanded: true,
          });
        }
        return receipt(parsed.data);
      } catch (err) {
        if (isGitHubError(err, 'VALIDATION')) {
          const text = err.message.toLowerCase();
          if (text.includes('already exists')) {
            const found = await lookup();
            if (found) return found;
          }
          if (text.includes('no commits between')) {
            throw new GitHubError(
              'EMPTY_DELIVERY',
              `${branch} 相对 ${facts.defaultBranch} 没有提交，开不了 PR`,
            );
          }
        }
        throw err;
      }
    },
  });

  // 回读自证：拿到编号不等于成了
  const pr = await readPull(deps, repo, value.number, 'agent', ctx.signal);
  if (pr.state !== 'open') {
    throw new GitHubError(
      'PR_CLOSED',
      `${slug} 的 PR #${pr.number}（${branch}）已经${pr.merged ? '合并' : '关掉'}了`,
      {
        details: { number: pr.number, merged: pr.merged ?? false },
      },
    );
  }
  const author = pr.user?.login ?? null;
  if (!deps.bots.is('agent', pr.user)) {
    if (!replay) {
      throw new GitHubError(
        'AUTHOR_MISMATCH',
        `PR #${pr.number} 的作者是 ${author ?? '（读不到）'}，不是「干活的」机器人`,
        {
          details: { number: pr.number, author },
        },
      );
    }
    deps.log.warn('这个分支上的 PR 不是「干活的」机器人开的', {
      repo: slug,
      branch,
      number: pr.number,
      author,
    });
  }
  return {
    number: pr.number,
    url: pr.html_url,
    nodeId: pr.node_id,
    created: !replay,
    headMatches: pr.head.sha === input.head,
    author,
  };
}

// —— 读 CI ——

export interface CiRead {
  evaluation: CiEvaluation;
  /** 这个头上有没有任何检查或工作流运行（判「根本没跑」用）。 */
  anyActivity: boolean;
}

export async function requiredChecksFor(
  deps: Deps,
  repo: RepoRef,
  explicit?: readonly string[],
  signal?: AbortSignal,
) {
  if (explicit?.length) return [...explicit];
  const facts = await deps.facts.get(repo, 'engine', signal);
  const rules = await deps.facts.branchRules(repo, facts.defaultBranch, 'engine', signal);
  if (rules.requiredChecks.length === 0) {
    throw new GitHubError(
      'NO_REQUIRED_CHECKS',
      `${repoSlug(repo)} 的主线规则里没有必过检查：没法判 CI 绿（零条检查不当绿）。给主线规则集加上必过检查，或调用时写明检查名`,
    );
  }
  return rules.requiredChecks;
}

export async function readCi(
  deps: Deps,
  repo: RepoRef,
  sha: string,
  required: readonly string[],
  signal?: AbortSignal,
): Promise<CiRead> {
  const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
  const auth = { as: 'engine' as const, repo };
  const runs = await deps.client.all<unknown>(
    {
      method: 'GET',
      path: `${base}/commits/${sha}/check-runs`,
      auth,
      query: { per_page: 100, filter: 'all' },
      signal,
    },
    (d) => (d as { check_runs?: unknown })?.check_runs,
    10,
  );
  const parsedRuns = z.array(CheckRunSchema).safeParse(runs);
  if (!parsedRuns.success) throw unexpected(`读 ${sha.slice(0, 7)} 的检查`, runs[0]);
  const statusRes = await deps.client.request({
    method: 'GET',
    path: `${base}/commits/${sha}/status`,
    auth,
    query: { per_page: 100 },
    signal,
  });
  const statuses = z.object({ statuses: z.array(CommitStatusSchema) }).safeParse(statusRes.data);
  if (!statuses.success) throw unexpected(`读 ${sha.slice(0, 7)} 的提交状态`, statusRes.data);
  const checkRuns: CheckRun[] = parsedRuns.data.filter((r) => r.head_sha === sha);
  const commitStatuses: CommitStatus[] = statuses.data.statuses;
  const evaluation = evaluateChecks(required, checkRuns, commitStatuses);
  let anyActivity = checkRuns.length > 0 || commitStatuses.length > 0;
  if (!anyActivity) {
    // 检查还没建出来，但工作流可能已经在排队（Actions: read）。读不懂就是没查成，不当「没有工作流」
    const wf = await deps.client.request({
      method: 'GET',
      path: `${base}/actions/runs`,
      auth,
      query: { head_sha: sha, per_page: 1 },
      signal,
    });
    const runs = z.object({ total_count: z.number() }).safeParse(wf.data);
    if (!runs.success) throw unexpected(`读 ${sha.slice(0, 7)} 的工作流运行`, wf.data);
    anyActivity = runs.data.total_count > 0;
  }
  return { evaluation, anyActivity };
}

// —— 等 CI ——

export interface WaitCiInput {
  repo: RepoRef;
  prNumber: number;
  head: string;
  /** 必过检查的名字；不给就读主线规则集里的。 */
  checks?: readonly string[] | undefined;
  /** 总等多久，默认 30 分钟。 */
  timeoutMs?: number | undefined;
  /** 这么久一个检查、一个工作流都没出现，判「CI 根本没跑」，默认 5 分钟。 */
  missingAfterMs?: number | undefined;
  /** 轮询间隔，默认 15 秒。 */
  pollMs?: number | undefined;
  /** 读到红之后隔多久再确认一次（刚推送就读到的红可能是旧的，C17），默认 20 秒。 */
  confirmRedMs?: number | undefined;
}

export type CiWaitResult =
  | { state: 'green'; head: string; checks: CheckVerdict[] }
  | {
      state: 'red';
      head: string;
      checks: CheckVerdict[];
      failedChecks: string[];
      digest?: string | undefined;
    }
  /** 和主线冲突：GitHub 不给冲突的 PR 起 CI，要先同步主线（C1）。 */
  | { state: 'conflict'; head: string; detail: string }
  /** PR 的头变了：结论必须绑在要合的头上，重新送检。 */
  | { state: 'head_moved'; head: string; actualHead: string; detail: string }
  | { state: 'closed'; head: string; detail: string }
  /** 一个检查、一个工作流都没起。 */
  | { state: 'missing'; head: string; detail: string }
  /** 起了，没在时限内跑完。 */
  | { state: 'timeout'; head: string; pending: string[]; detail: string }
  /** 没查成（GitHub 读不到），不是没过也不是过了。 */
  | { state: 'unknown'; head: string; detail: string };

interface WaitMemo {
  head: string;
  startedAt: number;
  sawActivityAt: number | null;
}

export async function waitCi(
  deps: Deps,
  input: WaitCiInput,
  ctx: ActivityContext = {},
): Promise<CiWaitResult> {
  const { repo, prNumber, head } = input;
  const now = () => deps.client.now().getTime();
  const sleep = (ms: number) => deps.client.sleep(ms, ctx.signal);
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  const missingAfterMs = input.missingAfterMs ?? 5 * 60_000;
  const pollMs = input.pollMs ?? 15_000;
  const confirmRedMs = input.confirmRedMs ?? 20_000;
  const resumed = asMemo(ctx.lastHeartbeat, head);
  const memo: WaitMemo = resumed ?? { head, startedAt: now(), sawActivityAt: null };
  const required = await requiredChecksFor(deps, repo, input.checks, ctx.signal);
  let failures = 0;
  let redSeenAt: number | null = null;

  for (;;) {
    ctx.signal?.throwIfAborted();
    ctx.heartbeat?.(memo);
    let pr: Pull;
    let ci: CiRead;
    try {
      pr = await readPull(deps, repo, prNumber, 'engine', ctx.signal);
      ci = await readCi(deps, repo, head, required, ctx.signal);
      failures = 0;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      if (!(isGitHubError(err) && err.retryable)) {
        return { state: 'unknown', head, detail: `读 PR #${prNumber} 或它的检查失败：${errMessage(err)}` };
      }
      failures += 1;
      if (failures >= 3) {
        return {
          state: 'unknown',
          head,
          detail: `连续 ${failures} 次读不到 PR #${prNumber} 的 CI：${errMessage(err)}`,
        };
      }
      await sleep(pollMs);
      continue;
    }

    if (pr.state === 'closed') {
      return { state: 'closed', head, detail: `PR #${prNumber} 已经${pr.merged ? '合并' : '关掉'}了` };
    }
    if (pr.head.sha !== head) {
      return {
        state: 'head_moved',
        head,
        actualHead: pr.head.sha,
        detail: `PR #${prNumber} 的头从 ${head.slice(0, 7)} 变成了 ${pr.head.sha.slice(0, 7)}`,
      };
    }
    if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
      return {
        state: 'conflict',
        head,
        detail: `PR #${prNumber} 和主线冲突，GitHub 不会给它起 CI：先同步主线`,
      };
    }

    const e = ci.evaluation;
    if (ci.anyActivity && memo.sawActivityAt === null) memo.sawActivityAt = now();
    if (e.overall === 'green') return { state: 'green', head, checks: e.checks };
    if (e.overall === 'red') {
      // 第一次读到红：隔一会儿在同一个头上再确认一轮（期间有人重跑，就接着等）
      if (redSeenAt === null) {
        redSeenAt = now();
        await sleep(confirmRedMs);
        continue;
      }
      return { state: 'red', head, checks: e.checks, failedChecks: e.failed, digest: failureDigest(e) };
    }
    redSeenAt = null;

    const elapsed = now() - memo.startedAt;
    if (memo.sawActivityAt === null && elapsed >= missingAfterMs) {
      return {
        state: 'missing',
        head,
        detail: `等了 ${Math.round(elapsed / 60_000)} 分钟，${head.slice(0, 7)} 上一个检查、一个工作流都没起（必过：${required.join('、')}）`,
      };
    }
    if (elapsed >= timeoutMs) {
      const pending = [...e.pending, ...e.missing];
      return {
        state: 'timeout',
        head,
        pending,
        detail: `等了 ${Math.round(elapsed / 60_000)} 分钟还没跑完：${pending.join('、')}`,
      };
    }
    await sleep(pollMs);
  }
}

function asMemo(v: unknown, head: string): WaitMemo | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Partial<WaitMemo>;
  if (m.head !== head || typeof m.startedAt !== 'number') return null;
  return {
    head,
    startedAt: m.startedAt,
    sawActivityAt: typeof m.sawActivityAt === 'number' ? m.sawActivityAt : null,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// —— 合并 ——

export interface MergePrInput {
  repo: RepoRef;
  prNumber: number;
  /** 只合这个头；头变了就不合（C8）。 */
  expectedHead: string;
  checks?: readonly string[] | undefined;
  /** squash 提交的标题，默认「PR 标题 (#编号)」。 */
  commitTitle?: string | undefined;
  /** squash 提交的正文，默认空（不让 GitHub 拼默认正文：里面可能带关单词）。 */
  commitMessage?: string | undefined;
  /** 合完删分支，默认删（仓没开「合并后自动删」）。 */
  deleteBranch?: boolean | undefined;
}

export type MergeRefusal =
  | 'head_moved'
  | 'not_open'
  | 'wrong_base'
  | 'conflict'
  | 'behind_main'
  | 'ci_not_green'
  | 'merged_other_head';

export type MergePrResult =
  | {
      merged: true;
      mergeCommit: string;
      /** true = 早就合了（重试），这次没合。 */
      alreadyMerged: boolean;
      branchDeleted: boolean;
      /** 合并人；不是「引擎」机器人要报警（C22，对账也会查）。 */
      mergedBy: string | null;
      mergedByEngine: boolean;
    }
  | { merged: false; reason: MergeRefusal; detail: string };

export async function mergePr(
  deps: Deps,
  input: MergePrInput,
  ctx: ActivityContext = {},
): Promise<MergePrResult> {
  const { repo, prNumber, expectedHead } = input;
  const slug = repoSlug(repo);
  const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
  const auth = { as: 'engine' as const, repo };
  const facts = await deps.facts.get(repo, 'engine', ctx.signal);

  let pr = await readPull(deps, repo, prNumber, 'engine', ctx.signal);
  if (pr.merged) {
    // 重试时已经合了：把合并记录补上（上一次可能合完没来得及记账）
    const done = pr;
    if (done.head.sha === expectedHead) {
      await once<MergeReceipt>(deps.ledger.idempotency, {
        key: mergeKey(repo, prNumber, expectedHead),
        action: 'github.merge_pr',
        target: `${slug}#${prNumber}`,
        now: deps.client.now,
        lookup: async () => mergeReceipt(done),
        write: async () => mergeReceipt(done),
      });
    }
    return afterMerge(deps, input, pr, true, ctx);
  }
  const refused = (reason: MergeRefusal, detail: string): MergePrResult => {
    deps.log.info('不合并', { repo: slug, prNumber, reason, detail });
    return { merged: false, reason, detail };
  };
  if (pr.state !== 'open') return refused('not_open', `PR #${prNumber} 已经关了`);
  if (pr.head.sha !== expectedHead) {
    return refused(
      'head_moved',
      `PR #${prNumber} 的头是 ${pr.head.sha.slice(0, 7)}，不是审过的 ${expectedHead.slice(0, 7)}`,
    );
  }
  if (pr.base.ref !== facts.defaultBranch) {
    return refused('wrong_base', `PR #${prNumber} 的目标是 ${pr.base.ref}，不是主线 ${facts.defaultBranch}`);
  }

  // mergeable 是 GitHub 后台算的：null = 还没算完，重读几次（C10）
  for (let i = 0; pr.mergeable === null || pr.mergeable === undefined; i += 1) {
    if (i >= 5) {
      throw new GitHubError('MERGEABLE_UNKNOWN', `PR #${prNumber} 能不能合 GitHub 还没算出来，稍后重试`, {
        retryable: true,
      });
    }
    await deps.client.sleep(2000 * 2 ** i, ctx.signal);
    pr = await readPull(deps, repo, prNumber, 'engine', ctx.signal);
    if (pr.head.sha !== expectedHead) return refused('head_moved', `PR #${prNumber} 的头刚变了`);
  }
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    return refused('conflict', `PR #${prNumber} 和主线冲突`);
  }

  // 基于最新主线
  const cmp = await deps.client.request<{ behind_by?: number; ahead_by?: number }>({
    method: 'GET',
    path: `${base}/compare/${encRef(facts.defaultBranch)}...${expectedHead}`,
    auth,
    query: { per_page: 1 },
    signal: ctx.signal,
  });
  const behindBy = cmp.data?.behind_by;
  if (typeof behindBy !== 'number')
    throw unexpected(`比较 ${facts.defaultBranch}...${expectedHead.slice(0, 7)}`, cmp.data);
  if (behindBy > 0) {
    return refused('behind_main', `主线比 PR #${prNumber} 多 ${behindBy} 个提交：先同步主线、在新头上重测`);
  }

  // 合并前再确认一次：CI 在这个头上是绿的
  const required = await requiredChecksFor(deps, repo, input.checks, ctx.signal);
  const ci = await readCi(deps, repo, expectedHead, required, ctx.signal);
  if (ci.evaluation.overall !== 'green') {
    const e = ci.evaluation;
    const parts = [
      e.failed.length ? `红：${e.failed.join('、')}` : '',
      e.pending.length ? `没跑完：${e.pending.join('、')}` : '',
      e.missing.length ? `没出现：${e.missing.join('、')}` : '',
    ].filter(Boolean);
    return refused(
      'ci_not_green',
      `PR #${prNumber} 的 CI 在 ${expectedHead.slice(0, 7)} 上不是全绿（${parts.join('；')}）`,
    );
  }

  if (pr.draft) {
    await deps.client.graphql(
      auth,
      'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      { id: pr.node_id },
      { mutation: true, signal: ctx.signal },
    );
  }

  // 关单词：正文里的「Closes #N」合并时会让 GitHub 自己关单（C13）
  const title = neutralizeCloseKeywords(pr.title);
  const prBody = pr.body ?? '';
  if (hasCloseKeywords(prBody) || title !== pr.title) {
    await deps.client.request({
      method: 'PATCH',
      path: `${base}/pulls/${prNumber}`,
      auth,
      body: { title, body: neutralizeCloseKeywords(prBody) },
      signal: ctx.signal,
    });
    deps.log.warn('PR 正文里有关单词，合并前已改成「关联」', { repo: slug, prNumber });
  }

  const commitTitle = neutralizeCloseKeywords(input.commitTitle ?? `${title} (#${prNumber})`);
  const commitMessage = neutralizeCloseKeywords(input.commitMessage ?? '');
  const mergedNow = async (): Promise<MergeReceipt | null> => {
    const p = await readPull(deps, repo, prNumber, 'engine', ctx.signal);
    return p.merged && p.head.sha === expectedHead ? mergeReceipt(p) : null;
  };
  try {
    // 合并也记进幂等账：对账靠它核「合并的 PR 都是合并队列合的」（C21）
    await once<MergeReceipt>(deps.ledger.idempotency, {
      key: mergeKey(repo, prNumber, expectedHead),
      action: 'github.merge_pr',
      target: `${slug}#${prNumber}`,
      now: deps.client.now,
      lookup: mergedNow,
      write: async () => {
        const res = await deps.client.request<{ merged?: boolean; sha?: string; message?: string }>({
          method: 'PUT',
          path: `${base}/pulls/${prNumber}/merge`,
          auth,
          body: {
            merge_method: 'squash',
            sha: expectedHead,
            commit_title: commitTitle,
            commit_message: commitMessage,
          },
          allow: [405, 409, 422],
          signal: ctx.signal,
        });
        // 不看文案：重读一遍再分类。只有冲突是「必然失败」，其余交给重试（C11）
        const again = await readPull(deps, repo, prNumber, 'engine', ctx.signal);
        if (again.merged && again.head.sha === expectedHead) return mergeReceipt(again);
        const message = res.data?.message ?? '';
        if (res.status === 200) {
          throw new GitHubError('READBACK_MISMATCH', `合并接口回了成功，回读 PR #${prNumber} 却不是已合并`, {
            retryable: true,
            maybeLanded: true,
          });
        }
        if (again.head.sha !== expectedHead) {
          throw refusal('head_moved', `合并时 PR #${prNumber} 的头变了（${message}）`);
        }
        if (again.mergeable === false || again.mergeable_state === 'dirty') {
          throw refusal('conflict', `合并时 PR #${prNumber} 和主线冲突（${message}）`);
        }
        if (res.status === 422) {
          throw new GitHubError('MERGE_REJECTED', `GitHub 不收这次合并（422）：${message}`, { status: 422 });
        }
        throw new GitHubError(
          'MERGE_NOT_ALLOWED',
          `PR #${prNumber} 现在合不了（${res.status}）：${message}`,
          {
            retryable: true,
            status: res.status,
          },
        );
      },
    });
  } catch (err) {
    if (isGitHubError(err, 'MERGE_REFUSED')) {
      const d = err.details as { reason: MergeRefusal; detail: string };
      return refused(d.reason, d.detail);
    }
    throw err;
  }
  const merged = await readPull(deps, repo, prNumber, 'engine', ctx.signal);
  return afterMerge(deps, input, merged, false, ctx);
}

/** 合并记录：幂等账里 action=github.merge_pr，键由仓、PR 号、合的头推出来（对账按同样的方法找）。 */
export interface MergeReceipt {
  number: number;
  head: string;
  mergeCommit: string | null;
  mergedBy: string | null;
}

export function mergeKey(repo: RepoRef, prNumber: number, head: string): string {
  return idempotencyKey('merge_pr', `${repoSlug(repo).toLowerCase()}#${prNumber}`, head);
}

function mergeReceipt(p: Pull): MergeReceipt {
  return {
    number: p.number,
    head: p.head.sha,
    mergeCommit: p.merge_commit_sha ?? null,
    mergedBy: p.merged_by?.login ?? null,
  };
}

function refusal(reason: MergeRefusal, detail: string): GitHubError {
  return new GitHubError('MERGE_REFUSED', detail, { details: { reason, detail } });
}

async function afterMerge(
  deps: Deps,
  input: MergePrInput,
  pr: Pull,
  already: boolean,
  ctx: ActivityContext,
): Promise<MergePrResult> {
  const { repo, prNumber, expectedHead } = input;
  if (pr.head.sha !== expectedHead) {
    return {
      merged: false,
      reason: 'merged_other_head',
      detail: `PR #${prNumber} 已经合并了，但合的头是 ${pr.head.sha.slice(0, 7)}，不是 ${expectedHead.slice(0, 7)}`,
    };
  }
  const mergeCommit = pr.merge_commit_sha;
  if (!mergeCommit || !/^[0-9a-f]{40}/.test(mergeCommit))
    throw unexpected(`读 PR #${prNumber} 的合并提交`, pr);
  const mergedBy = pr.merged_by?.login ?? null;
  const mergedByEngine = deps.bots.is('engine', pr.merged_by ?? null);
  if (!mergedByEngine)
    deps.log.warn('PR 不是「引擎」机器人合的', { repo: repoSlug(repo), prNumber, mergedBy });
  let branchDeleted = false;
  if (input.deleteBranch !== false)
    branchDeleted = await deleteBranch(deps, repo, pr, expectedHead, ctx.signal);
  return { merged: true, mergeCommit, alreadyMerged: already, branchDeleted, mergedBy, mergedByEngine };
}

/** 删合并过的分支；本来就没了正常返回。分支上又有了新提交就不删。 */
export async function deleteBranch(
  deps: Deps,
  repo: RepoRef,
  pr: Pick<Pull, 'head' | 'base'>,
  expectedHead: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const sameRepo = pr.head.repo?.full_name.toLowerCase() === pr.base.repo.full_name.toLowerCase();
  if (!sameRepo || pr.head.ref === pr.base.ref) return false;
  const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}/git`;
  const auth = { as: 'engine' as const, repo };
  const ref = await deps.client.request<{ object?: { sha?: string } }>({
    method: 'GET',
    path: `${base}/ref/heads/${encRef(pr.head.ref)}`,
    auth,
    allow: [404],
    signal,
  });
  if (ref.status === 404) return true;
  if (ref.data?.object?.sha !== expectedHead) {
    deps.log.warn('分支上有合并之后的新提交，不删', { repo: repoSlug(repo), branch: pr.head.ref });
    return false;
  }
  await deps.client.request({
    method: 'DELETE',
    path: `${base}/refs/heads/${encRef(pr.head.ref)}`,
    auth,
    allow: [404, 422],
    signal,
  });
  return true;
}
