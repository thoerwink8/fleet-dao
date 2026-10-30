// 开单服务（决定 0122，母单 #3739 第 1 片，协议在 shared 的 intake.ts）：POST /api/nodes/issues 开单，GET /api/nodes/events 读开单账本。
// 本机、法国指挥官、本机 Mirasim 三个入口都经它开单；和 /api/nodes/claims 同一个认人（只认机器通行证 X-Fleet-Node-Token，挂在 node-report.ts 的小应用里）。
// 改这里之前必须知道：
// - 开单流程：认人 → 没接 GitHub 回 503 → 解析（坏形状 400）→ 仓不归法国管 404 → 正文检查（缺节 422，一次列全）→ 查重（强命中 409 带候选，
//   force / mergeInto 才绕开）→ 开单 / 并单 → 记一条操作记录。mergeInto 是往已有的单上留评论，评论不是单子正文，不查四节。
// - 凭据：用「引擎」机器人（github-mirror.ts 的 intakeIssues）；凭据没读到就没有，回 503，不假装开了。幂等、卫生检查在 @fleet-dao/github 的 openIssue / commentIssue 里。
// - 幂等：idempotencyKey 原样当 GitHub 那边的幂等键；同一个 key 重放回原来那张、created:false。key 同时写进单子正文的来源行（单键），
//   查重时靠它认出「就是这次自己开的那张」，重放不会被自己拦成重复。
// - 查重只看开着的单（conventions 的 rankSimilar，纯字面打分；强命中线 STRONG_THRESHOLD），读候选失败回 503，不当成「没有重复」。
// - 账本：不另建表，三种 action（issue.open / issue.merge / issue.duplicate_refused）写进 audit_log，target = issue:<owner>/<name>#<号>，
//   actor = agent / node:<环境编号>，via = agent（和本机领单同一个写法）。重放也记一条（after.created 是 false），免得「开成了、记账前挂了」后重试时账上缺这一笔。
import {
  checkIssueBody,
  defectImpactProblem,
  domainLabel,
  doneSection,
  issueBodyTooLong,
  LOCAL_LABEL,
  natureLabel,
  parseMd,
  rankSimilar,
  requiredSectionProblems,
  strongMatches,
} from '@fleet-dao/conventions';
import { isGitHubError, type OpenIssueRow } from '@fleet-dao/github';
import {
  INTAKE_AUDIT,
  INTAKE_EVENTS_PATH,
  INTAKE_ISSUES_PATH,
  INTAKE_TARGET_PREFIX,
  type IntakeCandidate,
  IntakeEventsQuerySchema,
  IntakeEventsResponseSchema,
  type IntakeIssueRequest,
  IntakeIssueRequestSchema,
  IntakeIssueResponseSchema,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from './deps.ts';
import { ApiError, errorBody, readJson, readQuery, reply } from './http.ts';

type NodeEnv = { Variables: { nodeId: string } };

/** 开单服务要的 GitHub 能力（「引擎」机器人）。真装配在 github-mirror.ts；测试换成假的。 */
export interface IntakeIssuesPort {
  /** 此刻开着的单（不含 PR）。读不到抛错。 */
  listOpenIssues(input: { repo: { owner: string; name: string } }): Promise<OpenIssueRow[]>;
  /** 开一张单（幂等，按 key 认）。milestone：当前 = 挂开着的那个 v<N>（没有就不挂），未排期 = 不挂。 */
  openIssue(input: {
    repo: { owner: string; name: string };
    key: string;
    title: string;
    body: string;
    labels: string[];
    milestone: '当前' | '未排期';
  }): Promise<{ number: number; url: string; created: boolean }>;
  /** 在一张单上留一条评论（幂等，按 key 认）。 */
  commentIssue(input: {
    repo: { owner: string; name: string };
    issueNumber: number;
    key: string;
    body: string;
  }): Promise<{ commentId: number; url: string; created: boolean }>;
}

export const INTAKE_NOT_WIRED = '这台后端没接上 GitHub（开发环境，或机器人凭据没读到），开不了单';
export const INTAKE_EVENTS_UNREADABLE = '读不到开单账本（库读失败），不拿空列表冒充「没有新事件」';

const big = bodyLimit({
  maxSize: 256 * 1024,
  onError: (c) => c.json(errorBody('too_large', '开单的请求超过 256 KB，没收'), 413),
});

/** 单子正文末尾那行可见的来源说明；单键也写在里面（查重靠它认出自己）。 */
export function sourceLine(req: Pick<IntakeIssueRequest, 'source' | 'idempotencyKey'>): string {
  return `来源：${req.source.kind} ${req.source.ref}（单键 ${req.idempotencyKey}）`;
}

const sourceOf = (req: IntakeIssueRequest) => ({ kind: req.source.kind, ref: req.source.ref });

/** 正文的所有问题（一次列全）：四节、缺陷的「影响」、怎么算做完、PR 正文、diff 外证据、超长。没有问题回空。 */
export function bodyProblems(
  req: Pick<IntakeIssueRequest, 'body' | 'kind' | 'local'>,
): { field: string; why: string }[] {
  const body = req.body.replace(/\r\n?/g, '\n');
  const doc = parseMd('body.md', body);
  const problems: { field: string; why: string }[] = requiredSectionProblems(doc).map((p) => ({
    field: p.label,
    why: p.why,
  }));
  if (req.kind === '缺陷') {
    const impact = defectImpactProblem(body);
    if (impact) problems.push({ field: '影响', why: impact });
  }
  const done = doneSection(doc);
  if (done !== 'ok') {
    problems.push({
      field: '怎么算做完',
      why: `正文里${done === 'missing' ? '没有「## 怎么算做完」一节' : '「怎么算做完」一节是空的'}：以后要做的事得写清怎么算做完（测试名、脚本、真机上看到什么）。`,
    });
  }
  // 前面的都齐了，才看 checkIssueBody 里剩下的（PR 正文、diff 外证据）；它自己只报第一条，所以放最后
  if (problems.length === 0) {
    const checked = checkIssueBody(body, { local: req.local, kind: req.kind });
    if (!checked.ok) problems.push({ field: checked.field ?? '正文', why: checked.why });
  }
  const tooLong = issueBodyTooLong(body);
  if (tooLong) problems.push({ field: '正文', why: tooLong });
  return problems;
}

const repoRef = (slug: string) => {
  const [owner = '', name = ''] = slug.split('/');
  return { owner, name };
};

/** GitHub 那边拒掉的翻成状态码：内容问题 422，目标不是单子 404，别的 502。 */
function githubFailure(err: unknown, what: string): ApiError {
  const why = errMessage(err);
  if (isGitHubError(err)) {
    if (['HYGIENE_BLOCKED', 'HYGIENE_UNSCANNED', 'INVALID_INPUT', 'BODY_TOO_LONG'].includes(err.code)) {
      return new ApiError(422, 'body_refused', `${what}没成：${why}`);
    }
    if (['NOT_AN_ISSUE', 'NOT_FOUND'].includes(err.code)) {
      return new ApiError(404, 'issue_not_found', `${what}没成：${why}`);
    }
  }
  return new ApiError(502, 'github_failed', `${what}没成：${why}`);
}

export function registerIntakeReceiver(
  app: Hono<NodeEnv>,
  deps: Deps,
  authenticate: MiddlewareHandler<NodeEnv>,
): void {
  const { log } = deps;

  async function audit(entry: {
    nodeId: string;
    action: string;
    repo: string;
    number: number;
    after: Record<string, unknown>;
  }): Promise<void> {
    await deps.store.appendAudit({
      actor: { kind: 'agent', id: `node:${entry.nodeId}` },
      action: entry.action,
      target: `${INTAKE_TARGET_PREFIX}${entry.repo}#${entry.number}`,
      after: { nodeId: entry.nodeId, repo: entry.repo, number: entry.number, ...entry.after },
      via: 'agent',
      ok: true,
    });
  }

  app.post(INTAKE_ISSUES_PATH, authenticate, big, async (c) => {
    const nodeId = c.get('nodeId');
    const port = deps.intakeIssues;
    if (!port) throw new ApiError(503, 'intake_not_wired', INTAKE_NOT_WIRED);
    const req = await readJson(c, IntakeIssueRequestSchema);

    const managed = (await deps.store.listRepos()).some(
      (r) => `${r.owner}/${r.name}`.toLowerCase() === req.repo.toLowerCase(),
    );
    if (!managed) throw new ApiError(404, 'unknown_repo', `${req.repo} 不是法国管的仓，开不了单`);
    const repo = repoRef(req.repo);
    const src = sourceOf(req);
    const sourceNote = sourceLine(req);

    // 并单：不开新单，在那张单上留一条评论（评论不是单子正文，不查四节）
    if (req.mergeInto !== undefined) {
      const text = `并单（来自${req.source.kind} ${req.source.ref}）：${req.title}\n\n${req.body}\n\n${sourceNote}`;
      let got: Awaited<ReturnType<IntakeIssuesPort['commentIssue']>>;
      try {
        got = await port.commentIssue({
          repo,
          issueNumber: req.mergeInto,
          key: req.idempotencyKey,
          body: text,
        });
      } catch (err) {
        throw githubFailure(err, `在 ${req.repo} #${req.mergeInto} 上留并单评论`);
      }
      await audit({
        nodeId,
        action: INTAKE_AUDIT.merge,
        repo: req.repo,
        number: req.mergeInto,
        after: { source: src, title: req.title, idempotencyKey: req.idempotencyKey, created: got.created },
      });
      return reply(c, IntakeIssueResponseSchema, {
        number: req.mergeInto,
        url: got.url,
        created: got.created,
        merged: true,
      });
    }

    const problems = bodyProblems(req);
    if (problems.length > 0) {
      throw new ApiError(
        422,
        'invalid_issue_body',
        `正文有 ${problems.length} 处不合格，单没开：${problems.map((p) => p.why).join(' ')}`,
        { problems },
      );
    }

    // 查重：只看开着的单；读不到不当成「没有重复」
    let open: OpenIssueRow[];
    try {
      open = await port.listOpenIssues({ repo });
    } catch (err) {
      log.warn('开单查重读不到开着的单', { nodeId, repo: req.repo, error: errMessage(err) });
      throw new ApiError(
        503,
        'duplicate_check_unavailable',
        `读不到 ${req.repo} 开着的单，查不了重复，单没开`,
      );
    }
    // 这个单键以前开过（单子正文里有它的来源行）：这是重放，直接交给幂等，不再拿它和别的单比
    const mine = `（单键 ${req.idempotencyKey}）`;
    const replay = open.some((i) => i.body.includes(mine));
    if (!replay && req.force !== true) {
      const strong = strongMatches(
        rankSimilar(
          { title: req.title, body: req.body },
          open.map((i) => ({ number: i.number, title: i.title, body: i.body, kind: 'issue' as const })),
        ),
      );
      const top = strong[0];
      if (top) {
        const candidates: IntakeCandidate[] = strong.map((s) => ({
          number: s.number,
          title: s.title,
          score: Number(s.score.toFixed(3)),
          why: s.why,
        }));
        await audit({
          nodeId,
          action: INTAKE_AUDIT.duplicateRefused,
          repo: req.repo,
          number: top.number,
          after: { source: src, title: req.title, idempotencyKey: req.idempotencyKey, candidates },
        });
        throw new ApiError(
          409,
          'duplicate_suspected',
          `和开着的 #${top.number}（${top.title}）太像，单没开：确是重复就带 mergeInto 并过去，确不是就带 force 照开`,
          { candidates },
        );
      }
    }

    const labels = [
      req.kind,
      domainLabel(req.domain),
      natureLabel(req.nature),
      ...(req.local ? [LOCAL_LABEL] : []),
    ];
    let opened: Awaited<ReturnType<IntakeIssuesPort['openIssue']>>;
    try {
      opened = await port.openIssue({
        repo,
        key: req.idempotencyKey,
        title: req.title,
        body: `${req.body.replace(/\s+$/, '')}\n\n${sourceNote}`,
        labels,
        milestone: req.milestone,
      });
    } catch (err) {
      throw githubFailure(err, `在 ${req.repo} 开单`);
    }
    await audit({
      nodeId,
      action: INTAKE_AUDIT.open,
      repo: req.repo,
      number: opened.number,
      after: {
        source: src,
        title: req.title,
        idempotencyKey: req.idempotencyKey,
        created: opened.created,
        forced: req.force === true,
      },
    });
    return reply(c, IntakeIssueResponseSchema, {
      number: opened.number,
      url: opened.url,
      created: opened.created,
    });
  });

  // 读账本：operation log 里 target 以 issue: 开头的行，按 id 升序往后读
  app.get(INTAKE_EVENTS_PATH, authenticate, async (c) => {
    const q = readQuery(c, IntakeEventsQuerySchema);
    let events: Awaited<ReturnType<Deps['store']['listIssueEvents']>>;
    try {
      events = await deps.store.listIssueEvents({ after: q.after, limit: q.limit });
    } catch (err) {
      log.warn('开单账本读不到', { nodeId: c.get('nodeId'), error: errMessage(err) });
      throw new ApiError(503, 'issue_events_unreadable', INTAKE_EVENTS_UNREADABLE);
    }
    return reply(c, IntakeEventsResponseSchema, { events, next: events.at(-1)?.id ?? q.after });
  });
}
