// 真端口测试共用的底子：内存库里的一份目录（两个 Claude 池：独享、拼车；一个没接上的执行方式）、一个需求，
// 一个本地 git「镜像」（顶替 github 包的 fetchMainline / bundleCommits），一个记属主的假工作树管家，
// 一个不起真执行体的假插头（按剧本发事件、改工作树、交报告）。
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ClaudeCodeRunOptions,
  ClaudeCodeRunReport,
  ClaudeCodeRunSpec,
  RateLimitReading,
  SessionUser,
} from '@fleet-dao/adapters';
import { type Db, pools, repos, routes, savePoolQuota, seed, stagePolicyRoutes, tasks } from '@fleet-dao/db';
import type { ProgressEvent, StageKind } from '@fleet-dao/shared';
import { layout, type WorkTrees } from '../../src/real/worktrees.ts';

export const NOW = new Date('2026-09-25T08:00:00.000Z');
export const MIN = 60_000;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
  GIT_CONFIG_NOSYSTEM: '1',
};
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

/**
 * 目录：两个 Claude 订阅池各一条 Claude Code 路由（同一个会话用户），一条 codex 路由（没接上）。两个池故意不标组织类型
 * （orgKind）：这里测一般的选路，会话用户挂哪个组织、哪个池才派的那一条在 store-ports.test.ts 里单测。
 */
export async function world(db: Db, options: { order?: string[]; stages?: StageKind[] } = {}) {
  await seed(db);
  await db.insert(pools).values([
    {
      id: 'claude-solo',
      channelId: 'claude-subscription',
      maxConcurrency: 3,
      runAsUser: 'fleet-agent-carpool',
    },
    {
      id: 'claude-carpool',
      channelId: 'claude-subscription',
      maxConcurrency: 3,
      runAsUser: 'fleet-agent-carpool',
    },
    { id: 'relay', channelId: 'mirasim-cloud', maxConcurrency: 3 },
  ]);
  await db.insert(routes).values([
    {
      id: 'solo',
      channelId: 'claude-subscription',
      poolId: 'claude-solo',
      modelId: 'opus-5.5',
      hostId: 'claude-code',
      alive: true,
      upstreamModel: 'claude-opus-5-5',
    },
    {
      id: 'carpool',
      channelId: 'claude-subscription',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      hostId: 'claude-code',
      alive: true,
      upstreamModel: 'claude-opus-5-5',
    },
    {
      id: 'luna',
      channelId: 'mirasim-cloud',
      poolId: 'relay',
      modelId: 'gpt-5.6-luna',
      hostId: 'codex',
      alive: true,
      upstreamModel: 'gpt-5.6-luna',
    },
  ]);
  const order = options.order ?? ['solo', 'carpool'];
  for (const stage of options.stages ?? (['execute', 'triage', 'review'] as StageKind[])) {
    await db
      .insert(stagePolicyRoutes)
      .values(order.map((routeId, position) => ({ stage, routeId, position, enabled: true })));
  }
  // 额度都读成了、都还宽：选路按人排的顺序走（额度未知的备池只放一个试探，别让它搅进来）。
  for (const poolId of ['claude-solo', 'claude-carpool', 'relay']) {
    await savePoolQuota(
      db,
      {
        poolId,
        readAt: new Date(NOW.getTime() - MIN).toISOString(),
        complete: true,
        windows: [
          {
            poolId,
            window: '5h',
            label: 'five_hour',
            unit: 'percent',
            utilization: 0.1,
            reading: 'measured',
            readAt: new Date(NOW.getTime() - MIN).toISOString(),
            source: 'test',
          },
          {
            poolId,
            window: '7d',
            label: 'seven_day',
            unit: 'percent',
            utilization: 0.1,
            reading: 'measured',
            readAt: new Date(NOW.getTime() - MIN).toISOString(),
            source: 'test',
          },
        ],
      },
      { now: NOW },
    );
  }
}

export async function addTask(db: Db, over: { testCommand?: string } = {}) {
  const [repo] = await db
    .insert(repos)
    .values({
      owner: 'acme',
      name: `widgets-${randomUUID().slice(0, 6)}`,
      testCommand: over.testCommand ?? 'pnpm check',
    })
    .returning();
  if (!repo) throw new Error('repo 没写进去');
  const [task] = await db
    .insert(tasks)
    .values({
      repoId: repo.id,
      issueNumber: 12,
      title: '登录页加验证码',
      rawRequest: '登录页加一个手机验证码',
      requestedBy: 'founder-a',
      priority: 10,
    })
    .returning();
  if (!task) throw new Error('task 没写进去');
  return { repo, task };
}

/** 引擎这边的「镜像」：主线两次提交；bundleCommits 和 github 包一样把 tip 挂在 refs/fleet/export/<序号> 上。 */
export function mirror(root: string) {
  const dir = join(root, 'mirror');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'second');
  const head = git(dir, 'rev-parse', 'HEAD');
  const calls: { tips: string[]; exclude: string[] }[] = [];
  let n = 0;
  return {
    dir,
    head,
    calls,
    gh: {
      async fetchMainline() {
        return { head: git(dir, 'rev-parse', 'refs/heads/main'), defaultBranch: 'main' };
      },
      async bundleCommits(input: { tips: string[]; exclude?: string[] | undefined; outPath: string }) {
        calls.push({ tips: input.tips, exclude: input.exclude ?? [] });
        n += 1;
        const ref = `refs/fleet/export/${n}`;
        git(dir, 'update-ref', ref, input.tips[0] as string);
        git(dir, 'bundle', 'create', input.outPath, ref, ...(input.exclude ?? []).map((e) => `^${e}`));
        git(dir, 'update-ref', '-d', ref);
        return {
          path: input.outPath,
          bytes: readFileSync(input.outPath).length,
          refs: [{ tip: input.tips[0] as string, ref }],
        };
      },
      async commitIdentity() {
        return { name: 'fleet-agent[bot]', email: '1+fleet-agent[bot]@users.noreply.github.com' };
      },
    },
  };
}

/** 假的工作树管家：目录真建在临时目录里，属主记在表里；adopt 记下每一次。 */
export function fakeTrees(root: string) {
  const owners = new Map<string, SessionUser>();
  const adopts: { dir: string; user: SessionUser }[] = [];
  const trees: WorkTrees = {
    ...layout(root),
    async ownerOf(dir) {
      return owners.get(dir) ?? null;
    },
    async adopt(dir, user) {
      adopts.push({ dir, user });
      mkdirSync(dir, { recursive: true });
      owners.set(dir, user);
    },
    async remove(dir) {
      const gone = !owners.has(dir);
      owners.delete(dir);
      rmSync(dir, { recursive: true, force: true });
      return { gone };
    },
  };
  return { trees, owners, adopts };
}

export interface FakeRunScript {
  /** 进程起不来（spawnError），不调 onSpawn。 */
  spawnError?: string;
  /** 迟迟起不来：不调 onSpawn，等被叫停才收场（测「等进程起来」超时）。 */
  hangBeforeSpawn?: boolean;
  /** 进程「起来」（调 onSpawn）之前做的事：比如把库里这一行删掉，测开工记不上。 */
  beforeSpawn?: (spec: ClaudeCodeRunSpec) => Promise<void> | void;
  /** 起来之后做的事：发事件、改工作树、在库里写 done……abort 了要尽快返回。 */
  act?: (ctx: {
    spec: ClaudeCodeRunSpec;
    emit: (kind: ProgressEvent['kind'], payload: unknown, at?: Date) => void;
    rateLimit: (reading: RateLimitReading) => void;
    signal: AbortSignal;
  }) => Promise<void> | void;
  /** 执行体的终帧；不给 = 正常完成。null = 没有终帧。 */
  result?: Partial<NonNullable<ClaudeCodeRunReport['stream']['result']>> | null;
  exitCode?: number | null;
  apiError?: { code?: string; text: string };
  lastContextTokens?: number;
  stderrTail?: string;
}

/** 假插头：不起进程，按剧本走；被 abort 就当成「引擎叫停」收场（和真插头一样 killed=aborted）。 */
export function fakeRun(script: (spec: ClaudeCodeRunSpec, n: number) => FakeRunScript) {
  const specs: ClaudeCodeRunSpec[] = [];
  const options: ClaudeCodeRunOptions[] = [];
  let n = 0;
  const run = async (spec: ClaudeCodeRunSpec, opts: ClaudeCodeRunOptions): Promise<ClaudeCodeRunReport> => {
    n += 1;
    specs.push(spec);
    options.push(opts);
    const s = script(spec, n);
    const startedAt = new Date().toISOString();
    const base = {
      runId: spec.runId,
      requestedModel: spec.model,
      session: spec.session,
      stragglers: 0,
      leftovers: 0,
      stderrTail: s.stderrTail ?? '',
      startedAt,
      lines: 0,
      droppedLines: 0,
      signal: null,
    };
    const stream = (rateLimits: RateLimitReading[]): ClaudeCodeRunReport['stream'] => ({
      sessionId: spec.session.id,
      observedModel: spec.model,
      ...(s.lastContextTokens === undefined ? {} : { lastContextTokens: s.lastContextTokens }),
      startedWork: true,
      toolCalls: 0,
      toolErrors: 0,
      filesChanged: [],
      testRuns: [],
      permissionDenials: [],
      apiRetries: 0,
      ...(s.apiError ? { apiError: s.apiError } : {}),
      rateLimits,
      ...(s.result === null
        ? {}
        : {
            result: {
              isError: false,
              terminalReason: 'completed',
              models: [spec.model],
              permissionDenials: 0,
              sessionCostUsd: 0.5,
              usage: { inputTokens: 100, outputTokens: 20 },
              ...s.result,
            },
          }),
      frames: 1,
      nonJsonLines: 0,
      unknownFrames: {},
    });
    if (s.spawnError) {
      const endedAt = new Date().toISOString();
      return { ...base, exitCode: null, spawnError: s.spawnError, endedAt, wallMs: 0, stream: stream([]) };
    }
    if (s.hangBeforeSpawn) {
      const signal = opts.signal ?? new AbortController().signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const endedAt = new Date().toISOString();
      return {
        ...base,
        exitCode: null,
        spawnError: '起到一半被叫停',
        endedAt,
        wallMs: 0,
        stream: stream([]),
      };
    }
    await s.beforeSpawn?.(spec);
    await opts.onSpawn?.({
      pid: 4242,
      runId: spec.runId,
      scope: `fleet-agent-${spec.runId}.scope`,
      startedAt,
    });
    const readings: RateLimitReading[] = [];
    const signal = opts.signal ?? new AbortController().signal;
    await s.act?.({
      spec,
      emit: (kind, payload, at) =>
        void opts.onEvent?.({ runId: spec.runId, at: (at ?? new Date()).toISOString(), kind, payload }),
      rateLimit: (reading) => {
        readings.push(reading);
        void opts.onRateLimit?.(reading);
      },
      signal,
    });
    const endedAt = new Date().toISOString();
    if (signal.aborted) {
      return {
        ...base,
        exitCode: null,
        signal: 'SIGTERM',
        killed: { reason: 'aborted', at: endedAt },
        endedAt,
        wallMs: 1,
        stream: stream(readings),
      };
    }
    return {
      ...base,
      exitCode: s.exitCode === undefined ? 0 : s.exitCode,
      endedAt,
      wallMs: 1,
      stream: stream(readings),
    };
  };
  return { run, specs, options, count: () => n };
}

/**
 * 假的 fleet-agent-scope：记下每次调用（FAKE_SCOPE_LOG 指的文件，一行一条 JSON）；list 输出 FAKE_SCOPE_LIST、
 * 退出码 FAKE_SCOPE_LIST_EXIT；stop 退出码 FAKE_SCOPE_STOP_EXIT。经 [node, 这个文件] 调（sudo 换成 node）。
 */
export function fakeScopeHelper(root: string): {
  helper: string;
  sudo: string[];
  log: string;
  calls(): { action: string; args: string[] }[];
} {
  const helper = join(root, 'fake-scope.mjs');
  const log = join(root, 'fake-scope.log');
  writeFileSync(
    helper,
    [
      "import { appendFileSync } from 'node:fs';",
      'const [action, ...args] = process.argv.slice(2);',
      "if (process.env.FAKE_SCOPE_LOG) appendFileSync(process.env.FAKE_SCOPE_LOG, JSON.stringify({ action, args }) + '\\n');",
      "if (action === 'list') { process.stdout.write(process.env.FAKE_SCOPE_LIST ?? ''); process.exit(Number(process.env.FAKE_SCOPE_LIST_EXIT ?? '0')); }",
      "if (action === 'stop') process.exit(Number(process.env.FAKE_SCOPE_STOP_EXIT ?? '0'));",
      'process.exit(0);',
    ].join('\n'),
  );
  process.env.FAKE_SCOPE_LOG = log;
  return {
    helper,
    sudo: [process.execPath],
    log,
    calls: () => {
      try {
        return readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { action: string; args: string[] });
      } catch {
        return [];
      }
    },
  };
}

/** 等到 abort（剧本里「会话一直跑、直到被停」用）。 */
export function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
