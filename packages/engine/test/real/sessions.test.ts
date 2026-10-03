// 会话端口（写码会话、会话断了接着干、切号时在跑的会话、分诊/需求文档/审查、开 PR 前验证）。夹具在 sessions-rig.ts；原来一个文件，拆开是为了让 CI 的 engine 分片能按文件均分。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { appendProgressEvents, auditLog, progressEvents, sessionStops } from '@fleet-dao/db';

import { assertPublishable } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';

import type { LaunchSessionInput } from '../../src/ports.ts';

import { screenForOtherVendor } from '../../src/real/sessions.ts';

import { layout } from '../../src/real/worktrees.ts';
import { type FakeRunScript, git, untilAborted } from './fixtures.ts';

import {
  BRANCH,
  commitAndDone,
  ctx,
  launch,
  m,
  repo,
  root,
  runOnce,
  runRow,
  setup,
  t,
  taskId,
} from './sessions-rig.ts';

describe('写码会话', () => {
  it('从镜像建树、起新会话、交活（fleet done + 新提交）；进度写进库，开工和结局都记下', async () => {
    const { ports, fake, trees } = setup(commitAndDone());
    const input = launch();
    const started = await ports.startSession(input, ctx());
    expect(started).toMatchObject({ resumed: false, handle: { pid: 4242 } });
    // 树交给会话用户；会话自己的临时目录（它的 TMPDIR）在工作树根下的 _tmp/<runId>，不在工作树里，也归它
    const tmp = layout(join(root, 'work')).tmpFor(input.runId);
    expect(trees.adopts).toEqual([
      { dir: input.worktreePath, user: 'fleet-agent-carpool' },
      { dir: tmp, user: 'fleet-agent-carpool' },
    ]);
    const spec = fake.specs[0];
    expect(spec?.env.tmpDir).toBe(tmp);
    expect(existsSync(tmp)).toBe(true);
    expect(spec?.session).toEqual({ mode: 'new', id: started.sessionId });
    expect(spec?.cwd).toBe(input.worktreePath);
    expect(spec?.cgroup).toMatchObject({
      id: input.runId,
      user: 'fleet-agent-carpool',
      // 交换区上限 0 写「0」：帮手脚本和插头都不认「0M」（2026-09-26 法国第一次真起会话就卡在这）
      limits: { memoryHigh: '1536M', memoryMax: '2048M', memorySwapMax: '0' },
    });
    expect(spec?.model).toBe('claude-opus-5-5');
    expect(spec?.prompt).toContain('需求 #12');
    // 测试命令来自仓的流程配置副本：仍记进会话那一行（556-4 之前的兼容字段），但 554-2 起提示词不再要求
    // 会话里原样跑——done 核查看的是 PR 上的 CI（packages/api/src/done-check.ts），会话里不跑。
    expect(spec?.prompt).toContain('测试由 CI 跑');
    expect(spec?.prompt).toContain('不在会话里跑测试');
    expect(spec?.prompt).not.toContain('交活只认会话里原样跑的');
    expect(spec?.testCommands).toEqual(['pnpm check']);
    expect((await runRow(input.runId))?.testCommand).toBe('pnpm check');
    expect(fake.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/reclaude']);
    // 树是会话用户从镜像的 bundle 建的：分支在起会话前的头上；主线钉成 origin/main（pnpm test:changed 和它比）。
    expect(git(input.worktreePath as string, 'rev-parse', `${BRANCH}~1`)).toBe(m.head);
    expect(git(input.worktreePath as string, 'rev-parse', 'refs/remotes/origin/main')).toBe(m.head);

    const beat = ctx();
    const end = await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      beat,
    );
    expect(end.outcome).toBe('done');
    // 看守交回之前，会话的临时目录已经删了
    expect(existsSync(tmp)).toBe(false);
    expect(end.output).toMatchObject({ kind: 'delivery', summary: '做完了', testsPassed: true });
    expect(end.output?.kind === 'delivery' && end.output.head).toBe(
      git(input.worktreePath as string, 'rev-parse', 'HEAD'),
    );
    expect(end.output?.kind === 'delivery' && end.output.changedFiles?.[0]).toMatch(/^src\/login-/);
    const row = await runRow(input.runId);
    expect(row).toMatchObject({
      sessionId: started.sessionId,
      outcome: 'ok',
      runAsUser: 'fleet-agent-carpool',
      routeOutcome: 'ok',
      costUsd: 0.5,
    });
    expect(row?.startedAt).not.toBeNull();
    const kinds = (await t.db.select().from(progressEvents)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['tool', 'test', 'done']));
  });

  it('token 照终帧记进库，缓存读写单列（折额度当量要用，#216）', async () => {
    const { ports } = setup(() => ({
      ...commitAndDone()(),
      result: {
        usage: {
          inputTokens: 12,
          outputTokens: 340,
          cacheReadInputTokens: 51_200,
          cacheCreationInputTokens: 2_048,
        },
      },
    }));
    const input = launch();
    const { end } = await runOnce(ports, input);
    expect(end.usage).toEqual({
      inputTokens: 12,
      outputTokens: 340,
      cacheReadTokens: 51_200,
      cacheWriteTokens: 2_048,
    });
    expect(await runRow(input.runId)).toMatchObject({
      inputTokens: 12,
      outputTokens: 340,
      cacheReadTokens: 51_200,
      cacheWriteTokens: 2_048,
    });
  });

  it('终帧没报缓存读写（假插头默认只报输入输出）：库里留空，就是没读到，不记成 0', async () => {
    const { ports } = setup(commitAndDone());
    const input = launch();
    const { end } = await runOnce(ports, input);
    expect(end.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(await runRow(input.runId)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it('同一个 runId 起第二次：回同一个，不起第二个进程；叫停过的 runId 不再起', async () => {
    const { ports, fake } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
    const input = launch();
    const first = await ports.startSession(input, ctx());
    const again = await ports.startSession(input, ctx());
    expect(again.sessionId).toBe(first.sessionId);
    expect(fake.count()).toBe(1);
    await ports.stopSession({ taskId, runId: input.runId, mode: 'kill', reason: '叫停' }, ctx());
    const end = await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: first.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(end.outcome).toBe('stopped');
    expect((await t.db.select().from(sessionStops)).map((s) => s.runId)).toEqual([input.runId]);

    const stopped = launch();
    await ports.stopSession({ taskId, runId: stopped.runId, mode: 'kill', reason: '起之前就叫停' }, ctx());
    await expect(ports.startSession(stopped, ctx())).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    expect(fake.count()).toBe(1);
  });

  it('建树取包半截失败（仓建了、包是坏的）后同一个 runId 重试：照常取包、检出分支，不在空仓里起会话', async () => {
    let bundles = 0;
    const gh = {
      ...m.gh,
      async bundleCommits(input: Parameters<typeof m.gh.bundleCommits>[0]) {
        const made = await m.gh.bundleCommits(input);
        bundles += 1;
        if (bundles === 1) writeFileSync(made.path, '这不是 bundle\n');
        return made;
      },
    };
    const { ports, fake } = setup(commitAndDone(), { gh });
    const input = launch();
    const dir = input.worktreePath as string;
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'GIT_FAILED',
      retryable: true,
    });
    expect(fake.count()).toBe(0);
    // 留下的是个空仓：.git 在，HEAD 解析不出来
    expect(git(dir, 'rev-parse', '--git-dir')).toBe('.git');
    expect(() => git(dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')).toThrow();
    // 活动重试：同一个 runId 再来
    const started = await ports.startSession(input, ctx());
    expect(fake.count()).toBe(1);
    expect(bundles).toBe(2);
    const end = await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(end.outcome).toBe('done');
    // 会话是在检出好的分支上干的：分支在起会话前的头（baseHead）上，会话的提交接在它后面
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(git(dir, 'rev-parse', `${BRANCH}~1`)).toBe(m.head);
  });

  it('没用 fleet done 交活、有没提交的已跟踪改动、没有新提交：都判没交付，不当成做完', async () => {
    for (const [options, words] of [
      [{ noDone: true }, '没用 fleet done'],
      [{ dirty: true }, '没提交的已跟踪改动'],
      [{ noCommit: true }, '没有新提交'],
    ] as const) {
      const { ports } = setup(commitAndDone(options));
      const { end } = await runOnce(
        ports,
        launch({ worktreePath: layout(join(root, `w-${randomUUID()}`)).treeFor(repo, BRANCH) }),
      );
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('not_delivered');
      expect(end.failure?.message).toContain(words);
    }
  });

  // #293：会话在树里并过主线，交活的改动清单要扣掉并进来的主线（user-git.ts 的 ownSpan）。原来按 git diff base HEAD 算，
  // 主线上别人改的页面代码也算成这张单改的，开 PR 前验证按界面类派、没人可派。
  describe('会话并了主线（#293）', () => {
    const UI = 'deploy/web/health/health.js';
    /** 主线上别人又改了页面代码。 */
    function mainlineChangesUi(): string {
      mkdirSync(join(m.dir, 'deploy', 'web', 'health'), { recursive: true });
      writeFileSync(join(m.dir, UI), 'export const h = 2;\n');
      git(m.dir, 'add', '--', UI);
      git(m.dir, 'commit', '-q', '-m', 'main: 健康页');
      return git(m.dir, 'rev-parse', 'HEAD');
    }
    /**
     * 会话在树里并主线：新主线由引擎推之前取进树里、钉成 origin/main（github-ports 的 pushBranch，这里照做一遍），会话照着
     * git merge 它；own 为真再提交一个自己改的文件。都跑了测试、fleet done。
     */
    const mergesMainline =
      (options: { own?: boolean } = {}) =>
      (): FakeRunScript => ({
        act: async ({ spec, emit }) => {
          git(spec.cwd, 'fetch', '-q', m.dir, '+refs/heads/main:refs/remotes/origin/main');
          git(spec.cwd, 'merge', '--no-ff', '--no-edit', '-q', 'origin/main');
          if (options.own) {
            mkdirSync(join(spec.cwd, 'src'), { recursive: true });
            writeFileSync(join(spec.cwd, 'src', 'login-own.ts'), 'export const code = 1;\n');
            git(spec.cwd, 'add', '--', 'src');
            git(spec.cwd, 'commit', '-q', '-m', 'feat: 登录页加验证码');
          }
          emit('tool', {
            phase: 'start',
            toolUseId: 'u1',
            name: 'Bash',
            action: 'run',
            summary: 'pnpm check',
          });
          emit('test', { command: 'pnpm check', passed: true });
          emit('tool', {
            phase: 'end',
            toolUseId: 'u1',
            name: 'Bash',
            action: 'run',
            summary: 'pnpm check',
            ok: true,
          });
          await appendProgressEvents(t.db, spec.runId, [
            { at: new Date(), kind: 'done', payload: { summary: '做完了', testsPassed: true } },
          ]);
        },
      });

    it('【故意造出的失败】并了改过页面代码的主线、又改了自己的：交回的改动只有自己改的，主线的页面代码不算', async () => {
      mainlineChangesUi();
      const { ports } = setup(mergesMainline({ own: true }));
      const input = launch();
      const { end } = await runOnce(ports, input);
      expect(end.outcome).toBe('done');
      // 原来的算法（git diff base HEAD）会是 [页面代码, 自己的]
      expect(git(input.worktreePath as string, 'diff', '--name-only', m.head, 'HEAD').split('\n')).toContain(
        UI,
      );
      expect(end.output?.kind === 'delivery' && end.output.changedFiles).toEqual(['src/login-own.ts']);
    });

    it('【故意造出的失败】只并了主线、自己没写东西：判没交付，不当成交了主线上别人的活', async () => {
      mainlineChangesUi();
      const { ports } = setup(mergesMainline());
      const { end } = await runOnce(ports, launch());
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('not_delivered');
      expect(end.failure?.message).toContain('除了并进来的主线');
    });

    it('钉主线之前建的老树接着用：起会话前把主线钉到起会话前的头，交活照常核（不因为树里没钉判不了）', async () => {
      const { ports } = setup(commitAndDone());
      const input = launch();
      const dir = input.worktreePath as string;
      await runOnce(ports, input);
      const first = git(dir, 'rev-parse', 'HEAD');
      // 老树：#218 之前建的，树里没有 origin/main
      git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
      const { end } = await runOnce(ports, launch({ baseHead: first }));
      expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(first);
      expect(end.outcome).toBe('done');
      const files = end.output?.kind === 'delivery' ? (end.output.changedFiles ?? []) : [];
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^src\/login-/);
    });
  });

  it('会话说卡住了（fleet blocked）：结局 blocked，带原因', async () => {
    const { ports } = setup(() => ({
      act: async ({ spec }) => {
        await appendProgressEvents(t.db, spec.runId, [
          { at: new Date(), kind: 'blocked', payload: { reason: '缺测试账号', needs: 'access' } },
        ]);
      },
    }));
    const { end } = await runOnce(ports, launch());
    expect(end).toMatchObject({ outcome: 'blocked', blocked: { reason: '缺测试账号', needs: 'access' } });
  });
});

describe('会话断了接着干', () => {
  it('同一个会话用户：--resume 续上；这一轮的花费按上一轮的累计求差', async () => {
    const { ports, fake } = setup((_, n) => commitAndDone({ cost: n === 1 ? 0.5 : 0.8 })());
    const first = await runOnce(ports, launch());
    const input = launch({
      resumeSessionId: first.sessionId,
      baseHead: first.end.output?.kind === 'delivery' ? first.end.output.head : m.head,
    });
    const second = await runOnce(ports, input);
    expect(fake.specs[1]?.session).toEqual({ mode: 'resume', id: first.sessionId });
    expect(second.sessionId).toBe(first.sessionId);
    expect(fake.specs[1]?.prompt.startsWith('接着干')).toBe(true);
    expect((await runRow(input.runId))?.costUsd).toBeCloseTo(0.3);
  });

  it('续会话按上一轮的上下文多等第一帧；上一个会话没提交就断了：续上的提示词写明先读 git diff 接着做', async () => {
    // 第一轮：上下文 20 万 token，改了 README 没提交、没交活就断了（发布停机、被杀这一类）
    const { ports, fake } = setup((_, n) =>
      n === 1
        ? commitAndDone({ noCommit: true, noDone: true, dirty: true, contextTokens: 200_000 })()
        : commitAndDone()(),
    );
    const first = await runOnce(ports, launch());
    expect(first.end.outcome).toBe('failed');
    expect(fake.specs[0]?.limits?.startupMs).toBeUndefined();
    expect(fake.specs[0]?.prompt).not.toContain('没提交的改动');
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    // 20 万 token ÷ 每分钟 4 万 = 多等 5 分钟
    expect(fake.specs[1]?.limits?.startupMs).toBe(180_000 + 5 * 60_000);
    expect(fake.specs[1]?.prompt).toContain('工作树里有上一个会话没提交的改动（1 个文件');
    expect(fake.specs[1]?.prompt).toContain('README.md');
  });

  it('换了账号池（切号后原会话绑在旧组织上）、上一轮上下文还小：同一个会话用户 --fork-session 续，不改属主、不拷记录', async () => {
    const { ports, fake, trees } = setup((_, n) => commitAndDone(n === 1 ? { contextTokens: 5_000 } : {})());
    const carpool = {
      routeId: 'carpool',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      family: 'claude',
      hostId: 'claude-code' as const,
    };
    const first = await runOnce(ports, launch({ route: carpool }));
    const input = launch({ resumeSessionId: first.sessionId });
    const started = await ports.startSession(input, ctx());
    // 树第一次起会话时交给了会话用户，之后还是它：不再改属主（每个会话自己的临时目录另算）
    expect(trees.treeAdopts()).toEqual([{ dir: input.worktreePath, user: 'fleet-agent-carpool' }]);
    expect(fake.specs[1]?.session).toEqual({ mode: 'fork', from: first.sessionId, id: started.sessionId });
    expect(fake.specs[1]?.cgroup?.user).toBe('fleet-agent-carpool');
    expect(started.resumed).toBe(true);
    expect(started.sessionId).not.toBe(first.sessionId);
    await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    // fork 出来的会话不知道累计花费从哪算起：不记这一轮的花费。
    expect((await runRow(input.runId))?.costUsd).toBeNull();
  });

  it('换了账号池、上一轮上下文大了：开新会话，带接力任务书（已提交的不重做）', async () => {
    const { ports, fake } = setup((_, n) => commitAndDone(n === 1 ? { contextTokens: 200_000 } : {})());
    const carpool = {
      routeId: 'carpool',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      family: 'claude',
      hostId: 'claude-code' as const,
    };
    const first = await runOnce(ports, launch({ route: carpool }));
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    const spec = fake.specs[1];
    expect(spec?.session.mode).toBe('new');
    expect(spec?.prompt).toContain('接力');
    expect(spec?.prompt).toContain('feat: 登录页加验证码');
    expect(spec?.prompt).toContain('大了不 fork');
  });

  it('上一轮跑在已停用的会话用户下（过程记录在已删的家目录里）：同一个池也不硬续，开新会话带接力任务书', async () => {
    const { ports, fake } = setup((_, n) => commitAndDone(n === 1 ? { contextTokens: 5_000 } : {})());
    const first = await runOnce(ports, launch());
    await t.client.query(
      `update session_runs set run_as_user = 'fleet-agent-dedicated' where session_id = $1`,
      [first.sessionId],
    );
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    expect(fake.specs[1]?.session.mode).toBe('new');
    expect(fake.specs[1]?.prompt).toContain('接力');
    expect(fake.specs[1]?.prompt).toContain('不是现在的会话用户');
  });
});

describe('切号那一刻在跑的会话（#59）', () => {
  const CARPOOL = {
    routeId: 'carpool',
    poolId: 'claude-carpool',
    modelId: 'opus-5.5',
    family: 'claude',
    hostId: 'claude-code' as const,
  };
  const WHY = '切号：会话用户从拼车组织切到独享组织，先停下，切完接着干';

  it('停下跑在这些池上、进程起来了的会话：交回 org_switch（可重试，不算路由的失败）；别的池上的不碰；已经在停的不重复叫停', async () => {
    const { ports } = setup(() => ({
      act: async ({ signal }) => untilAborted(signal),
      lastContextTokens: 5_000,
    }));
    const onCarpool = launch({ route: CARPOOL });
    const onSolo = launch({ subtaskKey: 'other', brief: { ...launch().brief, branch: 'fleet/12-other' } });
    const a = await ports.startSession(onCarpool, ctx());
    const b = await ports.startSession(onSolo, ctx());
    const carpool = new Set(['claude-carpool']);
    expect(ports.orgSwitch.live(carpool)).toEqual([onCarpool.runId]);
    expect(ports.orgSwitch.stop(carpool, WHY)).toEqual([onCarpool.runId]);
    expect(ports.orgSwitch.stop(carpool, WHY)).toEqual([]);
    const end = await ports.awaitSession(
      { taskId, runId: onCarpool.runId, sessionId: a.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(end).toMatchObject({
      outcome: 'failed',
      sessionId: a.sessionId,
      failure: { code: 'org_switch', message: WHY, retryable: true, machine: '法国' },
    });
    // 收场了：不在手上了
    expect(ports.orgSwitch.live(carpool)).toEqual([]);
    expect(await runRow(onCarpool.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'org_switch',
      routeOutcome: 'neutral',
      contextTokens: 5_000,
    });
    // 切号不记叫停（叫停记录会让同一个 runId 起不来）：续的是新的 runId
    expect((await t.db.select().from(sessionStops)).map((s) => s.runId)).toEqual([]);
    // 独享池上的那个照跑
    expect(ports.orgSwitch.live(new Set(['claude-solo']))).toEqual([onSolo.runId]);
    await ports.stopSession({ taskId, runId: onSolo.runId, mode: 'kill', reason: '收尾' }, ctx());
    await ports.awaitSession(
      { taskId, runId: onSolo.runId, sessionId: b.sessionId, stage: 'execute' },
      ctx(),
    );
  });

  it('切号停下的会话接着干：换了池 fork 续上，提示词里写着上一次为什么停；怎么续的进操作记录', async () => {
    const { ports, fake } = setup((_, n) =>
      n === 1
        ? { act: async ({ signal }) => untilAborted(signal), lastContextTokens: 5_000 }
        : commitAndDone()(),
    );
    const first = launch({ route: CARPOOL });
    const a = await ports.startSession(first, ctx());
    ports.orgSwitch.stop(new Set(['claude-carpool']), WHY);
    await ports.awaitSession({ taskId, runId: first.runId, sessionId: a.sessionId, stage: 'execute' }, ctx());
    const next = launch({ resumeSessionId: a.sessionId });
    const again = await runOnce(ports, next);
    expect(fake.specs[1]?.session).toEqual({ mode: 'fork', from: a.sessionId, id: again.sessionId });
    expect(fake.specs[1]?.prompt).toContain(WHY);
    expect(again.end.outcome).toBe('done');
    const audits = (await t.db.select().from(auditLog)).filter((r) => r.action === 'session-org.resume');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: 'engine',
      target: `session-run:${next.runId}`,
      before: { runId: first.runId, routeId: 'carpool' },
      after: { routeId: 'solo', poolId: 'claude-solo', mode: 'fork' },
      ok: true,
    });
    expect(audits[0]?.reason).toContain('fork 续上');
  });

  it('不是切号停下的会话接着干：不记这一条', async () => {
    const { ports } = setup(() => commitAndDone()());
    const first = await runOnce(ports, launch());
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    expect((await t.db.select().from(auditLog)).filter((r) => r.action === 'session-org.resume')).toEqual([]);
  });
});

describe('分诊、需求文档、方案、审查：读结论文件', () => {
  const triage = (text: string | null): FakeRunScript => ({
    act: ({ spec }) => {
      if (text === null) return;
      mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
      writeFileSync(join(spec.cwd, '.fleet-out', 'triage.json'), text);
    },
  });
  const triageLaunch = () => {
    // 分诊是需求自己的会话：没有子任务、没有工作树、没有起会话前的头。
    const { subtaskKey: _k, worktreePath: _w, baseHead: _b, ...rest } = launch({ stage: 'triage' });
    return rest;
  };

  it('检出副本从主线建；写对了就交回分诊结论', async () => {
    const { ports, fake } = setup(() =>
      triage('{"clear": true, "summary": "理解为：加验证码", "size": "S"}'),
    );
    const { end } = await runOnce(ports, triageLaunch());
    expect(end).toMatchObject({
      outcome: 'done',
      output: { kind: 'triage', verdict: { clear: true, size: 'S' } },
    });
    const dir = fake.specs[0]?.cwd as string;
    expect(dir).toBe(layout(join(root, 'work')).scratchFor(repo, 12, 'triage'));
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(m.head);
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(m.head);
  });

  it('审查：检出 PR 的头；主线另取进来钉成 origin/main，git diff origin/main...HEAD 只列 PR 自己的改动', async () => {
    // PR 从主线分出去多一个提交；之后主线又进了一个提交（不在 PR 的历史里，得另取进树）
    git(m.dir, 'checkout', '-q', '-b', 'pr');
    writeFileSync(join(m.dir, 'pr.ts'), 'export const pr = 1;\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'pr');
    const prHead = git(m.dir, 'rev-parse', 'HEAD');
    git(m.dir, 'checkout', '-q', 'main');
    writeFileSync(join(m.dir, 'later.ts'), 'export const later = 1;\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'main moved');
    const mainHead = git(m.dir, 'rev-parse', 'HEAD');
    const { ports, fake } = setup(() => ({
      act: ({ spec }) => {
        mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
        writeFileSync(join(spec.cwd, '.fleet-out', 'review.json'), '{"verdict": "pass", "findings": []}');
      },
    }));
    const base = launch({ stage: 'review' });
    const { worktreePath: _w, baseHead: _b, ...rest } = base;
    const { end } = await runOnce(ports, { ...rest, brief: { ...base.brief, prNumber: 101, head: prHead } });
    expect(end).toMatchObject({
      outcome: 'done',
      output: { kind: 'review', review: { verdict: 'pass', head: prHead } },
    });
    const dir = fake.specs[0]?.cwd as string;
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(prHead);
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(mainHead);
    expect(git(dir, 'diff', '--name-only', 'origin/main...HEAD')).toBe('pr.ts');
  });

  it('没写结论文件、写的不是 JSON、说不清却没写要问的：都判交错了（wrong_output）', async () => {
    for (const text of [null, '不是 JSON', '{"clear": false}']) {
      const { ports } = setup(() => triage(text));
      const { end } = await runOnce(ports, triageLaunch());
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('wrong_output');
    }
  });

  it('需求文档：「对应计划：」那一行对得上检出副本里的 plan.md 才收；没有这一行、对不上都判交错了（开 PR 要照它填）', async () => {
    const doc = (text: string, plan?: string): FakeRunScript => ({
      act: ({ spec }) => {
        mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
        writeFileSync(join(spec.cwd, '.fleet-out', 'doc.md'), text);
        if (plan !== undefined) {
          mkdirSync(join(spec.cwd, 'docs'), { recursive: true });
          writeFileSync(join(spec.cwd, 'docs', 'plan.md'), plan);
        }
      },
    });
    const specLaunch = () => {
      const { subtaskKey: _k, worktreePath: _w, baseHead: _b, ...rest } = launch({ stage: 'spec' });
      return rest;
    };
    const plan = '# 计划\n\n### P1 核心闭环\n\n- 工作流：需求、子任务。\n';
    const good = '# 登录页加验证码\n\n对应计划：plan.md P1「工作流」\n\n要验证码';
    const ok = setup(() => doc(good, plan));
    expect((await runOnce(ok.ports, specLaunch())).end).toMatchObject({
      outcome: 'done',
      output: { kind: 'doc', markdown: good },
    });
    for (const [text, withPlan, why] of [
      ['# 登录页加验证码\n\n要验证码', plan, '没有「对应计划：」那一行'],
      ['# 登录页加验证码\n\n对应计划：plan.md P1「没有这一条」\n', plan, '找不到'],
      // 仓里没有 plan.md：不许瞎凑一条
      [good, undefined, '仓里没有'],
    ] as const) {
      const bad = setup(() => doc(text, withPlan));
      const { end } = await runOnce(bad.ports, specLaunch());
      expect(end.outcome).toBe('failed');
      expect(end.failure).toMatchObject({ code: 'wrong_output', message: expect.stringContaining(why) });
    }
  });
});

describe('开 PR 前验证：检出送检的头，发出去的材料先过卫生检查，读结论文件', () => {
  const CRITERIA = ['过期的验证码登录不了', '有一条故意造出失败的测试'];
  /** 装成真密钥的值（运行时拼，源码里不出现整段，全仓卫生检查不会拦这个文件自己）。 */
  const LEAK = ['ghp', 'q7Rz2LmX9vKp4TnB8wYc1HdF6jGs3NaEw5Yu'].join('_');
  const verifyLaunch = (head: string, criteria: string[] = CRITERIA): LaunchSessionInput => {
    const base = launch({ stage: 'verify' });
    const { worktreePath: _w, baseHead: _b, ...rest } = base;
    return {
      ...rest,
      brief: {
        ...base.brief,
        head,
        verify: {
          criteria,
          specPath: 'specs/12-login/需求.md',
          planSummary: '登录表单加验证码输入，后端校验五分钟过期',
          changedFiles: ['a.ts'],
        },
      },
    };
  };
  const writes = (text: string | null): FakeRunScript => ({
    act: ({ spec }) => {
      if (text === null) return;
      mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
      writeFileSync(join(spec.cwd, '.fleet-out', 'verify.json'), text);
    },
  });
  const report = (head: string) => ({
    head,
    results: CRITERIA.map((criterion) => ({ criterion, answer: 'done', evidence: '看过 a.ts' })),
    findings: [],
  });
  // 卫生检查只管一个仓（hygiene-scope.ts，默认 fleet-dao 自己）：测试里的任务挂在夹具仓上，把管的就是这个夹具仓
  const checked = (
    repo: { owner: string; name: string },
    what: string,
    texts: { path: string; text: string }[],
  ) => assertPublishable(repo, what, texts, repo);
  const caught = (fn: () => void): unknown => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('检出送检的头；这次真要发的整份提示词先过卫生检查；写对了交回结论', async () => {
    const screened: { what: string; texts: { path: string; text: string }[] }[] = [];
    const { ports, fake } = setup(() => writes(JSON.stringify(report(m.head))), {
      screen: (repo, what, texts) => {
        screened.push({ what, texts });
        checked(repo, what, texts);
      },
    });
    const { end } = await runOnce(ports, verifyLaunch(m.head));
    expect(end).toMatchObject({ outcome: 'done', output: { kind: 'verify', report: report(m.head) } });
    const sent = fake.specs[0];
    expect(screened).toEqual([
      { what: '发给别家的验证材料', texts: [{ path: '验证提示词', text: sent?.prompt }] },
    ]);
    expect(sent?.prompt).toContain('1. 过期的验证码登录不了');
    expect(sent?.prompt).toContain('specs/12-login/需求.md');
    expect(git(sent?.cwd as string, 'rev-parse', 'HEAD')).toBe(m.head);
  });

  it('【故意造出的失败】材料里有真密钥：不发、不起会话，报 MATERIAL_BLOCKED，报错里只有位置和规则、没有那个值', async () => {
    const { ports, fake } = setup(() => writes(JSON.stringify(report(m.head))), { screen: checked });
    const input = verifyLaunch(m.head, [`别把 ${LEAK} 写进日志`]);
    const error = await ports.startSession(input, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MATERIAL_BLOCKED', retryable: false });
    const message = String((error as Error).message);
    expect(message).toContain('没过卫生检查，没发给Claude Code：查出 1 处（验证提示词 第');
    expect(message).toContain('token');
    expect(message).not.toContain(LEAK);
    expect(fake.specs).toEqual([]);
    expect((await runRow(input.runId))?.startedAt).toBeNull();
  });

  it('【故意造出的失败】会话端口没配卫生检查：发不出去（HYGIENE_UNSCANNED），不当成查过了', async () => {
    const { ports, fake } = setup(() => writes(JSON.stringify(report(m.head))));
    const error = await ports.startSession(verifyLaunch(m.head), ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'HYGIENE_UNSCANNED', retryable: false });
    expect(fake.specs).toEqual([]);
  });

  it('【故意造出的失败】检查自己出错：原样报 HYGIENE_UNSCANNED、算没扫成，不发', () => {
    const broken = caught(() =>
      screenForOtherVendor(
        repo,
        () => {
          throw new Error('扫描器坏了');
        },
        '提示词',
        'Cursor Agent',
      ),
    );
    expect(broken).toMatchObject({ code: 'HYGIENE_UNSCANNED', retryable: false });
    expect(String((broken as Error).message)).toContain('没扫成，不发给Cursor Agent');
  });

  it('#246：结论文件里 criterion 只差反引号 → 会话端口认得（挡这一道的是 core 的 checkReport），交回的是清单原文', async () => {
    const ticked = [
      '`packages/engine/src/jobs/alert-sweep.ts` 加一条规则：读不了记这一轮没查全，不撤。',
      ...CRITERIA,
    ];
    const answer = (criterion: string) => ({ criterion, answer: 'done', evidence: '看过 a.ts' });
    const written = { head: m.head, results: ticked.map((c) => answer(c.replaceAll('`', ''))), findings: [] };
    const { ports } = setup(() => writes(JSON.stringify(written)), { screen: checked });
    const { end } = await runOnce(ports, verifyLaunch(m.head, ticked));
    expect(end).toMatchObject({
      outcome: 'done',
      output: { kind: 'verify', report: { head: m.head, results: ticked.map(answer), findings: [] } },
    });
  });

  it('【故意造出的失败】没写结论、写的不是 JSON、审的不是送检的头、漏答一条、答了清单外的（字不一样，不只差格式）：都判交错了（wrong_output），写明哪里不对', async () => {
    const other = 'f'.repeat(40);
    const good = report(m.head);
    for (const [text, why] of [
      [null, '没写结论 .fleet-out/verify.json'],
      ['不是 JSON', '不是合法的 JSON'],
      [JSON.stringify(report(other)), `审的不是送检的头：送的是 ${m.head}，审的是 ${other}`],
      [JSON.stringify({ ...good, results: good.results.slice(0, 1) }), '没答：「有一条故意造出失败的测试」'],
      [
        JSON.stringify({
          ...good,
          results: [
            ...good.results.slice(0, 1),
            { criterion: '有两条故意造出失败的测试', answer: 'done', evidence: '看过 a.ts' },
          ],
        }),
        '答了清单外的一条：「有两条故意造出失败的测试」',
      ],
    ] as const) {
      const { ports } = setup(() => writes(text), { screen: checked });
      const { end } = await runOnce(ports, verifyLaunch(m.head));
      expect(end.outcome).toBe('failed');
      expect(end.failure).toMatchObject({ code: 'wrong_output', message: expect.stringContaining(why) });
    }
  });
});
