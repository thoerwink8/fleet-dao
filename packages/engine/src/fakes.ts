// 假实现：不碰真仓、真会话、真 GitHub，用来把流程跑通（测试、联调）。行为可以按剧本改。

import type { RiskyFile } from '@fleet-dao/conventions';
import type { Brief, FlowConfigRead, TaskAsk, VerifyReport } from '@fleet-dao/core';
import type { StageKind } from '@fleet-dao/shared';
import type { MergeOutcome, TestResult } from './decisions/merge.ts';
import type { PlannedSubtask } from './decisions/plan.ts';
import type { TriageVerdict } from './decisions/triage.ts';
import type { CiResult, ReviewResult, SyncResult } from './decisions/verify.ts';
import {
  type AskHumanInput,
  type CheckHighRiskInput,
  type Criteria,
  type EnginePorts,
  type LaunchSessionInput,
  type LeadStep,
  type MergePrInput,
  type OpenPrInput,
  type PickRouteInput,
  type PickRouteResult,
  type PortContext,
  PortError,
  type PortName,
  type PostSecondOpinionInput,
  type PostSecondOpinionResult,
  type PushBranchInput,
  type RaiseAlertInput,
  type ReadCriteriaInput,
  type RequestApprovalInput,
  type RouteChoice,
  type RunTestsInput,
  type Scope,
  type SessionEnd,
  type SessionOutput,
  type StartSessionResult,
  type SyncMainlineInput,
  type TaskRequest,
  type TaskStateSnapshot,
  type TimingEntry,
  type UpdateIssueProgressInput,
  type VerificationRecord,
  type WaitCiInput,
  type WriteSpecDocInput,
} from './ports.ts';

export interface FakeSessionPlan {
  outcome?: 'done' | 'failed' | 'stalled' | 'blocked';
  /** jev = 看守活动问回来的 Jev 答案（真端口在规则认不出时才问），原样随结局交给工作流。 */
  failure?: {
    code: string;
    message?: string;
    retryable?: boolean;
    jev?: NonNullable<SessionEnd['failure']>['jev'];
  };
  /** needs 不给就是 human（fleet blocked 一定要写 --needs，假会话省事给个默认）。 */
  blocked?: {
    reason?: string;
    question?: string;
    options?: string[];
    needs?: 'human' | 'info' | 'access' | 'other';
  };
  /** 会话挂着不结束，直到 release()、stopSession 或取消。 */
  hold?: boolean;
  /** 第一次看守不心跳也不返回（模拟工人进程没了），重试的那次接上。 */
  loseFirstWatch?: boolean;
  output?: SessionOutput;
}

export interface FakeScript {
  plan: PlannedSubtask[];
  triage: (n: number) => TriageVerdict;
  /**
   * n = 这个阶段第几次起会话，所有子任务一起数；own = 这个子任务自己这个阶段第几次起（分诊、写需求、写方案这些不属于
   * 子任务的算一份）。都从 1 开始。几个子任务并行时谁的会话先起是赛跑：要挑「某个子任务的第几次」看 own，拿 n 配
   * subtaskKey 会随先后错位（#88：readme 先起就拿走了 1，form 的那次成了 2）。
   */
  session: (input: LaunchSessionInput, n: number, own: number) => FakeSessionPlan | undefined;
  review: (input: LaunchSessionInput, n: number) => Omit<ReviewResult, 'head'> | undefined;
  /**
   * 开 PR 前验证会话交回的结论（n = 第几次起验证会话）；不给就是每条「怎么算做完」都答做到、审的是送检的头。
   * 可以故意给形状不对的（unknown）：假会话原样交，工作流经 decide 判（真会话端口会先拦一道，见 real/sessions.ts）。
   */
  verify: (input: LaunchSessionInput, n: number) => VerifyReport | unknown | undefined;
  /** 读需求文档的「怎么算做完」：给了 PortError 就抛它；不给就是 specDir 下的需求.md、两条。 */
  criteria: (input: ReadCriteriaInput, n: number) => Criteria | PortError | undefined;
  /** 写这张单的会话用过的族：不给就照假会话算（验证、审查不算）；一个都没有抛 AUTHORS_UNKNOWN，和真端口一样。 */
  authors: (input: Scope, n: number) => string[] | PortError | undefined;
  /**
   * Fusion 的 Lead 这一步交回的（n = 这一步第几次）；不给就是一份合格的（方案提交了、简报齐全、验收收下、不驳回、最终审查
   * 过了……）。要故意交错的给形状不对的：假会话原样交，工作流经 decide 调 core 判。
   */
  lead: (step: LeadStep, input: LaunchSessionInput, n: number) => SessionOutput | undefined;
  /** 流程配置副本：给了 PortError 就抛它；不给就是刚同步过、读自仓里的 FAKE_FLOW_CONFIG。 */
  flow: (input: Scope, n: number) => FlowConfigRead | PortError | undefined;
  /** 单子现在的标题和正文（停下等人之后重认需求文档用）：给了 PortError 就抛它；不给就报任务不在（和真端口一样明确失败）。 */
  request: (input: Scope, n: number) => TaskRequest | PortError | undefined;
  /**
   * 读这张单的提问（taskAsks）之前：给了 PortError 就抛它（假的「库没查成」）；n = 第几次读。给了数组就读它，不给就读
   * FakeWorld.askRows 里这张单的。
   */
  taskAsks: (input: Scope, n: number) => TaskAsk[] | PortError | undefined;
  /** 起会话：给了就抛它（假的「发给别家的材料没过卫生检查」……）；n = 这个阶段第几次起。 */
  startSession: (input: LaunchSessionInput, n: number) => PortError | undefined;
  ci: (input: WaitCiInput, n: number) => Partial<CiResult> | undefined;
  /**
   * 这个 PR 碰没碰先审后合的路径（#253）：给了 PortError 就抛它（假的「清单读不到」……）；给了数组就当命中的（不给就是
   * 空的，不高风险）。n = 第几次查（从 1 开始）。
   */
  highRisk: (input: CheckHighRiskInput, n: number) => RiskyFile[] | PortError | undefined;
  /**
   * 第二意见的结论写回 GitHub（#253）：给了 PortError 就抛它（假的「贴状态没权限」……）；n = 第几次贴（从 1 开始）。
   */
  postSecondOpinion: (
    input: PostSecondOpinionInput,
    n: number,
  ) => PostSecondOpinionResult | PortError | undefined;
  sync: (input: SyncMainlineInput, n: number) => Partial<SyncResult> | undefined;
  tests: (input: RunTestsInput, n: number) => Partial<TestResult> | undefined;
  merge: (input: MergePrInput, n: number) => Partial<MergeOutcome> | undefined;
  /** 推分支：给了就抛它（假的卫生检查拦下、名单没读到……）；n = 第几次推（从 1 开始）。 */
  push: (input: PushBranchInput, n: number) => PortError | undefined;
  /**
   * 推上去的头相对主线的净改动（推分支交回的 changedFiles）；n 同 push。不给就不交：老版端口的样子，Fusion 照会话交的
   * 累计算。
   */
  pushed: (input: PushBranchInput, n: number) => string[] | undefined;
  /** 开 PR：给了就抛它（假的卫生检查拦下标题或正文……）；n = 第几次开（从 1 开始）。 */
  openPr: (input: OpenPrInput, n: number) => PortError | undefined;
  /** 写需求文档、方案、结果进主线：给了就抛它；n = 第几次写（三种文档一起数，从 1 开始）。 */
  specDoc: (input: WriteSpecDocInput, n: number) => PortError | undefined;
  /** 写 issue 进度段：给了就抛它（假的卫生检查拦下子任务标题……）；n = 第几次写（从 1 开始）。 */
  progress: (input: UpdateIssueProgressInput, n: number) => PortError | undefined;
  route: (input: PickRouteInput, n: number) => PickRouteResult | undefined;
  /** 前 N 次调用抛可重试的 TRANSIENT。 */
  failFirst: Partial<Record<PortName, number>>;
  /** 前 N 次调用做完了再抛可重试的 TRANSIENT（事办成了、回话丢了：重试时考的是幂等）。 */
  failAfter: Partial<Record<PortName, number>>;
  /** 每次调用先等这么久（测串行、并发用）。 */
  delayMs: Partial<Record<PortName, number>>;
  /** 这几个端口的调用挂着不返回，直到 releasePort（要控制先后时用它，别赌延时够不够长）。 */
  holdPorts: PortName[];
  heartbeatMs: number;
  routes: RouteChoice[];
}

export interface FakeCall {
  port: PortName;
  input: unknown;
  attempt: number;
  at: number;
  end: number | null;
  ok: boolean | null;
}

export interface FakeSession {
  id: string;
  runId: string;
  stage: StageKind;
  input: LaunchSessionInput;
  plan: FakeSessionPlan;
  n: number;
  released: boolean;
  stopped: boolean;
  watching: boolean;
}

export interface FakeWorld {
  ports: EnginePorts;
  calls: FakeCall[];
  timings: TimingEntry[];
  /** 写进「库」的任务状态，按写入顺序。 */
  states: TaskStateSnapshot[];
  sessions: Map<string, FakeSession>;
  /** 真起了进程的 runId，每起一次记一次（同一个 runId 出现两次 = 起了两个会话）。 */
  spawned: string[];
  /** 发出去的提问卡片（按 askId 去重后的）。 */
  asks: AskHumanInput[];
  /** 发出去的批准卡片（按 approvalId 去重后的）。 */
  approvals: RequestApprovalInput[];
  /** 报过的警（按调用顺序，含重复的 dedupeKey）。 */
  alerts: RaiseAlertInput[];
  /** 写进「库」的验证记录（同一个 id 整行覆盖，和真库一样），按第一次写入的先后。 */
  verifications: VerificationRecord[];
  /**
   * 「库」里的提问（asks 表，#259）：测试往里放会话 fleet ask 问的、改回答（模拟他晚到的回答）；taskAsks 按任务读它，
   * markAsksApplied 照改 applied。引擎自己问的（askHuman）也记一份进来。
   */
  askRows: (TaskAsk & { taskId: string })[];
  callsOf<P extends PortName>(port: P): (FakeCall & { input: Parameters<EnginePorts[P]>[0] })[];
  count(port: PortName): number;
  /** 放行一个挂着的会话。 */
  release(sessionId: string): void;
  /** 放行 holdPorts 挂着的那个端口（挂着的和以后的调用都不再挂）。 */
  releasePort(port: PortName): void;
  /** 正挂着、有人在看守的会话。 */
  held(): FakeSession[];
  /**
   * 等到 check 成立：假世界每变一下（端口调用开始、结束，会话开始看守，放行）当场重查，不按钟点轮询。check 只能看假世界里的
   * 东西（调用、会话、写进库的状态……），要看 Temporal 查询结果的用 test/support.ts 的 queryUntil。
   * timeoutMs 内没等到就报错、写明在等什么，不无限挂着；check 抛错原样报出来。
   */
  until(check: () => boolean, what: string, timeoutMs?: number): Promise<void>;
}

export const FAKE_ROUTES: readonly RouteChoice[] = [
  { routeId: 'r1', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
  { routeId: 'r2', poolId: 'p2', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
  { routeId: 'r3', poolId: 'p3', modelId: 'm2', family: 'kimi', hostId: 'api-shell' },
];

const DOC_FILE = { requirement: '需求.md', plan: '方案.md', result: '结果.md' } as const;

/**
 * 假端口的流程配置（合并过全组织默认的整份，core 的 FlowConfig 形状）：每一步的模型用 FAKE_ROUTES 里的模型——
 * Lead 是 m1（claude 族），副手先 m2（kimi 族）再 m1，验证先 m3（gpt 族，FAKE_ROUTES 里没有，要验证的用例自己加一条）再 m2。
 */
export const FAKE_FLOW_CONFIG = {
  formatVersion: 1,
  profiles: {
    default: {
      mode: 'fusion',
      steps: { lead: ['m1'], sidekick: ['m2', 'm1'], review: [], verify: ['m3', 'm2'], discuss: ['m3'] },
      review: { vendors: 0, rounds: 1 },
      verify: { rounds: 2 },
      discuss: { vendors: 1, rounds: 1 },
    },
    single: {
      mode: 'single',
      steps: { lead: ['m1'], sidekick: [], review: [], verify: ['m3', 'm2'], discuss: ['m3'] },
      review: { vendors: 0, rounds: 1 },
      verify: { rounds: 1 },
      discuss: { vendors: 1, rounds: 1 },
    },
  },
  categoryProfiles: { 需求: 'default', 缺陷: 'default', 杂项: 'default' },
  bans: [
    { id: 'gpt-no-ui', reason: 'GPT 不做界面类的活' },
    { id: 'no-fable', reason: '不用 Fable' },
  ],
  testCommand: 'pnpm test:changed',
  highRiskPaths: [],
  uiPaths: ['web/'],
} as const;

/** 假 Lead 默认写的任务简报：只许改 src/login/。 */
export const FAKE_BRIEF: Brief = {
  goal: '登录页加验证码',
  scope: '只改登录表单和校验',
  constraints: [],
  files: ['src/login/'],
  acceptance: ['验证码五分钟过期'],
  returnFormat: '改了哪些文件、测试结果',
};

/** 假的提交号：40 位（验证、方案交回的都要完整提交号），末尾是序号。 */
export function fakeHead(n: number): string {
  return `${n}`.padStart(40, 'f');
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve());
  });
}

export function createFakeWorld(script: Partial<FakeScript> = {}): FakeWorld {
  const calls: FakeCall[] = [];
  const timings: TimingEntry[] = [];
  const states: TaskStateSnapshot[] = [];
  const sessions = new Map<string, FakeSession>();
  const spawned: string[] = [];
  const asks: AskHumanInput[] = [];
  const approvals: RequestApprovalInput[] = [];
  const alerts: RaiseAlertInput[] = [];
  const verifications: VerificationRecord[] = [];
  const askRows: (TaskAsk & { taskId: string })[] = [];
  /** 和真实现一样按 runId 幂等：起过的原样返回，叫停过的不再起。 */
  const byRun = new Map<string, StartSessionResult>();
  const stoppedRuns = new Set<string>();
  const heldPorts = new Set<PortName>(script.holdPorts ?? []);
  const counters = new Map<string, number>();
  const prByBranch = new Map<string, number>();
  const heartbeatMs = script.heartbeatMs ?? 50;
  const routes = script.routes ?? [...FAKE_ROUTES];
  let seq = 0;
  const next = (key: string) => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return n;
  };
  /** until 挂着的等待：假世界每变一下都叫一遍，各自重查自己的条件。 */
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const probe of [...waiters]) probe();
  };

  /** 假会话「改了」哪些文件：照交代的地方各改一个（以 / 结尾的是目录）。 */
  const filesOf = (brief: LaunchSessionInput['brief']) =>
    brief.touches.map((t) =>
      t === '*' ? 'README.md' : t.endsWith('/') ? `${t}changed.ts` : `${t}/changed.ts`,
    );

  /** 假 Lead 每一步默认交回一份合格的。 */
  const leadOutput = (s: FakeSession, step: LeadStep): SessionOutput => {
    const lead = s.input.brief.lead;
    const docs = lead?.docs ?? { requirement: '', plan: '', result: '' };
    switch (step) {
      case 'plan':
        seq += 1;
        return {
          kind: 'lead-plan',
          head: fakeHead(seq),
          // 还没有需求文档的单（#295）：照交代把引擎照正文写好的那份和方案一起提交
          changedFiles: lead?.requirementText ? [docs.requirement, docs.plan] : [docs.plan],
          summary: '登录表单加验证码输入，后端校验五分钟过期',
          brief: FAKE_BRIEF,
          small: true,
          highRisk: false,
          holds: [],
        };
      case 'accept':
        return { kind: 'lead-verdict', verdict: 'accept', why: '看过改动，和简报一致，测试齐' };
      case 'rebut':
        return { kind: 'lead-rebut', rebuttals: [] };
      case 'fix-brief':
        return { kind: 'lead-brief', brief: { ...FAKE_BRIEF, goal: '照返工意见修好' } };
      case 'review':
        seq += 1;
        return {
          kind: 'lead-review',
          verdict: 'pass',
          why: '改动和方案一致，CI 绿',
          did: ['登录页加了验证码'],
          owed: [],
          head: fakeHead(seq),
          changedFiles: [docs.result],
        };
      case 'pr-text':
        return { kind: 'lead-text', summary: '登录表单加验证码', did: ['加了验证码输入'] };
      case 'takeover':
        seq += 1;
        return {
          kind: 'delivery',
          head: fakeHead(seq),
          summary: `Lead 自己写完：${s.input.brief.title}`,
          testsPassed: true,
          changedFiles: filesOf(s.input.brief),
        };
    }
  };

  const outputFor = (s: FakeSession): SessionOutput => {
    if (s.plan.output) return s.plan.output;
    const brief = s.input.brief;
    if (brief.lead) {
      const step = brief.lead.step;
      return script.lead?.(step, s.input, next(`lead:${step}`)) ?? leadOutput(s, step);
    }
    switch (s.stage) {
      case 'triage':
        return {
          kind: 'triage',
          verdict: script.triage?.(s.n) ?? { clear: true, summary: `理解为：${brief.title}` },
        };
      case 'spec':
        return { kind: 'doc', markdown: `# 需求：${brief.title}\n\n${brief.request}\n` };
      case 'plan':
        return {
          kind: 'plan',
          markdown: `# 方案：${brief.title}\n`,
          subtasks: script.plan ?? [{ key: 'main', title: brief.title, touches: ['src'] }],
        };
      case 'review': {
        const review = script.review?.(s.input, s.n) ?? { verdict: 'pass', findings: [] };
        return { kind: 'review', review: { ...review, head: brief.head ?? '' } };
      }
      case 'verify': {
        const scripted = script.verify?.(s.input, s.n);
        const report =
          scripted ??
          ({
            head: brief.head ?? '',
            results: (brief.verify?.criteria ?? []).map((criterion) => ({
              criterion,
              answer: 'done' as const,
              evidence: '假验证：看过改动',
            })),
            findings: [],
          } satisfies VerifyReport);
        return { kind: 'verify', report: report as VerifyReport };
      }
      default:
        seq += 1;
        return {
          kind: 'delivery',
          // Fusion 的副手（照任务简报干的）交完整提交号：后面的验证、方案都认 40 位的
          head: brief.task ? fakeHead(seq) : `${s.input.subtaskKey ?? 'x'}-${seq}`,
          summary: `做完：${brief.title}`,
          testsPassed: true,
          // 老老实实改方案点名的地方。
          changedFiles: filesOf(brief),
        };
    }
  };

  /** 和真执行体一样：token 报这一次的，花费报会话累计的（同一个会话每跑一次加 1 分钱）。 */
  const costTotals = new Map<string, number>();
  const usageOf = (sessionId: string) => {
    const sessionCostUsd = Math.round(((costTotals.get(sessionId) ?? 0) + 0.01) * 100) / 100;
    costTotals.set(sessionId, sessionCostUsd);
    return { usage: { inputTokens: 100, outputTokens: 10 }, sessionCostUsd };
  };

  const endFor = (s: FakeSession): SessionEnd => {
    const spent = usageOf(s.id);
    if (s.stopped) return { sessionId: s.id, outcome: 'stopped', ...spent };
    const outcome = s.plan.outcome ?? 'done';
    if (outcome === 'done') return { sessionId: s.id, outcome, output: outputFor(s), ...spent };
    if (outcome === 'blocked') {
      return {
        sessionId: s.id,
        outcome,
        ...spent,
        blocked: {
          reason: s.plan.blocked?.reason ?? '需要人回答',
          needs: s.plan.blocked?.needs ?? 'human',
          ...(s.plan.blocked?.question ? { question: s.plan.blocked.question } : {}),
          ...(s.plan.blocked?.options ? { options: s.plan.blocked.options } : {}),
        },
      };
    }
    const failure = s.plan.failure ?? { code: outcome === 'stalled' ? 'SESSION_STALLED' : 'SESSION_FAILED' };
    return {
      sessionId: s.id,
      outcome,
      ...spent,
      failure: {
        code: failure.code,
        message: failure.message ?? `假会话${outcome === 'stalled' ? '没动静' : '失败'}`,
        ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
        ...(failure.jev ? { jev: failure.jev } : {}),
      },
    };
  };

  const impl: EnginePorts = {
    async pickRoute(input) {
      const scripted = script.route?.(input, next('pickRoute'));
      if (scripted) return scripted;
      // 整族避开（开 PR 前验证只派别家）：点名的、续会话的也照样避开，和真选路一样。给验证留一家时副手先避开的族
      // （keepVerifier.spare）这里也一律避开：假世界不排验证那一步的路由，判不了别家会不会让验证没人可派——和真选路
      // 没有候选会让验证落空时一样（给验证留一家的真判法测在 test/routing/verifier.test.ts、test/real/store-ports.test.ts）
      const families = new Set(
        [...(input.avoidFamilies ?? []), ...(input.keepVerifier?.spare ?? [])].map((f) =>
          f.trim().toLowerCase(),
        ),
      );
      // 流程配置的模型顺序：只派这几个模型的路由，按这个先后（和真选路一样）
      const models = input.models;
      const usable = routes
        .filter(
          (r) =>
            !input.avoidRouteIds.includes(r.routeId) &&
            !input.avoidPoolIds.includes(r.poolId) &&
            !input.avoidModelIds.includes(r.modelId) &&
            !families.has(r.family.toLowerCase()) &&
            (!models || models.includes(r.modelId)),
        )
        .sort((a, b) => (models ? models.indexOf(a.modelId) - models.indexOf(b.modelId) : 0));
      const preferred = input.preferRouteId
        ? usable.find((r) => r.routeId === input.preferRouteId)
        : undefined;
      // 续同一个会话：还是那一条（和真选路一样，避开的照样不派）。
      const stuck = input.stickRouteId ? usable.find((r) => r.routeId === input.stickRouteId) : undefined;
      const route = preferred ?? stuck ?? usable[0];
      if (!route) {
        return {
          ok: false,
          waitFor: 'none',
          detail:
            families.size > 0
              ? `没有别家可验：写这张单的是 ${[...families].join('、')} 族，这一步只派别家，不拿同族顶`
              : models
                ? `流程配置里这一步的模型（${models.join('、') || '一个都没配'}）没有能派的路由`
                : '能用的路由都被避开了',
        };
      }
      return {
        ok: true,
        route,
        why: preferred ? '点名的路由' : stuck ? '续同一个会话' : '排第一的可用路由',
      };
    },
    async startSession(input) {
      const known = byRun.get(input.runId);
      if (known) return known;
      if (stoppedRuns.has(input.runId)) {
        throw new PortError('SESSION_STOPPED', `会话 ${input.runId} 已经叫停，不再起`, { retryable: false });
      }
      const n = next(`session:${input.stage}`);
      const own = next(`session:${input.stage}:${input.subtaskKey ?? '-'}`);
      const refused = script.startSession?.(input, n);
      if (refused) throw refused;
      const id = input.resumeSessionId ?? `s${next('sessionId')}`;
      sessions.set(id, {
        id,
        runId: input.runId,
        stage: input.stage,
        input,
        plan: script.session?.(input, n, own) ?? {},
        n,
        released: false,
        stopped: false,
        watching: false,
      });
      spawned.push(input.runId);
      const started: StartSessionResult = {
        sessionId: id,
        resumed: Boolean(input.resumeSessionId),
        handle: { pid: 40_000 + next('pid'), scope: `fleet-agent-${input.runId}.scope` },
      };
      byRun.set(input.runId, started);
      return started;
    },
    async awaitSession(input, ctx) {
      const s = sessions.get(input.sessionId);
      if (!s || s.runId !== input.runId) {
        throw new PortError('SESSION_LOST', `接不上会话 ${input.sessionId}`, { retryable: false });
      }
      if (s.plan.loseFirstWatch && ctx.attempt === 1) {
        // 工人「没了」：不心跳、不返回，直到这个进程里的工人关掉。
        await aborted(ctx.signal);
        throw new Error('看守随工人一起没了');
      }
      s.watching = true;
      changed();
      try {
        while (s.plan.hold && !s.released && !s.stopped && !ctx.signal.aborted) {
          ctx.heartbeat({ sessionId: s.id });
          await pause(heartbeatMs, ctx.signal);
        }
      } finally {
        s.watching = false;
      }
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('取消');
      return endFor(s);
    },
    async stopSession(input) {
      stoppedRuns.add(input.runId);
      const started = byRun.get(input.runId);
      const s = started ? sessions.get(started.sessionId) : undefined;
      if (s && s.runId === input.runId) s.stopped = true;
    },
    async createWorktree(input) {
      return {
        path: `/fake/worktrees/${input.taskId}/${input.subtaskKey ?? 'main'}`,
        branch: input.branch,
        baseSha: 'base',
      };
    },
    async removeWorktree(input) {
      return {
        removed: true,
        gone: false,
        ...(input.archive
          ? { archivedTo: `/fake/archive/${input.taskId}/${input.subtaskKey ?? 'main'}` }
          : {}),
      };
    },
    async pushBranch(input) {
      const n = next('pushBranch');
      const refused = script.push?.(input, n);
      if (refused) throw refused;
      const changedFiles = script.pushed?.(input, n);
      return { head: input.head, ...(changedFiles ? { changedFiles } : {}) };
    },
    async runTests(input) {
      return { passed: true, head: input.head, summary: '全绿', ...script.tests?.(input, next('runTests')) };
    },
    async openPr(input) {
      const refused = script.openPr?.(input, next('openPr'));
      if (refused) throw refused;
      let pr = prByBranch.get(input.branch);
      if (pr === undefined) {
        pr = 100 + prByBranch.size;
        prByBranch.set(input.branch, pr);
      }
      return { prNumber: pr };
    },
    async waitCi(input) {
      return { state: 'green', head: input.head, failedChecks: [], ...script.ci?.(input, next('waitCi')) };
    },
    async checkHighRisk(input) {
      const scripted = script.highRisk?.(input, next('checkHighRisk'));
      if (scripted instanceof PortError) throw scripted;
      return { hits: scripted ?? [] };
    },
    async postSecondOpinion(input) {
      const scripted = script.postSecondOpinion?.(input, next('postSecondOpinion'));
      if (scripted instanceof PortError) throw scripted;
      return scripted ?? {};
    },
    async syncMainline(input) {
      return {
        state: 'clean',
        head: input.head,
        conflictFiles: [],
        ...script.sync?.(input, next('syncMainline')),
      };
    },
    async mergePr(input) {
      const n = next('mergePr');
      return { merged: true, mergeCommit: `mc-${input.prNumber}-${n}`, ...script.merge?.(input, n) };
    },
    async updateIssueProgress(input) {
      const refused = script.progress?.(input, next('updateIssueProgress'));
      if (refused) throw refused;
    },
    async saveTaskState(input) {
      states.push(input);
    },
    async closeIssue() {},
    async writeSpecDoc(input) {
      const refused = script.specDoc?.(input, next('writeSpecDoc'));
      if (refused) throw refused;
      return { path: `${input.specDir}/${DOC_FILE[input.doc]}` };
    },
    async readCriteria(input) {
      const scripted = script.criteria?.(input, next('readCriteria'));
      if (scripted instanceof PortError) throw scripted;
      return (
        scripted ?? {
          path: `${input.specDir}/${DOC_FILE.requirement}`,
          criteria: ['照原话做完', '有一条故意造出失败的测试'],
        }
      );
    },
    async authorFamilies(input) {
      const scripted = script.authors?.(input, next('authorFamilies'));
      if (scripted instanceof PortError) throw scripted;
      const families =
        scripted ??
        [
          ...new Set(
            [...sessions.values()]
              .filter((s) => s.input.taskId === input.taskId && s.stage !== 'verify' && s.stage !== 'review')
              .map((s) => s.input.route.family),
          ),
        ].sort();
      if (families.length === 0) {
        throw new PortError(
          'AUTHORS_UNKNOWN',
          `任务 ${input.taskId} 一个起过的会话都查不到：不知道写它的是哪一族，判不了验证模型是不是别家，不验`,
          { retryable: false },
        );
      }
      return { families };
    },
    async recordVerification(input) {
      const at = verifications.findIndex((v) => v.id === input.id);
      if (at >= 0) verifications[at] = input;
      else verifications.push(input);
    },
    async flowConfig(input) {
      const scripted = script.flow?.(input, next('flowConfig'));
      if (scripted instanceof PortError) throw scripted;
      return (
        scripted ?? {
          replica: {
            syncedAt: new Date().toISOString(),
            error: null,
            unread: null,
            testCommand: FAKE_FLOW_CONFIG.testCommand,
          },
          source: 'project',
          config: FAKE_FLOW_CONFIG,
        }
      );
    },
    async taskRequest(input) {
      const scripted = script.request?.(input, next('taskRequest'));
      if (scripted instanceof PortError) throw scripted;
      if (scripted) return scripted;
      throw new PortError('TASK_NOT_FOUND', `库里没有任务 ${input.taskId}（假端口没给单子正文）`, {
        retryable: false,
      });
    },
    async askHuman(input) {
      if (!asks.some((a) => a.askId === input.askId)) asks.push(input);
      if (!askRows.some((a) => a.id === input.askId)) {
        askRows.push({
          id: input.askId,
          taskId: input.taskId,
          question: input.question,
          options: input.options ?? [],
          applied: false,
          ...(input.recommended ? { scope: 'task' as const, recommended: input.recommended } : {}),
        });
      }
    },
    async taskAsks(input) {
      const scripted = script.taskAsks?.(input, next('taskAsks'));
      if (scripted instanceof PortError) throw scripted;
      if (scripted) return scripted;
      return askRows.filter((a) => a.taskId === input.taskId).map(({ taskId: _task, ...a }) => ({ ...a }));
    },
    async markAsksApplied(input) {
      for (const a of askRows) {
        if (a.taskId === input.taskId && input.askIds.includes(a.id) && a.answer !== undefined)
          a.applied = true;
      }
    },
    async requestApproval(input) {
      if (!approvals.some((a) => a.approvalId === input.approvalId)) approvals.push(input);
    },
    async raiseAlert(input) {
      alerts.push(input);
      return { alertId: `alert-${next('alert')}` };
    },
    async recordTiming(input) {
      timings.push(input);
    },
  };

  const ports = {} as Record<PortName, (input: unknown, ctx: PortContext) => Promise<unknown>>;
  for (const name of Object.keys(impl) as PortName[]) {
    const fn = impl[name] as (input: unknown, ctx: PortContext) => Promise<unknown>;
    ports[name] = async (input, ctx) => {
      const call: FakeCall = { port: name, input, attempt: ctx.attempt, at: Date.now(), end: null, ok: null };
      calls.push(call);
      changed();
      try {
        while (heldPorts.has(name) && !ctx.signal.aborted) await pause(heartbeatMs, ctx.signal);
        const delay = script.delayMs?.[name] ?? 0;
        if (delay > 0) await pause(delay, ctx.signal);
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('取消');
        const failures = script.failFirst?.[name] ?? 0;
        if (failures > 0 && calls.filter((c) => c.port === name).length <= failures) {
          throw new PortError('TRANSIENT', `${name} 假失败`, { retryable: true });
        }
        const out = await fn(input, ctx);
        const lostReplies = script.failAfter?.[name] ?? 0;
        if (lostReplies > 0 && calls.filter((c) => c.port === name).length <= lostReplies) {
          throw new PortError('TRANSIENT', `${name} 做完了、回话丢了（假）`, { retryable: true });
        }
        call.ok = true;
        return out;
      } catch (error) {
        call.ok = false;
        throw error;
      } finally {
        call.end = Date.now();
        changed();
      }
    };
  }

  return {
    ports: ports as unknown as EnginePorts,
    calls,
    timings,
    states,
    sessions,
    spawned,
    asks,
    approvals,
    alerts,
    verifications,
    askRows,
    callsOf: (<P extends PortName>(port: P) => calls.filter((c) => c.port === port)) as FakeWorld['callsOf'],
    count: (port) => calls.filter((c) => c.port === port).length,
    release(sessionId) {
      const s = sessions.get(sessionId);
      if (s) s.released = true;
      changed();
    },
    releasePort(port) {
      heldPorts.delete(port);
      changed();
    },
    held: () => [...sessions.values()].filter((s) => s.plan.hold && !s.released && !s.stopped && s.watching),
    until(check, what, timeoutMs = 20_000) {
      return new Promise<void>((resolve, reject) => {
        const settle = (error?: unknown) => {
          waiters.delete(probe);
          clearTimeout(timer);
          if (error === undefined) resolve();
          else reject(error);
        };
        const probe = () => {
          try {
            if (check()) settle();
          } catch (error) {
            settle(error ?? new Error(`查「${what}」时出错`));
          }
        };
        const timer = setTimeout(
          () => settle(new Error(`等了 ${timeoutMs} 毫秒还没等到：${what}`)),
          timeoutMs,
        );
        waiters.add(probe);
        probe();
      });
    },
  };
}
