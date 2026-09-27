// 发布不碰会话（会话脱开引擎进程，real/session-io.ts、adapters 的 detached.ts）全程：真库（PGlite）、真会话端口、真的 Claude 插头
// 起一个假执行体（照法国真跑的过程记录回放，停在半路等测试放行）。引擎 A 起会话 → A 停机放手（不停会话）→ 引擎 B 起来，
// 收孤儿时留着它 → B 的看守接回：确认过的进度不重写、之后的照常写，会话接着干完，结局收得到。
// 故意造出的失败：接回记录没了（SESSION_LOST）、外壳被强杀没留退出码（exit_lost，EN1 续会话）、引擎不在时叫停了（收孤儿收掉）。
// 外壳是 /bin/sh，按进程组收：只在 Linux、macOS 上跑（CI 是 Linux）。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IO_FILES, runClaudeCode } from '@fleet-dao/adapters';
import { appendProgressEvents, getSessionRun, progressEvents, requestSessionStop } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextAction } from '../../src/decisions/failure.ts';
import { DEFAULT_LIMITS } from '../../src/limits.ts';
import type { LaunchSessionInput, PortContext, RouteChoice } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { META_FILE } from '../../src/real/session-io.ts';
import { confirmedSeq, createSessionPorts } from '../../src/real/sessions.ts';
import { createStorePorts } from '../../src/real/store-ports.ts';
import { layout } from '../../src/real/worktrees.ts';
import {
  addTask,
  fakeMirasimDeps,
  fakeScopeHelper,
  fakeTrees,
  git,
  mirror,
  NOW,
  orgListRig,
  world,
} from './fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const onPosix = process.platform !== 'win32';
const FIXTURE = fileURLToPath(
  new URL('../../../adapters/test/fixtures/claude-code/cc-haiku-edit.ndjson', import.meta.url),
);
/** 回放到第 7 行（前面有工具调用的事件）停住，等测试放行。 */
const HOLD_AT = 7;
const KINDS = ['file', 'say', 'tool', 'tool', 'tool', 'tool'];

// 假执行体：读完提示词，照过程记录回放；会话号、模型换成插头点名的（不然插头当成会话、模型对不上停掉）
const AGENT = `
import { existsSync, readFileSync } from 'node:fs';
const [fixture, go, hold] = process.argv.slice(2, 5);
const args = process.argv.slice(5);
const sid = args[args.indexOf('--session-id') + 1];
const model = args[args.indexOf('--model') + 1];
for await (const _ of process.stdin) {}
const lines = readFileSync(fixture, 'utf8').split('\\n').filter((l) => l.trim());
let i = 0;
for (const line of lines) {
  if (i === Number(hold)) while (!existsSync(go)) await new Promise((r) => setTimeout(r, 20));
  const f = JSON.parse(line);
  if ('session_id' in f) f.session_id = sid;
  if (f.message && f.message.model) f.message.model = model;
  if (f.type === 'system' && f.subtype === 'init') { f.model = model; f.cwd = process.cwd(); }
  if (f.modelUsage) f.modelUsage = Object.fromEntries(Object.values(f.modelUsage).map((v) => [model, v]));
  process.stdout.write(JSON.stringify(f) + '\\n');
  i++;
}
`;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
let m: ReturnType<typeof mirror>;
const groups: number[] = [];
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  root = mkdtempSync(join(tmpdir(), 'fleet-detach-'));
  m = mirror(root);
  writeFileSync(join(root, 'agent.mjs'), AGENT);
  process.env.FAKE_SCOPE_LIST = '';
});
afterEach(() => {
  // 测试里的会话没进 scope：按外壳的进程组收掉留下的
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 已经没了
    }
  }
  delete process.env.FAKE_SCOPE_LIST;
  rmSync(root, { recursive: true, force: true });
});

const ctx = (signal = new AbortController().signal): PortContext => ({
  signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
});

/** 一个引擎（A、B 共用同一个库、同一个工作树的根、同一个收发目录的根）。 */
function engine(logs: string[] = []) {
  const scope = fakeScopeHelper(root);
  const sessions = createSessionPorts({
    db: t.db,
    trees: fakeTrees(join(root, 'work')).trees,
    exec: localExec(),
    gh: m.gh,
    tmpDir: join(root, 'tmp'),
    machine: '法国',
    claudeCommand: () => [
      process.execPath,
      join(root, 'agent.mjs'),
      FIXTURE,
      join(root, 'go'),
      String(HOLD_AT),
    ],
    cursorCommand: (user) => [`/opt/fake/${user}/cursor-agent`],
    grokCommand: (user) => [`/opt/fake/${user}/grok`],
    ...fakeMirasimDeps(),
    helper: scope.helper,
    sudo: scope.sudo,
    gitBin: 'git',
    shBin: 'sh',
    // 真的 Claude 插头，只是不进 scope（测试机上没有 systemd 帮手）：按外壳的进程组收
    run: {
      'claude-code': (spec, opts) => {
        const { cgroup: _scope, ...plain } = spec;
        return runClaudeCode(plain, opts);
      },
    },
    ioRoot: join(root, 'io'),
    tickMs: 10,
    stallCheckMs: 60_000,
    flushMs: 5,
    spawnTimeoutMs: 10_000,
    killEvidence: {
      readText: async () => {
        throw new Error('测试里没有 cgroup');
      },
      releaseLockBusy: async () => undefined,
      cgroupRoot: '/nope',
      slicePath: 'fleet.slice/fleet-agents.slice',
      releasesDir: '/nope',
    },
    log: (message) => logs.push(message),
  });
  return { sessions, scope, logs };
}

async function launchInput(): Promise<LaunchSessionInput> {
  const rig = orgListRig();
  rig.answer('carpool');
  const store = createStorePorts({
    db: t.db,
    now: () => NOW,
    draw: () => 0.5,
    log: () => {},
    sessionOrg: rig.reader({ ttlMs: 30_000, now: () => NOW }),
  });
  const { task, repo } = await addTask(t.db);
  const branch = `fleet/${task.issueNumber}-${randomUUID().slice(0, 6)}`;
  const r = await store.pickRoute(
    { taskId: task.id, stage: 'execute', avoidRouteIds: [], avoidPoolIds: [], avoidModelIds: [] },
    ctx(),
  );
  if (!r.ok) throw new Error(`选路没派出去：${r.detail}`);
  const route: RouteChoice = r.route;
  return {
    taskId: task.id,
    subtaskKey: 'login',
    runId: randomUUID(),
    stage: 'execute',
    route,
    whyRoute: '测试',
    queuedAt: NOW.toISOString(),
    brief: {
      title: '登录页加验证码',
      request: '加一个手机验证码',
      acceptance: ['能收到验证码'],
      touches: ['src'],
      feedback: [],
      answers: [],
      branch,
    },
    worktreePath: layout(join(root, 'work')).treeFor({ owner: repo.owner, name: repo.name }, branch),
    baseHead: m.head,
    stallSeconds: 360,
    sessionMinutes: 90,
    resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 },
    launch: { fleetApi: 'http://127.0.0.1:8788', fleetToken: 'tok', pathPrepend: ['/opt/fleet/cli/bin'] },
  };
}

async function until(check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等不到');
}

const ioDir = (runId: string) => join(root, 'io', runId);
const outLines = (runId: string) => {
  const file = join(ioDir(runId), IO_FILES.out);
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim()).length
    : 0;
};
const wrapperPid = (runId: string) => Number(readFileSync(join(ioDir(runId), IO_FILES.pid), 'utf8').trim());

/** 引擎 A 起会话，看守挂上，跑到停住的那一行、进度确认进库；然后 A 停机：放手、看守随旧进程断了。 */
async function startThenStopEngineA(input: LaunchSessionInput) {
  const a = engine();
  const started = await a.sessions.startSession(input, ctx());
  const watching = new AbortController();
  const awaitA = a.sessions
    .awaitSession(
      { taskId: input.taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(watching.signal),
    )
    .then(
      () => 'returned',
      () => 'cancelled',
    );
  await until(() => outLines(input.runId) === HOLD_AT);
  groups.push(wrapperPid(input.runId));
  // 停住之前最后一条带事件的是第 6 行（序号 6）：确认到它，A 手上就没有在写的了（真停机时旧进程已经没了，不会和新引擎抢着写）
  await until(async () => ((await getSessionRun(t.db, input.runId))?.outputSeq ?? -1) === 6);
  expect(a.sessions.releaseDetached()).toEqual([input.runId]);
  watching.abort(new Error('工人停下'));
  expect(await awaitA).toBe('cancelled');
  return started;
}

/** 会话在工作树里交活：提交一个文件、fleet done（会话里这两样是执行体做的，这里测试代劳）。 */
async function deliver(input: LaunchSessionInput): Promise<string> {
  const dir = input.worktreePath as string;
  writeFileSync(join(dir, `x-${randomUUID().slice(0, 4)}.ts`), 'export const x = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'feat: 接着干完');
  await appendProgressEvents(t.db, input.runId, [
    { at: new Date(), kind: 'done', payload: { summary: '做完了', testsPassed: true } },
  ]);
  return git(dir, 'rev-parse', 'HEAD');
}

async function kindsWritten(runId: string): Promise<string[]> {
  return (await t.db.select().from(progressEvents))
    .filter((r) => r.runId === runId && r.kind !== 'done')
    .map((r) => r.kind)
    .sort();
}

describe('进度确认到哪一行（confirmedSeq）', () => {
  it('批里最大的序号；一行的事件被切在两批里时只确认到上一行；没有序号不确认', () => {
    expect(confirmedSeq([{ seq: 1 }, { seq: 3 }], undefined)).toBe(3);
    expect(confirmedSeq([{ seq: 1 }, { seq: 3 }], 3)).toBe(2);
    expect(confirmedSeq([{ seq: 0 }], 0)).toBeUndefined();
    expect(confirmedSeq([{ seq: undefined }], undefined)).toBeUndefined();
  });
});

describe.skipIf(!onPosix)('发布不碰会话：引擎重启，会话接着跑、新引擎接回', () => {
  for (const when of ['still-running', 'finished-while-away'] as const) {
    it(`${when === 'still-running' ? '会话还在干活' : '会话在引擎不在时干完了'}：新引擎收孤儿时留着它，看守接回，进度不重写不漏写，结局收得到`, async () => {
      const input = await launchInput();
      const started = await startThenStopEngineA(input);
      const head = await deliver(input);

      if (when === 'finished-while-away') {
        writeFileSync(join(root, 'go'), '');
        await until(() => readFileSync(join(ioDir(input.runId), IO_FILES.exit), 'utf8').trim() !== '');
      } else {
        // scope 还在册（活着）
        process.env.FAKE_SCOPE_LIST = `${input.runId} active\n`;
      }

      const b = engine();
      expect(await b.sessions.reapOrphanSessions()).toBe(0);
      expect(b.scope.calls().filter((c) => c.action === 'stop')).toEqual([]);
      expect(b.logs.join('\n')).toContain(input.runId);
      expect(existsSync(join(ioDir(input.runId), META_FILE))).toBe(true);

      const ended = b.sessions.awaitSession(
        { taskId: input.taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
        ctx(),
      );
      if (when === 'still-running') writeFileSync(join(root, 'go'), '');
      const end = await ended;
      expect(end).toMatchObject({ outcome: 'done', output: { kind: 'delivery', head } });
      // 提示词只喂过一次（接回没重起会话）；进度从头到尾一份：A 确认过的没重写，A 没确认的、放手之后的都写了
      expect(await kindsWritten(input.runId)).toEqual(KINDS);
      const row = await getSessionRun(t.db, input.runId);
      expect(row?.endedAt).toBeTruthy();
      expect(row?.outputSeq).toBeGreaterThanOrEqual(HOLD_AT);
      // 收场后收发目录删掉
      expect(existsSync(ioDir(input.runId))).toBe(false);
    });
  }

  it('接回记录没了：接不回，按 SESSION_LOST 收掉旧会话、交回工作流续会话', async () => {
    const input = await launchInput();
    const started = await startThenStopEngineA(input);
    rmSync(join(ioDir(input.runId), META_FILE));
    const b = engine();
    const end = await b.sessions.awaitSession(
      { taskId: input.taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'SESSION_LOST', retryable: true } });
    expect(end.failure?.message).toContain('没有接回记录');
    expect((await getSessionRun(t.db, input.runId))?.failureCode).toBe('SESSION_LOST');
  });

  it('外壳被强杀、没留退出码（会话也没了）：接回照实判 exit_lost，失败分流 EN1 续会话，不当成成功或 0', async () => {
    const input = await launchInput();
    const started = await startThenStopEngineA(input);
    process.kill(-wrapperPid(input.runId), 'SIGKILL');
    const b = engine();
    const end = await b.sessions.awaitSession(
      { taskId: input.taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'exit_lost' } });
    expect(end.failure?.message).toContain('退出码');
    const next = nextAction({
      failure: {
        source: 'session:execute',
        code: end.failure?.code ?? '',
        message: end.failure?.message ?? '',
        retryable: null,
      },
      limits: DEFAULT_LIMITS,
      routeBound: true,
      context: {
        stage: 'execute',
        route: {
          routeId: input.route.routeId,
          poolId: input.route.poolId,
          modelId: input.route.modelId,
          hostId: input.route.hostId,
        },
        now: NOW.toISOString(),
      },
    });
    expect(next).toMatchObject({ action: 'retry', rule: 'EN1' });
  });

  it('引擎不在时叫停了：新引擎收孤儿时不留它，按编号收掉 scope、删收发目录', async () => {
    const input = await launchInput();
    await startThenStopEngineA(input);
    await requestSessionStop(t.db, { runId: input.runId, reason: '工作流收尾' });
    process.env.FAKE_SCOPE_LIST = `${input.runId} active\n`;
    const b = engine();
    expect(await b.sessions.reapOrphanSessions()).toBe(1);
    expect(b.scope.calls().filter((c) => c.action === 'stop')).toEqual([
      { action: 'stop', args: [input.runId] },
    ]);
    expect(b.logs.join('\n')).toContain('已经叫停');
    expect(existsSync(ioDir(input.runId))).toBe(false);
  });
});
