// 每小时对账的真装配：内存库上跑真迁移（提醒、需求、PR 头、结局记账都是真查询）、临时目录里的真 git 树（以本机执行器顶替
// 会话用户）、假的工作树管家（属主记在表里）、假的 Temporal（工作流在不在跑、挂没挂着由用例定）。
// 残留的干净树删掉、提醒跟着撤；有没推的东西不删、改报要人拍；读不到目录、查不了 Temporal、删不掉、git 没跑成都记没查成；
// 条件还在的提醒不撤；卡住报警超过 24 小时再推一次、同一天不重复。每条失败路径都故意造一次。
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RequirementWorkflows, silentLogger } from '@fleet-dao/api';
import {
  type AlertRow,
  alertByKey,
  approvals,
  auditLog,
  githubEvents,
  notifications,
  pullRequests,
  repos,
  scheduleRuns,
  sessionRuns,
  subtasks,
  tasks,
  upsertAlert,
  users,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { IssuePlan } from '@fleet-dao/github';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AlertSweepDeps, type RouteCheck, sweepAlerts } from '../../src/jobs/alert-sweep.ts';
import { HOURLY_RECONCILE_JOB, runHourlyReconcileJob } from '../../src/jobs/hourly-reconcile.ts';
import { MERGED_PR_LOOKBACK_MS } from '../../src/jobs/reconcile-checks.ts';
import {
  beijingDate,
  RECONCILE_ACTOR,
  type WorkflowReader,
  type WorkflowState,
  type WorkflowView,
} from '../../src/jobs/reconcile-common.ts';
import { localExec } from '../../src/real/exec.ts';
import {
  type HourlyReconcileWiring,
  hourlyReconcileJob,
  listDirEntries,
  workflowViewOf,
} from '../../src/real/hourly-reconcile.ts';
import { registerEngineJobs } from '../../src/real/jobs.ts';
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
afterEach(() => rmSync(root, { recursive: true, force: true }));

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
    sessionOrg: async () => ({ ok: true, org: 'carpool' }),
    machine: '法国',
    selfCheck: async () => [],
    gitBin: 'git',
    shBin: 'sh',
    log: quiet,
    stageRoutable: async (): Promise<RouteCheck> => ({ kind: 'none', detail: '没有在线的路由' }),
    gh: ghWith(),
    requirements: {
      async start() {
        throw new Error('用例里不该真拉起工作流');
      },
    } as never,
    intakeLog: silentLogger,
    ...over,
    workflows: wf,
  })({ workflow: {} as never } as never, 'fleet-test');
}

/**
 * 假 GitHub：审合并的 PR 由用例定（默认一条都没合）；补拉时接活那道门要的镜像照收不记，现读 issue 挂在哪个版本
 * 默认照抛（用例里走到了才给）。
 */
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
    eventSink: () => ({ accept: async () => {} }),
    readIssuePlan: async () => {
      throw new Error('用例里不该现读 issue');
    },
    ...over,
  };
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
  });

/** 直接改库（引擎包不直接依赖 drizzle）：时刻一律 ISO 字符串再 ::timestamptz（生产驱动不收 Date 参数）。 */
const sql = (text: string, params: unknown[] = []) => t.client.query(text, params);

/** 把一条提醒的建立、更新时刻挪到 at（造「很久以前报的」）。 */
async function backdate(dedupeKey: string, at: Date, updatedAt = at) {
  await sql(
    'update notifications set created_at = $1::timestamptz, updated_at = $2::timestamptz where dedupe_key = $3',
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

describe('工作树：残留的删掉、有东西的交人拍', { timeout: 120_000 }, () => {
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

  it('有没推的提交：不删，报要人拍（写清哪棵树、有什么、怎么删），「工作树没收掉」改成指向它；人点了处理之后不再报', async () => {
    const { task, sub } = await work();
    const tree = makeTree('acme_widgets/160-login', { extra: 2, dirty: true });
    probeDir();
    await alert(`sub:${sub.id}:worktree`, { title: '工作树没收掉' });

    const run = await runHourlyReconcileJob(deps());
    expect(existsSync(tree.dir)).toBe(true);
    const keep = await alertByKey(t.db, 'worktree:acme_widgets/160-login');
    expect(keep).toMatchObject({
      level: 'decision',
      taskId: null,
      link: `/tasks/${task.id}`,
      resolvedAt: null,
      title: '工作树里有没推的东西，删不删要你拍：acme_widgets/160-login',
    });
    expect(keep?.body).toContain(`法国的 ${tree.dir}（需求 #160 的子任务「login」）`);
    expect(keep?.body).toContain('没推的提交 2 个：');
    expect(keep?.body).toContain('session work 1');
    expect(keep?.body).toContain('没提交的改动 1 处：?? half-done.ts');
    expect(keep?.body).toContain(`fleet-agent-scope remove ${tree.dir}`);
    expect((await alertByKey(t.db, `sub:${sub.id}:worktree`))?.body).toMatch(
      /^已撤：树里还有没推、没提交的东西，改成要你拍：看「工作树里有没推的东西/,
    );
    expect(run).toMatchObject({ outcome: 'ok', found: 2 });

    // 人看过、点了处理（决定留着）：下一轮不再报、不重新打开
    await resolvedByHuman({ key: 'worktree:acme_widgets/160-login' }, 'founder-a');
    expect(await runHourlyReconcileJob(deps())).toMatchObject({ outcome: 'ok', found: 0 });
    expect(await alertByKey(t.db, 'worktree:acme_widgets/160-login')).toMatchObject({
      resolvedBy: 'founder-a',
    });
    expect(existsSync(tree.dir)).toBe(true);
  });

  it('要人拍的那棵后来推上去了（PR 镜像里有它的头）、也清干净了：下一轮删掉，要人拍的跟着撤', async () => {
    const { repo } = await work();
    const tree = makeTree('acme_widgets/160-login', { extra: 1 });
    probeDir();
    await runHourlyReconcileJob(deps());
    expect((await alertByKey(t.db, 'worktree:acme_widgets/160-login'))?.resolvedAt).toBeNull();

    await t.db.insert(pullRequests).values({
      repoId: repo.id,
      number: 7,
      state: 'merged',
      headRef: 'fleet/160-login',
      headSha: tree.head,
      updatedAt: new Date(),
    });
    await runHourlyReconcileJob(deps());
    expect(existsSync(tree.dir)).toBe(false);
    expect(await alertByKey(t.db, 'worktree:acme_widgets/160-login')).toMatchObject({
      resolvedBy: RECONCILE_ACTOR,
      body: expect.stringMatching(/^已撤：树里已经没有没推、没提交的东西了/),
    });
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

  it('缓存以外还剩一个源文件：不删，报要人拍，提醒里列出那个文件、写明一共几个（缓存不列），看里面给 find 不给 git', async () => {
    const { task } = await work();
    probeDir();
    const dir = plainTree('acme_widgets/160-handover-store', {
      'packages/api/tsconfig.tsbuildinfo': '{}',
      'packages/api/src/handover.ts': 'export const h = 1;\n',
    });

    const run = await runHourlyReconcileJob(deps());
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(existsSync(dir)).toBe(true);
    const keep = await alertByKey(t.db, 'worktree:acme_widgets/160-handover-store');
    expect(keep).toMatchObject({
      level: 'decision',
      resolvedAt: null,
      link: `/tasks/${task.id}`,
      title: '工作树里有没推的东西，删不删要你拍：acme_widgets/160-handover-store',
    });
    expect(keep?.body).toContain(
      '- 这一层不是 git 仓，里面有 1 个文件（能重新生成的编译和工具缓存不算）：packages/api/src/handover.ts\n',
    );
    expect(keep?.body).not.toContain('tsbuildinfo');
    expect(keep?.body).toContain(`看里面：sudo -u ${USER} find ${dir} ! -type d`);
    expect(keep?.body).not.toContain('git -C');
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

  it('需求工作流还在跑、或者它的子任务工作流还在收尾：这张需求的树都不碰，「工作树没收掉」也留着', async () => {
    const { sub } = await work();
    const tree = makeTree('acme_widgets/160-login');
    probeDir();
    await alert(`sub:${sub.id}:worktree`);
    const running = fakeWorkflows({ 'req:acme/widgets#160': { state: 'running' } });
    expect(await runHourlyReconcileJob(deps({ workflows: running.reader }))).toMatchObject({ outcome: 'ok' });
    expect(existsSync(tree.dir)).toBe(true);
    expect((await alertByKey(t.db, `sub:${sub.id}:worktree`))?.resolvedAt).toBeNull();

    const finishing = fakeWorkflows({
      'req:acme/widgets#160': { state: 'closed', status: 'COMPLETED' },
      [`sub:${sub.id}`]: { state: 'running' },
    });
    await runHourlyReconcileJob(deps({ workflows: finishing.reader }));
    expect(existsSync(tree.dir)).toBe(true);
  });

  it('工作流都不在跑了、树里却还有没结束的会话（被强行终止留下的、认不出的工作流起的）：不碰，记没查成写明是哪个会话；会话结束了照删', async () => {
    await world(t.db);
    const { task, sub } = await work();
    const tree = makeTree('acme_widgets/160-login');
    probeDir();
    await alert(`sub:${sub.id}:worktree`);
    const [run] = await t.db
      .insert(sessionRuns)
      .values({
        taskId: task.id,
        subtaskId: sub.id,
        stage: 'execute',
        routeId: 'solo',
        whyRoute: '写码阶段首选',
        worktreePath: tree.dir,
      })
      .returning();
    if (!run) throw new Error('run 没写进去');

    const first = await runHourlyReconcileJob(deps());
    expect(first.outcome).toBe('partial');
    expect(first.why).toContain(`acme_widgets/160-login 里还有没结束的会话（execute 阶段`);
    expect(first.why).toContain(`会话 ${run.id.slice(0, 8)}`);
    expect(existsSync(tree.dir)).toBe(true);
    expect((await alertByKey(t.db, `sub:${sub.id}:worktree`))?.resolvedAt).toBeNull();

    await sql("update session_runs set ended_at = now(), outcome = 'stopped' where id = $1", [run.id]);
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
        throw new Error('session_runs 读超时（故意造的）');
      },
    });
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('里有没有没结束的会话没查成（没碰）：session_runs 读超时');
    expect(existsSync(tree.dir)).toBe(true);
  });

  it('Fusion 报的「工作树没收掉」（键里只有需求）：这张需求的 Fusion 树都有了去向才撤；还在用、那个仓列不了就留着', async () => {
    await work();
    probeDir();
    const tree = makeTree('acme_widgets/160-f1234abcd');
    await alert('req:acme/widgets#160:worktree', { title: '工作树没收掉' });
    const stillOpen = async () =>
      (await alertByKey(t.db, 'req:acme/widgets#160:worktree'))?.resolvedAt === null;

    // Fusion 的编号和需求工作流同一个：还在跑，树不碰、提醒留着
    const running = fakeWorkflows({ 'req:acme/widgets#160': { state: 'running' } });
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
    const other = fakeWorkflows({ 'req:acme/widgets#161': { state: 'running' } });
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

  it('选路报的「做完没人能验」：这张单还在跑就留着（选路自己撤）；做完、叫停、没做完了才撤，写明为什么', async () => {
    probeDir();
    const { task } = await work('running');
    const key = `no-verifier:${task.id}`;
    await alert(key, { taskId: task.id, title: '需求 #160 做完没人能验：开 PR 前验证派不出别家' });
    await runHourlyReconcileJob(deps());
    expect((await alertByKey(t.db, key))?.resolvedAt).toBeNull();
    await sql("update tasks set state = 'stopped' where id = $1", [task.id]);
    await runHourlyReconcileJob(deps());
    expect((await alertByKey(t.db, key))?.body).toMatch(
      /^已撤：需求现在是「人叫停了」，走不到开 PR 前验证那一步了/,
    );
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
});

describe('没人处理的卡住报警：超过 24 小时再推一次，一天最多一次', { timeout: 60_000 }, () => {
  const remindersOf = async (id: string) =>
    (await t.db.select().from(notifications)).filter((n) => n.dedupeKey.startsWith(`remind:${id}:`));

  it('超过 24 小时：写一条「还没处理」（新卡、新弹窗）；同一天再跑不重复；第二天再来一条；不到 24 小时的不推', async () => {
    probeDir();
    const { task } = await work();
    const { id } = await alert('backup.stale:nightly', {
      taskId: task.id,
      title: '夜间备份超过 26 小时没开跑',
    });
    await alert('fresh:1');
    const now = new Date();
    await backdate('backup.stale:nightly', new Date(now.getTime() - 25 * HOUR));

    const first = await runHourlyReconcileJob(deps({ now: () => now }));
    expect(first).toMatchObject({ outcome: 'ok', found: 1 });
    const [r1] = await remindersOf(id);
    expect(r1).toMatchObject({
      dedupeKey: `remind:${id}:${beijingDate(now)}`,
      level: 'alert',
      taskId: task.id,
      title: '还没处理：夜间备份超过 26 小时没开跑',
      resolvedAt: null,
    });
    expect(r1?.body).toContain('到现在 25 小时 没人处理');
    expect(r1?.body).toContain('原来的正文');

    expect(await runHourlyReconcileJob(deps({ now: () => now }))).toMatchObject({ found: 0 });
    expect(await remindersOf(id)).toHaveLength(1);
    // 不到 24 小时的不推
    const fresh = await alertByKey(t.db, 'fresh:1');
    expect(await remindersOf(fresh?.id ?? 'none')).toEqual([]);

    const tomorrow = new Date(now.getTime() + 25 * HOUR);
    await runHourlyReconcileJob(deps({ now: () => tomorrow }));
    expect((await remindersOf(id)).map((r) => r.dedupeKey).sort()).toEqual(
      [`remind:${id}:${beijingDate(now)}`, `remind:${id}:${beijingDate(tomorrow)}`].sort(),
    );
  });

  it('要人拍的不在这里再推（它们有自己的提醒规矩）', async () => {
    probeDir();
    const { id } = await alert('pool-hold:claude-carpool', { level: 'decision' });
    await backdate('pool-hold:claude-carpool', new Date(Date.now() - 30 * HOUR));
    await runHourlyReconcileJob(deps());
    expect(await remindersOf(id)).toEqual([]);
  });

  it('人在再提醒上点了处理：原来那条跟着撤（处理人记那个人）；原来那条处理了：再提醒跟着撤', async () => {
    probeDir();
    const a = await alert('mq:acme/widgets:decide', { title: '合并队列判断出错，卡住了' });
    const b = await alert('reconcile:pr:acme/widgets#9');
    const long = new Date(Date.now() - 30 * HOUR);
    await backdate('mq:acme/widgets:decide', long);
    await backdate('reconcile:pr:acme/widgets#9', long);
    const running = fakeWorkflows({ 'mq:acme/widgets': { state: 'running' } });
    await runHourlyReconcileJob(deps({ workflows: running.reader }));
    const [ra] = await remindersOf(a.id);
    const [rb] = await remindersOf(b.id);
    if (!ra || !rb) throw new Error('该有再提醒');

    await resolvedByHuman({ id: ra.id }, 'founder-a');
    await resolvedByHuman({ id: b.id }, 'founder-b');
    await runHourlyReconcileJob(deps({ workflows: running.reader }));
    expect(await alertByKey(t.db, 'mq:acme/widgets:decide')).toMatchObject({
      resolvedBy: 'founder-a',
      body: expect.stringMatching(/^已撤：人在再提醒上点了处理/),
    });
    expect((await alertByKey(t.db, rb.dedupeKey))?.body).toMatch(/^已撤：原来那条已经处理了/);
    const audits = await t.db.select().from(auditLog);
    expect(audits.every((x) => x.actorId === RECONCILE_ACTOR)).toBe(true);
  });
});

describe('两处核对接到真库', { timeout: 60_000 }, () => {
  /** 白名单里的创始人：真接活那道门按 GitHub 编号认他。 */
  const FOUNDER = { login: 'founder-a', id: 4242 };

  /** 仓的「让 AI 接活」一天前打开、流程配置副本刚同步过（接活拉起前两样都看）。 */
  async function dispatchOn(repoId: string) {
    await sql(
      `update repos set auto_dispatch_since = $1::timestamptz, flow_config = '{}'::jsonb, flow_source = 'org_default',
         flow_commit = $2, flow_synced_at = now() where id = $3`,
      [new Date(Date.now() - 24 * HOUR).toISOString(), 'c'.repeat(40), repoId],
    );
  }

  /**
   * 一条 issues 投递：status、note、reason 是接活记的；author 是这张 issue 的作者编号（不给是白名单外的人）；at 是这一版
   * issue 的时刻（默认一小时前）；state 是这一版开着还是关着（默认开着）。
   */
  interface DeliveryFixture {
    id?: string;
    status: 'accepted' | 'failed' | 'ignored';
    note?: string;
    reason?: string;
    author?: number;
    at?: Date;
    state?: 'open' | 'closed';
  }

  /** 一张排队的单，带（或不带）一条 issues 投递。 */
  async function queuedWithDelivery(repoId: string, issueNumber: number, delivery: DeliveryFixture | null) {
    const [row] = await t.db
      .insert(tasks)
      .values({
        repoId,
        issueNumber,
        title: '还没派',
        rawRequest: '排队',
        requestedBy: 'founder-a',
        priority: 10,
        state: 'queued',
      })
      .returning();
    if (!row) throw new Error('单没写进去');
    if (delivery) await addDelivery(issueNumber, delivery);
    return row;
  }

  async function addDelivery(issueNumber: number, delivery: DeliveryFixture) {
    const id = delivery.id ?? `d-${issueNumber}`;
    const at = (delivery.at ?? new Date(Date.now() - HOUR)).toISOString();
    const state = delivery.state ?? 'open';
    const action = state === 'open' ? 'opened' : 'closed';
    const author = {
      login: delivery.author ? FOUNDER.login : 'someone',
      id: delivery.author ?? 999,
      type: 'User',
    };
    const payload = {
      action,
      sender: author,
      repository: { full_name: 'acme/widgets' },
      issue: {
        number: issueNumber,
        title: '还没派',
        body: '排队',
        state,
        created_at: at,
        updated_at: at,
        user: author,
      },
    };
    await sql(
      `insert into github_events (delivery_id, event, action, source, repo, payload, status, reason, note, finished_at)
       values ($1, 'issues', $2, 'webhook', 'acme/widgets', $3::jsonb, $4, $5, $6, now())`,
      [id, action, JSON.stringify(payload), delivery.status, delivery.reason ?? null, delivery.note ?? null],
    );
    await sql(
      `insert into github_event_versions (delivery_id, object, version, state) values ($1, $2, $3::timestamptz, $4)`,
      [id, `acme/widgets:issue:${issueNumber}`, at, state],
    );
  }

  /** 现读的 issue：开着、挂在当前版本 v1 上的独立单；over 改哪样。 */
  function plan(over: Partial<IssuePlan> = {}): IssuePlan {
    const v1 = { number: 8, title: 'v1 Fusion 接活' };
    return {
      state: 'open',
      reopened: false,
      pullRequest: false,
      author: FOUNDER.login,
      milestone: v1,
      openMilestones: [v1],
      labels: [],
      parent: null,
      subIssues: 0,
      ...over,
    };
  }

  it('【故意造出的失败】接活开着：在干的单工作流不在报卡住、又在跑撤掉；排队的记着不派理由不报；没理由的经真接活补拉，门没收、没投递报卡住（下一轮说法不变）；刚更新的不查', async () => {
    probeDir();
    const { repo, task } = await work('running');
    await dispatchOn(repo.id);
    await sql('update tasks set updated_at = $1::timestamptz where id = $2', [
      new Date(Date.now() - 20 * 60_000).toISOString(),
      task.id,
    ]);
    const held = await queuedWithDelivery(repo.id, 161, {
      status: 'accepted',
      note: 'task=created, workflow=unscheduled',
    });
    // 作者不在白名单：真接活重放时门口就不收
    const outsider = await queuedWithDelivery(repo.id, 163, { status: 'failed', reason: '上次没处理成' });
    const orphan = await queuedWithDelivery(repo.id, 164, null);
    // 机器人关的单（接活不叫停自己，库里还排着）：不是开着的单，不补拉、不报
    const botClosed = await queuedWithDelivery(repo.id, 166, {
      status: 'accepted',
      note: 'stop=skip_bot',
      state: 'closed',
    });
    const [fresh] = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 162,
        title: '刚收尾',
        rawRequest: '刚更新',
        requestedBy: 'founder-a',
        priority: 10,
        state: 'planning',
        updatedAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!fresh) throw new Error('单没写进去');
    const wf = fakeWorkflows();
    const run = await runHourlyReconcileJob(deps({ workflows: wf.reader }));
    expect(run).toMatchObject({ outcome: 'ok', found: 3 });
    const row = await alertByKey(t.db, `reconcile:workflow:${task.id}`);
    expect(row).toMatchObject({
      level: 'alert',
      taskId: task.id,
      link: 'https://github.com/acme/widgets/issues/160',
      resolvedAt: null,
    });
    expect(row?.body).toContain('在干');
    expect(row?.body).toContain('已经不在了');
    expect(await alertByKey(t.db, `reconcile:workflow:${held.id}`)).toBeNull();
    expect(await alertByKey(t.db, `reconcile:workflow:${fresh.id}`)).toBeNull();
    expect(await alertByKey(t.db, `reconcile:workflow:${botClosed.id}`)).toBeNull();
    const outsiderAlert = `reconcile:workflow:${outsider.id}`;
    expect((await alertByKey(t.db, outsiderAlert))?.body).toContain(
      '补拉时接活没收：门口没收（author_not_whitelisted）',
    );
    expect((await alertByKey(t.db, `reconcile:workflow:${orphan.id}`))?.body).toContain(
      '库里没有这张 issue 的投递',
    );

    // 门口没收的那条重放后记成了不收：下一轮照样认得出是它、说法不变，不改说成「没有投递」
    const running = fakeWorkflows({ 'req:acme/widgets#160': { state: 'running' } });
    await runHourlyReconcileJob(deps({ workflows: running.reader }));
    expect((await alertByKey(t.db, `reconcile:workflow:${task.id}`))?.body).toMatch(/^已撤：需求工作流在跑/);
    expect((await alertByKey(t.db, outsiderAlert))?.body).toContain('门口没收（author_not_whitelisted）');

    // 项目接活关了：不再查，旧提醒撤掉
    await sql('update repos set auto_dispatch_since = null where id = $1', [repo.id]);
    await runHourlyReconcileJob(deps({ workflows: running.reader }));
    expect((await alertByKey(t.db, `reconcile:workflow:${orphan.id}`))?.body).toMatch(
      /^已撤：这个项目「让 AI 接活」关着/,
    );
  });

  it('没着落的排队单经真接活补拉：挂在当前版本的真拉起来（工作流在跑就算补上、不报）；贴着「本机做」的记成不派、下一轮不再补拉', async () => {
    probeDir();
    const { repo } = await work('failed');
    await dispatchOn(repo.id);
    await t.db
      .insert(users)
      .values({ displayName: '创始人 A', role: 'founder', githubLogin: FOUNDER.login, githubId: FOUNDER.id });
    // 上次现读版本没读成（记成出错）：两张都是白名单作者开的
    const missed = await queuedWithDelivery(repo.id, 165, {
      status: 'failed',
      reason: '没查成：读不到挂在哪个版本',
      author: FOUNDER.id,
    });
    const local = await queuedWithDelivery(repo.id, 166, {
      status: 'failed',
      reason: '没查成：读不到挂在哪个版本',
      author: FOUNDER.id,
    });
    const wf = fakeWorkflows();
    const started: number[] = [];
    const requirements: RequirementWorkflows = {
      async start(input) {
        started.push(input.issueNumber);
        wf.states[`req:acme/widgets#${input.issueNumber}`] = { state: 'running' };
        return 'started';
      },
    };
    const read: number[] = [];
    const gh = ghWith({
      async readIssuePlan(input) {
        read.push(input.issueNumber);
        return input.issueNumber === 166 ? plan({ labels: ['本机做'] }) : plan();
      },
    });

    const first = await runHourlyReconcileJob(deps({ workflows: wf.reader, requirements, gh }));
    expect(first).toMatchObject({ outcome: 'ok', found: 2 });
    expect(started).toEqual([165]);
    expect(read.sort()).toEqual([165, 166]);
    expect(await alertByKey(t.db, `reconcile:workflow:${missed.id}`)).toBeNull();
    expect(await alertByKey(t.db, `reconcile:workflow:${local.id}`)).toBeNull();
    const notes = Object.fromEntries(
      (await t.db.select().from(githubEvents)).map((e) => [e.deliveryId, `${e.status} ${e.note}`]),
    );
    expect(notes['d-165']).toMatch(/^accepted .*workflow=started/);
    expect(notes['d-166']).toMatch(/^accepted .*workflow=reserved_local/);

    // 下一轮：165 的工作流在跑、166 投递上记着「本机做」，都有着落，一条都不再补拉
    read.length = 0;
    const second = await runHourlyReconcileJob(deps({ workflows: wf.reader, requirements, gh }));
    expect(second).toMatchObject({ outcome: 'ok', found: 0 });
    expect(read).toEqual([]);
    expect(started).toEqual([165]);
  });

  it('合了的 PR：镜像补上、合并人不对都只算进发现计数，不再报 reconcile:pr 提醒（#445：仓里没开合并队列，这条检查已经删掉）；列不出来这个仓进原因、这一轮不记 ok', async () => {
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
    expect(await alertByKey(t.db, 'reconcile:pr:acme/widgets#7')).toBeNull();

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

  it('【故意造出的失败】合了的 PR 对上的单：会话没结局、单没记成做完，报 reconcile:ledger 写明缺什么；别的分支上的会话不算；补齐了撤掉', async () => {
    await world(t.db);
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
      .insert(sessionRuns)
      .values({
        taskId: task.id,
        stage: 'execute',
        routeId: 'solo',
        whyRoute: '写码阶段首选',
        branch: 'fleet/160-abc',
        queuedAt: new Date(Date.now() - 5 * HOUR),
        startedAt: new Date(Date.now() - 5 * HOUR),
      })
      .returning();
    if (!run) throw new Error('run 没写进去');
    // 更早一轮（被强行终止、会话没收，#247）在另一条分支上：不算进这条 PR 的账
    await t.db.insert(sessionRuns).values({
      taskId: task.id,
      stage: 'execute',
      routeId: 'solo',
      whyRoute: '写码阶段首选',
      branch: 'fleet/160-old',
      queuedAt: new Date(Date.now() - 9 * HOUR),
      startedAt: new Date(Date.now() - 9 * HOUR),
    });
    const first = await runHourlyReconcileJob(deps());
    expect(first).toMatchObject({ outcome: 'ok', found: 1 });
    const row = await alertByKey(t.db, 'reconcile:ledger:acme/widgets#9');
    expect(row).toMatchObject({ level: 'alert', taskId: task.id, resolvedAt: null });
    expect(row?.body).toContain('单 #160：1 次会话没有结局（execute）');
    expect(row?.body).toContain('单 #160：合并关单那一步没写完：库里这张单是「在合并」');
    expect(row?.link).toBe('https://github.com/acme/widgets/pull/9');

    await sql(
      `update session_runs set ended_at = now(), outcome = 'ok', input_tokens = 10, output_tokens = 5 where id = $1`,
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
    const open = await alertByKey(t.db, 'github-app:engine:acme/widgets');
    expect(open).toMatchObject({ level: 'alert', resolvedAt: null });
    expect(open?.title).toBe('「引擎」机器人在 acme/widgets 上的权限不对：缺 statuses:write');

    engineHas = true;
    expect(await runHourlyReconcileJob(deps({ selfCheck }))).toMatchObject({ outcome: 'ok', found: 1 });
    const closed = await alertByKey(t.db, 'github-app:engine:acme/widgets');
    expect(closed?.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(closed?.body).toMatch(/^已撤：「引擎」机器人在 acme\/widgets 上的权限够了/);
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
