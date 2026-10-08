// 临时指挥官整理待办（jobs/groom.ts）的真装配（母单 #1335 第 3 片，#1338）。
//
// 改这里之前必须知道：
// - 会话怎么起：和别的一次性会话同一条路——选路按用途 groom（路由两层的用途 → 模型 → 路由，Fable 的硬禁令在选路里照旧生效）→
//   路由查出执行方式和会话用户（resolveSegmentRoute）→ 备一个主线的检出（prepareSegmentTree，钉在读到的主线头）→ 生产 Spawner 起会话。
//   会话收场删检出。不进 runs 表：runs 的 segment 只认对题 / 动手 / 验收三种（库里有约束），这一次的模型和用量写进 groom.done 操作记录。
// - 会话的工具面：读主线的只读检出（工作目录）；单子全在提示词里；它没有 GitHub 令牌（会话用户读不到引擎的凭据，design 第十四节）。
//   所有写操作（开单、评论、贴标签、往正文末尾追加）都在 GroomWrites 里由引擎代码执行，那里没有关单、改里程碑、推代码的入口。
// - 登记进一次性会话的清单（oneShots.enter）：切号、发布排空都能停下它；停下的算这一次没整理成（算进今天的次数）。
// - 读 GitHub、写 GitHub 都是「引擎」机器人（@fleet-dao/github）；单子正文是 AI 写的，写之前中和 @ 提醒和 <!-- -->、过卫生检查（github 包里做）。

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseStandardPaths } from '@fleet-dao/conventions';
import { type Db, listIntakeRepos, recordGroomDone, recordGroomStart, upsertAlert } from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { createPgStore, githubWhitelist } from '@fleet-dao/store';
import type { GroomFacts, GroomRunDeps, GroomSessionOutcome } from '../jobs/groom.ts';
import { GROOM_CLOSED_DAYS } from '../jobs/groom.ts';
import type { IntakeRepo } from '../jobs/intake.ts';
import type { PickRouteInput, PickRouteResult, PortContext } from '../ports.ts';
import type { UserExec } from './exec.ts';
import { groomRequestDeps } from './groom-request.ts';
import { mapped } from './mirror.ts';
import type { OneShotSessions } from './one-shot-sessions.ts';
import { hostSegmentSpawner, resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';
import { prepareSegmentTree } from './segment-tree.ts';
import type { Identity } from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

/** 整理待办要用到的 GitHub 这几下。 */
export type GroomGitHub = Pick<
  GitHub,
  | 'readGroomFacts'
  | 'listClosedIssues'
  | 'openIssue'
  | 'commentIssue'
  | 'addIssueLabel'
  | 'appendIssueBody'
  | 'fetchMainline'
  | 'bundleCommits'
> & {
  claims: Pick<GitHub['claims'], 'openPulls'>;
  commitIdentity(repo: { owner: string; name: string }): Promise<Identity>;
};

/** 改标准的路径清单跟着引擎代码一起发布（法国是整棵 monorepo 的检出），从引擎自己的检出里读。 */
const STANDARD_PATHS_URL = new URL('../../../conventions/standard-paths.json', import.meta.url);

const toRepo = (r: Awaited<ReturnType<typeof listIntakeRepos>>[number]): IntakeRepo => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  defaultBranch: r.defaultBranch,
  testCommand: r.testCommand,
  autoDispatchSince: r.autoDispatchSince ? r.autoDispatchSince.toISOString() : null,
});

export interface GroomWiring {
  db: Db;
  gh: GroomGitHub;
  trees: WorkTrees;
  exec: UserExec;
  /** 引擎自己的临时目录（bundle 落在这里）。 */
  tmpDir: string;
  /** 生产 Spawner 的装配（和动手、验收会话同一份）。 */
  spawner: SegmentSpawnerDeps;
  /** 选路（store-ports 的 pickRoute）。 */
  pickRoute: (input: PickRouteInput, ctx: PortContext) => Promise<PickRouteResult>;
  /** 一次性会话的登记（切号、发布排空照它停下会话）。 */
  sessions: OneShotSessions;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

const SPAWN_MARGIN_MS = 60_000;

/** 给 EngineJobs.groom 用的工厂：每一眼现装。 */
export function groomJob(w: GroomWiring): () => GroomRunDeps {
  const now = w.now ?? (() => new Date());
  const log: GroomRunDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const spawn = hostSegmentSpawner(w.spawner);
  const store = createPgStore(w.db, { now });
  const ref = (repo: IntakeRepo) => ({ owner: repo.owner, name: repo.name });

  const readFacts = async (repo: IntakeRepo): Promise<GroomFacts> => {
    const r = ref(repo);
    const groom = await w.gh.readGroomFacts({ repo: r });
    const closed = await w.gh.listClosedIssues({
      repo: r,
      since: new Date(now().getTime() - GROOM_CLOSED_DAYS * 24 * 60 * 60_000),
    });
    const pulls = await w.gh.claims.openPulls(r);
    const main = await mapped(() => w.gh.fetchMainline({ repo: r }));
    return {
      issues: groom.issues.map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body,
        // 账号删了、编号或类型读不到：认不出的人不在白名单里
        author:
          i.author !== null && i.authorId !== null && i.authorType !== null
            ? { login: i.author, id: i.authorId, type: i.authorType }
            : null,
        createdAt: i.createdAt,
        labels: i.labels,
        milestone: i.milestone,
      })),
      openMilestones: groom.milestones
        .filter((m) => m.state === 'open')
        .map((m) => ({ number: m.number, title: m.title, description: m.description })),
      closed,
      pulls: pulls.map((p) => ({ number: p.number, title: p.title, body: p.body })),
      mainHead: main.head,
    };
  };

  const runSession: GroomRunDeps['runSession'] = async (input): Promise<GroomSessionOutcome> => {
    const runId = randomUUID();
    const stop = new AbortController();
    const ctx: PortContext = {
      signal: stop.signal,
      heartbeat: () => undefined,
      attempt: 1,
      lastHeartbeat: undefined,
    };
    // 1. 选路：用途 groom。taskId 只是个占位（没有属于任何需求的任务行，不预占池的名额）
    const picked = await w.pickRoute(
      { taskId: `groom:${runId}`, stage: 'groom', avoidRouteIds: [], avoidPoolIds: [], avoidModelIds: [] },
      ctx,
    );
    if (!picked.ok) return { ok: false, why: `选不到路由（用途 groom）：${picked.detail}` };
    const route = picked.route;
    // 2. 路由 → 会话用户（树要归它）
    let info: Awaited<ReturnType<typeof resolveSegmentRoute>>;
    try {
      info = await resolveSegmentRoute(w.spawner, route.routeId);
    } catch (err) {
      return { ok: false, why: errMessage(err), routeId: route.routeId };
    }
    const ticket = w.sessions.enter({ poolId: route.poolId, stage: 'groom', taskId: `groom:${runId}` });
    ticket.attempt(runId);
    const dir = w.trees.treeFor(ref(input.repo), `fleet/groom-${runId.slice(0, 8)}`);
    const timeoutMs = input.timeoutMinutes * 60_000;
    try {
      // 3. 主线的检出（钉在读到的主线头）
      await prepareSegmentTree(
        { gh: w.gh, trees: w.trees, exec: w.exec, tmpDir: w.tmpDir },
        {
          repo: { owner: input.repo.owner, name: input.repo.name, defaultBranch: input.repo.defaultBranch },
          worktreePath: dir,
          branch: `groom-${runId.slice(0, 8)}`,
          baseSha: input.mainHead,
          user: info.user,
          runId,
        },
        ctx,
      );
      // 4. 起会话：切号 / 排空叫停（ticket.signal）和我们自己的时限都接进去
      const timer = setTimeout(() => stop.abort(new Error('整理会话超时')), timeoutMs);
      let out: Awaited<ReturnType<typeof spawn>>;
      try {
        ticket.running();
        out = await spawn({
          argv: [],
          cwd: dir,
          stdin: input.prompt,
          signal: AbortSignal.any([stop.signal, ticket.signal]),
          timeoutMs: timeoutMs + SPAWN_MARGIN_MS,
          // 生产 Spawner 只读 routeId、runId、effort；segment 在这里只是占位（不进 runs）
          input: {
            runId,
            segment: 'scope',
            modelId: route.modelId,
            routeId: route.routeId,
            prompt: input.prompt,
            cwd: dir,
          },
        });
      } finally {
        clearTimeout(timer);
      }
      const facts = out.facts;
      const usage = facts?.usage;
      const base = {
        routeId: route.routeId,
        ...(facts?.actualModel === undefined ? {} : { model: facts.actualModel }),
        ...(usage === undefined ? {} : { usage }),
        ...(facts?.costUsd === undefined ? {} : { costUsd: facts.costUsd }),
      };
      if (ticket.signal.aborted) {
        return {
          ok: false,
          why: `被切号或发布排空停下：${errMessage(ticket.signal.reason)}`,
          routeId: route.routeId,
        };
      }
      if (out.exitCode === 0) return { ok: true, answer: out.stdout, ...base };
      const why = out.killed
        ? `会话被杀（超时或被叫停）：${errMessage(stop.signal.reason ?? '原因不明')}`
        : `会话没成功收场（退出码 ${out.exitCode}）：${facts?.detail ?? out.stderr.slice(-300)}`;
      return { ok: false, why, routeId: route.routeId };
    } catch (err) {
      return { ok: false, why: errMessage(err), routeId: route.routeId };
    } finally {
      ticket.leave();
      await w.trees.remove(dir).catch((err: unknown) => {
        log('warn', '整理会话的检出没删掉（引擎下次起来时的清理会收）', { dir, error: errMessage(err) });
      });
    }
  };

  const request = groomRequestDeps(w.db, now);
  return () => ({
    rows: request.rows,
    engineMaster: request.engineMaster,
    recordStart: (i) => recordGroomStart(w.db, i),
    recordDone: (i) => recordGroomDone(w.db, i),
    async findRepo(slug) {
      const want = slug.toLowerCase();
      const all = await listIntakeRepos(w.db);
      const hit = all.find((r) => `${r.owner}/${r.name}`.toLowerCase() === want);
      return hit ? toRepo(hit) : null;
    },
    async whitelist() {
      return githubWhitelist(await store.listUsers());
    },
    readFacts,
    async standardPaths() {
      const parsed = parseStandardPaths(await readFile(STANDARD_PATHS_URL, 'utf8'));
      if (typeof parsed === 'string') throw new Error(`改标准的路径清单认不出：${parsed}`);
      return parsed;
    },
    runSession,
    writes: (repo) => ({
      openIssue: (i) =>
        w.gh.openIssue({
          repo: ref(repo),
          key: i.key,
          title: i.title,
          body: i.body,
          labels: i.labels,
          milestone: null,
        }),
      comment: async (i) => {
        const got = await w.gh.commentIssue({
          repo: ref(repo),
          issueNumber: i.issueNumber,
          key: i.key,
          body: i.body,
        });
        return { created: got.created };
      },
      addLabel: async (i) => {
        await w.gh.addIssueLabel({ repo: ref(repo), issueNumber: i.issueNumber, label: i.label });
      },
      appendBody: async (i) => {
        const got = await w.gh.appendIssueBody({
          repo: ref(repo),
          issueNumber: i.issueNumber,
          key: i.key,
          text: i.text,
        });
        return { outcome: got.outcome };
      },
    }),
    async notify(n) {
      await upsertAlert(w.db, {
        dedupeKey: n.key,
        level: n.level,
        taskId: null,
        title: n.title,
        body: n.body,
      });
    },
    now,
    log,
  });
}
