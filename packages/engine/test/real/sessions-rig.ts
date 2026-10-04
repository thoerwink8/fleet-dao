// sessions.*.test.ts 共用的夹具：内存库、镜像、假插头的装配（原来都在一个 2500 行的 sessions.test.ts 里，单文件 vitest 切不开，
// 它一个文件 78 秒、定死了 CI 里 engine 分片的墙钟，所以按话题拆成几个文件，各自 import 这里）。
// 改这里之前必须知道：t、root、m、taskId、repo 是 ES 模块的活绑定（let 导出），由下面的 beforeAll/beforeEach 赋值；
// 每个测试文件各有一份模块实例，钩子注册在 import 它的那个文件上，所以各文件之间互不串。
// 会话端口：起会话（建树、定接着干的方式、登记开工）、看守（进度写库、按进展判停滞、交活核实、读结论文件）、
// 叫停、收孤儿。用内存库、本地 git（顶替会话用户的执行器）、假插头（不起真执行体）；每条失败路径都故意造一次。
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCursorAgent } from '@fleet-dao/adapters';
import { appendProgressEvents, sessionRuns } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';

import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { JevPort } from '../../src/failure/jev.ts';
import type { LaunchSessionInput, PortContext, SessionEnd } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';

import { createSessionPorts, type SessionPortsDeps } from '../../src/real/sessions.ts';

import { layout } from '../../src/real/worktrees.ts';
import {
  addTask,
  type CursorKeyRig,
  type FakeCursorScript,
  type FakeGrokScript,
  type FakeRunScript,
  fakeCursorRun,
  fakeGrokRun,
  fakeMirasimDeps,
  fakeRun,
  fakeScopeHelper,
  fakeTrees,
  git,
  mirror,
  NOW,
  world,
} from './fixtures.ts';

// 每条用例（和每条用例前建的镜像）都真跑好几次 git（Windows 上一次几百毫秒），机器忙时默认的 5 秒、10 秒不够。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

export let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

export let root: string;
export let m: ReturnType<typeof mirror>;
export let taskId: string;
export let repo: { owner: string; name: string };
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  const added = await addTask(t.db);
  taskId = added.task.id;
  repo = { owner: added.repo.owner, name: added.repo.name };
  root = mkdtempSync(join(tmpdir(), 'fleet-sessions-'));
  m = mirror(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['FAKE_SCOPE_LOG', 'FAKE_SCOPE_LIST', 'FAKE_SCOPE_LIST_EXIT', 'FAKE_SCOPE_STOP_EXIT']) {
    delete process.env[k];
  }
});

export const BRANCH = 'fleet/12-login';

export function ctx(): PortContext & { beats: number } {
  const c = { beats: 0 } as PortContext & { beats: number };
  return Object.assign(c, {
    signal: new AbortController().signal,
    heartbeat() {
      c.beats += 1;
    },
    attempt: 1,
    lastHeartbeat: undefined,
  });
}

export function setup(
  script: (spec: Parameters<ReturnType<typeof fakeRun>['run']>[0], n: number) => FakeRunScript,
  options: {
    spawnTimeoutMs?: number;
    gh?: typeof m.gh;
    jev?: JevPort;
    jevTimeoutMs?: number;
    stallJevEveryMs?: number;
    /** cursor-agent 路由起的会话走这个剧本（假插头照真跑夹具回放）；不给就是不该起 cursor。 */
    cursor?: (spec: Parameters<ReturnType<typeof fakeCursorRun>['run']>[0], n: number) => FakeCursorScript;
    /** 发给别家（开 PR 前验证）的材料怎么过卫生检查；不给就是没配检查。 */
    screen?: SessionPortsDeps['screen'];
    /** 端口的日志（删不掉临时目录这类只记日志的）；不给就不记。 */
    log?: SessionPortsDeps['log'];
    /** cursor 的会话用真插头、真起法（经假帮手真起进程，fixtures 的 cursorKeyRig），不用假插头。 */
    realCursor?: CursorKeyRig;
    /** grok 路由起的会话走这个剧本（假插头照真跑夹具回放）；不给就是不该起 grok。 */
    grok?: (spec: Parameters<ReturnType<typeof fakeGrokRun>['run']>[0], n: number) => FakeGrokScript;
  } = {},
) {
  const fake = fakeRun(script);
  const cursor = fakeCursorRun(
    options.cursor ??
      (() => {
        throw new Error('这条用例不该起 cursor-agent');
      }),
  );
  const grok = fakeGrokRun(
    options.grok ??
      (() => {
        throw new Error('这条用例不该起 grok');
      }),
  );
  const trees = fakeTrees(join(root, 'work'));
  const scope = fakeScopeHelper(root);
  const rig = options.realCursor;
  const logs: string[] = [];
  const ports = createSessionPorts({
    db: t.db,
    trees: trees.trees,
    exec: localExec(),
    gh: options.gh ?? m.gh,
    tmpDir: join(root, 'tmp'),
    machine: '法国',
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    cursorCommand: rig ? rig.command : (user) => [`/opt/fake/${user}/cursor-agent`],
    grokCommand: (user) => [`/opt/fake/${user}/grok`],
    ...fakeMirasimDeps(),
    helper: rig ? rig.helper : scope.helper,
    sudo: rig ? rig.sudo : scope.sudo,
    gitBin: 'git',
    shBin: 'sh',
    run: { 'claude-code': fake.run, 'cursor-agent': rig ? runCursorAgent : cursor.run, grok: grok.run },
    tickMs: 10,
    stallCheckMs: 30,
    flushMs: 5,
    spawnTimeoutMs: options.spawnTimeoutMs ?? 5000,
    stallPolicy: { noProgressSeconds: 1 },
    ...(options.jev ? { jev: options.jev } : {}),
    ...(options.jevTimeoutMs === undefined ? {} : { jevTimeoutMs: options.jevTimeoutMs }),
    ...(options.stallJevEveryMs === undefined ? {} : { stallJevEveryMs: options.stallJevEveryMs }),
    // 派给别家（cursor、grok）的整份提示词都要先过卫生检查：起它们的用例没给检查就放一个都放行的（查出来拦下的另有用例）
    ...(options.screen
      ? { screen: options.screen }
      : options.cursor || options.grok || rig
        ? { screen: () => {} }
        : {}),
    log: (message, fields) => {
      if (rig) logs.push(JSON.stringify([message, fields]));
      options.log?.(message, fields);
    },
  });
  return { ports, fake, cursor, grok, trees, scope, logs };
}

export function launch(over: Partial<LaunchSessionInput> = {}): LaunchSessionInput {
  return {
    taskId,
    subtaskKey: 'login',
    runId: randomUUID(),
    stage: 'execute',
    route: {
      routeId: 'solo',
      poolId: 'claude-solo',
      modelId: 'opus-5.5',
      family: 'claude',
      hostId: 'claude-code',
    },
    whyRoute: '测试',
    queuedAt: NOW.toISOString(),
    brief: {
      title: '登录页加验证码',
      request: '加一个手机验证码',
      acceptance: ['能收到验证码'],
      touches: ['src'],
      feedback: [],
      answers: [],
      branch: BRANCH,
    },
    worktreePath: layout(join(root, 'work')).treeFor(repo, BRANCH),
    baseHead: m.head,
    stallSeconds: 360,
    sessionMinutes: 90,
    resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 },
    launch: { fleetApi: 'http://127.0.0.1:8788', fleetToken: 'tok', pathPrepend: ['/opt/fleet/cli/bin'] },
    ...over,
  };
}

/** 会话干完活：提交一个文件、跑一次测试（插头报 test 事件）、fleet done（后端写 done 进度）。 */
export const commitAndDone =
  (
    options: {
      dirty?: boolean;
      noCommit?: boolean;
      noDone?: boolean;
      cost?: number;
      contextTokens?: number;
    } = {},
  ) =>
  (): FakeRunScript => ({
    ...(options.cost === undefined ? {} : { result: { sessionCostUsd: options.cost } }),
    ...(options.contextTokens === undefined ? {} : { lastContextTokens: options.contextTokens }),
    act: async ({ spec, emit }) => {
      if (!options.noCommit) {
        mkdirSync(join(spec.cwd, 'src'), { recursive: true });
        writeFileSync(
          join(spec.cwd, 'src', `login-${randomUUID().slice(0, 4)}.ts`),
          'export const code = 1;\n',
        );
        // 只加这一个目录：Windows 上引擎这边的 git 检出时会换行尾，git add . 会把别的文件也带上。
        git(spec.cwd, 'add', '--', 'src');
        git(spec.cwd, 'commit', '-q', '-m', 'feat: 登录页加验证码');
      }
      if (options.dirty) writeFileSync(join(spec.cwd, 'README.md'), '# 改了没提交\n');
      emit('tool', { phase: 'start', toolUseId: 'u1', name: 'Bash', action: 'run', summary: 'pnpm check' });
      emit('test', { command: 'pnpm check', passed: true });
      emit('tool', {
        phase: 'end',
        toolUseId: 'u1',
        name: 'Bash',
        action: 'run',
        summary: 'pnpm check',
        ok: true,
      });
      if (!options.noDone) {
        await appendProgressEvents(t.db, spec.runId, [
          { at: new Date(), kind: 'done', payload: { summary: '做完了', testsPassed: true } },
        ]);
      }
    },
  });

export async function runOnce(
  ports: ReturnType<typeof setup>['ports'],
  input: LaunchSessionInput,
): Promise<{ sessionId: string; end: SessionEnd }> {
  const started = await ports.startSession(input, ctx());
  const end = await ports.awaitSession(
    { taskId, runId: input.runId, sessionId: started.sessionId, stage: input.stage },
    ctx(),
  );
  return { sessionId: started.sessionId, end };
}

export const runRow = async (id: string) => (await t.db.select().from(sessionRuns)).find((r) => r.id === id);
