// 会话端口（失败、Fusion 的 Lead、收孤儿、临时目录、Jev）。夹具在 sessions-rig.ts；原来一个文件，拆开是为了让 CI 的 engine 分片能按文件均分。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { scopePrefix } from '@fleet-dao/adapters';
import { getSessionRun, notifications, quotaWindows, sessionRuns, upsertAlert } from '@fleet-dao/db';

import { assertPublishable } from '@fleet-dao/github';
import { describe, expect, it, vi } from 'vitest';
import type { JevAskContext, JevPort, JevQuestion, JevReply } from '../../src/failure/jev.ts';
import type { LaunchSessionInput, LeadStep } from '../../src/ports.ts';

import { poolHoldKey } from '../../src/real/store-ports.ts';
import { layout } from '../../src/real/worktrees.ts';
import { addCursorRoute, type FakeRunScript, git, NOW, untilAborted } from './fixtures.ts';

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

describe('失败', () => {
  it('额度用满：带上游给的清零时刻交给失败分流；额度读数顺手记账', async () => {
    const resetsAt = new Date(NOW.getTime() + 3 * 3600_000).toISOString();
    const { ports } = setup(() => ({
      result: { isError: true, terminalReason: 'api_error', text: 'usage limit reached' },
      exitCode: 1,
      act: ({ rateLimit }) => {
        rateLimit({
          status: 'rejected',
          exhausted: true,
          rateLimitType: 'five_hour',
          resetsAt,
          windows: [{ name: 'five_hour', utilization: 1, resetsAt }],
          observedAt: NOW.toISOString(),
        });
      },
    }));
    const { end } = await runOnce(ports, launch());
    expect(end).toMatchObject({
      outcome: 'failed',
      failure: { code: 'quota_exhausted', resetsAt, machine: '法国', runAsUser: 'fleet-agent-carpool' },
    });
    const windows = (await t.db.select().from(quotaWindows)).filter(
      (w) => w.poolId === 'claude-solo' && w.label === 'five_hour',
    );
    expect(windows[0]?.upstreamStatus).toBe('limit_reached');
  });

  it('设备被撤销：原样交给失败分流；整池暂停（要人拍，写清哪台机器、哪个会话用户），下一次跑通就撤掉', async () => {
    const { ports } = setup((_, n) =>
      n === 1
        ? {
            result: {
              isError: true,
              terminalReason: 'api_error',
              apiErrorStatus: 401,
              text: 'device_revoked',
            },
            apiError: { code: 'device_revoked', text: '401 device_revoked' },
            exitCode: 1,
          }
        : commitAndDone()(),
    );
    const firstInput = launch();
    const first = await runOnce(ports, firstInput);
    expect(first.end.outcome).toBe('failed');
    expect(first.end.failure?.code).toBe('agent_error');
    expect(first.end.failure?.message).toContain('device_revoked');
    const hold = (await t.db.select().from(notifications)).find(
      (n) => n.dedupeKey === poolHoldKey('claude-solo'),
    );
    expect(hold).toMatchObject({ level: 'decision', resolvedAt: null });
    expect(hold?.body).toContain('法国');
    expect(hold?.body).toContain('fleet-agent-carpool');
    expect(hold?.body).toContain('reclaude login');
    // 账号池的事不算这条路由的账（不喂熔断）。
    expect((await runRow(firstInput.runId))?.routeOutcome).toBe('neutral');

    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    const after = (await t.db.select().from(notifications)).find(
      (n) => n.dedupeKey === poolHoldKey('claude-solo'),
    );
    expect(after?.resolvedAt).not.toBeNull();
    expect(after?.resolvedBy).toBe('engine');
  });

  it('封号：同样整池暂停；已经暂停着的不重复开', async () => {
    await upsertAlert(t.db, {
      dedupeKey: 'unrelated',
      level: 'alert',
      taskId: null,
      title: 'x',
      body: '',
    });
    const { ports } = setup(() => ({
      result: { isError: true, terminalReason: 'api_error', text: 'account_banned：当前绑定账号暂不可用' },
      exitCode: 1,
    }));
    await runOnce(ports, launch());
    await runOnce(ports, launch());
    const holds = (await t.db.select().from(notifications)).filter(
      (n) => n.dedupeKey === poolHoldKey('claude-solo'),
    );
    expect(holds).toHaveLength(1);
  });

  it('按进展判停滞：同一个动作反复做、半天没推进（绕圈），停掉，结局 stalled', async () => {
    const { ports } = setup(() => ({
      act: async ({ emit, signal }) => {
        for (let i = 0; i < 4; i++) {
          emit('tool', {
            phase: 'start',
            toolUseId: `u${i}`,
            name: 'Bash',
            action: 'run',
            summary: 'pnpm test',
          });
          emit('tool', {
            phase: 'end',
            toolUseId: `u${i}`,
            name: 'Bash',
            action: 'run',
            summary: 'pnpm test',
            ok: false,
          });
        }
        await Promise.race([untilAborted(signal), new Promise((r) => setTimeout(r, 10_000))]);
      },
    }));
    const { end } = await runOnce(ports, launch());
    expect(end.outcome).toBe('stalled');
    expect(end.failure?.message).toMatch(/^L1：/);
  });

  it('接不上（工人重启过）：按记下的 scope 收掉旧会话，回 SESSION_LOST；库里这一行记上结局', async () => {
    const { ports } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
    const input = launch();
    const started = await ports.startSession(input, ctx());
    // 新的工人进程：看不到上一个进程起的会话。
    const { ports: restarted } = setup(() => ({}));
    const end = await restarted.awaitSession(
      {
        taskId,
        runId: input.runId,
        sessionId: started.sessionId,
        stage: 'execute',
        ...(started.handle ? { handle: started.handle } : {}),
      },
      ctx(),
    );
    expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'SESSION_LOST', retryable: true } });
    expect(end.failure?.message).toContain('接不上会话');
    expect(await getSessionRun(t.db, input.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SESSION_LOST',
    });
    await ports.stopSession({ taskId, runId: input.runId, mode: 'kill', reason: '收尾' }, ctx());
  });

  it('进程起不来：明确报 SPAWN_FAILED（不可重试：原因原样交工作流），库里这一行记上结局', async () => {
    const { ports, fake } = setup(() => ({ spawnError: 'spawn /opt/fake/reclaude ENOENT' }));
    const input = launch();
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
      retryable: false,
      message: expect.stringContaining('ENOENT'),
    });
    expect(await getSessionRun(t.db, input.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_FAILED',
    });
    // 同一个 runId 再起一次（活动原地重试就是这样）：库里已经记了结局，明确报已经结束过、不再起进程——
    // 所以 SPAWN_FAILED 不能标可重试，不然真原因被这一句盖掉；换新 runId 重起是工作流的事
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'SESSION_ENDED',
      retryable: false,
    });
    expect(fake.specs).toHaveLength(1);
  });

  it('进程起来了、库里却没这一行（开工记不上）：停掉会话、收掉 scope，明确报 SESSION_RECORD_MISSING，不当成起好了', async () => {
    const { ports, fake, scope } = setup(() => ({
      // 起来之前这一行没了（被删、库回滚……）：进程号和 scope 记不下，工人重启后就收不掉它
      beforeSpawn: async () => {
        await t.db.delete(sessionRuns);
      },
      act: async ({ signal }) => untilAborted(signal),
    }));
    const input = launch();
    const err = await ports.startSession(input, ctx()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SESSION_RECORD_MISSING', retryable: false });
    expect((err as Error).message).toContain('已经停掉');
    // 插头被叫停、scope 按编号收了：不留一个库里查不到的会话在跑
    expect(fake.options[0]?.signal?.aborted).toBe(true);
    expect(scope.calls().some((c) => c.action === 'stop' && c.args.includes(input.runId))).toBe(true);
    expect(fake.count()).toBe(1);
  });

  it('进程起来了、开工写库时库报错：一样停掉会话、收掉 scope，报 SESSION_RECORD_FAILED（可重试），不留孤儿', async () => {
    // 只拦「记开工」那一句（它改 handle）：库连不上、写超时之类
    await t.client.exec(`
      create function sessions_test_refuse() returns trigger language plpgsql as $$
      begin raise exception 'sessions_test_refuse'; end $$;
      create trigger sessions_test_refuse before update of handle on session_runs
        for each row execute function sessions_test_refuse();
    `);
    try {
      const { ports, fake, scope } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
      const input = launch();
      const err = await ports.startSession(input, ctx()).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'SESSION_RECORD_FAILED', retryable: true });
      expect((err as Error).message).toContain('已经停掉');
      expect(fake.options[0]?.signal?.aborted).toBe(true);
      expect(scope.calls().some((c) => c.action === 'stop' && c.args.includes(input.runId))).toBe(true);
      // 库里这一行还是没记开工的样子：重试照常从头起，不会被当成「上一个工人起过」
      expect((await getSessionRun(t.db, input.runId))?.startedAt ?? null).toBeNull();
    } finally {
      await t.client.exec(
        'drop trigger sessions_test_refuse on session_runs; drop function sessions_test_refuse();',
      );
    }
  });

  it('进程迟迟起不来：到点明确报 SPAWN_TIMEOUT（不可重试），叫停它，库里这一行记上结局', async () => {
    const { ports } = setup(() => ({ hangBeforeSpawn: true }), { spawnTimeoutMs: 200 });
    const input = launch();
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'SPAWN_TIMEOUT',
      retryable: false,
    });
    expect(await getSessionRun(t.db, input.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_TIMEOUT',
    });
  });

  it('路由的执行方式没接上、账号池没定会话用户、任务不在：起之前明确拒', async () => {
    const { ports, fake } = setup(() => ({}));
    await expect(
      ports.startSession(
        launch({
          route: {
            routeId: 'luna',
            poolId: 'relay',
            modelId: 'gpt-5.6-luna',
            family: 'gpt',
            hostId: 'codex',
          },
        }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: 'HOST_NOT_WIRED',
      retryable: false,
      message: expect.stringContaining('现在接了 Claude Code、Cursor Agent'),
    });
    await t.client.query("update pools set run_as_user = null, org_kind = null where id = 'claude-solo'");
    await expect(ports.startSession(launch(), ctx())).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    await t.client.query(
      "update pools set run_as_user = 'fleet-agent-carpool', org_kind = 'carpool' where id = 'claude-solo'",
    );
    await expect(ports.startSession(launch({ taskId: randomUUID() }), ctx())).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect(fake.count()).toBe(0);
  });

  it('资源上限不是非负整数（小数、负数、不是数）：起之前明确拒，不悄悄取整，库里不留这一行', async () => {
    const { ports, fake } = setup(() => ({}));
    for (const resources of [
      { memoryHighMb: 1536.5, memoryMaxMb: 2048, swapMaxMb: 0 },
      { memoryHighMb: 1536, memoryMaxMb: -1, swapMaxMb: 0 },
      { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: Number.NaN },
    ]) {
      const input = launch({ resources });
      await expect(ports.startSession(input, ctx()), JSON.stringify(resources)).rejects.toMatchObject({
        code: 'BAD_INPUT',
        retryable: false,
      });
      expect(await getSessionRun(t.db, input.runId)).toBeNull();
    }
    expect(fake.count()).toBe(0);
  });

  it('交给插头的上限帮手认得：交换区上限 0 写「0」，写成「0M」帮手会拒、会话起不来（法国 2026-09-26 实测）', async () => {
    const { ports, fake } = setup(commitAndDone());
    const input = launch({ resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 } });
    const started = await ports.startSession(input, ctx());
    expect(started.handle).toMatchObject({ pid: 4242 });
    const cgroup = fake.specs[0]?.cgroup;
    expect(cgroup?.limits).toEqual({ memoryHigh: '1536M', memoryMax: '2048M', memorySwapMax: '0' });
    // 和真插头同一道校验：不抛就是帮手认得
    expect(() => scopePrefix(cgroup as NonNullable<typeof cgroup>, '/fleet-test-cwd')).not.toThrow();
    await ports.stopSession({ taskId, runId: input.runId, mode: 'kill', reason: '收尾' }, ctx());
  });
});

describe('Fusion 的 Lead：在这张单的工作树里跑，按这一步读结论文件', () => {
  const DOCS = {
    requirement: 'specs/12-login/需求.md',
    plan: 'specs/12-login/方案.md',
    result: 'specs/12-login/结果.md',
  };
  const BRIEF = {
    goal: '加验证码',
    scope: '只改登录',
    constraints: [],
    files: ['src/login/'],
    acceptance: ['五分钟过期'],
    returnFormat: '改了什么',
  };
  const freshTree = () => layout(join(root, `w-${randomUUID().slice(0, 8)}`)).treeFor(repo, BRANCH);
  const leadLaunch = (step: LeadStep, over: Partial<LaunchSessionInput> = {}): LaunchSessionInput => {
    const base = launch({ stage: step === 'takeover' ? 'execute' : 'plan', ...over });
    return {
      ...base,
      brief: { ...base.brief, specDir: 'specs/12-login', lead: { step, mode: 'fusion', docs: DOCS } },
    };
  };
  const writeOut = (cwd: string, file: string, value: unknown) => {
    mkdirSync(join(cwd, '.fleet-out'), { recursive: true });
    writeFileSync(join(cwd, '.fleet-out', file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const commitDoc = (cwd: string, path: string) => {
    mkdirSync(join(cwd, 'specs', '12-login'), { recursive: true });
    writeFileSync(join(cwd, path), '# 写好了\n');
    git(cwd, 'add', '--', 'specs');
    git(cwd, 'commit', '-q', '-m', `docs: ${path}`);
  };

  it('写方案：在新工作树上起（检出这张单的分支）；方案提交进分支，头和改到的文件从提交里读；结论文件不会被提交', async () => {
    const { ports, fake } = setup(() => ({
      act: ({ spec }) => {
        commitDoc(spec.cwd, DOCS.plan);
        writeOut(spec.cwd, 'lead-plan.json', {
          summary: '加验证码',
          brief: BRIEF,
          small: true,
          highRisk: false,
          holds: [],
        });
      },
    }));
    const input = leadLaunch('plan');
    const { end } = await runOnce(ports, input);
    const dir = input.worktreePath as string;
    expect(end).toMatchObject({
      outcome: 'done',
      output: {
        kind: 'lead-plan',
        head: git(dir, 'rev-parse', 'HEAD'),
        changedFiles: [DOCS.plan],
        summary: '加验证码',
        brief: BRIEF,
        small: true,
        highRisk: false,
        holds: [],
      },
    });
    expect(fake.specs[0]?.cwd).toBe(dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(fake.specs[0]?.prompt).toContain(DOCS.requirement);
    // 结论文件在工作树里、进了这棵树自己的忽略清单：git add 带不走，看改动时也看不到
    expect(git(dir, 'check-ignore', '.fleet-out/lead-plan.json')).toBe('.fleet-out/lead-plan.json');
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all', '--', '.fleet-out')).toBe('');
  });

  it('最终审查：结果.md 提交进分支，交回过了、做了什么，头和改到的文件从提交里读', async () => {
    const { ports } = setup(() => ({
      act: ({ spec }) => {
        commitDoc(spec.cwd, DOCS.result);
        writeOut(spec.cwd, 'lead-review.json', {
          verdict: 'pass',
          why: '都做到了',
          did: ['加了验证码'],
          owed: [],
        });
      },
    }));
    const input = leadLaunch('review', { worktreePath: freshTree() });
    const { end } = await runOnce(ports, input);
    expect(end).toMatchObject({
      outcome: 'done',
      output: {
        kind: 'lead-review',
        verdict: 'pass',
        did: ['加了验证码'],
        changedFiles: [DOCS.result],
        head: git(input.worktreePath as string, 'rev-parse', 'HEAD'),
      },
    });
  });

  it('【故意造出的失败】最终审查前 Lead 并了主线（主线上别人改了页面代码）再提交结果.md：改到的文件只有结果.md（#293）', async () => {
    const UI = 'deploy/web/health/health.js';
    mkdirSync(join(m.dir, 'deploy', 'web', 'health'), { recursive: true });
    writeFileSync(join(m.dir, UI), 'export const h = 2;\n');
    git(m.dir, 'add', '--', UI);
    git(m.dir, 'commit', '-q', '-m', 'main: 健康页');
    const { ports } = setup(() => ({
      act: ({ spec }) => {
        // 新主线由引擎取进树里、钉成 origin/main（推之前并主线那一步），Lead 照着 git merge
        git(spec.cwd, 'fetch', '-q', m.dir, '+refs/heads/main:refs/remotes/origin/main');
        git(spec.cwd, 'merge', '--no-ff', '--no-edit', '-q', 'origin/main');
        commitDoc(spec.cwd, DOCS.result);
        writeOut(spec.cwd, 'lead-review.json', {
          verdict: 'pass',
          why: '都做到了',
          did: ['加了验证码'],
          owed: [],
        });
      },
    }));
    const input = leadLaunch('review', { worktreePath: freshTree() });
    const { end } = await runOnce(ports, input);
    expect(git(input.worktreePath as string, 'diff', '--name-only', m.head, 'HEAD').split('\n')).toContain(
      UI,
    );
    expect(end).toMatchObject({
      outcome: 'done',
      output: { kind: 'lead-review', changedFiles: [DOCS.result] },
    });
  });

  it('【故意造出的失败】只看不改的一步提交了、没写结论文件、写方案却留着没提交的改动：都判交错了（wrong_output），写明哪里不对', async () => {
    const cases: [LeadStep, FakeRunScript, string][] = [
      [
        'accept',
        {
          act: ({ spec }) => {
            commitDoc(spec.cwd, DOCS.plan);
            writeOut(spec.cwd, 'lead-verdict.json', { verdict: 'accept', why: '看过了' });
          },
        },
        '这一步只看不改',
      ],
      ['accept', {}, '没写结论 .fleet-out/lead-verdict.json'],
      [
        'plan',
        {
          act: ({ spec }) => {
            writeFileSync(join(spec.cwd, 'README.md'), '# 改了没提交\n');
            writeOut(spec.cwd, 'lead-plan.json', {
              summary: '加验证码',
              brief: BRIEF,
              small: true,
              highRisk: false,
              holds: [],
            });
          },
        },
        '没提交的已跟踪改动',
      ],
      [
        'accept',
        { act: ({ spec }) => writeOut(spec.cwd, 'lead-verdict.json', { verdict: 'maybe', why: 'x' }) },
        'verdict 要是 accept 或 reject',
      ],
    ];
    for (const [step, script, why] of cases) {
      const { ports } = setup(() => script);
      const { end } = await runOnce(ports, leadLaunch(step, { worktreePath: freshTree() }));
      expect(end.outcome).toBe('failed');
      expect(end.failure).toMatchObject({ code: 'wrong_output', message: expect.stringContaining(why) });
    }
  });

  it('【故意造出的失败】续同一个会话时，以前同一步留下的结论文件起之前先删掉：这一轮没写就是没写，不拿上一轮的顶', async () => {
    const { ports } = setup((_spec, n) =>
      n === 1
        ? { act: ({ spec }) => writeOut(spec.cwd, 'lead-verdict.json', { verdict: 'accept', why: '看过了' }) }
        : {},
    );
    const first = leadLaunch('accept', { worktreePath: freshTree() });
    const one = await runOnce(ports, first);
    expect(one.end).toMatchObject({ outcome: 'done', output: { kind: 'lead-verdict', verdict: 'accept' } });
    const again = await runOnce(ports, { ...first, runId: randomUUID(), resumeSessionId: one.sessionId });
    expect(again.end.outcome).toBe('failed');
    expect(again.end.failure?.message).toContain('没写结论 .fleet-out/lead-verdict.json');
  });

  it('派给别家的（cursor 上的副手）：整份提示词先过卫生检查，查出真密钥不发、不起会话', async () => {
    const leak = ['ghp', 'Zt4wQ9mB2xKc7RvN1pLs8HdJ3fGy6TaEu5Vo'].join('_');
    const { routeId, poolId } = await addCursorRoute(t.db);
    const route = {
      routeId,
      poolId,
      modelId: 'cursor-auto',
      family: 'cursor',
      hostId: 'cursor-agent' as const,
    };
    const screened: string[] = [];
    const { ports, cursor } = setup(() => ({}), {
      cursor: () => ({ replay: 'cursor-edit-commit' }),
      screen: (repo, what, texts) => {
        screened.push(what);
        assertPublishable(repo, what, texts, repo);
      },
    });
    const input = launch({ route, worktreePath: freshTree() });
    const error = await ports
      .startSession({ ...input, brief: { ...input.brief, request: `别把 ${leak} 写进日志` } }, ctx())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MATERIAL_BLOCKED', retryable: false });
    expect(String((error as Error).message)).toContain('发给别家的交代没过卫生检查，没发给Cursor Agent');
    expect(String((error as Error).message)).not.toContain(leak);
    expect(screened).toEqual(['发给别家的交代']);
    expect(cursor.specs).toEqual([]);
  });
});

describe('收孤儿', () => {
  it('列出来的在册会话逐个收掉（已经停了的不算）；列不出来明确报错，不当成一个都没有', async () => {
    const { ports, scope } = setup(() => ({}));
    process.env.FAKE_SCOPE_LIST = `${randomUUID()} active\npush-x-g1 failed\nold-1 inactive\n`;
    expect(await ports.reapOrphanSessions()).toBe(2);
    expect(scope.calls().filter((c) => c.action === 'stop')).toHaveLength(2);
    process.env.FAKE_SCOPE_LIST_EXIT = '1';
    await expect(ports.reapOrphanSessions()).rejects.toThrow('查不了上一轮留下的会话');
  });
});

describe('会话自己的临时目录（TMPDIR）：插头一收场就删，删不掉明说', () => {
  const tmpOf = (runId: string) => layout(join(root, 'work')).tmpFor(runId);
  type Logged = { message: string; fields: Record<string, unknown> | undefined };
  const logger = () => {
    const logs: Logged[] = [];
    return {
      logs,
      log: (message: string, fields?: Record<string, unknown>) => logs.push({ message, fields }),
    };
  };

  it('失败、被叫停收场：看守交回之前临时目录已经删了（写码会话正常交活的见「写码会话」第一条）', async () => {
    const failing = setup(() => ({ exitCode: 1, result: null }));
    const failed = launch();
    const { end } = await runOnce(failing.ports, failed);
    expect(end.outcome).toBe('failed');
    expect(failing.trees.adopts.map((a) => a.dir)).toContain(tmpOf(failed.runId));
    expect(existsSync(tmpOf(failed.runId))).toBe(false);

    const hanging = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
    const stopped = launch();
    const started = await hanging.ports.startSession(stopped, ctx());
    expect(existsSync(tmpOf(stopped.runId))).toBe(true);
    await hanging.ports.stopSession({ taskId, runId: stopped.runId, mode: 'kill', reason: '叫停' }, ctx());
    const stoppedEnd = await hanging.ports.awaitSession(
      { taskId, runId: stopped.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(stoppedEnd.outcome).toBe('stopped');
    expect(existsSync(tmpOf(stopped.runId))).toBe(false);
  });

  it('进程没起来、迟迟起不来：临时目录照样删，不留给下次起来再清', async () => {
    const broken = setup(() => ({ spawnError: 'spawn /opt/fake/reclaude ENOENT' }));
    const input = launch();
    await expect(broken.ports.startSession(input, ctx())).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
    expect(broken.trees.adopts.map((a) => a.dir)).toContain(tmpOf(input.runId));
    await vi.waitFor(() => expect(broken.trees.removes).toContain(tmpOf(input.runId)));
    expect(existsSync(tmpOf(input.runId))).toBe(false);

    const slow = setup(() => ({ hangBeforeSpawn: true }), { spawnTimeoutMs: 200 });
    const late = launch();
    await expect(slow.ports.startSession(late, ctx())).rejects.toMatchObject({ code: 'SPAWN_TIMEOUT' });
    await vi.waitFor(() => expect(slow.trees.removes).toContain(tmpOf(late.runId)));
    expect(existsSync(tmpOf(late.runId))).toBe(false);
  });

  it('工人重启过：看守接不上时收掉旧会话、删它的临时目录；叫停不在这个进程里的会话，收掉 scope 后删', async () => {
    const { ports } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
    const lost = launch();
    const started = await ports.startSession(lost, ctx());
    expect(existsSync(tmpOf(lost.runId))).toBe(true);
    const restarted = setup(() => ({}));
    const end = await restarted.ports.awaitSession(
      {
        taskId,
        runId: lost.runId,
        sessionId: started.sessionId,
        stage: 'execute',
        ...(started.handle ? { handle: started.handle } : {}),
      },
      ctx(),
    );
    expect(end.failure?.code).toBe('SESSION_LOST');
    expect(restarted.trees.removes).toContain(tmpOf(lost.runId));
    expect(existsSync(tmpOf(lost.runId))).toBe(false);

    const orphan = launch();
    await ports.startSession(orphan, ctx());
    expect(existsSync(tmpOf(orphan.runId))).toBe(true);
    const other = setup(() => ({}));
    await other.ports.stopSession(
      { taskId, runId: orphan.runId, mode: 'kill', reason: '换了工人叫停' },
      ctx(),
    );
    expect(other.scope.calls().some((c) => c.action === 'stop' && c.args.includes(orphan.runId))).toBe(true);
    expect(existsSync(tmpOf(orphan.runId))).toBe(false);

    for (const input of [lost, orphan]) {
      await ports.stopSession({ taskId, runId: input.runId, mode: 'kill', reason: '收尾' }, ctx());
    }
  });

  it('【故意造出的失败】临时目录删不掉：会话的结局照常交回，日志里明说没删掉、是哪个目录，不当成删好了', async () => {
    const { logs, log } = logger();
    const { ports, trees } = setup(commitAndDone(), { log });
    const input = launch();
    trees.fail.remove.add(tmpOf(input.runId));
    const { end } = await runOnce(ports, input);
    expect(end.outcome).toBe('done');
    expect(existsSync(tmpOf(input.runId))).toBe(true);
    const said = logs.find((l) => l.message.includes('会话的临时目录没删掉'));
    expect(said?.fields).toMatchObject({
      runId: input.runId,
      dir: tmpOf(input.runId),
      error: expect.stringContaining('删不掉'),
    });
  });

  it('工人起来时清掉上一轮留下的临时目录，这个进程里在跑的不碰；【故意造出的失败】删不掉、列不出来都明说没清成，不挡工人接活', async () => {
    const { logs, log } = logger();
    const { ports, trees } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }), { log });
    const left = [randomUUID(), randomUUID()].map(tmpOf);
    for (const dir of left) {
      mkdirSync(join(dir, 'ssr'), { recursive: true });
      writeFileSync(join(dir, 'ssr', 'cache'), 'x');
    }
    const running = launch();
    await ports.startSession(running, ctx());
    expect(await ports.reapOrphanSessions()).toBe(0);
    for (const dir of left) expect(existsSync(dir)).toBe(false);
    expect(existsSync(tmpOf(running.runId))).toBe(true);
    expect(logs.map((l) => l.message)).toContain('删掉上一轮会话留下的临时目录 2 个');

    const stuck = tmpOf(randomUUID());
    mkdirSync(stuck, { recursive: true });
    trees.fail.remove.add(stuck);
    expect(await ports.reapOrphanSessions()).toBe(0);
    expect(existsSync(stuck)).toBe(true);
    const notRemoved = logs.find((l) => l.message.includes('有 1 个没删掉'));
    expect(notRemoved?.fields?.failed).toEqual([expect.stringContaining(stuck)]);

    trees.fail.list = true;
    expect(await ports.reapOrphanSessions()).toBe(0);
    const unlisted = logs.find((l) => l.message.includes('没清成：列不出来'));
    expect(unlisted?.fields?.error).toContain('列不出会话临时目录');

    await ports.stopSession({ taskId, runId: running.runId, mode: 'kill', reason: '收尾' }, ctx());
  });
});

describe('Jev（判断题）：只在看守活动里问', () => {
  /** 记下每一问的假 Jev；answer 抛错、永不返回都照原样。 */
  function fakeJev(answer: (q: JevQuestion) => JevReply | Promise<JevReply>) {
    const asked: { question: JevQuestion; ctx: JevAskContext | undefined }[] = [];
    const port: JevPort = {
      async ask(question, ctx) {
        asked.push({ question, ctx });
        return (await answer(question)) as never;
      },
    };
    return { port, asked };
  }
  /** 执行体报错收场，原文是规则表里没有的一句。 */
  const oddFailure = (): FakeRunScript => ({
    result: { isError: true, terminalReason: 'api_error', text: '上游回了一句谁也没见过的话 zq-17' },
    exitCode: 1,
  });
  const shadowSwap: JevReply = {
    asked: true,
    ok: true,
    choice: 'swapRoute',
    confidence: 0.9,
    shadow: true,
    modelVersion: 'jev-1.13.0',
  };

  it('规则认不出的失败：问一次（带上是哪次会话、哪个任务的哪一步），回答随结局交给工作流；只记不拦的不改路由的账', async () => {
    const jev = fakeJev(() => shadowSwap);
    const { ports } = setup(oddFailure, { jev: jev.port });
    const input = launch();
    const { end } = await runOnce(ports, input);
    expect(end.outcome).toBe('failed');
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0]?.question.questionId).toBe('failure-triage');
    expect(jev.asked[0]?.question.sample).toContain('zq-17');
    expect(jev.asked[0]?.ctx).toEqual({
      subject: `run:${input.runId}`,
      about: `任务 ${taskId} 的 execute 阶段（会话失败）`,
    });
    expect(end.failure?.jev).toEqual(shadowSwap);
    // 认不出的失败照旧算这条路由的账（问没问 Jev 都一样）。
    expect((await runRow(input.runId))?.routeOutcome).toBe('fail');
  });

  it('规则认得出的失败（设备被撤销）：不问，结局里也没有 Jev 的回答', async () => {
    const jev = fakeJev(() => {
      throw new Error('不该问');
    });
    const { ports } = setup(
      () => ({
        result: { isError: true, terminalReason: 'api_error', apiErrorStatus: 401, text: 'device_revoked' },
        apiError: { code: 'device_revoked', text: '401 device_revoked' },
        exitCode: 1,
      }),
      { jev: jev.port },
    );
    const { end } = await runOnce(ports, launch());
    expect(end.outcome).toBe('failed');
    expect(jev.asked).toHaveLength(0);
    expect(end.failure?.jev).toBeUndefined();
  });

  it('Jev 卡住、抛错：当没判出来，结局照常交回（带着没判出来的原因）', async () => {
    const hanging = fakeJev(() => new Promise<JevReply>(() => {}));
    const slow = setup(oddFailure, { jev: hanging.port, jevTimeoutMs: 50 });
    const a = await runOnce(slow.ports, launch());
    expect(a.end.outcome).toBe('failed');
    expect(a.end.failure?.jev).toEqual({ asked: true, ok: false, reason: '超过 50 毫秒没回' });

    const throwing = fakeJev(() => {
      throw new Error('连不上');
    });
    const broken = setup(oddFailure, { jev: throwing.port });
    const b = await runOnce(broken.ports, launch());
    expect(b.end.failure?.jev).toEqual({ asked: true, ok: false, reason: '调用出错：连不上' });
  });

  /** 有动静、没推进、看不出在重复（拿不准）：跑两条不同的命令，然后干等。 */
  const unsureStall = (until: (signal: AbortSignal) => Promise<void>) => (): FakeRunScript => ({
    act: async ({ emit, signal }) => {
      for (const [i, summary] of ['pnpm test', 'pnpm lint'].entries()) {
        emit('tool', { phase: 'start', toolUseId: `u${i}`, name: 'Bash', action: 'run', summary });
        emit('tool', { phase: 'end', toolUseId: `u${i}`, name: 'Bash', action: 'run', summary, ok: false });
      }
      await until(signal);
    },
  });
  const waitFor = async (cond: () => boolean, signal: AbortSignal, ms = 8000) => {
    const end = Date.now() + ms;
    while (!cond() && !signal.aborted && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  };

  it('停滞拿不准：问 Jev；只记不拦的「在绕圈」不停会话，同一个会话隔一阵才再问', async () => {
    const jev = fakeJev(() => ({ asked: true, ok: true, choice: 'looping', confidence: 0.9, shadow: true }));
    const { ports } = setup(
      unsureStall(async (signal) => {
        await waitFor(() => jev.asked.length > 0, signal);
        // 问过之后再多跑几轮停滞判断（每 30 毫秒一轮）：不该停、也不该再问。
        await new Promise((r) => setTimeout(r, 300));
      }),
      { jev: jev.port },
    );
    const input = launch();
    const { end } = await runOnce(ports, input);
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0]?.question.questionId).toBe('stall-predict');
    expect(jev.asked[0]?.ctx).toEqual({
      subject: `run:${input.runId}`,
      about: `任务 ${taskId} 的 execute 阶段（会话没推进）`,
    });
    expect(end.outcome).not.toBe('stalled');
  });

  it('停滞拿不准、Jev 在真拦且有把握判「在绕圈」：停掉会话，结局 stalled（规则 LJ）', async () => {
    const jev = fakeJev(() => ({ asked: true, ok: true, choice: 'looping', confidence: 0.9, shadow: false }));
    const { ports } = setup(
      unsureStall(async (signal) => {
        await Promise.race([untilAborted(signal), new Promise((r) => setTimeout(r, 10_000))]);
      }),
      { jev: jev.port },
    );
    const { end } = await runOnce(ports, launch());
    expect(end.outcome).toBe('stalled');
    expect(end.failure?.message).toMatch(/^LJ：/);
  });
});
