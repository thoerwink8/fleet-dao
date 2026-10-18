// 每小时对账的真装配：内存库上跑真迁移（提醒、需求、PR 头、结局记账都是真查询）、临时目录里的真 git 树（以本机执行器顶替
// 会话用户）、假的工作树管家（属主记在表里）、假的 Temporal（工作流在不在跑、挂没挂着由用例定）。
// 残留的树删掉、提醒跟着撤（未发布提交先完整保全，复杂成果留树）；读不到目录、查不了 Temporal、删不掉、git 没跑成都记没查成；
// 条件还在的提醒不撤；卡住报警超过 24 小时再推一次、同一天不重复。每条失败路径都故意造一次。
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AlertRow,
  alertByKey,
  approvals,
  auditLog,
  notifications,
  pullRequests,
  readLocalOrphans,
  repos,
  resolveAlertByKey,
  runs,
  scheduleRuns,
  subtasks,
  tasks,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { type AppCredentials, createGitHub, memoryLedger, silentLogger } from '@fleet-dao/github';
import { noteOnlyOptions } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AlertSweepDeps, type RouteCheck, sweepAlerts } from '../../src/jobs/alert-sweep.ts';
import { HOURLY_RECONCILE_JOB, runHourlyReconcileJob } from '../../src/jobs/hourly-reconcile.ts';
import { MERGED_PR_LOOKBACK_MS } from '../../src/jobs/reconcile-checks.ts';
import {
  RECONCILE_ACTOR,
  type WorkflowReader,
  type WorkflowState,
  type WorkflowView,
} from '../../src/jobs/reconcile-common.ts';
import { localExec } from '../../src/real/exec.ts';
import {
  closedIssueHoldOf,
  type HourlyReconcileWiring,
  hourlyReconcileJob,
  listDirEntries,
  taskViewOf,
  temporalWorkflows,
  workflowViewOf,
} from '../../src/real/hourly-reconcile.ts';
import { registerEngineJobs } from '../../src/real/jobs.ts';
import { runChildOk } from '../child.ts';
import { fakeTrees, git, world } from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

const USER = 'fleet-agent-carpool' as const;
const HOUR = 60 * 60_000;
const quiet = () => {};

let root: string;
let ft: ReturnType<typeof fakeTrees>;
beforeEach(async () => {
  await resetTestDb(t);
  await registerEngineJobs(t.db);
  root = mkdtempSync(join(tmpdir(), 'fleet-reconcile-'));
  ft = fakeTrees(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-archive`, { recursive: true, force: true });
});

/** 一个仓（acme/widgets）、一张需求（#160）、一个子任务（key login）。 */
async function work(state: (typeof tasks.$inferInsert)['state'] = 'failed') {
  const [repo] = await t.db
    .insert(repos)
    .values({ owner: 'acme', name: 'widgets', testCommand: 'pnpm check' })
    .returning();
  if (!repo) throw new Error('repo 没写进去');
  const [task] = await t.db
    .insert(tasks)
    .values({
      repoId: repo.id,
      issueNumber: 160,
      title: '登录页加验证码',
      rawRequest: '登录页加一个手机验证码',
      requestedBy: 'founder-a',
      priority: 10,
      state,
    })
    .returning();
  if (!task) throw new Error('task 没写进去');
  const [sub] = await t.db
    .insert(subtasks)
    .values({ taskId: task.id, index: 0, title: '登录页', key: 'login' })
    .returning();
  if (!sub) throw new Error('subtask 没写进去');
  return { repo, task, sub };
}

/** 一棵引擎建出来的树：一个主线提交、refs/fleet/incoming 指着它；extra 个会话自己的提交；dirty 留一个没提交的改动。 */
function makeTree(
  rel: string,
  opts: { extra?: number; dirty?: boolean } = {},
): { dir: string; head: string } {
  const dir = `${root}/${rel}`;
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'mainline');
  git(dir, 'update-ref', 'refs/fleet/incoming', 'HEAD');
  for (let i = 0; i < (opts.extra ?? 0); i += 1) {
    writeFileSync(join(dir, `work-${i}.ts`), `export const w = ${i};\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `session work ${i}`);
  }
  if (opts.dirty) writeFileSync(join(dir, 'half-done.ts'), 'x\n');
  ft.owners.set(dir, USER);
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

function probeDir() {
  const dir = `${root}/_route-probe/${USER}`;
  mkdirSync(dir, { recursive: true });
  ft.owners.set(dir, USER);
  return dir;
}

function fakeWorkflows(states: Record<string, WorkflowState> = {}, views: Record<string, WorkflowView> = {}) {
  const asked: string[] = [];
  const reader: WorkflowReader = {
    async state(id) {
      asked.push(id);
      return states[id] ?? { state: 'missing' };
    },
    async view(id) {
      const v = views[id];
      if (!v) throw new Error(`用例没给 ${id} 的查询结果`);
      return v;
    },
  };
  return { reader, asked, states, views };
}

function deps(over: Partial<HourlyReconcileWiring> & { now?: () => Date } = {}) {
  const wf = over.workflows ?? fakeWorkflows().reader;
  return hourlyReconcileJob({
    db: t.db,
    trees: ft.trees,
    exec: localExec(),
    archiveDir: `${root}-archive`,
    sessionOrg: async () => ({ ok: true, org: 'carpool' }),
    carpoolRegistry: async () => ({ ok: true }),
    machine: '法国',
    selfCheck: async () => [],
    gitBin: 'git',
    shBin: 'sh',
    log: quiet,
    stageRoutable: async (): Promise<RouteCheck> => ({ kind: 'none', detail: '没有在线的路由' }),
    gh: ghWith(),
    // 自动合并兜底（#242）部分在这一组里不走到 GitHub：默认空装；要走到那个部分的用例（看那个部分
    // 的测试，本文件不安排）再单独装这一份
    autoMergeGh: {
      listPrs: async () => [],
      pullFiles: async () => [],
      checksEvaluate: async () => 'none',
      requiredChecks: async () => ['check'],
      readStandardPathsFile: async () => '{"paths":[]}',
      enableAutoMerge: async () => {},
    },
    autoMergeAlerts: {
      raise: async () => {},
      resolve: async () => 'not_found',
      listOpenByPrefix: async () => [],
    },
    // 单已关且停下等人就撤任务（#1816）在本文件不走到 Temporal / GitHub：默认空装（这里的假客户端也列不了工作流）
    closedIssueTasks: {
      runningTaskWorkflowIds: async () => [],
      isParked: async () => false,
      resolveParkAlerts: async () => 0,
      issueState: async () => 'open',
      abandon: async () => 'gone',
    },
    ...over,
    workflows: wf,
  })({ workflow: {} as never } as never, 'fleet-test');
}

/** 假 GitHub：审合并的 PR 由用例定（默认一条都没合）。 */
function ghWith(over: Partial<HourlyReconcileWiring['gh']> = {}): HourlyReconcileWiring['gh'] {
  return {
    auditMergedPrs: async () => ({
      outcome: 'ok',
      scanned: 0,
      found: 0,
      fixed: 0,
      problems: [],
      findings: [],
    }),
    readIssueState: async () => {
      throw new Error('用例里不该读单状态');
    },
    // 立案（#1406）走到这里：默认开成一张假单。要测写失败的用例自己换。
    openIssue: async () => ({
      number: 9001,
      url: 'https://github.com/acme/widgets/issues/9001',
      created: true,
    }),
    claims: new Proxy({} as HourlyReconcileWiring['gh']['claims'], {
      get: (_t, prop) => () => {
        throw new Error(`用例里不该碰 PR 读写（${String(prop)}）`);
      },
    }),
    // 自动合并兜底（#242）那部分的 GitHub：走到就是「用例写错了」
    pullFiles: async () => {
      throw new Error('用例里不该读 PR 改到的文件');
    },
    readRepoFile: async () => {
      throw new Error('用例里不该读主线上文件');
    },
    mergePr: async () => {
      throw new Error('用例里不该直接合并');
    },
    deps: new Proxy({} as HourlyReconcileWiring['gh']['deps'], {
      get: (_t, prop) => {
        // 主线红每轮都读 ci.yml。这一页是空的：没有要推的，也不算没查成。别的请求照旧不该发生。
        if (prop === 'client') {
          return {
            async request(req: { path?: string }) {
              if (typeof req.path === 'string' && req.path.includes('/actions/workflows/ci.yml/runs')) {
                return { status: 200, data: { workflow_runs: [] }, headers: new Headers() };
              }
              throw new Error(`用例里不该碰 GitHub 的 deps（client.request ${req.path ?? ''}）`);
            },
            async all() {
              throw new Error('用例里不该碰 GitHub 的 deps（client.all）');
            },
          };
        }
        return () => {
          throw new Error(`用例里不该碰 GitHub 的 deps（${String(prop)}）`);
        };
      },
    }),
    ...over,
  };
}

/**
 * #1960 正文里那一行。日期还没到；括号里的 #2789 是已合 PR，不是 issue。
 * 前置语法认括号里的 #N，这一行会解析出 issues=[2789]、until=2026-11-12。
 */
const ISSUE_1960_PREREQUISITE =
  '前置：2026-11-12 复查日（PR #2789 已合、决定 0102 已写；到日子按返工率复查、写进 0102 再关单）';

/** 失败轮之前种下的旧名单。对上北京时间 2026-10-18 05:41 留下的那一份。 */
const OLD_ORPHANS = [
  {
    repo: 'acme/widgets',
    issue: 7,
    labeledForMs: 90_000_000,
    labeledFor: '25 小时',
    reason: '上一份还在',
  },
];

type PrerequisiteNode = { kind: 'issue' | 'pr'; state: 'open' | 'closed' | 'merged' };

const PREREQUISITE_API = 'https://api.github.test';
const PREREQUISITE_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  checks: 'read',
  actions: 'read',
  statuses: 'write',
  metadata: 'read',
  administration: 'write',
};

let prerequisiteApps: Record<'agent' | 'engine', AppCredentials> | undefined;
function prerequisiteAppCredentials(): Record<'agent' | 'engine', AppCredentials> {
  if (prerequisiteApps) return prerequisiteApps;
  const agent = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const engine = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  prerequisiteApps = {
    agent: { role: 'agent', appId: 101, slug: 'fleet-test-agent', privateKey: agent, source: 'test' },
    engine: { role: 'engine', appId: 202, slug: 'fleet-test-engine', privateKey: engine, source: 'test' },
  };
  return prerequisiteApps;
}

/**
 * 真 createGitHub 接一份只答安装、令牌、IssueStates 和 issue REST 的假服务。
 * GraphQL issueOrPullRequest 认 issue 和 PR；REST 的 GET /issues/N 对 PR 带回 pull_request，
 * 真 readIssueState 因此抛 NOT_AN_ISSUE。装配要是改回逐个 readIssueState，前置是 PR 的那一轮就红。
 */
function prerequisiteGitHub(
  nodes: ReadonlyMap<string, PrerequisiteNode>,
  breakage?: 'forbidden' | 'down' | 'bad-shape',
) {
  const issueStates: { owner: string; name: string; numbers: number[] }[] = [];
  const issueGets: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) {
      return json(200, { id: 22, permissions: PREREQUISITE_PERMISSIONS });
    }
    if (path === '/app/installations/22/access_tokens') {
      return json(201, {
        token: 'ghs_testengine1xxxxxxxxxxxxxxxx',
        expires_at: '2099-01-01T00:00:00.000Z',
        permissions: PREREQUISITE_PERMISSIONS,
      });
    }
    const issuePath = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    if (issuePath && method === 'GET') {
      const owner = issuePath[1] ?? '';
      const name = issuePath[2] ?? '';
      const number = Number(issuePath[3]);
      issueGets.push(`${owner}/${name}#${number}`);
      const node = nodes.get(`${owner}/${name}#${number}`);
      if (!node) return json(404, { message: 'Not Found' });
      return json(200, {
        number,
        node_id: `I_${number}`,
        html_url: `https://github.test/${owner}/${name}/issues/${number}`,
        state: node.state === 'open' ? 'open' : 'closed',
        title: `#${number}`,
        body: '',
        user: null,
        updated_at: '2026-10-16T11:12:42Z',
        ...(node.kind === 'pr'
          ? { pull_request: { url: `https://github.test/${owner}/${name}/pull/${number}` } }
          : {}),
      });
    }
    if (path === '/graphql' && method === 'POST') {
      if (breakage === 'down') throw new Error('network down');
      if (breakage === 'forbidden') return json(403, { message: 'Resource not accessible by integration' });
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (!body.query?.includes('query IssueStates')) {
        return json(404, { message: '假 GitHub 不认识这个查询' });
      }
      const variables = body.variables ?? {};
      const owner = String(variables.owner ?? '');
      const name = String(variables.name ?? '');
      const indexed: number[] = [];
      for (const [key, value] of Object.entries(variables)) {
        const m = /^n(\d+)$/.exec(key);
        if (!m) continue;
        indexed[Number(m[1])] = Number(value);
      }
      const numbers = indexed.filter((n) => Number.isInteger(n));
      issueStates.push({ owner, name, numbers });
      if (breakage === 'bad-shape') {
        return json(200, { data: { repository: { a0: { __typename: 'Blob' } } } });
      }
      const repository: Record<string, unknown> = {};
      const errors: { type: string; message: string }[] = [];
      numbers.forEach((n, i) => {
        const node = nodes.get(`${owner}/${name}#${n}`);
        if (!node) {
          repository[`a${i}`] = null;
          errors.push({
            type: 'NOT_FOUND',
            message: `Could not resolve to an issue or pull request with the number of ${n}.`,
          });
          return;
        }
        repository[`a${i}`] =
          node.kind === 'issue'
            ? { __typename: 'Issue', state: node.state === 'open' ? 'OPEN' : 'CLOSED' }
            : {
                __typename: 'PullRequest',
                prState: node.state === 'open' ? 'OPEN' : node.state === 'merged' ? 'MERGED' : 'CLOSED',
              };
      });
      return json(200, { data: { repository }, ...(errors.length > 0 ? { errors } : {}) });
    }
    return json(404, { message: `假 GitHub 里没有 ${method} ${path}` });
  };
  const gh = createGitHub({
    ledger: memoryLedger(),
    apps: prerequisiteAppCredentials(),
    apiUrl: PREREQUISITE_API,
    fetch: fetchImpl,
    now: () => new Date('2026-10-17T22:41:00.000Z'),
    sleep: async () => undefined,
    env: {},
    stateDir: join(root, 'gh-state'),
    log: silentLogger,
  });
  return { gh, issueStates, issueGets };
}

function prerequisiteNodes(
  rows: readonly [string, number, PrerequisiteNode['kind'], PrerequisiteNode['state']][],
): Map<string, PrerequisiteNode> {
  return new Map(rows.map(([repo, number, kind, state]) => [`${repo}#${number}`, { kind, state }]));
}

const alert = (
  dedupeKey: string,
  over: { level?: 'alert' | 'decision'; taskId?: string | null; title?: string } = {},
) =>
  upsertAlert(t.db, {
    dedupeKey,
    level: over.level ?? 'alert',
    taskId: over.taskId ?? null,
    title: over.title ?? dedupeKey,
    body: '原来的正文',
    ...(over.level === 'decision' ? { options: noteOnlyOptions(), reason: 'human-only' as const } : {}),
  });

/** 直接改库（引擎包不直接依赖 drizzle）：时刻一律 ISO 字符串再 ::timestamptz（生产驱动不收 Date 参数）。 */
const sql = (text: string, params: unknown[] = []) => t.client.query(text, params);

/** world() 的额度读数停在固定的假时刻；把读数推到此刻（额度核对搬去看门狗以后对账不再看它，留着不碍事）。 */
async function freshenQuota() {
  await sql('update pools set last_read_ok_at = now()');
  await sql('update quota_windows set read_at = now()');
}

/** 把一条提醒的建立、这一次挂起、更新时刻挪到 at（造「很久以前报的、一直挂着」）。updatedAt 单独给时只挪最近一次再报。 */
async function backdate(dedupeKey: string, at: Date, updatedAt = at) {
  await sql(
    'update notifications set created_at = $1::timestamptz, raised_at = $1::timestamptz, updated_at = $2::timestamptz where dedupe_key = $3',
    [at.toISOString(), updatedAt.toISOString(), dedupeKey],
  );
}

/** 人在驾驶舱点了处理。 */
async function resolvedByHuman(where: { key: string } | { id: string }, by: string) {
  const [column, value] = 'key' in where ? ['dedupe_key', where.key] : ['id', where.id];
  await sql(`update notifications set resolved_at = now(), resolved_by = $1 where ${column} = $2`, [
    by,
    value,
  ]);
}

const runsOf = async () =>
  (await t.db.select().from(scheduleRuns)).filter((r) => r.job === HOURLY_RECONCILE_JOB.id);

describe('工作树：残留的经成果保全后清理，复杂成果和人指定留的树保留', { timeout: 120_000 }, () => {
  it('没有在跑的任务在用、什么都不剩的树删掉，「工作树没收掉」跟着撤（写明为什么、记操作记录）；检出副本里会话交给引擎的结论文件不算剩着；探针目录不算残留', async () => {
    const { sub } = await work();
    const tree = makeTree('acme_widgets/160-login');
    const scratch = makeTree('acme_widgets/160.plan');
    mkdirSync(join(scratch.dir, '.fleet-out'));
    writeFileSync(join(scratch.dir, '.fleet-out', 'plan.md'), '# 方案\n');
    const probe = probeDir();
    // 会话自己的临时目录（会话收场、工人起来时各自清）：不碰、不算认不出的东西
    const sessionTmp = `${root}/_tmp/${randomUUID()}`;
    mkdirSync(sessionTmp, { recursive: true });
    await alert(`sub:${sub.id}:worktree`, { title: '工作树没收掉' });

    const run = await runHourlyReconcileJob(deps());
    expect(existsSync(tree.dir)).toBe(false);
    expect(existsSync(scratch.dir)).toBe(false);
    expect(existsSync(probe)).toBe(true);
    expect(existsSync(sessionTmp)).toBe(true);
    const row = await alertByKey(t.db, `sub:${sub.id}:worktree`);
    expect(row?.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(row?.body).toMatch(/^已撤：每小时对账把这棵树删了（acme_widgets\/160-login）/);
    expect(await t.db.select().from(auditLog)).toEqual([
      expect.objectContaining({ actorId: RECONCILE_ACTOR, action: 'notification.resolve' }),
    ]);
    // 两棵树 + 一个探针目录（提醒那部分列的时候，这条已经撤了）；删了两棵、撤了一条
    expect(run).toMatchObject({ outcome: 'ok', scanned: 3, found: 3 });
    expect((await runsOf())[0]).toMatchObject({ outcome: 'ok', scanned: 3, found: 3 });
  });

  it('未提交成果不能被小时清扫绕过保全：留树、记没查成，原卡保持未修复', async () => {
    const { sub } = await work();
    const tree = makeTree('acme_widgets/160-login', { extra: 2, dirty: true });
    probeDir();
    await alert(`sub:${sub.id}:worktree`, { title: '工作树没收掉' });

    const run = await runHourlyReconcileJob(deps());
    expect(existsSync(tree.dir)).toBe(true);
    expect(await alertByKey(t.db, 'worktree:acme_widgets/160-login')).toBeNull();
    expect((await t.db.select().from(notifications)).filter((n) => n.level === 'decision')).toEqual([]);
    const row = await alertByKey(t.db, `sub:${sub.id}:worktree`);
    expect(row?.resolvedAt).toBeNull();
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('保留原树供接管');
    expect(git(tree.dir, 'rev-parse', 'HEAD')).toBe(tree.head);
  });

  describe('删树前保全界面截图（#2983）', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag)]);

    /** 照 docs/design/驾驶舱界面.md 第七节做一个不挂引用的孤儿图片提交（原图删掉，提交是唯一副本）。 */
    function orphanShot(dir: string, name: string, bytes: Buffer): string {
      const work = `${root}-src`;
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, name), bytes);
      // 提交身份放进环境：CI 的机器上没有全局的 user.name
      const env = {
        ...process.env,
        GIT_INDEX_FILE: `${root}-orphan.idx`,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
      };
      runChildOk('git', ['--work-tree', work, 'add', '-f', '.'], { cwd: dir, env });
      const tree = runChildOk('git', ['write-tree'], { cwd: dir, env });
      const commit = runChildOk('git', ['commit-tree', tree, '-m', '截图'], { cwd: dir, env });
      rmSync(work, { recursive: true, force: true });
      rmSync(`${root}-orphan.idx`, { force: true });
      return commit;
    }

    it('复现：树里只剩没推的孤儿图片提交（treeLeftovers 看不到，以前照空树删）：先存进受限归档、记清单，再删', async () => {
      const { task } = await work();
      const tree = makeTree('acme_widgets/160-login');
      orphanShot(tree.dir, 'home-before.png', png('before'));
      probeDir();

      const run = await runHourlyReconcileJob(deps());
      expect(run.outcome).toBe('ok');
      expect(existsSync(tree.dir)).toBe(false);
      const manifest = join(`${root}-archive`, task.id, 'shots', tree.head, 'manifest.json');
      const m = JSON.parse(readFileSync(manifest, 'utf8'));
      expect(m.delivery).toMatchObject({ outcome: 'archived', head: tree.head, branch: 'shots/160' });
      expect(m.delivery.files[0].path).toMatch(/\/home-before\.png$/);
      expect(readdirSync(join(manifest, '..')).filter((f) => f.endsWith('.png'))).toHaveLength(1);
    });

    it('【故意造出的失败】归档写不进去：树留着、图还在，这一轮记没查成写明原因；修好了下一轮存上再删', async () => {
      await work();
      const tree = makeTree('acme_widgets/160-login', { extra: 1 });
      mkdirSync(join(tree.dir, '_tmp', 'shots', '160'), { recursive: true });
      writeFileSync(join(tree.dir, '_tmp', 'shots', '160', 'after.png'), png('after'));
      probeDir();
      writeFileSync(`${root}-archive`, '占住了');

      const run = await runHourlyReconcileJob(deps());
      expect(run.outcome).toBe('partial');
      expect(run.why).toContain('acme_widgets/160-login 里的界面截图没交付也没存档成，树留着没删');
      expect(existsSync(join(tree.dir, '_tmp', 'shots', '160', 'after.png'))).toBe(true);

      rmSync(`${root}-archive`);
      await runHourlyReconcileJob(deps());
      expect(existsSync(tree.dir)).toBe(false);
    });
  });

  it('以前（#2729 之前）报过的工作树要你拍、人点了留着：照人的意思留着，不删、不再报', async () => {
    await work();
    const tree = makeTree('acme_widgets/160-login', { extra: 2, dirty: true });
    probeDir();
    await alert('worktree:acme_widgets/160-login', { level: 'decision', title: '工作树里有没推的东西' });
    await resolvedByHuman({ key: 'worktree:acme_widgets/160-login' }, 'founder-a');

    expect(await runHourlyReconcileJob(deps())).toMatchObject({ outcome: 'ok', found: 0 });
    expect(existsSync(tree.dir)).toBe(true);
    expect(await alertByKey(t.db, 'worktree:acme_widgets/160-login')).toMatchObject({
      resolvedBy: 'founder-a',
    });
    expect(await runHourlyReconcileJob(deps())).toMatchObject({ outcome: 'ok', found: 0 });
    expect(existsSync(tree.dir)).toBe(true);
  });

  it('以前工作树要你拍还开着：未发布提交保全后清理，原卡写明清理前成果', async () => {
    await work();
    const tree = makeTree('acme_widgets/160-login', { extra: 1 });
    probeDir();
    await alert('worktree:acme_widgets/160-login', { level: 'decision', title: '工作树里有没推的东西' });

    await runHourlyReconcileJob(deps());
    expect(existsSync(tree.dir)).toBe(false);
    expect(await alertByKey(t.db, 'worktree:acme_widgets/160-login')).toMatchObject({
      resolvedBy: RECONCILE_ACTOR,
      body: expect.stringMatching(
        /^已撤：树里剩着没推的东西，每小时对账经成果保全后清理了（acme_widgets\/160-login）：没推的提交 1 个/,
      ),
    });
  });

  it('【故意造出的失败】还剩没推东西的树删不掉：记没查成（partial），树留着，不报要你拍', async () => {
    await work();
    const tree = makeTree('acme_widgets/160-login', { extra: 1 });
    probeDir();
    ft.trees.remove = async () => {
      throw new Error('权限不够');
    };
    const run = await runHourlyReconcileJob(deps());
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('acme_widgets/160-login 还剩没推的东西，保全清理没做成：权限不够');
    expect(existsSync(tree.dir)).toBe(true);
    expect(await alertByKey(t.db, 'worktree:acme_widgets/160-login')).toBeNull();
  });

  /** 一棵不是 git 仓的树（上一版删到一半、会话的编译进程又写回来的那种）：rel 下按路径写文件，属主记会话用户。 */
  function plainTree(rel: string, files: Record<string, string>): string {
    const dir = `${root}/${rel}`;
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    ft.owners.set(dir, USER);
    return dir;
  }

  it('只剩能重新生成的缓存（法国 160-handover-store：不是 git 仓，只剩两个 tsbuildinfo；git 仓里只剩没跟踪的缓存也一样）：照空树删，上一版报的要人拍跟着撤', async () => {
    await work();
    probeDir();
    const dir = plainTree('acme_widgets/160-handover-store', {
      'packages/api/tsconfig.tsbuildinfo': '{}',
      'packages/db/tsconfig.tsbuildinfo': '{}',
    });
    // 上一版把它判成「这一层不是 git 仓，里面却有东西」，报了要人拍
    await alert('worktree:acme_widgets/160-handover-store', {
      level: 'decision',
      title: '工作树里有没推的东西，删不删要你拍：acme_widgets/160-handover-store',
    });
    const repoTree = makeTree('acme_widgets/160-login');
    mkdirSync(join(repoTree.dir, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(repoTree.dir, 'node_modules', 'foo', 'index.js'), 'x\n');
    writeFileSync(join(repoTree.dir, 'tsconfig.tsbuildinfo'), '{}');

    const run = await runHourlyReconcileJob(deps());
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(repoTree.dir)).toBe(false);
    expect(await alertByKey(t.db, 'worktree:acme_widgets/160-handover-store')).toMatchObject({
      resolvedBy: RECONCILE_ACTOR,
      body: expect.stringMatching(
        /^已撤：树里已经没有没推、没提交的东西了（能重新生成的编译和工具缓存不算），每小时对账把树删了（acme_widgets\/160-handover-store）/,
      ),
    });
    // 两棵树 + 探针目录；删了两棵、撤了一条
    expect(run).toMatchObject({ outcome: 'ok', scanned: 3, found: 3 });
  });

  it('非Git目录剩着源文件：保留原树，不能用AI自产物的身份跳过保全', async () => {
    await work();
    probeDir();
    const dir = plainTree('acme_widgets/160-handover-store', {
      'packages/api/tsconfig.tsbuildinfo': '{}',
      'packages/api/src/handover.ts': 'export const h = 1;\n',
    });
    await alert('worktree:acme_widgets/160-handover-store', {
      level: 'decision',
      title: '工作树里有没推的东西',
    });

    const run = await runHourlyReconcileJob(deps());
    expect(run.outcome).toBe('partial');
    expect(existsSync(dir)).toBe(true);
    const row = await alertByKey(t.db, 'worktree:acme_widgets/160-handover-store');
    expect(row?.resolvedAt).toBeNull();
    expect(readFileSync(join(dir, 'packages/api/src/handover.ts'), 'utf8')).toContain('export const h');
    expect(run.why).toContain('保留原树供接管');
  });

  it('树里有目录读不了：记没查成（partial，写明哪棵、为什么），不删，也不报要人拍', async () => {
    await work();
    probeDir();
    const dir = plainTree('acme_widgets/160-handover-store', { 'packages/api/tsconfig.tsbuildinfo': '{}' });
    const real = localExec();
    const run = await runHourlyReconcileJob(
      deps({
        exec: async (c) =>
          c.argv.join(' ').includes('find')
            ? { ...(await real(c)), code: 1, stderr: "find: './locked': Permission denied\n" }
            : real(c),
      }),
    );
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain(
      "acme_widgets/160-handover-store 里还剩什么没查成（没删）：列树里的东西：退出码 1（find: './locked': Permission denied）",
    );
    expect(existsSync(dir)).toBe(true);
    expect(await alertByKey(t.db, 'worktree:acme_widgets/160-handover-store')).toBeNull();
  });

  // 真把目录权限去掉：Windows 上去不掉、root 照样读得了，这两种不跑（CI 是 Linux 普通用户）。
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '真有读不了的目录（chmod 000）：记没查成，不删',
    async () => {
      await work();
      probeDir();
      const dir = plainTree('acme_widgets/160-handover-store', {
        'packages/api/tsconfig.tsbuildinfo': '{}',
        'locked/secret.ts': 'export const s = 1;\n',
      });
      chmodSync(join(dir, 'locked'), 0o000);
      try {
        const run = await runHourlyReconcileJob(deps());
        expect(run.outcome).toBe('partial');
        expect(run.why).toContain('acme_widgets/160-handover-store 里还剩什么没查成（没删）');
        expect(existsSync(dir)).toBe(true);
      } finally {
        chmodSync(join(dir, 'locked'), 0o755);
      }
    },
  );

  it('任务工作流还在跑、或者它的子任务工作流还在收尾：这张单的树都不碰，「工作树没收掉」也留着', async () => {
    const { sub } = await work();
    const tree = makeTree('acme_widgets/160-login');
    probeDir();
    await alert(`sub:${sub.id}:worktree`);
    const running = fakeWorkflows({ 'task:acme/widgets#160': { state: 'running' } });
    expect(await runHourlyReconcileJob(deps({ workflows: running.reader }))).toMatchObject({ outcome: 'ok' });
    expect(existsSync(tree.dir)).toBe(true);
    expect((await alertByKey(t.db, `sub:${sub.id}:worktree`))?.resolvedAt).toBeNull();

    const finishing = fakeWorkflows({
      'task:acme/widgets#160': { state: 'closed', status: 'COMPLETED' },
      [`sub:${sub.id}`]: { state: 'running' },
    });
    await runHourlyReconcileJob(deps({ workflows: finishing.reader }));
    expect(existsSync(tree.dir)).toBe(true);
  });

  it('任务工作流（task:）在跑、树里没开着的会话（等 CI、等合并）：任务自己的树 <号>-t<8 位> 不被当残留删掉（#901）', async () => {
    await work();
    probeDir();
    const tree = makeTree('acme_widgets/160-t1234abcd');
    const running = fakeWorkflows({ 'task:acme/widgets#160': { state: 'running' } });
    expect(await runHourlyReconcileJob(deps({ workflows: running.reader }))).toMatchObject({ outcome: 'ok' });
    expect(running.asked).toContain('task:acme/widgets#160');
    expect(existsSync(tree.dir)).toBe(true);
    // 对照：旧的 req: 编号在跑（现实里不会有这条工作流）不算在用，这棵干净的树照删——保护认的是 task: 不是 req:
    const legacy = fakeWorkflows({ 'req:acme/widgets#160': { state: 'running' } });
    await runHourlyReconcileJob(deps({ workflows: legacy.reader }));
    expect(existsSync(tree.dir)).toBe(false);
  });

  it('工作流都不在跑了、树里却还有没结束的会话（被强行终止留下的、认不出的工作流起的）：不碰，记没查成写明是哪个会话；会话结束了照删', async () => {
    await world(t.db);
    const { task, sub } = await work();
    const tree = makeTree('acme_widgets/160-login');
    probeDir();
    await alert(`sub:${sub.id}:worktree`);
    const [run] = await t.db
      .insert(runs)
      .values({
        taskId: task.id,
        segment: 'manual',
        model: 'opus-5.5',
        routeId: 'solo',
        startedAt: new Date(Date.now() - HOUR),
        worktreePath: tree.dir,
      })
      .returning();
    if (!run) throw new Error('run 没写进去');

    const first = await runHourlyReconcileJob(deps());
    expect(first.outcome).toBe('partial');
    expect(first.why).toContain(`acme_widgets/160-login 里还有没结束的会话（动手段`);
    expect(first.why).toContain(`会话 ${run.id.slice(0, 8)}`);
    expect(existsSync(tree.dir)).toBe(true);
    expect((await alertByKey(t.db, `sub:${sub.id}:worktree`))?.resolvedAt).toBeNull();

    await sql("update runs set ended_at = now(), outcome = 'killed' where id = $1", [run.id]);
    expect(await runHourlyReconcileJob(deps())).toMatchObject({ outcome: 'ok' });
    expect(existsSync(tree.dir)).toBe(false);
  });

  it('查不了有没有没结束的会话：树都不碰，记没查成', async () => {
    await work();
    probeDir();
    const tree = makeTree('acme_widgets/160-login');
    const wiring = deps();
    const run = await runHourlyReconcileJob({
      ...wiring,
      openSessions: async () => {
        throw new Error('runs 读超时（故意造的）');
      },
    });
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('里有没有没结束的会话没查成（没碰）：runs 读超时');
    expect(existsSync(tree.dir)).toBe(true);
  });

  it('Fusion 报的「工作树没收掉」（键里只有需求）：这张需求的 Fusion 树都有了去向才撤；还在用、那个仓列不了就留着', async () => {
    await work();
    probeDir();
    const tree = makeTree('acme_widgets/160-f1234abcd');
    await alert('req:acme/widgets#160:worktree', { title: '工作树没收掉' });
    const stillOpen = async () =>
      (await alertByKey(t.db, 'req:acme/widgets#160:worktree'))?.resolvedAt === null;

    // 这张单的任务工作流还在跑：树不碰、提醒留着
    const running = fakeWorkflows({ 'task:acme/widgets#160': { state: 'running' } });
    await runHourlyReconcileJob(deps({ workflows: running.reader }));
    expect(existsSync(tree.dir)).toBe(true);
    expect(await stillOpen()).toBe(true);

    // 仓那一层这一轮列不了：看不到树的去向，留着
    const listDir: HourlyReconcileWiring['listDir'] = async (dir) => {
      if (dir.endsWith('acme_widgets')) throw new Error('EACCES: 故意造的');
      return listDirEntries(dir);
    };
    expect((await runHourlyReconcileJob(deps({ listDir }))).outcome).toBe('partial');
    expect(await stillOpen()).toBe(true);

    // 工作流结束了、树里什么都不剩：删树、撤提醒
    await runHourlyReconcileJob(deps());
    expect(existsSync(tree.dir)).toBe(false);
    expect((await alertByKey(t.db, 'req:acme/widgets#160:worktree'))?.body).toMatch(
      /^已撤：每小时对账把这棵树删了（acme_widgets\/160-f1234abcd）/,
    );
  });

  it('Fusion 的树早没了：「工作树没收掉」撤掉，写明这张需求的树不在了；别的需求的不动', async () => {
    await work();
    probeDir();
    makeTree('acme_widgets/161-fabcdef12');
    await alert('req:acme/widgets#160:worktree');
    const other = fakeWorkflows({ 'task:acme/widgets#161': { state: 'running' } });
    await runHourlyReconcileJob(deps({ workflows: other.reader }));
    expect((await alertByKey(t.db, 'req:acme/widgets#160:worktree'))?.body).toMatch(
      /^已撤：这张需求的树已经不在了（acme_widgets\/160-f…）/,
    );
    expect(existsSync(`${root}/acme_widgets/161-fabcdef12`)).toBe(true);
  });

  it('树已经不在了（别人删了）：「工作树没收掉」撤掉，写明树不在了', async () => {
    const { sub } = await work();
    probeDir();
    await alert(`sub:${sub.id}:worktree`);
    await runHourlyReconcileJob(deps());
    expect((await alertByKey(t.db, `sub:${sub.id}:worktree`))?.body).toBe(
      '已撤：树已经不在了（acme_widgets/160-login）\n\n原来的正文',
    );
  });

  it('读不到工作树的根：记没查成（failed，写明原因），抛出——不当成没有残留', async () => {
    rmSync(root, { recursive: true, force: true });
    await expect(runHourlyReconcileJob(deps())).rejects.toThrow('读不了');
    const [row] = await runsOf();
    expect(row).toMatchObject({ outcome: 'failed' });
    expect(row?.why).toContain(`工作树的根 ${root} 读不了`);
  });

  it('仓那一层列不了、有认不出的东西：这一轮记 partial 写明哪里没查成，别的照查', async () => {
    await work();
    probeDir();
    makeTree('acme_widgets/160-login');
    mkdirSync(`${root}/lost+found`);
    const listDir: HourlyReconcileWiring['listDir'] = async (dir) => {
      if (dir.endsWith('acme_widgets')) throw new Error('EACCES: 故意造的没权限');
      return listDirEntries(dir);
    };
    const run = await runHourlyReconcileJob(deps({ listDir }));
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('acme_widgets 列不了：EACCES: 故意造的没权限');
    expect(run.why).toContain('认不出的东西');
    expect(run.why).toContain('lost+found');
    expect(existsSync(`${root}/acme_widgets/160-login`)).toBe(true);
  });

  it('查不了 Temporal、git 没跑成、删不掉：树都不删，记没查成（partial），提醒不撤', async () => {
    const { sub } = await work();
    probeDir();
    const tree = makeTree('acme_widgets/160-login');
    await alert(`sub:${sub.id}:worktree`);

    const down: WorkflowReader = {
      state: async () => {
        throw new Error('14 UNAVAILABLE: 连不上 Temporal');
      },
      view: async () => {
        throw new Error('不该问');
      },
    };
    const noTemporal = await runHourlyReconcileJob(deps({ workflows: down }));
    expect(noTemporal.outcome).toBe('partial');
    expect(noTemporal.why).toContain('有没有在跑的任务在用没查成：14 UNAVAILABLE');

    const real = localExec();
    const gitDown = await runHourlyReconcileJob(
      deps({
        exec: (c) =>
          c.argv.includes('status')
            ? Promise.resolve({
                code: 128,
                stdout: Buffer.alloc(0),
                stderr: 'fatal: 故意造的\n',
                timedOut: false,
                aborted: false,
              })
            : real(c),
      }),
    );
    expect(gitDown.outcome).toBe('partial');
    expect(gitDown.why).toContain('里还剩什么没查成（没删）');

    ft.trees.remove = async () => {
      throw new Error('删 x 没成：退出码 1');
    };
    const stuck = await runHourlyReconcileJob(deps());
    expect(stuck.outcome).toBe('partial');
    expect(stuck.why).toContain('acme_widgets/160-login 删不掉：删 x 没成');
    expect(existsSync(tree.dir)).toBe(true);
    expect((await alertByKey(t.db, `sub:${sub.id}:worktree`))?.resolvedAt).toBeNull();
  });

  it('残留太多：一轮只看前几棵，剩下的下一轮再看，这一轮记没查全', async () => {
    await work();
    probeDir();
    makeTree('acme_widgets/160-a');
    makeTree('acme_widgets/160-b');
    makeTree('acme_widgets/160-c');
    const run = await runHourlyReconcileJob(deps({ inspectMax: 2 }));
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('这一轮只看了 2 棵，还有 1 棵下一轮再看');
    expect(await runHourlyReconcileJob(deps({ inspectMax: 2 }))).toMatchObject({ outcome: 'ok' });
  });
});

describe('提醒：条件没了就撤、还在就留着', { timeout: 60_000 }, () => {
  const parkedView = (since: Date, over: Partial<WorkflowView> = {}): WorkflowView => ({
    parked: true,
    waiting: {
      kind: 'human',
      detail: '挂起：「triage」没有能用的路由（等「继续」或「换路由」）',
      since: since.toISOString(),
    },
    doing: '分诊',
    approval: null,
    ...over,
  });

  it('挂起的任务工作流结束了、不挂着了：撤，写明为什么', async () => {
    probeDir();
    await alert('req:acme/patrol#11:park:1', { title: '「triage」没有能用的路由' });
    await alert('sub:3f0f8a6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b:park:2', { title: '判断「verify」出错，挂起等人' });
    const wf = fakeWorkflows(
      {
        'req:acme/patrol#11': { state: 'closed', status: 'TERMINATED' },
        'sub:3f0f8a6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b': { state: 'running' },
      },
      {
        'sub:3f0f8a6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b': parkedView(new Date(), { parked: false, doing: '等 CI' }),
      },
    );
    const run = await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect(run).toMatchObject({ outcome: 'ok', found: 2 });
    expect((await alertByKey(t.db, 'req:acme/patrol#11:park:1'))?.body).toMatch(
      /^已撤：任务已经不挂着了：工作流已经结束（被强行终止了）/,
    );
    expect((await alertByKey(t.db, 'sub:3f0f8a6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b:park:2'))?.body).toMatch(
      /^已撤：任务已经不挂着了：挂起已经解除、接着干了（现在：等 CI）/,
    );
  });

  it('还挂着的就是这一次：留着；「没有能用的路由」这时路由恢复了，正文开头写一句点继续（不撤）；路由又没了就拿掉那句', async () => {
    probeDir();
    await alert('req:acme/patrol#11:park:1', { title: '「triage」没有能用的路由' });
    const reported = new Date(Date.now() - 2 * HOUR);
    await backdate('req:acme/patrol#11:park:1', reported);
    const wf = fakeWorkflows(
      { 'req:acme/patrol#11': { state: 'running' } },
      { 'req:acme/patrol#11': parkedView(new Date(reported.getTime() - 1000)) },
    );
    await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect(await alertByKey(t.db, 'req:acme/patrol#11:park:1')).toMatchObject({
      resolvedAt: null,
      body: '原来的正文',
    });

    let route: RouteCheck = { kind: 'dispatch' };
    const withRoute = () => deps({ workflows: wf.reader, stageRoutable: async () => route });
    await runHourlyReconcileJob(withRoute());
    const annotated = await alertByKey(t.db, 'req:acme/patrol#11:park:1');
    expect(annotated?.resolvedAt).toBeNull();
    expect(annotated?.body).toBe(
      '路由已经恢复（「triage」阶段现在有能用的路由了）：任务还挂着等人，在驾驶舱点「继续」就接着干。\n\n原来的正文',
    );
    // 再跑一轮不重复写（飞书卡片不每小时改一次）
    const before = annotated?.updatedAt.getTime();
    await runHourlyReconcileJob(withRoute());
    expect((await alertByKey(t.db, 'req:acme/patrol#11:park:1'))?.updatedAt.getTime()).toBe(before);

    route = { kind: 'none', detail: '都下线了' };
    await runHourlyReconcileJob(withRoute());
    expect(await alertByKey(t.db, 'req:acme/patrol#11:park:1')).toMatchObject({
      resolvedAt: null,
      body: '原来的正文',
    });
  });

  it('这一次挂起早过去了（人点继续以后又挂起了一次）：旧的那条撤掉', async () => {
    probeDir();
    await alert('req:acme/patrol#11:park:1', { title: '「triage」没有能用的路由' });
    await backdate('req:acme/patrol#11:park:1', new Date(Date.now() - 3 * HOUR));
    const wf = fakeWorkflows(
      { 'req:acme/patrol#11': { state: 'running' } },
      { 'req:acme/patrol#11': parkedView(new Date(Date.now() - HOUR)) },
    );
    await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect((await alertByKey(t.db, 'req:acme/patrol#11:park:1'))?.body).toMatch(
      /^已撤：这一次挂起已经过去了/,
    );
  });

  it('任务工作流（task:）的挂起提醒：工作流已结束→撤；还停在这一次→不撤；读不到状态→不撤、这一轮记没查成（#901）', async () => {
    probeDir();
    const ended = 'task:acme/patrol#11:park:1';
    const stillParked = 'task:acme/patrol#12:park:1';
    const unreadable = 'task:acme/patrol#13:park:1';
    for (const key of [ended, stillParked, unreadable]) await alert(key, { title: '动手 3 轮都没过' });
    await backdate(stillParked, new Date(Date.now() - 2 * HOUR));
    const wf = fakeWorkflows(
      {
        'task:acme/patrol#11': { state: 'closed', status: 'COMPLETED' },
        'task:acme/patrol#12': { state: 'running' },
        'task:acme/patrol#13': { state: 'running' },
      },
      // #13 故意不给查询结果：fakeWorkflows 的 view 对没给的抛错，和真实读不了 taskStatus 是同一个效果
      { 'task:acme/patrol#12': parkedView(new Date(Date.now() - 3 * HOUR)) },
    );
    const run = await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain(`提醒 ${unreadable}（挂起）没查成`);
    expect((await alertByKey(t.db, ended))?.body).toMatch(/^已撤：任务已经不挂着了：工作流已经结束/);
    expect((await alertByKey(t.db, stillParked))?.resolvedAt).toBeNull();
    expect((await alertByKey(t.db, unreadable))?.resolvedAt).toBeNull();
  });

  it('先挂起提醒、后任务做完：工作流还显示挂着也撤；仍叫停或仍挂着不撤', async () => {
    probeDir();
    const { repo, task } = await work('running');
    const doneKey = 'task:acme/widgets#160:park:1';
    await alert(doneKey, { title: '自动合并没挂上', taskId: task.id });
    await sql("update tasks set state = 'done' where id = $1", [task.id]);
    const stopped = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 161,
        title: '登录页加验证码',
        rawRequest: '登录页加一个手机验证码',
        requestedBy: 'founder-a',
        priority: 10,
        state: 'stopped',
      })
      .returning();
    const stalled = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 162,
        title: '登录页加验证码',
        rawRequest: '登录页加一个手机验证码',
        requestedBy: 'founder-a',
        priority: 10,
        state: 'stalled',
      })
      .returning();
    const stoppedTask = stopped[0];
    const stalledTask = stalled[0];
    if (!stoppedTask || !stalledTask) throw new Error('task 没写进去');
    const stoppedKey = 'task:acme/widgets#161:park:1';
    const parkedKey = 'task:acme/widgets#162:park:2';
    await alert(stoppedKey, { title: '自动合并没挂上', taskId: stoppedTask.id });
    await alert(parkedKey, { title: '自动合并没挂上', taskId: stalledTask.id });
    const wf = fakeWorkflows(
      {
        'task:acme/widgets#160': { state: 'running' },
        'task:acme/widgets#161': { state: 'running' },
        'task:acme/widgets#162': { state: 'running' },
      },
      {
        'task:acme/widgets#160': parkedView(new Date()),
        'task:acme/widgets#161': parkedView(new Date()),
        'task:acme/widgets#162': parkedView(new Date()),
      },
    );
    const run = await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect(run.outcome).toBe('ok');
    const withdrawn = await alertByKey(t.db, doneKey);
    expect(withdrawn?.body).toMatch(/^已撤：任务已经做完了，这条挂起不再成立/);
    expect(withdrawn?.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(withdrawn?.resolvedAt).not.toBeNull();
    expect((await alertByKey(t.db, stoppedKey))?.resolvedAt).toBeNull();
    expect((await alertByKey(t.db, parkedKey))?.resolvedAt).toBeNull();
  });

  it('事件数到线：工作流结束了才撤；需求没做完：状态不再是 failed 才撤；要人批：批了才撤', async () => {
    probeDir();
    const { task, sub } = await work('failed');
    await alert('sub:aaaaaaaa-1111-4222-8333-444444444444:history');
    await alert('req:acme/widgets#160:history');
    await alert('req:acme/widgets#160:failed', { taskId: task.id });
    const approvalId = randomUUID();
    await t.db.insert(approvals).values({
      id: approvalId,
      taskId: task.id,
      subtaskId: sub.id,
      holds: ['release'],
      prNumber: 3,
      head: 'a'.repeat(40),
      title: '发 v2',
      summary: '对外发布',
    });
    await alert(`approval:${approvalId}`, { level: 'decision', taskId: task.id });
    const wf = fakeWorkflows(
      { 'req:acme/widgets#160': { state: 'running' }, [`sub:${sub.id}`]: { state: 'running' } },
      {
        [`sub:${sub.id}`]: {
          parked: false,
          waiting: null,
          doing: '等人批准',
          approval: { approvalId, state: 'pending' },
        },
      },
    );
    await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect((await alertByKey(t.db, 'sub:aaaaaaaa-1111-4222-8333-444444444444:history'))?.body).toMatch(
      /^已撤：这条工作流已经不在了.*事件数不会再涨了/,
    );
    expect((await alertByKey(t.db, 'req:acme/widgets#160:history'))?.resolvedAt).toBeNull();
    expect((await alertByKey(t.db, 'req:acme/widgets#160:failed'))?.resolvedAt).toBeNull();
    expect((await alertByKey(t.db, `approval:${approvalId}`))?.resolvedAt).toBeNull();

    await sql("update tasks set state = 'running' where id = $1", [task.id]);
    await sql(
      "update approvals set decision = 'approved', decided_by = 'founder-a', decided_at = now() where id = $1",
      [approvalId],
    );
    await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect((await alertByKey(t.db, 'req:acme/widgets#160:failed'))?.body).toMatch(
      /^已撤：需求现在是「在干」/,
    );
    expect((await alertByKey(t.db, `approval:${approvalId}`))?.body).toMatch(
      /^已撤：已经批准了（founder-a）/,
    );
  });

  it('已删的 no-verifier：对账不再撤，叫停了也留着（库里还开着的由迁移 0072 标成已撤）', async () => {
    probeDir();
    const { task } = await work('running');
    const key = `no-verifier:${task.id}`;
    await alert(key, { taskId: task.id, title: '需求 #160 做完没人能验：开 PR 前验证派不出别家' });
    await runHourlyReconcileJob(deps());
    expect((await alertByKey(t.db, key))?.resolvedAt).toBeNull();
    await sql("update tasks set state = 'stopped' where id = $1", [task.id]);
    await runHourlyReconcileJob(deps());
    const kept = await alertByKey(t.db, key);
    expect(kept?.resolvedAt).toBeNull();
    expect(kept?.body).toBe('原来的正文');
  });

  it('Fusion 发的要人批（没有子任务）：等它的是需求工作流；还在等这一次就留着，工作流不在了就撤', async () => {
    probeDir();
    const { task } = await work('running');
    const approvalId = randomUUID();
    await t.db.insert(approvals).values({
      id: approvalId,
      taskId: task.id,
      subtaskId: null,
      holds: ['release'],
      prNumber: 3,
      head: 'a'.repeat(40),
      title: '发 v2',
      summary: '对外发布',
    });
    await alert(`approval:${approvalId}`, { level: 'decision', taskId: task.id });
    const waiting = fakeWorkflows(
      { 'req:acme/widgets#160': { state: 'running' } },
      {
        'req:acme/widgets#160': {
          parked: false,
          waiting: null,
          doing: '等人批准',
          approval: { approvalId, state: 'pending' },
        },
      },
    );
    await runHourlyReconcileJob(deps({ workflows: waiting.reader }));
    expect((await alertByKey(t.db, `approval:${approvalId}`))?.resolvedAt).toBeNull();

    await runHourlyReconcileJob(deps());
    expect((await alertByKey(t.db, `approval:${approvalId}`))?.body).toMatch(
      /^已撤：在等批准的这条工作流已经不在了.*不用再批了/,
    );
  });

  it('查不了挂没挂着：不撤，这一轮记没查全、写明是哪条', async () => {
    probeDir();
    await alert('req:acme/patrol#11:park:1', { title: '「triage」没有能用的路由' });
    const wf = fakeWorkflows({ 'req:acme/patrol#11': { state: 'running' } });
    const run = await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('提醒 req:acme/patrol#11:park:1（挂起）没查成：用例没给');
    expect((await alertByKey(t.db, 'req:acme/patrol#11:park:1'))?.resolvedAt).toBeNull();
  });

  it('全熔断：还全熔断不撤、不调 updateOpen/raise；熔断解了就撤；判不了记没查成、不撤', async () => {
    const row = (dedupeKey: string): AlertRow => ({
      id: 'alert-1',
      dedupeKey,
      level: 'alert',
      taskId: null,
      title: '「execute」阶段的路由全都熔断了',
      body: '原来的正文',
      link: null,
      createdAt: new Date('2026-09-26T01:00:00.000Z'),
      raisedAt: new Date('2026-09-26T01:00:00.000Z'),
      updatedAt: new Date('2026-09-26T01:00:00.000Z'),
      resolvedAt: null,
      resolvedBy: null,
    });
    const calls = { updateOpen: 0, raise: 0 };
    const resolved: { by: string; why: string }[] = [];
    let mode: 'open' | 'clear' | 'throw' = 'open';
    const sweepDeps: AlertSweepDeps = {
      workflows: {
        state: async () => ({ state: 'missing' }),
        view: async () => {
          throw new Error('不该问');
        },
      },
      taskState: async () => null,
      approval: async () => null,
      stageRoutable: async () => ({ kind: 'none', detail: '没有在线的路由' }),
      stageAllOpen: async () => {
        if (mode === 'throw') throw new Error('路由事实没读成');
        if (mode === 'open') return { allOpen: true };
        return { allOpen: false, detail: '第 2 条 Claude 订阅 · 拼车 · Opus 5.5 · Claude Code 不在熔断' };
      },
      alerts: {
        listOpen: async () => ({ alerts: [], truncated: false }),
        byKey: async () => null,
        latestByPrefix: async () => null,
        resolve: async (x) => {
          resolved.push({ by: x.by, why: x.why });
          return 'ok';
        },
        raise: async () => {
          calls.raise += 1;
        },
        insertOnce: async () => ({ created: false }),
        updateOpen: async () => {
          calls.updateOpen += 1;
          return 'ok';
        },
      },
      now: () => new Date('2026-09-26T02:00:00.000Z'),
      log: quiet,
    };
    const open = row('routing:all-open:execute');
    expect(await sweepAlerts(sweepDeps, [open], false)).toMatchObject({ found: 0, unchecked: [] });
    expect(calls).toEqual({ updateOpen: 0, raise: 0 });
    expect(resolved).toEqual([]);

    mode = 'clear';
    expect(await sweepAlerts(sweepDeps, [open], false)).toMatchObject({ found: 1, unchecked: [] });
    expect(calls).toEqual({ updateOpen: 0, raise: 0 });
    expect(resolved).toEqual([
      {
        by: RECONCILE_ACTOR,
        why: '写码有路由不熔断了：第 2 条 Claude 订阅 · 拼车 · Opus 5.5 · Claude Code 不在熔断',
      },
    ]);

    mode = 'throw';
    resolved.length = 0;
    const failed = await sweepAlerts(sweepDeps, [open], false);
    expect(failed.found).toBe(0);
    expect(failed.unchecked).toEqual(['提醒 routing:all-open:execute（全熔断）没查成：路由事实没读成']);
    expect(resolved).toEqual([]);
    expect(calls).toEqual({ updateOpen: 0, raise: 0 });

    const { stageAllOpen: _omit, ...unwired } = sweepDeps;
    const missing = await sweepAlerts(unwired, [open], false);
    expect(missing.found).toBe(0);
    expect(missing.unchecked).toEqual([
      '提醒 routing:all-open:execute（全熔断）没查成：全熔断判不了：没接上只读判法',
    ]);
    expect(resolved).toEqual([]);

    // 阶段名认不出：留着，不去判。
    expect(await sweepAlerts(sweepDeps, [row('routing:all-open:zzz')], false)).toMatchObject({
      found: 0,
      unchecked: [],
    });
  });

  it('全熔断解了：真库里撤掉，正文以「已撤：」开头、含「有路由不熔断了」，处理人是每小时对账', async () => {
    probeDir();
    await alert('routing:all-open:execute', { title: '「execute」阶段的路由全都熔断了' });
    const job = (allOpen: boolean) =>
      deps({
        stageAllOpen: async () =>
          allOpen ? { allOpen: true } : { allOpen: false, detail: '第 2 条 Claude 订阅 · 拼车不在熔断' },
      });
    const before = await alertByKey(t.db, 'routing:all-open:execute');
    const kept = await runHourlyReconcileJob(job(true));
    const mid = await alertByKey(t.db, 'routing:all-open:execute');
    expect(kept.outcome).toBe('ok');
    expect(mid).toMatchObject({ resolvedAt: null, body: '原来的正文' });
    expect(mid?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(await t.db.select().from(notifications)).toHaveLength(1);

    await runHourlyReconcileJob(job(false));
    const gone = await alertByKey(t.db, 'routing:all-open:execute');
    expect(gone?.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(gone?.body.startsWith('已撤：')).toBe(true);
    expect(gone?.body).toContain('有路由不熔断了');
    expect(gone?.body).toContain('写码有路由不熔断了');
  });

  it('【故意造出的失败】过期兜底：没有判法的提醒 3 天没被再报就撤成「已撤：过期」（记录不删）；有判法的、别处自己撤的、要人拍的、刚被再报的、没满 3 天的都不被误撤', async () => {
    probeDir();
    const now = new Date();
    const old = new Date(now.getTime() - 4 * 24 * HOUR);
    // 没有任何判法的（已删的「提醒派单」推出来的老键、工作流通报）：该过期
    await alert('unclaimed:abc:1', { title: '老提醒没人接' });
    await alert('wf:failure:account-banned', { title: '账号被封了' });
    // 有判法的：条件还在（全熔断还在）就留着，再老也不撤
    await alert('routing:all-open:execute', { title: '「execute」阶段的路由全都熔断了' });
    // 别处自己会撤的、要人拍的：不归这条兜底
    await alert('deploy-lag:2026-10-01', { title: '线上版本跟不上主线' });
    await alert('auto-release:failed:abc', { title: '自动发布没成' });
    await alert('backup.stale:nightly', { title: '夜间备份没开跑' });
    await alert('someone:asks-human', { level: 'decision', title: '等你拍' });
    for (const key of [
      'unclaimed:abc:1',
      'wf:failure:account-banned',
      'routing:all-open:execute',
      'deploy-lag:2026-10-01',
      'auto-release:failed:abc',
      'backup.stale:nightly',
      'someone:asks-human',
    ]) {
      await backdate(key, old);
    }
    // 老提醒但刚被再报过（updated_at 是新的）：条件还在，不撤
    await alert('unclaimed:fresh-again', { title: '老键但刚又报了' });
    await backdate('unclaimed:fresh-again', old, new Date(now.getTime() - 2 * HOUR));
    // 没满 3 天
    await alert('unclaimed:two-days', { title: '才两天' });
    await backdate('unclaimed:two-days', new Date(now.getTime() - 2 * 24 * HOUR));

    const run = await runHourlyReconcileJob(
      deps({ now: () => now, stageAllOpen: async () => ({ allOpen: true }) }),
    );
    expect(run.outcome).toBe('ok');

    for (const key of ['unclaimed:abc:1', 'wf:failure:account-banned']) {
      const gone = await alertByKey(t.db, key);
      expect(gone?.resolvedAt, key).not.toBeNull();
      expect(gone?.resolvedBy, key).toBe(RECONCILE_ACTOR);
      expect(gone?.body.startsWith('已撤：过期：'), key).toBe(true);
    }
    for (const key of [
      'routing:all-open:execute',
      'deploy-lag:2026-10-01',
      'auto-release:failed:abc',
      'backup.stale:nightly',
      'someone:asks-human',
      'unclaimed:fresh-again',
      'unclaimed:two-days',
    ]) {
      const kept = await alertByKey(t.db, key);
      expect(kept, key).not.toBeNull();
      expect(kept?.resolvedAt, `${key} 不该被过期兜底撤`).toBeNull();
    }
    // 记录都还在（不删）
    expect(await alertByKey(t.db, 'unclaimed:abc:1')).not.toBeNull();
  });
});

describe('没人处理的卡住报警：超过 24 小时再推一次，一天最多一次', { timeout: 60_000 }, () => {
  const remindersOf = async (id: string) =>
    (await t.db.select().from(notifications)).filter((n) => n.dedupeKey.startsWith(`remind:${id}:`));

  it('超过 24 小时也不再写「还没处理」再提醒（#2368），隔天也不写', async () => {
    probeDir();
    const { task } = await work();
    const { id } = await alert('backup.stale:nightly', {
      taskId: task.id,
      title: '夜间备份超过 26 小时没开跑',
    });
    await alert('fresh:1');
    const now = new Date();
    await backdate('backup.stale:nightly', new Date(now.getTime() - 25 * HOUR));

    await runHourlyReconcileJob(deps({ now: () => now }));
    expect(await remindersOf(id)).toEqual([]);
    const fresh = await alertByKey(t.db, 'fresh:1');
    expect(await remindersOf(fresh?.id ?? 'none')).toEqual([]);

    const tomorrow = new Date(now.getTime() + 25 * HOUR);
    await runHourlyReconcileJob(deps({ now: () => tomorrow }));
    expect(await remindersOf(id)).toEqual([]);
  });

  it('createdAt 在 30 小时前、10 分钟前刚从已处理重开的不推；同一条这一次挂满 25 小时照推', async () => {
    probeDir();
    const now = new Date();
    const createdAt = new Date(now.getTime() - 30 * HOUR);
    const { id } = await alert('quota-read:grok', { title: '额度读不到：grok' });
    await backdate('quota-read:grok', createdAt);
    expect(
      await resolveAlertByKey(t.db, {
        dedupeKey: 'quota-read:grok',
        by: 'engine:quota-read',
        at: new Date(now.getTime() - 20 * HOUR),
      }),
    ).toBe('ok');
    const beforeReopen = new Date();
    await alert('quota-read:grok', { title: '额度读不到：grok' });
    const reopened = await alertByKey(t.db, 'quota-read:grok');
    expect(reopened?.resolvedAt).toBeNull();
    expect(reopened?.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(reopened?.raisedAt.getTime()).toBeGreaterThanOrEqual(beforeReopen.getTime() - 1000);

    const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
    await sql(
      'update notifications set raised_at = $1::timestamptz, updated_at = $1::timestamptz where dedupe_key = $2',
      [tenMinAgo.toISOString(), 'quota-read:grok'],
    );
    const held = await runHourlyReconcileJob(deps({ now: () => now }));
    expect(held).toMatchObject({ outcome: 'ok', found: 0 });
    expect(await remindersOf(id)).toEqual([]);

    const hungFor = new Date(now.getTime() - 25 * HOUR);
    await sql(
      'update notifications set raised_at = $1::timestamptz, updated_at = $1::timestamptz where dedupe_key = $2',
      [hungFor.toISOString(), 'quota-read:grok'],
    );
    await runHourlyReconcileJob(deps({ now: () => now }));
    expect(await remindersOf(id)).toEqual([]);
    expect((await alertByKey(t.db, 'quota-read:grok'))?.createdAt.toISOString()).toBe(
      createdAt.toISOString(),
    );
  });

  it('要人拍的不在这里再推（它们有自己的提醒规矩）', async () => {
    probeDir();
    const { id } = await alert('pool-hold:claude-carpool', { level: 'decision' });
    await backdate('pool-hold:claude-carpool', new Date(Date.now() - 30 * HOUR));
    await runHourlyReconcileJob(deps());
    expect(await remindersOf(id)).toEqual([]);
  });
});

describe('核对接到真库', { timeout: 60_000 }, () => {
  /** 北京时间 2026-10-18 06:41，复查日 2026-11-12 还没到。 */
  const incidentNow = new Date('2026-10-17T22:41:00.000Z');

  function localIssue(number: number, body: string, labels: string[], at: string) {
    return {
      number,
      title: `#${number}`,
      body,
      author: null,
      authorId: null,
      authorType: null,
      authorIsBot: false,
      createdAt: at,
      updatedAt: at,
      labels,
      milestone: null,
    };
  }

  function localReads(
    at: string,
    issues: ReturnType<typeof localIssue>[],
    states: NonNullable<HourlyReconcileWiring['gh']['readIssueStates']>,
    one?: HourlyReconcileWiring['gh']['readIssueState'],
  ): HourlyReconcileWiring['gh'] {
    return ghWith({
      readGroomFacts: async () => ({ milestones: [], issues }),
      readIssueLabelEvents: async () => [
        { label: '本机做', action: 'labeled' as const, at, actor: 'fleet-engine[bot]', bot: true },
      ],
      readIssueComments: async () => [{ body: '留给本机做', at }],
      readIssueStates: states,
      ...(one ? { readIssueState: one } : {}),
    });
  }

  async function orphanRow() {
    const res = await sql(
      `select value, updated_at, version, updated_by from settings where key = 'reconcile.localOrphans'`,
    );
    const row = res.rows[0] as
      | { value: unknown; updated_at: Date; version: number; updated_by: string | null }
      | undefined;
    if (!row) throw new Error('reconcile.localOrphans 没有这一行');
    return row;
  }

  /** 种下 05:41 的旧名单，跑一轮失败的对账，价值、更新时刻、版本和改的人都得原样留着。 */
  async function expectOldOrphansKept(why: string, gh: HourlyReconcileWiring['gh']) {
    probeDir();
    await work();
    await sql(
      `insert into settings (key, value, version, updated_at, updated_by)
       values ('reconcile.localOrphans', $1::jsonb, 3, '2026-10-18T05:41:28.797+08:00', 'seed')`,
      [JSON.stringify(OLD_ORPHANS)],
    );
    const before = await orphanRow();
    const run = await runHourlyReconcileJob(deps({ now: () => incidentNow, gh }));
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('上一份名单留着');
    expect(run.why).toContain(why);
    expect(await orphanRow()).toEqual(before);
    expect(await readLocalOrphans(t.db)).toEqual([...OLD_ORPHANS]);
  }

  it('本机没人领：#1960 的已合 PR 前置走批量口子，日期未到不进名单，普通超时单照进', async () => {
    probeDir();
    await work();
    await t.db.insert(repos).values({ owner: 'beta', name: 'gadgets', testCommand: 'pnpm check' });
    const labeledAt = new Date(incidentNow.getTime() - 25 * HOUR).toISOString();
    const issue = (number: number, body: string, labels: string[] = ['本机做']) =>
      localIssue(number, body, labels, labeledAt);
    // 1960 和 53 都写了 #2789：同仓只该问一次。beta 是另一个仓，单独一批。
    const acme = [
      issue(1960, ISSUE_1960_PREREQUISITE),
      issue(2088, '等创始人确认', ['本机做', '要人拍']),
      issue(34, '前置：#35'),
      issue(35, '前置：#36'),
      issue(36, '普通超过 24 小时'),
      issue(50, '前置：#2788'),
      issue(51, '前置：#2790'),
      issue(52, '前置：#100 还开着，#2789 已合'),
      issue(53, '前置：#2789，再写一遍 #2789'),
    ];
    const beta = [issue(7, '前置：#2789')];
    const port = prerequisiteGitHub(
      prerequisiteNodes([
        ['acme/widgets', 2789, 'pr', 'merged'],
        ['acme/widgets', 35, 'issue', 'open'],
        ['acme/widgets', 36, 'issue', 'closed'],
        ['acme/widgets', 2788, 'pr', 'open'],
        ['acme/widgets', 2790, 'pr', 'closed'],
        ['acme/widgets', 100, 'issue', 'open'],
        ['beta/gadgets', 2789, 'pr', 'merged'],
      ]),
    );
    const asked: { repo: string; numbers: number[] }[] = [];
    const run = await runHourlyReconcileJob(
      deps({
        now: () => incidentNow,
        gh: ghWith({
          async readGroomFacts(input) {
            const key = `${input.repo.owner}/${input.repo.name}`;
            const issues = key === 'acme/widgets' ? acme : key === 'beta/gadgets' ? beta : null;
            if (!issues) throw new Error(`用例没给 ${key} 的开着的单`);
            return { milestones: [], issues };
          },
          readIssueLabelEvents: async () => [
            {
              label: '本机做',
              action: 'labeled' as const,
              at: labeledAt,
              actor: 'fleet-engine[bot]',
              bot: true,
            },
          ],
          readIssueComments: async () => [{ body: '留给本机做', at: labeledAt }],
          async readIssueStates(input) {
            asked.push({
              repo: `${input.repo.owner}/${input.repo.name}`,
              numbers: [...input.numbers],
            });
            return port.gh.readIssueStates(input);
          },
          readIssueState: (input) => port.gh.readIssueState(input),
        }),
      }),
    );
    const acmeNumbers = [2789, 35, 36, 2788, 2790, 100];
    expect(run.outcome).toBe('ok');
    expect(asked).toEqual([
      { repo: 'acme/widgets', numbers: acmeNumbers },
      { repo: 'beta/gadgets', numbers: [2789] },
    ]);
    expect(port.issueStates).toEqual([
      { owner: 'acme', name: 'widgets', numbers: acmeNumbers },
      { owner: 'beta', name: 'gadgets', numbers: [2789] },
    ]);
    expect(port.issueGets).toEqual([]);
    // 1960 日期未到；50 前置 PR 还开着；52 混着开着的 issue；34 等 #35；2088 要人拍。
    // 35 的前置 issue 已关、36 没有前置、51 的前置 PR 已关、53 和 beta#7 的前置 PR 已合：照进名单。
    expect(await readLocalOrphans(t.db)).toEqual([
      expect.objectContaining({ repo: 'acme/widgets', issue: 35 }),
      expect.objectContaining({ repo: 'acme/widgets', issue: 36 }),
      expect.objectContaining({ repo: 'acme/widgets', issue: 51 }),
      expect.objectContaining({ repo: 'acme/widgets', issue: 53 }),
      expect.objectContaining({ repo: 'beta/gadgets', issue: 7 }),
    ]);
  });

  it('【故意造出的失败】前置号不存在：这一轮 partial，旧名单的值和更新时刻留着', async () => {
    const labeledAt = new Date(incidentNow.getTime() - 25 * HOUR).toISOString();
    const port = prerequisiteGitHub(prerequisiteNodes([]));
    await expectOldOrphansKept(
      'GraphQL 出错',
      localReads(
        labeledAt,
        [localIssue(1960, '前置：#99999', ['本机做'], labeledAt)],
        (input) => port.gh.readIssueStates(input),
        (input) => port.gh.readIssueState(input),
      ),
    );
    expect((await orphanRow()).updated_at.toISOString()).toBe('2026-10-17T21:41:28.797Z');
  });

  it('【故意造出的失败】前置状态读取被拒绝：这一轮 partial，旧名单留着', async () => {
    const labeledAt = new Date(incidentNow.getTime() - 25 * HOUR).toISOString();
    const port = prerequisiteGitHub(prerequisiteNodes([['acme/widgets', 2789, 'pr', 'merged']]), 'forbidden');
    await expectOldOrphansKept(
      '没有权限',
      localReads(
        labeledAt,
        [localIssue(1960, ISSUE_1960_PREREQUISITE, ['本机做'], labeledAt)],
        (input) => port.gh.readIssueStates(input),
        (input) => port.gh.readIssueState(input),
      ),
    );
  });

  it('【故意造出的失败】前置状态连不上：这一轮 partial，旧名单留着', async () => {
    const labeledAt = new Date(incidentNow.getTime() - 25 * HOUR).toISOString();
    const port = prerequisiteGitHub(prerequisiteNodes([['acme/widgets', 2789, 'pr', 'merged']]), 'down');
    await expectOldOrphansKept(
      '连不上',
      localReads(
        labeledAt,
        [localIssue(36, '前置：#2789', ['本机做'], labeledAt)],
        (input) => port.gh.readIssueStates(input),
        (input) => port.gh.readIssueState(input),
      ),
    );
  });

  it('【故意造出的失败】前置状态的返回形状认不出：这一轮 partial，旧名单留着', async () => {
    const labeledAt = new Date(incidentNow.getTime() - 25 * HOUR).toISOString();
    const port = prerequisiteGitHub(prerequisiteNodes([['acme/widgets', 35, 'issue', 'open']]), 'bad-shape');
    await expectOldOrphansKept(
      '形状不一样',
      localReads(
        labeledAt,
        [localIssue(36, '前置：#35', ['本机做'], labeledAt)],
        (input) => port.gh.readIssueStates(input),
        (input) => port.gh.readIssueState(input),
      ),
    );
  });

  it('【故意造出的失败】前置状态的 Map 缺号：不当 closed，不写空名单，旧名单留着', async () => {
    const labeledAt = new Date(incidentNow.getTime() - 25 * HOUR).toISOString();
    await expectOldOrphansKept(
      'acme/widgets#35 的状态缺号',
      localReads(labeledAt, [localIssue(36, '前置：#35', ['本机做'], labeledAt)], async () => new Map()),
    );
  });

  it('【故意造出的失败】前置状态认不出：不当 closed，不写空名单，旧名单留着', async () => {
    const labeledAt = new Date(incidentNow.getTime() - 25 * HOUR).toISOString();
    await expectOldOrphansKept(
      'acme/widgets#35 的状态认不出：merged',
      localReads(
        labeledAt,
        [localIssue(36, '前置：#35', ['本机做'], labeledAt)],
        async () => new Map<number, 'open' | 'closed'>([[35, 'merged' as 'open']]),
      ),
    );
  });

  it('合了的 PR：镜像补上算发现计数；机器人开的 PR 合并人不对报 reconcile:pr 提醒（#440 恢复：#431 就是这么漏的）；列不出来这个仓进原因、这一轮不记 ok', async () => {
    probeDir();
    await work();
    const now = new Date('2026-09-26T09:41:00.000Z');
    const seen: { repo: string; since: Date }[] = [];
    const first = await runHourlyReconcileJob(
      deps({
        now: () => now,
        gh: ghWith({
          async auditMergedPrs(repo, since) {
            seen.push({ repo, since });
            return {
              outcome: 'ok',
              scanned: 1,
              found: 2,
              fixed: 1,
              problems: ['#7 合并了但镜像里没有（已补）', '#7 不是「引擎」机器人合的（合并人 founder）'],
              findings: [
                { number: 7, kind: 'mirror_fixed', text: '#7 合并了但镜像里没有（已补）' },
                {
                  number: 7,
                  kind: 'not_merged_by_engine',
                  text: '#7 不是「引擎」机器人合的（合并人 founder）',
                },
              ],
            };
          },
        }),
      }),
    );
    expect(seen.map((s) => s.repo)).toEqual(['acme/widgets']);
    expect(now.getTime() - (seen[0]?.since.getTime() ?? 0)).toBe(MERGED_PR_LOOKBACK_MS);
    expect(first).toMatchObject({ outcome: 'ok', found: 2 });
    // #440：机器人开的 PR 没经合并队列合，报一条 insertOnce 提醒；不会自己撤。
    const prAlert = await alertByKey(t.db, 'reconcile:pr:acme/widgets#7');
    expect(prAlert).toMatchObject({
      level: 'alert',
      title: '机器人开的 PR 没经合并队列合：acme/widgets#7',
      link: 'https://github.com/acme/widgets/pull/7',
    });
    expect(prAlert?.resolvedAt).toBeNull();

    const again = await runHourlyReconcileJob(
      deps({
        now: () => now,
        gh: ghWith({
          async auditMergedPrs() {
            return {
              outcome: 'unscanned',
              scanned: 0,
              found: 0,
              fixed: 0,
              problems: [],
              findings: [],
              why: '列合并的 PR 失败：403',
            };
          },
        }),
      }),
    );
    expect(again.outcome).not.toBe('ok');
    expect(again.why).toContain('acme/widgets：列合并的 PR 失败：403');
  });

  it('额度读数过期不归对账管了（决定 0093 搬去看门狗，jobs/watchdog-quota.ts）：读数早就旧了，对账也不报 reconcile:quota', async () => {
    await world(t.db); // 额度读数停在假的固定时刻，对真钟早就过期
    probeDir();
    await runHourlyReconcileJob(deps());
    expect(await alertByKey(t.db, 'reconcile:quota:claude-solo')).toBeNull();
  });

  it('【故意造出的失败】合了的 PR 对上的单：会话没结局、单没记成做完，报 reconcile:ledger 写明缺什么；别的分支上的会话不算；补齐了撤掉', async () => {
    await world(t.db);
    await freshenQuota();
    probeDir();
    const { repo, task } = await work('merging');
    const merged = new Date(Date.now() - 2 * HOUR);
    await t.db.insert(pullRequests).values({
      repoId: repo.id,
      number: 9,
      state: 'merged',
      headRef: 'fleet/160-abc',
      headSha: 'a'.repeat(40),
      updatedAt: merged,
    });
    const [run] = await t.db
      .insert(runs)
      .values({
        taskId: task.id,
        segment: 'manual',
        model: 'opus-5.5',
        routeId: 'solo',
        branch: 'fleet/160-abc',
        startedAt: new Date(Date.now() - 5 * HOUR),
      })
      .returning();
    if (!run) throw new Error('run 没写进去');
    // 更早一轮（被强行终止、会话没收，#247）在另一条分支上：不算进这条 PR 的账
    await t.db.insert(runs).values({
      taskId: task.id,
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'solo',
      branch: 'fleet/160-old',
      startedAt: new Date(Date.now() - 9 * HOUR),
    });
    const first = await runHourlyReconcileJob(deps());
    expect(first).toMatchObject({ outcome: 'ok', found: 1 });
    const row = await alertByKey(t.db, 'reconcile:ledger:acme/widgets#9');
    expect(row).toMatchObject({ level: 'alert', taskId: task.id, resolvedAt: null });
    expect(row?.body).toContain('单 #160：1 次会话没有结局（manual）');
    expect(row?.body).toContain('单 #160：合并关单那一步没写完：库里这张单是「在合并」');
    expect(row?.link).toBe('https://github.com/acme/widgets/pull/9');

    await sql(
      `update runs set ended_at = now(), outcome = 'done', route_outcome = 'ok', input_tokens = 10, output_tokens = 5 where id = $1`,
      [run.id],
    );
    await sql(`update tasks set state = 'done' where id = $1`, [task.id]);
    await runHourlyReconcileJob(deps());
    expect((await alertByKey(t.db, 'reconcile:ledger:acme/widgets#9'))?.body).toMatch(
      /^已撤：会话结局、用量、关单都记齐了/,
    );
  });
});

describe('GitHub 机器人权限自检：受管的仓从库里列，缺的报进提醒，好了下一轮撤', { timeout: 60_000 }, () => {
  it('【故意造出的失败】「引擎」缺 statuses:write：库里开一条要人看；权限补上后下一轮撤掉（处理人是每小时对账）', async () => {
    await work();
    probeDir();
    const asked: string[][] = [];
    let engineHas = false;
    const selfCheck: HourlyReconcileWiring['selfCheck'] = async (list) => {
      asked.push(list.map((r) => `${r.owner}/${r.name}`));
      return list.flatMap((r) => [
        { role: 'agent' as const, repo: `${r.owner}/${r.name}`, ok: true, missing: [], extra: [] },
        {
          role: 'engine' as const,
          repo: `${r.owner}/${r.name}`,
          ok: engineHas,
          missing: engineHas ? [] : ['statuses:write'],
          extra: [],
        },
      ]);
    };

    expect(await runHourlyReconcileJob(deps({ selfCheck }))).toMatchObject({ outcome: 'ok', found: 1 });
    expect(asked).toEqual([['acme/widgets']]);
    const open = await alertByKey(t.db, 'github-app:acme/widgets');
    expect(open).toMatchObject({ level: 'alert', resolvedAt: null });
    expect(open?.title).toBe('「引擎」机器人在 acme/widgets 上的权限不对：缺 statuses:write');

    engineHas = true;
    expect(await runHourlyReconcileJob(deps({ selfCheck }))).toMatchObject({ outcome: 'ok', found: 1 });
    const closed = await alertByKey(t.db, 'github-app:acme/widgets');
    expect(closed?.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(closed?.body).toMatch(/^已撤：acme\/widgets 的两个机器人都装上了、权限够了/);
  });
});

describe('status 查询认不出', () => {
  it('没有 parked、waiting 形状不对：明确报错，不当成「没挂着」', () => {
    expect(() => workflowViewOf({ doing: 'x' }, 'req:a/b#1')).toThrow('没有 parked');
    expect(() => workflowViewOf({ parked: true, waiting: { kind: 1 } }, 'req:a/b#1')).toThrow(
      'waiting 认不出',
    );
    expect(() => workflowViewOf(null, 'req:a/b#1')).toThrow('认不出');
    expect(
      workflowViewOf(
        {
          parked: false,
          waiting: null,
          doing: '写码',
          approval: { approvalId: 'x', state: 'pending', holds: [] },
        },
        'sub:1',
      ),
    ).toEqual({
      parked: false,
      waiting: null,
      doing: '写码',
      approval: { approvalId: 'x', state: 'pending' },
    });
  });
});

describe('任务工作流的 taskStatus 查询（#901）', () => {
  it('phase = parked 才算挂着；waiting、doing 原样带出；没有等批准这一项', () => {
    expect(
      taskViewOf(
        {
          phase: 'parked',
          doing: '停下等人：交代不全',
          waiting: {
            kind: 'human',
            detail: '交代不全（等「继续」或「放弃」）',
            since: '2026-10-05T01:00:00.000Z',
          },
        },
        'task:a/b#1',
      ),
    ).toEqual({
      parked: true,
      waiting: {
        kind: 'human',
        detail: '交代不全（等「继续」或「放弃」）',
        since: '2026-10-05T01:00:00.000Z',
      },
      doing: '停下等人：交代不全',
      approval: null,
    });
    expect(
      taskViewOf({ phase: 'implement', doing: '动手第 1 轮', waiting: null }, 'task:a/b#1'),
    ).toMatchObject({
      parked: false,
      waiting: null,
    });
    const paused = {
      phase: 'paused',
      doing: '已暂停',
      waiting: {
        kind: 'paused',
        detail: '已暂停（等「继续」或「放弃」）',
        since: '2026-10-17T20:32:41.000Z',
      },
    };
    expect(taskViewOf(paused, 'task:a/b#1').parked).toBe(false);
    expect(closedIssueHoldOf(paused, 'task:a/b#1')).toBe('paused-checkpoint');
  });

  it('关单收尾只把检查点软暂停从「还在跑」里分出来；parked 仍只认 phase=parked（#3002）', () => {
    const waiting = { kind: 'paused', detail: '等', since: '2026-10-17T20:32:41.000Z' };
    expect(
      closedIssueHoldOf(
        { phase: 'parked', doing: '停下', waiting: { ...waiting, kind: 'human' } },
        'task:a/b#1',
      ),
    ).toBe('parked');
    for (const phase of ['implement', 'ci', 'verify', 'merge', 'abandoned', 'done', 'brief']) {
      expect(closedIssueHoldOf({ phase, doing: phase, waiting: null }, 'task:a/b#1')).toBe('busy');
    }
    expect(closedIssueHoldOf({ phase: 'paused', doing: '还没到检查点', waiting: null }, 'task:a/b#1')).toBe(
      'busy',
    );
    expect(closedIssueHoldOf({ phase: 'implement', doing: '动手', waiting }, 'task:a/b#1')).toBe('busy');
    expect(() => closedIssueHoldOf({ parked: true, doing: 'x' }, 'task:a/b#1')).toThrow('没有 phase');
  });

  it('【故意造出的失败】回的是旧 status 的形状（有 parked 没 phase）、null、waiting 形状不对：明确报错，不当成「没挂着」', () => {
    expect(() => taskViewOf({ parked: true, doing: 'x' }, 'task:a/b#1')).toThrow('没有 phase');
    expect(() => taskViewOf(null, 'task:a/b#1')).toThrow('认不出');
    expect(() => taskViewOf({ phase: 'parked', waiting: { kind: 1 } }, 'task:a/b#1')).toThrow(
      'waiting 认不出',
    );
  });

  it('temporalWorkflows.view：task: 编号问 taskStatus，旧的 req:/sub: 编号还问 status；查询失败原样抛', async () => {
    const asked: [string, string][] = [];
    const client = {
      workflow: {
        getHandle: (id: string) => ({
          query: async (q: string | { name: string }) => {
            const name = typeof q === 'string' ? q : q.name;
            asked.push([id, name]);
            if (id === 'task:a/b#9') throw new Error('query rejected（故意造的）');
            return name === 'taskStatus'
              ? {
                  phase: 'parked',
                  doing: '停着',
                  waiting: { kind: 'human', detail: 'd', since: '2026-10-05T00:00:00Z' },
                }
              : { parked: false, waiting: null, doing: '旧的' };
          },
        }),
      },
    };
    const reader = temporalWorkflows(client as never);
    expect((await reader.view('task:a/b#1')).parked).toBe(true);
    expect((await reader.view('req:a/b#1')).doing).toBe('旧的');
    expect((await reader.view('sub:x')).parked).toBe(false);
    await expect(reader.view('task:a/b#9')).rejects.toThrow('query rejected');
    expect(asked).toEqual([
      ['task:a/b#1', 'taskStatus'],
      ['req:a/b#1', 'status'],
      ['sub:x', 'status'],
      ['task:a/b#9', 'taskStatus'],
    ]);
  });
});
