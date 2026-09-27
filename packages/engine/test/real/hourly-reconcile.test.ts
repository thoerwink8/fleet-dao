// 每小时对账的真装配：内存库上跑真迁移（提醒、需求、PR 头、结局记账都是真查询）、临时目录里的真 git 树（以本机执行器顶替
// 会话用户）、假的工作树管家（属主记在表里）、假的 Temporal（工作流在不在跑、挂没挂着由用例定）。
// 残留的干净树删掉、提醒跟着撤；有没推的东西不删、改报要人拍；读不到目录、查不了 Temporal、删不掉、git 没跑成都记没查成；
// 条件还在的提醒不撤；卡住报警超过 24 小时再推一次、同一天不重复。每条失败路径都故意造一次。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alertByKey,
  approvals,
  auditLog,
  notifications,
  pullRequests,
  repos,
  scheduleRuns,
  sessionRuns,
  subtasks,
  tasks,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RouteCheck } from '../../src/jobs/alert-sweep.ts';
import { HOURLY_RECONCILE_JOB, runHourlyReconcileJob } from '../../src/jobs/hourly-reconcile.ts';
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
    machine: '法国',
    gitBin: 'git',
    shBin: 'sh',
    log: quiet,
    stageRoutable: async (): Promise<RouteCheck> => ({ kind: 'none', detail: '没有在线的路由' }),
    ...over,
    workflows: wf,
  })({ workflow: {} as never });
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
      body: expect.stringMatching(/^已撤：里面的东西推走或清掉了/),
    });
  });

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
    const b = await alert('stuck:other');
    const long = new Date(Date.now() - 30 * HOUR);
    await backdate('mq:acme/widgets:decide', long);
    await backdate('stuck:other', long);
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
