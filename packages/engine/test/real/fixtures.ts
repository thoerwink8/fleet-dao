// 真端口测试共用的底子：内存库里的一份目录（两个 Claude 池：独享、拼车；一个没接上的执行方式）、一个需求，
// 一个本地 git「镜像」（顶替 github 包的 fetchMainline / bundleCommits），一个记属主的假工作树管家，
// 三个不起真执行体的假插头：Claude 的按剧本发事件、改工作树、交报告；cursor、grok 的拿法国真跑的过程记录
// （packages/adapters/test/fixtures/cursor-agent、grok）逐行喂给真的读取器，事件、会话号、终帧用量都是真解析出来的。
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentRunOptions,
  type ClaudeCodeRunOptions,
  type ClaudeCodeRunReport,
  type ClaudeCodeRunSpec,
  type CursorRunOptions,
  type CursorRunReport,
  type CursorRunSpec,
  CursorStreamReader,
  type GrokRunReport,
  type GrokRunSpec,
  GrokStreamReader,
  type KillReason,
  type LedgerFs,
  type MirasimAccepted,
  type MirasimConnect,
  type MirasimRunOptions,
  type MirasimRunReport,
  type MirasimRunSpec,
  type RateLimitReading,
  type SessionUser,
  scopePrefix,
} from '@fleet-dao/adapters';
import {
  applyQuotaReserveSeed,
  type Db,
  loadQuotaReserveSeed,
  models,
  pools,
  repos,
  routes,
  routingCatalog,
  routingPurposeModels,
  savePoolQuota,
  seed,
  tasks,
} from '@fleet-dao/db';
import type { TestDb } from '@fleet-dao/db/testing';
import type { ProgressEvent, StageKind } from '@fleet-dao/shared';
import type { CarpoolApiRead } from '../../src/jobs/carpool-outage.ts';
import type { UserCommand, UserCommandResult, UserExec } from '../../src/real/exec.ts';
import { cursorLaunchCommand } from '../../src/real/hosts.ts';
import { type SessionOrgControl, type SessionOrgDeps, sessionOrgReader } from '../../src/real/session-org.ts';
import { layout, SESSION_TMP_DIR, type WorkTrees } from '../../src/real/worktrees.ts';
import { runChildOk } from '../child.ts';

export const NOW = new Date('2026-09-25T08:00:00.000Z');
export const MIN = 60_000;

/**
 * 接口读数的替身（#194，切号接真库的测试用）：本人额度还宽、拼车和独享各一个可用账号；时刻就是传进来的假钟。
 * 返回类型写成判法认的 CarpoolApiRead（ok 那一支）。
 */
export function healthyCarpoolRead(at: Date): Extract<CarpoolApiRead, { ok: true }> {
  return {
    ok: true,
    requestedAt: at,
    serverDate: at,
    ageSeconds: null,
    quota: { usedUsd: 10, limitUsd: 80, resetsAt: new Date(at.getTime() + 180 * MIN), status: 'active' },
    org: 'ok',
    accounts: [
      { id: 'carpool-1', kind: 'carpool', hasAssignedAccount: true, expiresAt: null },
      { id: 'solo-1', kind: 'solo', hasAssignedAccount: true, expiresAt: null },
    ],
  };
}

/** 本人额度到顶的接口读数（几点恢复由接口说）。 */
export function fullCarpoolRead(at: Date, resetsAt: Date): Extract<CarpoolApiRead, { ok: true }> {
  return {
    ...healthyCarpoolRead(at),
    quota: { usedUsd: 80, limitUsd: 80, resetsAt, status: 'active' },
  };
}

/** 在线的路由必须带着探针的 ok 结论（库里约束 routes_alive_needs_probe_ok）。 */
export const PROBED_OK = {
  probeState: 'ok' as const,
  probedAt: new Date(NOW.getTime() - 5 * MIN),
  probeDetail: '答上了：OK',
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
  GIT_CONFIG_NOSYSTEM: '1',
};
export const git = (cwd: string, ...args: string[]) =>
  runChildOk('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

/**
 * 目录：两个 Claude 订阅池各一条 Claude Code 路由（同一个会话用户），一条 codex 路由（没接上）。两个池都标成会话用户挂着的
 * 拼车组织：这里测一般的选路（两条都派得出去）；只派挂着的那个组织、另一个挡掉，在 store-ports.test.ts 里单测。
 */
export async function world(db: Db, options: { order?: string[]; stages?: StageKind[] } = {}) {
  await seed(db);
  await db.insert(pools).values([
    {
      id: 'claude-solo',
      channelId: 'claude-subscription',
      maxConcurrency: 3,
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'carpool',
    },
    {
      id: 'claude-carpool',
      channelId: 'claude-subscription',
      maxConcurrency: 3,
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'carpool',
    },
    { id: 'relay', channelId: 'mirasim-cloud', maxConcurrency: 3 },
  ]);
  // 额度留量线：和发布时一样，把种子文件只补缺装进库（线只来自库里，引擎代码里没有默认值；没装上选路一律不派）
  await applyQuotaReserveSeed(db, await loadQuotaReserveSeed());
  await db.insert(routes).values([
    {
      id: 'solo',
      channelId: 'claude-subscription',
      poolId: 'claude-solo',
      modelId: 'opus-5.5',
      hostId: 'claude-code',
      alive: true,
      ...PROBED_OK,
      upstreamModel: 'claude-opus-5-5',
    },
    {
      id: 'carpool',
      channelId: 'claude-subscription',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      hostId: 'claude-code',
      alive: true,
      ...PROBED_OK,
      upstreamModel: 'claude-opus-5-5',
    },
    {
      id: 'luna',
      channelId: 'mirasim-cloud',
      poolId: 'relay',
      modelId: 'gpt-5.6-luna',
      hostId: 'codex',
      alive: true,
      ...PROBED_OK,
      upstreamModel: 'gpt-5.6-luna',
    },
  ]);
  await hangRoutes(
    db,
    options.stages ?? (['execute', 'triage', 'review'] as StageKind[]),
    options.order ?? ['solo', 'carpool'],
  );
  // 额度都读成了、都还宽：选路按人排的顺序走（额度未知的排在后面，别让它搅进来）。
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

/**
 * 把路由挂进路由两层（#574，选路、探针都读它）：每条路由挂在它自己的模型下（同一个模型下按给的先后），模型按第一次出现的先后
 * 排进这些用途。at 给了就从这个位置排（和目录样例的老平铺位置对齐：cursor 9、grok 10、mirasim 11，排在 world 的路由后面），
 * 不给就接在已有的后面。已经挂着的不动；位置撞了照样报错，不悄悄跳过。一个用途都不给就哪儿都不挂（不挂到模型下面：
 * 模型要是已经排进了别的用途，挂上去那些用途就会派到它）。两层的开关、模型都不分用途：同一个模型下的路由，排了这个模型的
 * 用途都看得见。
 */
export async function hangRoutes(
  db: Db,
  stages: readonly StageKind[],
  routeIds: readonly string[],
  at?: number,
): Promise<void> {
  if (routeIds.length === 0 || stages.length === 0) return;
  // 引擎包不直接依赖 drizzle-orm：表都很小，整张读出来在这里算，不拼查询条件
  const modelOf = new Map(
    (await db.select({ id: routes.id, modelId: routes.modelId }).from(routes)).map((r) => [r.id, r.modelId]),
  );
  const next = (positions: number[]) => (positions.length === 0 ? 0 : Math.max(...positions) + 1);
  const modelsInOrder: string[] = [];
  for (const [i, routeId] of routeIds.entries()) {
    const modelId = modelOf.get(routeId);
    if (!modelId) throw new Error(`夹具：路由 ${routeId} 库里没有，挂不进路由两层`);
    if (!modelsInOrder.includes(modelId)) modelsInOrder.push(modelId);
    const taken = (await db.select().from(routingCatalog))
      .filter((r) => r.modelId === modelId)
      .map((r) => r.position);
    await db
      .insert(routingCatalog)
      .values({ modelId, routeId, position: at === undefined ? next(taken) : at + i, enabled: true })
      .onConflictDoNothing({ target: [routingCatalog.modelId, routingCatalog.routeId] });
  }
  for (const stage of stages) {
    for (const [i, modelId] of modelsInOrder.entries()) {
      const taken = (await db.select().from(routingPurposeModels))
        .filter((r) => r.purpose === stage)
        .map((r) => r.position);
      await db
        .insert(routingPurposeModels)
        .values({ purpose: stage, modelId, position: at === undefined ? next(taken) : at + i })
        .onConflictDoNothing({ target: [routingPurposeModels.purpose, routingPurposeModels.modelId] });
    }
  }
}

/** 一个仓加一张需求。测试命令是 pnpm check（给人看的那一列，派活不认）；testCommand 给 null = 项目没写测试命令。 */
export async function addTask(db: Db, over: { testCommand?: string | null } = {}) {
  const testCommand = over.testCommand === undefined ? 'pnpm check' : over.testCommand;
  const [repo] = await db
    .insert(repos)
    .values({
      owner: 'acme',
      name: `widgets-${randomUUID().slice(0, 6)}`,
      // 给人看的那一列：派活不认它（占位）
      testCommand: testCommand ?? '-',
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

/**
 * 假的工作树管家：目录真建在临时目录里，属主记在表里；adopt、remove 记下每一次。
 * fail.remove 里的目录删不掉（抛错）、fail.list 为真时列不出会话临时目录：造「删不掉」「列不出来」用。
 */
export function fakeTrees(root: string) {
  const owners = new Map<string, SessionUser>();
  const adopts: { dir: string; user: SessionUser }[] = [];
  const removes: string[] = [];
  const fail = { remove: new Set<string>(), list: false };
  const tmpBase = `${root}/${SESSION_TMP_DIR}`;
  const trees: WorkTrees = {
    ...layout(root),
    async listTmp() {
      if (fail.list) throw new Error('假的：列不出会话临时目录');
      if (!existsSync(tmpBase)) return [];
      return readdirSync(tmpBase).map((name) => `${tmpBase}/${name}`);
    },
    async ownerOf(dir) {
      return owners.get(dir) ?? null;
    },
    async adopt(dir, user) {
      adopts.push({ dir, user });
      mkdirSync(dir, { recursive: true });
      owners.set(dir, user);
    },
    async remove(dir) {
      removes.push(dir);
      if (fail.remove.has(dir)) throw new Error(`假的：删不掉 ${dir}`);
      const gone = !owners.has(dir) && !existsSync(dir);
      owners.delete(dir);
      rmSync(dir, { recursive: true, force: true });
      return { gone };
    },
  };
  /** 工作树、检出副本的交接（会话临时目录的不算）。 */
  const treeAdopts = () => adopts.filter((a) => !a.dir.startsWith(`${tmpBase}/`));
  return { trees, owners, adopts, removes, fail, tmpBase, treeAdopts };
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
  /** 插头强杀了它（起不来、总时长到顶……）：退出码空、信号 SIGKILL，终帧照 result。 */
  killed?: Exclude<KillReason, 'aborted'>;
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
    // 和真插头一样先过帮手的参数校验（runAgentProcess 里 scopePrefix 抛错 = spawnError，不起进程）：
    // 引擎给的上限写法帮手不认时，这里就起不来，不再让假插头照单全收（2026-09-26 的「0M」就是这么漏的）。
    // 工作目录另给一个固定的绝对路径：只校验 scope 本身，测试的临时目录在 Windows 上不是 / 开头。
    let scopeError: string | undefined;
    if (spec.cgroup) {
      try {
        scopePrefix(spec.cgroup, '/fleet-test-cwd');
      } catch (err) {
        scopeError = err instanceof Error ? err.message : String(err);
      }
    }
    const spawnError = scopeError ?? s.spawnError;
    if (spawnError) {
      const endedAt = new Date().toISOString();
      return { ...base, exitCode: null, spawnError, endedAt, wallMs: 0, stream: stream([]) };
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
    let seq = 0;
    await s.act?.({
      spec,
      emit: (kind, payload, at) =>
        void opts.onEvent?.(
          { runId: spec.runId, at: (at ?? new Date()).toISOString(), kind, payload },
          { seq: seq++, replay: false },
        ),
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
    if (s.killed) {
      return {
        ...base,
        exitCode: null,
        signal: 'SIGKILL',
        killed: { reason: s.killed, at: endedAt },
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

// ---- cursor-agent

const CURSOR_FIXTURES = new URL('../../../adapters/test/fixtures/cursor-agent/', import.meta.url);

/** 法国上真跑的 cursor-agent 过程记录（一行一帧）和当时的工作目录（读取器按它把路径换成相对的）。 */
export function cursorFixture(name: string): { lines: string[]; cwd: string } {
  const lines = readFileSync(new URL(`${name}.ndjson`, CURSOR_FIXTURES), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, CURSOR_FIXTURES), 'utf8')) as {
    cwd: string;
  };
  return { lines, cwd: meta.cwd };
}

/** 真跑夹具里 cursor 自己起的会话号（cursor-edit-commit 开的会话，cursor-resume 续的就是它）。 */
export const CURSOR_SESSION = 'e06fc62e-72a6-4020-9144-01155dbba6db';

/** cursor-agent 没有登录态时 -p 模式的原话（2026.09.23 发行包；stderr、退出 1、没有 JSON）。 */
export const CURSOR_NO_LOGIN =
  "Error: Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable.";

/**
 * Cursor 拒了环境里的 API 密钥（无效、被撤、过期）时 -p 模式的原话（2026.09.26 发行包 index.js 的 api-key-auth：
 * 换令牌被拒就打这三行、退出 1、没有 JSON）。头一行不管有没有终端都带颜色。
 */
export const CURSOR_KEY_REJECTED =
  '\u001b[33m⚠ Warning: The provided API key is invalid.\u001b[0m\n' +
  'The API key was loaded from the CURSOR_API_KEY environment variable.\n' +
  'Please check you have the right key, create a new one, or authenticate without it.\n';

/**
 * 没信任过的工作目录、没带 --trust / --force 时 -p 模式在 stderr 打的那段（2026.09.26 发行包 6853.index.js；没有终端时
 * 不带颜色），打完就退出。最后三行里没有「Workspace Trust」这个词。
 */
export const CURSOR_TRUST_REQUIRED = [
  '',
  '⚠ Workspace Trust Required',
  '',
  ' Cursor Agent can execute code and access files in this directory.',
  ' Do you trust the contents of this directory?',
  '',
  ' /var/lib/fleet-work/_route-probe/fleet-agent-carpool',
  '',
  ' To proceed, you can either:',
  " • Run 'cursor-agent' interactively to decide",
  ' • Pass --trust, --yolo, or -f if you trust this directory',
  '',
].join('\n');

export interface FakeCursorScript {
  /** 回放哪一份真跑夹具（不带后缀）；不给 = 一帧都没有（只在 stderr 报错就退出的那种）。 */
  replay?: string;
  /** 只回放前几行（比如只要 init 帧，后面接自己写的终帧）。 */
  replayLines?: number;
  /** 接在回放后面的帧（探针要的「只回 OK」终帧、没有用量的终帧……）。 */
  frames?: Record<string, unknown>[];
  /** 进程起不来：不调 onSpawn。 */
  spawnError?: string;
  /** 起来之后、回放之前做的事：改工作树、写结论文件、在库里写 done……abort 了要尽快返回。 */
  act?: (ctx: { spec: CursorRunSpec; signal: AbortSignal }) => Promise<void> | void;
  stderr?: string;
  exitCode?: number | null;
  killed?: Exclude<KillReason, 'aborted'>;
}

/**
 * 假的 cursor 插头：不起进程，把夹具逐行喂给真的读取器（CursorStreamReader），事件照读取器给的发、init 帧的会话号照真插头的
 * 规矩报（续会话对不上就停、不报），报告里的 stream 就是读取器的摘要。被 abort 当成引擎叫停收场。
 */
export function fakeCursorRun(script: (spec: CursorRunSpec, n: number) => FakeCursorScript) {
  const specs: CursorRunSpec[] = [];
  const options: CursorRunOptions[] = [];
  let n = 0;
  const run = async (spec: CursorRunSpec, opts: CursorRunOptions): Promise<CursorRunReport> => {
    n += 1;
    specs.push(spec);
    options.push(opts);
    const s = script(spec, n);
    const startedAt = new Date().toISOString();
    const fixture = s.replay ? cursorFixture(s.replay) : { lines: [], cwd: spec.cwd };
    const reader = new CursorStreamReader({
      runId: spec.runId,
      cwd: fixture.cwd,
      testCommands: spec.testCommands ?? [],
    });
    const finish = (extra: Partial<CursorRunReport> & Pick<CursorRunReport, 'exitCode' | 'signal'>) => ({
      runId: spec.runId,
      requestedModel: spec.model,
      session: spec.session,
      stragglers: 0,
      leftovers: 0,
      stderrTail: s.stderr ?? '',
      startedAt,
      endedAt: new Date().toISOString(),
      wallMs: 1,
      lines: 0,
      droppedLines: 0,
      stream: reader.summary(),
      ...extra,
    });
    // 和真插头一样先过帮手的参数校验（见 fakeRun）。
    let scopeError: string | undefined;
    if (spec.cgroup) {
      try {
        scopePrefix(spec.cgroup, '/fleet-test-cwd');
      } catch (err) {
        scopeError = err instanceof Error ? err.message : String(err);
      }
    }
    const spawnError = scopeError ?? s.spawnError;
    if (spawnError) return finish({ exitCode: null, signal: null, spawnError });
    await opts.onSpawn?.({
      pid: 4343,
      runId: spec.runId,
      scope: `fleet-agent-${spec.runId}.scope`,
      startedAt,
    });
    const signal = opts.signal ?? new AbortController().signal;
    await s.act?.({ spec, signal });
    const resumeId = spec.session.mode === 'resume' ? spec.session.id : undefined;
    const lines = [
      ...fixture.lines.slice(0, s.replayLines ?? fixture.lines.length),
      ...(s.frames ?? []).map((f) => JSON.stringify(f)),
    ];
    let seq = 0;
    for (const line of lines) {
      if (signal.aborted) break;
      const effect = reader.read(line);
      const id = effect.init?.sessionId;
      if (id && resumeId && id !== resumeId) {
        const at = new Date().toISOString();
        return finish({ exitCode: null, signal: 'SIGTERM', killed: { reason: 'session_mismatch', at } });
      }
      if (id) opts.onSessionId?.(id);
      for (const event of effect.events) void opts.onEvent?.(event, { seq, replay: false });
      seq++;
    }
    const at = new Date().toISOString();
    if (signal.aborted)
      return finish({ exitCode: null, signal: 'SIGTERM', killed: { reason: 'aborted', at } });
    if (s.killed) return finish({ exitCode: null, signal: 'SIGKILL', killed: { reason: s.killed, at } });
    return finish({ exitCode: s.exitCode === undefined ? 0 : s.exitCode, signal: null });
  };
  return { run, specs, options, count: () => n };
}

// ---- grok

const GROK_FIXTURES = new URL('../../../adapters/test/fixtures/grok/', import.meta.url);

/** 法国上真跑的 grok 过程记录（一行一帧）和当时的工作目录（读取器按它把路径换成相对的）。 */
export function grokFixture(name: string): { lines: string[]; cwd: string } {
  const lines = readFileSync(new URL(`${name}.ndjson`, GROK_FIXTURES), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, GROK_FIXTURES), 'utf8')) as {
    cwd: string;
  };
  return { lines, cwd: meta.cwd };
}

/** grok 1.0.41 在会话用户家里没有登录态时无头模式的原话（法国实跑 2026-09-27：error 帧、stderr 各一遍，退出 1）。 */
export const GROK_NOT_SIGNED_IN =
  'Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\n' +
  'Alternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.';

/** grok 登录过期、续不上时的原话（xai-org/grok-build f0e3be1 的 crates/codegen/xai-grok-login/src/error.rs）。 */
export const GROK_TOKEN_EXPIRED = 'Token expired. Run `grok login` to re-authenticate.';

/** 点名的型号 grok 不认（法国实跑 2026-09-27：error 帧、stderr 各一遍，退出 1）。 */
export const GROK_UNKNOWN_MODEL =
  "Couldn't set model 'grok-9.9': Invalid params: \"unknown model id\". Run 'grok models' to see available models.";

/**
 * stdin 不是真管道时 grok 读 /dev/stdin 的报错（法国实跑 2026-09-27：stdin 给 socketpair，只在 stderr、退出 1）。
 * 插头前面垫了 cat 就撞不上；撞上了是起法坏了，不是没登录。
 */
export const GROK_NO_STDIN = "Error: Failed to read '/dev/stdin': No such device or address (os error 6)";

/** grok 报错退出的样子：error 帧和 stderr（「Error: 」开头）各一遍、退出 1、没有终帧（没登录、型号不对都是这样）。 */
export function grokRefused(message: string, exitCode = 1): FakeGrokScript {
  return { frames: [{ type: 'error', message }], stderr: `Error: ${message}\n`, exitCode };
}

/**
 * 探针要的那种回合：回答 OK（text 帧，一字一帧的增量拼成整句）、终帧带实际模型（会话号由假插头换成这一轮交给它的号）。
 * 用量照法国真跑的一次最小会话。
 */
export function grokAnswered(text = 'OK', model = 'grok-4.7-build'): Record<string, unknown>[] {
  return [
    ...[...text].map((data) => ({ type: 'text', data })),
    {
      type: 'end',
      stopReason: 'end_turn',
      sessionId: 'replaced-by-fake',
      usage: { input_tokens: 3212, output_tokens: 2, cache_read_input_tokens: 12032 },
      num_turns: 1,
      total_cost_usd: 0.0021,
      modelUsage: { [model]: { inputTokens: 3212, outputTokens: 2 } },
    },
  ];
}

export interface FakeGrokScript {
  /** 回放哪一份真跑夹具（不带后缀）；不给 = 一帧都没有。 */
  replay?: string;
  replayLines?: number;
  /** 接在回放后面的帧。 */
  frames?: Record<string, unknown>[];
  /**
   * 终帧回的会话号照不照夹具原样：默认换成这一轮交给插头的号（真 grok 带 -s / -r 起，终帧回的就是它）；
   * 给 true 就照夹具原样，造「回的号对不上」。
   */
  keepSessionId?: boolean;
  spawnError?: string;
  act?: (ctx: { spec: GrokRunSpec; signal: AbortSignal }) => Promise<void> | void;
  stderr?: string;
  exitCode?: number | null;
  killed?: Exclude<KillReason, 'aborted'>;
}

/**
 * 假的 grok 插头：不起进程，把夹具逐行喂给真的读取器（GrokStreamReader），事件照读取器给的发，报告里的 stream 就是读取器的
 * 摘要（会话号、实际模型只在终帧里：跑完由 grokRunFacts 核对）。被 abort 当成引擎叫停收场。
 */
export function fakeGrokRun(script: (spec: GrokRunSpec, n: number) => FakeGrokScript) {
  const specs: GrokRunSpec[] = [];
  const options: AgentRunOptions[] = [];
  let n = 0;
  const run = async (spec: GrokRunSpec, opts: AgentRunOptions): Promise<GrokRunReport> => {
    n += 1;
    specs.push(spec);
    options.push(opts);
    const s = script(spec, n);
    const startedAt = new Date().toISOString();
    const fixture = s.replay ? grokFixture(s.replay) : { lines: [], cwd: spec.cwd };
    const reader = new GrokStreamReader({
      runId: spec.runId,
      cwd: fixture.cwd,
      testCommands: spec.testCommands ?? [],
    });
    const finish = (extra: Partial<GrokRunReport> & Pick<GrokRunReport, 'exitCode' | 'signal'>) => ({
      runId: spec.runId,
      requestedModel: spec.model,
      session: spec.session,
      stragglers: 0,
      leftovers: 0,
      stderrTail: s.stderr ?? '',
      startedAt,
      endedAt: new Date().toISOString(),
      wallMs: 1,
      lines: 0,
      droppedLines: 0,
      stream: reader.summary(),
      ...extra,
    });
    // 和真插头一样先过帮手的参数校验（见 fakeRun）。
    let scopeError: string | undefined;
    if (spec.cgroup) {
      try {
        scopePrefix(spec.cgroup, '/fleet-test-cwd');
      } catch (err) {
        scopeError = err instanceof Error ? err.message : String(err);
      }
    }
    const spawnError = scopeError ?? s.spawnError;
    if (spawnError) return finish({ exitCode: null, signal: null, spawnError });
    await opts.onSpawn?.({
      pid: 4545,
      runId: spec.runId,
      scope: `fleet-agent-${spec.runId}.scope`,
      startedAt,
    });
    const signal = opts.signal ?? new AbortController().signal;
    await s.act?.({ spec, signal });
    const lines = [
      ...fixture.lines.slice(0, s.replayLines ?? fixture.lines.length),
      ...(s.frames ?? []).map((f) => JSON.stringify(f)),
    ].map((line) => {
      if (s.keepSessionId) return line;
      const frame = JSON.parse(line) as Record<string, unknown>;
      return frame.type === 'end' ? JSON.stringify({ ...frame, sessionId: spec.session.id }) : line;
    });
    let seq = 0;
    for (const line of lines) {
      if (signal.aborted) break;
      for (const event of reader.read(line).events) void opts.onEvent?.(event, { seq, replay: false });
      seq++;
    }
    for (const event of reader.flush()) void opts.onEvent?.(event, { seq, replay: false });
    const at = new Date().toISOString();
    if (signal.aborted)
      return finish({ exitCode: null, signal: 'SIGTERM', killed: { reason: 'aborted', at } });
    if (s.killed) return finish({ exitCode: null, signal: 'SIGKILL', killed: { reason: s.killed, at } });
    return finish({ exitCode: s.exitCode === undefined ? 0 : s.exitCode, signal: null });
  };
  return { run, specs, options, count: () => n };
}

// ---- mirasim

/**
 * 假的 Mirasim 连接 / 账本依赖：只是把 hostDrivers 要的形状填满，不真连服务、不真读账本。真的连接重试、令牌怎么读、
 * 账本怎么解析各有各的单元测试（packages/adapters/test/mirasim.test.ts、real/index.ts 的 mirasimDepsFor）；
 * 这里的用例要么不起 mirasim 路由，要么用 run.mirasim 顶掉插头本身（不会真调 connect / ledgerFs）。
 */
export function fakeMirasimDeps(): {
  mirasimConnect(user: SessionUser): MirasimConnect;
  mirasimLedgerDir(user: SessionUser): string;
  mirasimLedgerFs(user: SessionUser): LedgerFs;
} {
  return {
    mirasimConnect: (user) => async () => {
      throw new Error(`假的：这条用例不该真连 Mirasim（${user}）`);
    },
    mirasimLedgerDir: (user) => `/fake/${user}/.mirasim/traffic`,
    mirasimLedgerFs: (user) => ({
      readdir: async () => {
        throw new Error(`假的：这条用例不该真列 Mirasim 账本目录（${user}）`);
      },
      readFile: async () => {
        throw new Error(`假的：这条用例不该真读 Mirasim 账本文件（${user}）`);
      },
    }),
  };
}

/** 一份最小的 Mirasim 会话状态（MirasimSession.summary() 的形状）：done、没工具、没用量，text 给了才有回答。 */
export function mirasimState(
  over: Partial<MirasimRunReport['session']['state']> = {},
): MirasimRunReport['session'] {
  return {
    state: { text: '', reasoning: '', toolCalls: [], interactions: 0, phase: 'done', ...over },
    seq: 1,
    snapshots: 1,
    patches: 0,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: [],
    testRuns: [],
  };
}

export interface FakeMirasimScript {
  /** 快照状态（答上了的默认之上再改）：text、model、phase、error、usage…… */
  state?: Partial<MirasimRunReport['session']['state']>;
  /**
   * 报告顶层的字段（不给的用一份「答上了」的默认值补）：launchError、launchUnknown、killed、watchError、ledger……
   * 要把 base 给的默认值（比如 route=cloud 时自动补的账本）清掉、改回「没有」，显式给 undefined
   * （下面 run() 里会把值是 undefined 的键整个删掉，不会真的拼出一个 ledger: undefined 的报告）。
   */
  report?: {
    [K in keyof Omit<MirasimRunReport, 'session'>]?: Omit<MirasimRunReport, 'session'>[K] | undefined;
  };
  /** 服务端 accepted 报的会话号：不给就续会话给回原号、开新会话现造一个。 */
  sessionKey?: string;
  /** 不回 accepted（造「服务端没接这一针」）：hooks.onSessionId 不会被调用。 */
  noAccept?: boolean;
}

/**
 * 假的 Mirasim 插头：不连真服务，直接交出一份 MirasimRunReport（协议细节——快照合并、订阅重连——已经在
 * packages/adapters/test/mirasim.test.ts 测过；这里只测 hosts.ts 的驱动把 HostRunSpec 拼成 MirasimRunSpec、
 * 把报告整理成 HostReport 这一层胶水）。
 */
export function fakeMirasimRun(script: (spec: MirasimRunSpec, n: number) => FakeMirasimScript) {
  const specs: MirasimRunSpec[] = [];
  const options: MirasimRunOptions[] = [];
  let n = 0;
  const run = async (spec: MirasimRunSpec, opts: MirasimRunOptions): Promise<MirasimRunReport> => {
    n += 1;
    specs.push(spec);
    options.push(opts);
    const s = script(spec, n);
    const sessionKey =
      s.sessionKey ?? (spec.session.mode === 'resume' ? spec.session.key : `${spec.agent}:${randomUUID()}`);
    if (!s.noAccept) {
      const accepted: MirasimAccepted = { sessionKey, acceptedAt: new Date().toISOString() };
      opts.onAccepted?.(accepted);
    }
    const now = new Date().toISOString();
    const base: MirasimRunReport = {
      runId: spec.runId,
      agent: spec.agent,
      route: spec.route,
      resumed: spec.session.mode === 'resume',
      ...(spec.model ? { requestedModel: spec.model } : {}),
      ...(spec.expectModel ? { expectModel: spec.expectModel } : {}),
      // 没接 accepted（造「服务端没接这一针」）就不该有会话号：真插头在 accepted 之前就不知道 sessionKey
      ...(s.noAccept ? {} : { sessionKey }),
      terminal: { isError: false, detail: 'done' },
      session: mirasimState({ model: spec.model ?? spec.expectModel, ...s.state }),
      // route=cloud（design 第三节第 12 条：只留这一种）时 mirasimRunFacts 要看账本才算数（MS-27）：默认给一行像真的
      // 2xx，不然每条不特意测账本的用例都会白白判成 relayUnknown。要测账本没查成、没有 2xx，用 s.report.ledger 覆盖。
      ...(spec.route === 'cloud'
        ? {
            ledger: {
              state: 'read' as const,
              rows: [
                {
                  status: 200,
                  upstreamHost: 'relay.mirasim.example',
                  viaRelay: true,
                  ...(spec.model ? { model: spec.model } : {}),
                },
              ],
              unparsed: 0,
            },
          }
        : {}),
      foreignFrames: 0,
      resubscribes: 0,
      reconnects: 0,
      startedAt: now,
      endedAt: now,
      wallMs: 1,
    };
    // s.report 里显式给 undefined 的键（清掉 base 的默认值）整个删掉，不拼进报告里：exactOptionalPropertyTypes
    // 不许「有这个键、值是 undefined」，真的没有就该是键都不在。
    const merged: Record<string, unknown> = { ...base, ...s.report };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    return merged as unknown as MirasimRunReport;
  };
  return { run, specs, options, count: () => n };
}

/**
 * 一条 mirasim 路由（和目录样例同一个样子）：中转池不绑会话用户。执行体按上游串前缀或 routes.executor
 * （shared 的 resolveMirasimExecutor）。stages 给了就挂进这些用途的路由两层（hangRoutes，位置 11）。
 */
export async function addMirasimRoute(
  db: Db,
  over: { poolId?: string; modelId?: string; upstreamModel?: string; stages?: StageKind[] } = {},
): Promise<{ routeId: string; poolId: string }> {
  const poolId = over.poolId ?? 'mirasim-relay';
  const modelId = over.modelId ?? 'deepseek-flash';
  const routeId = `${poolId}:${modelId}:mirasim`;
  await db
    .insert(pools)
    .values({ id: poolId, channelId: 'mirasim-cloud', maxConcurrency: 5 })
    .onConflictDoNothing();
  // 种子里没有的模型串（测「目录配了、前缀认不出」时故意给一个没见过的）：现插一行，
  // 不然连 routes 外键都插不进去——生产上这一步由目录装载器做（catalog.ts 的 config.models），不是这份种子的事。
  await db
    .insert(models)
    .values({ id: modelId, family: 'deepseek', displayName: modelId })
    .onConflictDoNothing();
  await db.insert(routes).values({
    id: routeId,
    channelId: 'mirasim-cloud',
    poolId,
    modelId,
    hostId: 'mirasim',
    alive: true,
    ...PROBED_OK,
    upstreamModel: over.upstreamModel ?? modelId,
  });
  await hangRoutes(db, over.stages ?? [], [routeId], 11);
  return { routeId, poolId };
}

/**
 * 一条 grok 路由（和目录样例同一个样子）：SuperGrok 的池不绑会话用户，模型 grok-4.7。stages 给了就挂进这些用途的路由两层
 * （探针只探在用的路由），排在 cursor 那条（9）后面。
 */
export async function addGrokRoute(
  db: Db,
  over: { poolId?: string; stages?: StageKind[]; upstreamModel?: string } = {},
): Promise<{ routeId: string; poolId: string }> {
  const poolId = over.poolId ?? 'grok';
  const routeId = `${poolId}:grok-4.7:grok`;
  await db
    .insert(pools)
    .values({ id: poolId, channelId: 'grok-subscription', maxConcurrency: 6 })
    .onConflictDoNothing();
  await db.insert(routes).values({
    id: routeId,
    channelId: 'grok-subscription',
    poolId,
    modelId: 'grok-4.7',
    hostId: 'grok',
    alive: true,
    ...PROBED_OK,
    upstreamModel: over.upstreamModel ?? 'grok-4.7',
  });
  await hangRoutes(db, over.stages ?? [], [routeId], 10);
  return { routeId, poolId };
}

/**
 * 一条 cursor-agent 路由（和目录样例同一个样子）：池不绑会话用户（库里约束会话用户和 reclaude 组织类型同有同无），
 * 模型默认 auto（给 modelId 就是钉住某个型号的）。stages 给了就挂进这些用途的路由两层（探针只探在用的路由）。
 */
export async function addCursorRoute(
  db: Db,
  over: { poolId?: string; stages?: StageKind[]; upstreamModel?: string; modelId?: string } = {},
): Promise<{ routeId: string; poolId: string }> {
  const poolId = over.poolId ?? 'cursor';
  const modelId = over.modelId ?? 'cursor-auto';
  const routeId = `${poolId}:${modelId}:cursor-agent`;
  await db.insert(pools).values({ id: poolId, channelId: 'cursor', maxConcurrency: 6 }).onConflictDoNothing();
  await db.insert(routes).values({
    id: routeId,
    channelId: 'cursor',
    poolId,
    modelId,
    hostId: 'cursor-agent',
    alive: true,
    ...PROBED_OK,
    upstreamModel: over.upstreamModel ?? 'auto',
  });
  await hangRoutes(db, over.stages ?? [], [routeId], 9);
  return { routeId, poolId };
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

// ---- 真走一遍起 cursor-agent 的那条命令（只在 Linux 上用：NTFS 表示不了 600，Windows 上也起不了 /bin/sh）

export interface CursorKeyRig {
  /** 假密钥：运行时现拼（整段写在源码里，卫生检查会当成真的）。 */
  key: string;
  keyFile: string;
  versionsDir: string;
  /** 真的起法（real/hosts.ts 的 cursorLaunchCommand），指着这里的版本目录和密钥文件。 */
  command(user: SessionUser): string[];
  /** 假的 fleet-agent-scope：照真帮手的规矩起 -- 后面的命令，每次调用连参数、环境记进 scopeLog。经 node 跑。 */
  helper: string;
  sudo: string[];
  /** 假 cursor-agent 起过没有（收到的参数记在这，一次一段）。 */
  agentRan(): boolean;
  /** 之后起的假 cursor-agent 照 Cursor 拒掉密钥的样子报错退出（CURSOR_KEY_REJECTED）。 */
  rejectKey(): void;
  /** 这套东西在磁盘上留下的全部记录（帮手收到的参数和环境、假 cursor-agent 收到的参数）：搜值用。 */
  traces(): string;
}

/**
 * 一套假东西，让起 cursor-agent 的真命令从头走到尾：版本目录里一个假 cursor-agent（sh）——读完 stdin，参数记下来，环境里的
 * CURSOR_API_KEY 和密钥文件对不对得上只报一个词（OK / KEY_MISMATCH / NO_KEY），照 stream-json 打 init、说的话、终帧；
 * 值本身哪里都不打。密钥文件属跑测试的用户、600。
 */
export function cursorKeyRig(root: string): CursorKeyRig {
  const dir = join(root, 'cursor-rig');
  const versionsDir = join(dir, 'versions');
  const agentDir = join(versionsDir, '2026.09.26-aaa1111');
  const home = join(dir, 'home');
  const keyFile = join(home, '.cursor', 'fleet-api-key');
  const key = `fake-cursor-key-${randomBytes(24).toString('hex')}`;
  const argvLog = join(dir, 'agent-argv');
  const scopeLog = join(dir, 'scope.log');
  const rejectFlag = join(dir, 'reject');
  const helper = join(dir, 'fake-scope.mjs');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(keyFile, key);
  chmodSync(keyFile, 0o600);
  const sid = '0e0c0a0b-1111-4222-8333-444455556666';
  const agent = join(agentDir, 'cursor-agent');
  writeFileSync(
    agent,
    [
      '#!/bin/sh',
      'cat >/dev/null',
      `{ echo '--- run'; for a in "$@"; do printf '%s\\n' "$a"; done; } >>'${argvLog}'`,
      `if [ -e '${rejectFlag}' ]; then printf '\\033[33m⚠ Warning: The provided API key is invalid.\\033[0m\\nThe API key was loaded from the CURSOR_API_KEY environment variable.\\nPlease check you have the right key, create a new one, or authenticate without it.\\n' >&2; exit 1; fi`,
      `if ! printenv CURSOR_API_KEY >/dev/null; then a=NO_KEY; elif [ "$CURSOR_API_KEY" = "$(cat '${keyFile}')" ]; then a=OK; else a=KEY_MISMATCH; fi`,
      `printf '%s\\n' '{"type":"system","subtype":"init","apiKeySource":"env","cwd":"/w","session_id":"${sid}","model":"Auto","permissionMode":"default"}'`,
      `printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]},"session_id":"${sid}"}\\n' "$a"`,
      `printf '{"type":"result","subtype":"success","duration_ms":1,"duration_api_ms":1,"is_error":false,"result":"%s","session_id":"${sid}","request_id":"r","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}\\n' "$a"`,
      '',
    ].join('\n'),
  );
  chmodSync(agent, 0o755);
  writeFileSync(
    helper,
    [
      "import { spawn } from 'node:child_process';",
      "import { appendFileSync } from 'node:fs';",
      'const [action, ...rest] = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(scopeLog)}, JSON.stringify({ action, args: rest, env: process.env }) + '\\n');`,
      "if (action !== 'run') process.exit(0);",
      "const at = rest.indexOf('--');",
      "const cwdAt = rest.indexOf('--cwd');",
      'const command = rest.slice(at + 1);',
      '// 和真帮手一样：环境只剩 FLEET_* 这几类；PATH 取 FLEET_SESSION_PATH，家目录换成会话用户的',
      'const env = {};',
      'for (const [k, v] of Object.entries(process.env)) {',
      '  if (v !== undefined && /^(FLEET_[A-Z0-9_]+|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|GIT_TERMINAL_PROMPT)$/.test(k)) env[k] = v;',
      '}',
      `env.HOME = ${JSON.stringify(home)};`,
      "env.PATH = (process.env.FLEET_SESSION_PATH ?? '/usr/local/bin:/usr/bin:/bin') + ':' + env.HOME + '/.local/bin';",
      "const child = spawn(command[0], command.slice(1), { cwd: cwdAt >= 0 ? rest[cwdAt + 1] : '/', env, stdio: 'inherit' });",
      "child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));",
      "process.on('SIGTERM', () => child.kill('SIGTERM'));",
      '',
    ].join('\n'),
  );
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return {
    key,
    keyFile,
    versionsDir,
    command: () => cursorLaunchCommand(versionsDir, keyFile),
    helper,
    sudo: [process.execPath],
    agentRan: () => existsSync(argvLog),
    rejectKey: () => writeFileSync(rejectFlag, ''),
    traces: () => `${read(scopeLog)}\n${read(argvLog)}`,
  };
}

/** 占位的组织编号：真机上是三四位的数（reclaude org list 的第一列）。读法只许交出类型，编号、邮箱一个字都不许往外带。 */
export const CARPOOL_ORG_ID = 1111;
export const SOLO_ORG_ID = 2222;

/**
 * reclaude org list 真机的样子（法国 2026-09-27 读回的格式，编号、名字、邮箱换成占位的）：制表符分列，带 * 的是现在挂的，
 * 类型 team 是拼车、personal 是独享。current 给 null = 哪一行都不带 *；syncing = 前面先打一行 Syncing config…（真跑有时这样）。
 */
export function orgListText(current: 'carpool' | 'solo' | null, options: { syncing?: boolean } = {}): string {
  const mark = (kind: 'carpool' | 'solo') => (current === kind ? '*' : ' ');
  return [
    ...(options.syncing ? ['Syncing config…'] : []),
    'Available organizations:',
    `${mark('solo')} ${SOLO_ORG_ID}\t<独享组织名>\tpersonal\tfleet-test@localhost`,
    `${mark('carpool')} ${CARPOOL_ORG_ID}\t<拼车组织名>\tteam\tfleet-test@localhost`,
    'Switch organization: reclaude org <子命令> <org_id>',
    '',
  ].join('\n');
}

/** org list 替身回的东西：stdout 写成文字，别的照 UserCommandResult。 */
export type OrgListAnswer = Partial<Omit<UserCommandResult, 'stdout'>> & { stdout?: string };

export interface OrgListRig {
  /** 之后每次 org list 回什么：给组织类型就回一份像真的（它带 *），给对象就原样回（退出码、输出、超时……）。 */
  answer(out: 'carpool' | 'solo' | OrgListAnswer): void;
  /** 以会话用户跑命令的替身：记下每次调用，不真起进程。 */
  exec: UserExec;
  calls: UserCommand[];
  /** 真的读法（不留：每次都现读），接在这个替身上。 */
  reader(over?: Partial<SessionOrgDeps>): SessionOrgControl;
}

/** 会话用户挂的组织：以会话用户跑 reclaude org list 的替身（生产上经 fleet-agent-scope 起），默认挂着拼车。 */
export function orgListRig(): OrgListRig {
  const calls: UserCommand[] = [];
  let next: OrgListAnswer = { stdout: orgListText('carpool') };
  const exec: UserExec = async (command) => {
    calls.push(command);
    const { stdout, ...rest } = next;
    return {
      code: 0,
      stderr: '',
      timedOut: false,
      aborted: false,
      ...rest,
      stdout: Buffer.from(stdout ?? ''),
    };
  };
  return {
    answer: (out) => {
      next = typeof out === 'string' ? { stdout: orgListText(out) } : out;
    },
    exec,
    calls,
    reader: (over = {}) =>
      sessionOrgReader({
        exec,
        user: 'fleet-agent-carpool',
        reclaude: ['/home/fleet-agent-carpool/.local/bin/reclaude'],
        ttlMs: 0,
        ...over,
      }),
  };
}

/** 整个库拍成一段文字（public 下每张表的每一行）：搜值用。 */
export async function dumpDb(client: TestDb['client']): Promise<string> {
  const tables = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const parts: string[] = [];
  for (const { tablename } of tables.rows) {
    const { rows } = await client.query(`select * from "${tablename}"`);
    parts.push(
      `${tablename}: ${JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`,
    );
  }
  return parts.join('\n');
}
