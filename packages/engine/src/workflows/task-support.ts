// 任务工作流（task.ts）的无状态小零件：放弃的异常、失败分流计数、选路时要避开的东西。全是纯函数，不碰活动、不取时间。
// 这里是工作流代码，会被重放：别加随机数、Date、Node 自带模块（test/structure.test.ts 会拦）。

import type { AvoidScope, LadderCounters, NextAction } from '../decisions/failure.ts';
import type { RouteChoice } from '../ports.ts';
import {
  type AbandonCommand,
  type PauseCommand,
  type RepinCommand,
  SELF_CHECK_DIGEST_MAX,
  type SelfCheckResult,
} from '../task-contract.ts';

/** 放弃：从各处抛到最外层收尾。 */
export class Abandoned extends Error {
  readonly command: AbandonCommand;
  constructor(command: AbandonCommand) {
    super(`被 ${command.by} 放弃：${command.reason}`);
    this.name = 'Abandoned';
    this.command = command;
  }
}

/** hard 暂停把正在跑的动手会话取消了（#820 片 3）：从 cancellable 抛到动手会话那一段，那里按「被人暂停」接着停、等继续后重跑。 */
export class PausedInterrupt extends Error {
  readonly command: PauseCommand;
  constructor(command: PauseCommand) {
    super(`被 ${command.by} 暂停`);
    this.name = 'PausedInterrupt';
    this.command = command;
  }
}

/** 「现在就换」把正在跑的动手会话取消了（#1216）：从 cancellable 抛到动手会话那一段，那里不停下等人，直接回选路、按新指定的模型原分支重跑。 */
export class RepinInterrupt extends Error {
  readonly command: RepinCommand;
  constructor(command: RepinCommand) {
    super(`${command.by} 要求现在就换模型`);
    this.name = 'RepinInterrupt';
    this.command = command;
  }
}

/**
 * 下一次动手会话打算续哪一段（决定 0088）：被暂停取消的那一段拿不到执行编号，记起跑时刻（startedAfter）让活动去库里找；
 * 跑完了的那一段记编号。worktreePath 是那一段的工作树，换了树不续（会话记录按目录存）。
 */
export interface ResumeFrom {
  previous: { runId: string } | { startedAfter: string };
  worktreePath: string;
}

/** 找被取消那一段的起跑时刻往前放宽多少（毫秒）：工作流的时刻和活动写库的时刻都在法国这台机器上，留几秒余量。 */
export const RESUME_STARTED_SLACK_MS = 5_000;

/** 上一次跑成的动手会话（决定 0093 返工续会话）：返工轮续它；resumed 是它自己是不是续起来的（数连着续了几轮）。 */
export interface LastSession {
  runId: string;
  worktreePath: string;
  resumed: boolean;
}

/** 连着这么多轮续会话还没过，下一轮清空开新会话（决定 0093）。 */
export const RESUME_STREAK_LIMIT = 2;
/** 清空重来时每条返工意见最多留多少字：新会话要的是精炼过的失败摘要，不是上一轮的整份日志。 */
export const FRESH_FEEDBACK_LINE_MAX = 1500;

/** 连着续了两轮还没过：下一轮开新会话，返工意见精炼成这样（第一行写明为什么是新会话）。 */
export function freshSessionFeedback(feedback: readonly string[]): string[] {
  const lines = feedback.map((line) =>
    line.length > FRESH_FEEDBACK_LINE_MAX ? `${line.slice(0, FRESH_FEEDBACK_LINE_MAX)}…（后面省略）` : line,
  );
  return [
    `前 ${RESUME_STREAK_LIMIT} 轮续着同一个会话改都没过，这一轮开新会话从头看：树里是上几轮的提交，下面是还没解决的问题。`,
    ...lines,
  ];
}

/** 自测红了续进会话的那一句（第一行），后面跟精炼输出。 */
export const SELF_CHECK_RED_LINE = '引擎在你交活之后跑了测试和类型检查，没过。改到它过再提交：';

/** 自测的精炼输出合成一段（喂回会话、交给冷验收都用这一份）：每条命令一节，限 SELF_CHECK_DIGEST_MAX 字。 */
export function selfCheckText(result: SelfCheckResult): string {
  const parts = result.steps.map((s) => {
    const mark =
      s.outcome === 'pass' ? '过了' : s.outcome === 'fail' ? `没过（退出码 ${s.exitCode}）` : '没跑';
    return `$ ${s.command}：${mark}\n${s.digest}`;
  });
  if (result.state === 'skipped' && parts.length === 0) parts.push(`没跑成：${result.reason}`);
  const text = parts.join('\n\n');
  return text.length > SELF_CHECK_DIGEST_MAX ? `${text.slice(0, SELF_CHECK_DIGEST_MAX - 1)}…` : text;
}

/**
 * 单任务 token 预算超了停下时写给人的话（决定 0093）。tokens 是算进判断的合计（量到的 + 估的）；分不清的传 estimated: 0。
 * 估的那部分（被叫停的会话按量到的行推出来的下限）在人话里写明白是估的，别当成量到的。
 */
export function tokenBudgetStop(
  spent: { tokens: number; unmetered: number },
  budget: number,
  grants: number,
  split: { measured: number; estimated: number } = { measured: spent.tokens, estimated: 0 },
): { title: string; detail: string } {
  const m = (n: number) => `${(n / 1_000_000).toFixed(1)}M`;
  const allowed = budget * grants;
  const unmetered = spent.unmetered > 0 ? `（另有 ${spent.unmetered} 次会话用量还没补上，实际只多不少）` : '';
  const splitText =
    split.estimated > 0
      ? `（其中 ${split.measured} 是量到的，另 ${split.estimated} 是拿这张单量到的行估出来的下限：被叫停的会话记不到用量）`
      : '';
  return {
    title: `这张单花掉的 token 超了预算（${m(spent.tokens)} / ${m(allowed)}）`,
    detail:
      `动手和验收会话合计花掉 ${spent.tokens} token${splitText}${unmetered}，超过 ${allowed}（单任务预算 ${budget}` +
      `${grants > 1 ? ` × 已给 ${grants} 份` : ''}）。预算按近 14 天每张单花费的 p95 定（决定 0093）。` +
      '点「继续」再给一份同样多的接着干；不要了点「放弃」。',
  };
}

export const ZERO: LadderCounters = { retries: 0, reworks: 0, routeSwaps: 0, modelSwaps: 0 };

export interface Avoid {
  routeIds: string[];
  poolIds: string[];
  modelIds: string[];
  /**
   * 整族避开的作者族（决定 0093，换路由按族避开：同族换个模型多半重蹈覆辙）。只有自动处理时换路由（rt.avoidModel）会加；
   * 别的族一条都派不出时选路退回只避开模型（task-session.ts 的 pickRoute）。老历史里没有。
   */
  families?: string[];
}
export const NO_AVOID: Avoid = { routeIds: [], poolIds: [], modelIds: [] };

/** 一轮 CI 等下来该干什么。skip＝等的时候仓切成了不强制 CI，调用方直接合并。 */
export type CiStep =
  | { kind: 'green' }
  | { kind: 'merged'; mergeCommit?: string | undefined }
  | { kind: 'rework' }
  | { kind: 'skip' };

/** 不强制 CI 的仓，动手会话交活前要自己跑通。引擎这一路不设闸门。 */
export const SKIP_CI_SELF_VERIFY =
  '这个仓不强制 CI：交活前自己跑通（能起来，碰界面的贴截图）。引擎这一路不设 CI 和冷验收闸门。';

/** 不强制 CI 的仓，开 PR 正文里「验证」那一行。 */
export const SKIP_CI_PR_VERIFIED =
  '这个仓不强制 CI：交活前自己跑通（能起来，碰界面的贴截图）。引擎直接合并，不等 CI、不做冷验收';

/** 强制 CI 的仓一个检查都没有：停下等人，这句话要出现在提醒里。 */
export const FORCE_CI_NO_CHECKS = '这个仓是强制 CI，但没配检查';

/**
 * unknown 是不是「仓里没配检查」。超时、读失败不算：那两种照旧停下，不写成没配检查。
 * 活动的原文见 real/github-ports.ts 的 ciResultOf（missing →「根本没跑」）。
 */
export function ciUnknownIsNoChecks(detail: string | undefined): boolean {
  if (!detail) return false;
  if (detail.includes('CI 没在限时内跑完') || detail.includes('CI 没查成：')) return false;
  return detail.includes('没有检查') || detail.includes('根本没跑') || detail.includes('一个检查');
}

/** 验收停下的原因类别（#1404）。通知第一行、整理提示词都用这三份，不另写一份字符串。 */
export const VERIFY_STOP_UNPROVABLE = '验收条在 diff 里证不了';
export const VERIFY_STOP_OUT_OF_SCOPE = 'PR 改了范围外的文件';
export const VERIFY_STOP_OTHER = '其它';

/** 整理会话用 amend 补验收条的两类（#1465）。「其它」不进那一节。两类都沾上时先算证不了。 */
export const GROOM_VERIFY_STOP_CATEGORIES = [VERIFY_STOP_UNPROVABLE, VERIFY_STOP_OUT_OF_SCOPE] as const;

const UNPROVABLE_MARKS = ['无法证明', 'diff 未包含', '无法确认'] as const;
const OUT_OF_SCOPE_MARKS = ['额外修改', '范围外'] as const;

export function verifyStopCategory(original: string): string {
  if (UNPROVABLE_MARKS.some((mark) => original.includes(mark))) return VERIFY_STOP_UNPROVABLE;
  if (OUT_OF_SCOPE_MARKS.some((mark) => original.includes(mark))) return VERIFY_STOP_OUT_OF_SCOPE;
  return VERIFY_STOP_OTHER;
}

/**
 * 验收停下的通知正文：第一行是原因类别，后面接冷验收原话。
 * 认不出的归「其它」，原话照样留下，不吞掉。feedback 里的「验收没过：」前缀不算原话。
 */
export function verifyStopDetail(problems: readonly string[]): string {
  const original = problems
    .map((line) => line.replace(/^验收没过：/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  const category = verifyStopCategory(original);
  return original.length > 0 ? `${category}\n${original}` : category;
}

/** 头被别人改了，停下等人时写的话：点「继续」之后引擎对新的头重跑 CI 和验收，不是原样接着等。 */
export function headMovedDetail(now: string, pushed: string): string {
  return `现在的头是 ${now}，不是引擎验过、推上去的 ${pushed}。看过之后点「继续」：引擎会对新的头重跑 CI 和验收；不要这个 PR 了点「放弃」。`;
}

export function bump(counters: LadderCounters, next: NextAction): LadderCounters {
  const key =
    next.counter === undefined
      ? ({ retry: 'retries', swapRoute: 'routeSwaps', swapModel: 'modelSwaps', park: null } as const)[
          next.action
        ]
      : next.counter;
  return key ? { ...counters, [key]: (counters[key] ?? 0) + 1 } : counters;
}

export function widen(avoid: Avoid, route: RouteChoice, scope: AvoidScope): Avoid {
  const add = (list: string[], id: string) => (list.includes(id) ? list : [...list, id]);
  if (scope === 'pool') return { ...avoid, poolIds: add(avoid.poolIds, route.poolId) };
  if (scope === 'model') return { ...avoid, modelIds: add(avoid.modelIds, route.modelId) };
  return { ...avoid, routeIds: add(avoid.routeIds, route.routeId) };
}

function unionIds(left: readonly string[], right: readonly string[]): string[] {
  const out = [...left];
  for (const id of right) if (!out.includes(id)) out.push(id);
  return out;
}

/** 两份避让并成一份。顺序保持先左后右，同一编号不重复。两边都没有族的避让就不带 families（选路参数和老历史一样）。 */
export function mergeAvoid(left: Avoid, right: Avoid): Avoid {
  const families = unionIds(left.families ?? [], right.families ?? []);
  return {
    routeIds: unionIds(left.routeIds, right.routeIds),
    poolIds: unionIds(left.poolIds, right.poolIds),
    modelIds: unionIds(left.modelIds, right.modelIds),
    ...(families.length > 0 ? { families } : {}),
  };
}

/** 这条路由算哪一族（换路由按族避开用）：选路给的作者族，老历史里没有照 family；认不出（unclassified、空）回 null，不整族避开。 */
export function avoidableFamily(route: RouteChoice): string | null {
  const family = (route.authorFamily ?? route.family).trim().toLowerCase();
  return family === '' || family === 'unclassified' ? null : family;
}

/** 避让里加上整族避开这一族（已有就不重复）。 */
export function withFamily(avoid: Avoid, family: string): Avoid {
  const families = avoid.families ?? [];
  return families.includes(family) ? avoid : { ...avoid, families: [...families, family] };
}

/** 整族避开的那一层去掉（别的族一条都派不出时退回只避开模型）。 */
export function withoutFamilies(avoid: Avoid): Avoid {
  return { routeIds: avoid.routeIds, poolIds: avoid.poolIds, modelIds: avoid.modelIds };
}

/**
 * 动手一轮跑完没有提交：下一轮避开这条路由。
 * streak 是连着没提交的轮数（含这一轮）；到第 2 轮起，再避开这一轮的模型。早先避开的路由留着，直到「继续」清掉。
 */
export function noteEmptyCommit(
  avoid: Avoid,
  route: RouteChoice,
  streak: number,
): { avoid: Avoid; streak: number } {
  const next = streak + 1;
  const withRoute = widen(avoid, route, 'route');
  return { avoid: next >= 2 ? widen(withRoute, route, 'model') : withRoute, streak: next };
}

/** 整族避开之后别的族一条都派不出：退回只避开模型。写进 lastProblem，驾驶舱看得见。 */
export const NO_OTHER_FAMILY = '没有别的模型族可换，只避开模型';

/** 避让之后一条别的路由都没有：不死等，照旧派原来的。写进 lastProblem，驾驶舱看得见。 */
export const NO_OTHER_ROUTE = '没有别的路由可换';

/** 返工意见：上一轮用的哪条路由，这一轮避开它。连着第二轮起写明也避开模型（认得出族的连这一族）。 */
export function emptyCommitFeedback(
  route: RouteChoice,
  avoidModel: boolean,
  leftover: string,
  family: string | null = null,
): string {
  const model = avoidModel
    ? `，也避开模型 ${route.modelId}${family ? `和它那一族（${family}，别的族派不出才同族换模型）` : ''}`
    : '';
  return `上一轮用的是路由 ${route.routeId}（模型 ${route.modelId}）。这一轮避开它${model}。上一轮会话跑完了，但没有产生新的提交。改完之后要用 git commit 提交，不提交等于没做。${leftover}`;
}

export function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * 一步按失败分流要停下等人、但码在调用方给的「先自动处理一次」名单里（决定 0093，rt.step 的 escape）：不停下，抛给调用方去处理
 * （空交付回去重派动手会话……）。只抛一次：调用方处理完再撞上同样的，照旧停下。
 */
export class AutoEscape extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`先自动处理一次：${code}`);
    this.name = 'AutoEscape';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 动手会话没跑成、失败分流判停下等人时，先自动换一条路由（避开这个模型）重派一次的码（决定 0093，task-session.ts）：
 * 被引擎在时限上叫停（aborted）、总时长到顶、起不来、中转这一路额度用完或欠费（失败分流 QT3：换一路就能干，充值归人另办）。
 * 只有人能修的（没权限、卫生检查、登录失效……）不在里面。只加老历史里不会出现的码：已经记下的判断重放时走的分支不变。
 */
export const AUTO_REDISPATCH_CODES: readonly string[] = [
  'aborted',
  'wall_clock_timeout',
  'spawn_failed',
  'spawn_timeout',
  'startup_timeout',
  'relay_quota_exhausted',
];

/**
 * 同一条路由第二次总时长到顶，换路由时写进提示词（#2244）：这条路由在这张单上太慢，再原路续只烧额度。
 * 树上的改动还在，下一轮接着做，不从头重来。第一次到顶不走这里，仍原路续同一个会话。
 */
export function wallClockSwitchLine(modelId: string): string {
  return `${modelId} 在这条路由上第二次总时长到顶，不再原路续。树上的进度接着做，别从头重来。`;
}

/**
 * 有界耐心（决定 0093，借 magpie gateway-routing 的 Patience）：动手会话撞上上游临时故障（失败分流规则表上标了 blip 的：
 * 限流、繁忙、容量满……）、次数用完要停下时，先不停：歇一会儿重新选一次路由（不粘原路由）再起，直到预算用完才照旧停下。
 * 预算从第一次「该停下」起按墙钟算（含中间重跑的会话），默认 60 秒、最多 240 秒；歇的时长从会话时限里扣（计入会话总时限）。
 */
export const ROUTE_PATIENCE_SECONDS = 60;
export const ROUTE_PATIENCE_MAX_SECONDS = 240;
/** 每次歇多久：15 秒起翻倍，封顶 30 秒（magpie 的 retryPause 翻倍到 replanLongest）。 */
export const ROUTE_PATIENCE_PAUSE_SECONDS = 15;
export const ROUTE_PATIENCE_PAUSE_MAX_SECONDS = 30;

export type PatienceStep = { kind: 'pause'; seconds: number } | { kind: 'out'; reason: string };

/**
 * 这一次歇不歇（纯函数）：预算按 [0, ROUTE_PATIENCE_MAX_SECONDS] 夹住，认不出的按默认；歇完会超预算就不歇，写明已等多久。
 * sinceSeconds 认不出（不是有限非负数）不当成 0：直接用完，照旧停下。
 */
export function patienceStep(input: {
  sinceSeconds: number;
  round: number;
  budgetSeconds?: number;
}): PatienceStep {
  const raw = input.budgetSeconds;
  const budget =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
      ? Math.min(raw, ROUTE_PATIENCE_MAX_SECONDS)
      : ROUTE_PATIENCE_SECONDS;
  const since = input.sinceSeconds;
  if (!(Number.isFinite(since) && since >= 0)) {
    return { kind: 'out', reason: '耐心等待算不出已等多久，照旧停下' };
  }
  const round = Number.isInteger(input.round) && input.round > 0 ? input.round : 0;
  const seconds = Math.min(ROUTE_PATIENCE_PAUSE_SECONDS * 2 ** round, ROUTE_PATIENCE_PAUSE_MAX_SECONDS);
  if (since + seconds > budget) {
    return {
      kind: 'out',
      reason: `耐心等待用完（已等 ${Math.round(since)} 秒，预算 ${budget} 秒），照旧停下`,
    };
  }
  return { kind: 'pause', seconds };
}

/** 这一段的会话时限（分钟）：耐心等待歇掉的从里面扣（决定 0093），至少留 1 分钟。 */
export function segmentMinutesAfterPatience(base: number, waitedSeconds: number): number {
  if (!(Number.isFinite(waitedSeconds) && waitedSeconds > 0)) return base;
  return Math.max(1, base - Math.ceil(waitedSeconds / 60));
}

/** 推分支报空交付（起会话前的头之后没有新提交）：自动回去重派一次动手会话，不停下等人（决定 0093）。 */
export const EMPTY_DELIVERY_CODE = 'empty_delivery';

/** CI 的结果没查成：先自己隔一会儿重查几次再停下等人（决定 0093）。 */
export const CI_UNKNOWN_RECHECKS = 2;
export const CI_UNKNOWN_RECHECK_SECONDS = 120;

/** 推分支并主线撞上冲突，交回会话去解（不在 push 这一步里原地重试）。 */
export class ConflictHandoff extends Error {
  readonly files: readonly string[];
  /** false：合并没开始，树里没有这次的冲突标记。instruction 是原反馈（含要并的提交）。 */
  readonly pending: boolean;
  readonly instruction: string | null;
  constructor(files: readonly string[], options: { pending?: boolean; instruction?: string | null } = {}) {
    super(`有冲突没解：${files.join('、') || '（没读到冲突文件名）'}`);
    this.name = 'ConflictHandoff';
    this.files = files;
    this.pending = options.pending ?? true;
    this.instruction = options.instruction ?? null;
  }
}

/**
 * 交回会话的那一句。
 * 树里留着标记：冲突文件名，加上「解完 git add 并提交」。
 * 合并还没开始（blocked 是原反馈）：原句留着，里面有要并的提交。不改写成「树里留着冲突标记」。
 * 上一轮已经交过同一句还没解，补上「上一轮没解」。和上一轮原文一样就由调用方挂起。
 */
export function conflictHandoffLine(
  files: readonly string[],
  previous: readonly string[],
  blocked?: string | null,
): string {
  const names =
    files
      .map((f) => f.trim())
      .filter(Boolean)
      .join('、') || '（没读到冲突文件名）';
  if (blocked != null) {
    const base =
      blocked.trim() ||
      `有冲突没解：${names}。合并还没开始，树里没有冲突标记。在树里 git merge 目标提交，解掉冲突、提交后再交`;
    const noted = `${base}。上一轮没解`;
    return previous.includes(base) || previous.includes(noted) ? noted : base;
  }
  const base = `有冲突没解：${names}。树里留着冲突标记，解完 \`git add\` 并提交`;
  return previous.some((line) => line.includes('解完')) ? `${base}。上一轮没解` : base;
}

/** 占位不是文件名（MERGE_HEAD 还在、没读到文件名、没列出挡着的文件）。 */
const NOT_A_PATH = /^（/;

const FEEDBACK_FILE_LIST = [
  /有冲突没解：([^。\n]+)/,
  /有冲突：([^。\n]+)/,
  /真冲突：([^。\n]+)/,
  /要解决：([^。\n]+)/,
];

function realPaths(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const name = file.trim();
    if (!name || NOT_A_PATH.test(name) || found.includes(name)) continue;
    found.push(name);
  }
  return found;
}

/** 上一轮反馈里写过的冲突文件。删掉标记并 git add、没提交之后，这一轮可能只剩占位。 */
export function rememberedConflictFiles(previous: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of previous) {
    for (const pattern of FEEDBACK_FILE_LIST) {
      const matched = pattern.exec(line);
      const listed = matched?.[1];
      if (!listed) continue;
      for (const name of realPaths(listed.split('、'))) {
        if (!found.includes(name)) found.push(name);
      }
    }
  }
  return found;
}

/**
 * 交回和挂起用的冲突文件名。这一轮读到的真路径优先；没有就用上一轮反馈里的。
 * 两边都没有真路径，才留占位（MERGE_HEAD 还在、没读到文件名）。
 */
export function conflictFilesForHandoff(current: readonly string[], previous: readonly string[]): string[] {
  const names = realPaths(current);
  for (const name of rememberedConflictFiles(previous)) {
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > 0) return names;
  const placeholders = current.map((file) => file.trim()).filter((file) => file.length > 0);
  return placeholders.length > 0 ? placeholders : ['（没读到冲突文件名）'];
}

/**
 * #1303 的根因。引擎开的 PR 正文只收这里交给 openPr 的 did，不收会话最后一句，也不收代码注释。
 * 只写进这张单：别的单的正文保持原来两句，免得每张 PR 都带上这件事。
 */
export const CONFLICT_HANDOFF_CAUSE = [
  '根因：会话没解开，不是解完了没提交。',
  '推之前的 git merge 撞上内容冲突后会 merge --abort，会话起来时树是干净的，没有 MERGE_HEAD，不知道冲突在哪；',
  '工作流把 MERGE_CONFLICT 当成 pushBranch 原地重试，这句反馈没进会话提示词。',
  '下一轮原文一字不差就被挂起。',
].join('');

/** 一轮选路里最多当场探几条（#1409）。超过就停下，不再往下探。 */
export const DISPATCH_PROBE_LIMIT = 3;

export interface DispatchProbeFail {
  label: string;
  detail: string;
}

export interface DispatchProbeRound {
  fails: DispatchProbeFail[];
  probed: number;
}

export const EMPTY_DISPATCH_PROBE: DispatchProbeRound = { fails: [], probed: 0 };

/**
 * 这一条探完之后接着干什么。没真探的失败（counted 为假）不占 3 条名额。
 * 通过不改这一轮已经记下的失败：换到的那条用原来的失败名单来写「换到」。
 */
export function afterDispatchProbe(
  round: DispatchProbeRound,
  result: { label: string; detail: string; passed: boolean; counted: boolean },
): { round: DispatchProbeRound; action: 'dispatch' | 'pick' | 'stop' } {
  if (result.passed) return { round, action: 'dispatch' };
  const next: DispatchProbeRound = {
    fails: [...round.fails, { label: result.label, detail: result.detail }],
    probed: round.probed + (result.counted ? 1 : 0),
  };
  if (result.counted && next.probed >= DISPATCH_PROBE_LIMIT) return { round: next, action: 'stop' };
  return { round: next, action: 'pick' };
}

/** 返工意见和动手状态里的那一句。chosen 有值是派出去了；没有就是停下，每条带上原因。 */
export function dispatchProbeLine(fails: readonly DispatchProbeFail[], chosen: string | null): string {
  if (chosen && fails.length === 0) return `派前探测：${chosen} 通`;
  if (chosen) return `派前探测：${fails.map((item) => item.label).join('、')} 不通，换到 ${chosen}`;
  return `派前探测：${fails.map((item) => `${item.label} 不通（${item.detail}）`).join('；')}`;
}

/** 一条都没当场探到就停下：原因用选路给出的每条候选，不留空的「派前探测：」。 */
export function dispatchProbeBlockedLine(blockedDetail: string): string {
  return blockedDetail ? `派前探测：候选都被挡住（${blockedDetail}）` : '派前探测：没有能派的候选';
}

/** 停下时写进任务状态和提醒的全文：每条结果、到了 3 条的上限、还有被挡住的候选、以及不起会话。 */
export function dispatchProbeStopText(round: DispatchProbeRound, blockedDetail: string): string {
  const head =
    round.fails.length > 0 ? dispatchProbeLine(round.fails, null) : dispatchProbeBlockedLine(blockedDetail);
  const parts = [head];
  if (round.probed >= DISPATCH_PROBE_LIMIT) parts.push('本轮已当场探 3 条，不再往下探');
  if (blockedDetail && round.fails.length > 0) parts.push(`其余候选：${blockedDetail}`);
  parts.push('不起会话，等探针探通后再继续');
  return parts.join('。');
}

/** 同一轮里只留最新一条派前探测，别的返工意见不动。 */
export function withDispatchProbeNote(feedback: readonly string[], line: string): string[] {
  return [...feedback.filter((item) => !item.startsWith('派前探测：')), line];
}

/**
 * #1406 的 PR 说明。正文只收 taskPrDid，会话最后一句和代码注释都进不去。
 * 三条陈年提醒按合并事实写：reconcile:pr 是「发生过」、对账不撤，还开着就立案；
 * 同号若是 ledger，记账齐了由核对在立案前撤掉。
 */
export const ALERT_FILING_PR_NOTES = [
  'PR 说明：reconcile:* 三条若条件早已不成立，对账在立案前撤掉；仍成立的立案。canary:broken 自己会撤，不立案。',
  'PR 说明 #389：2026-09-27 thoerwink8 手动合。这条是 reconcile:pr（发生过、对账不撤），还开着就立案；同号的 reconcile:ledger 记账已齐，核对在立案前撤掉。',
  'PR 说明 #431：2026-09-28 thoerwink8 手动合、绕过合并队列。这条是 reconcile:pr，对账不撤，还开着就立案；同号的 reconcile:ledger 账已齐，核对在立案前撤掉。',
  'PR 说明 #1230：2026-10-07 fleet-dao-engine 自动合并耗时表，没有合并队列幂等账。这条是 reconcile:pr（缺记录、对账不撤），还开着就立案；同号的 reconcile:ledger 条件已不成立，核对在立案前撤掉。',
] as const;

/**
 * #1733 的 PR 说明。正文只收 taskPrDid，会话最后一句和代码注释都进不去。
 * 验收要写清：别的会话丢话选不列；四条新用例各自改前红、改后绿怎么验的。
 */
export const FOUNDERS_INBOX_PR_NOTES = [
  'PR 说明：取舍——别的会话丢的话不进「先答这些」，也不另起一行（避免误答）；只列本会话 sessionId 的丢失话。',
  'PR 说明：验法——四条新用例各在父提交 hooks 下改前红、本分支 hooks 下改后绿：①别的会话丢话不进先答 ②21:17 短句加 21:27 带下文重发不报 ③11:47 丢、15:01 同句收到不报 ④本会话真丢仍报。命令：npx vitest run agents/test/session-start.test.ts -t 「别的会话丢的话|21:17|11:47|故意造出的失败」。',
] as const;

/**
 * #1983 的 PR 说明。正文只收 taskPrDid，会话最后一句和代码注释都进不去。
 * 写清等合并时检查转红断在哪，以及同一个「一直等」还在哪些路径上、各怎么处理。
 */
export const MERGE_WAIT_RED_PR_NOTES = [
  '根因：等合并的 waitMerged 只看合没合、开没开、头变没变、自动合并还在不在、冲不冲突。必过检查红了和还在跑（pending）都是 mergeable_state=blocked，都回 waiting，工作流没有时限地接着等。主页只要落在合并段就写「等合并队列」，红和排队长得一样。',
  '处理：第一次读到红（含 merge-gate、cold-verify）就写「检查红了：」加检查名，确认 20 秒仍红就把检查名和原因交回返工。返工 3 轮用完仍红则停下，报警进「要你拍的」，不再等。合并闸误报也走这条，原因原文带上，不另判闸对不对。',
  '同一根子旁的路径：检查还在跑（pending）或一条都没有，仍等，和红不是同一件事，检查一直 pending 这次不改。PR 被关了本来就停下报人。和主线冲突已经并主线或交回返工；草稿被标成 mergeable=false 也会进冲突那条，这次不改分类。自动合并被撤掉就重新挂，挂不上停下；重新挂上之后红检查走上面的新路径。头被别人改了就停下，人点继续后重走 CI 和验收，不是一直等。落后主线但 mergeable=true 仍等（GitHub 还能合）；mergeable=false 走冲突那条。读检查失败抛错重试，不装成还在等；没接上读检查也抛，不默认 pending。不强制 CI 的直接合并 mergeNow 故意不看检查，另一条路，这次不改。每小时对账不推卡在 waitMerged 里的任务：红了由这条工作流自己返工，不加第二套看守。',
] as const;

/**
 * #2261 的 PR 说明。正文只收 taskPrDid，会话最后一句和代码注释都进不去：验收条要的「改了哪几处、留着的为什么不用改」
 * 得写进这里，不然 PR 正文里没有这份清单。列的是 #2181 同类（也含根因那次）——db 包 src 里所有并行查询都改成
 * allSettledOrThrow 都落定再返回，四处随 #2181 的 PR 进主线、七处是这个 PR 改的；剩下的不用改的另写一条。
 */
export const ALLSETTLED_PR_NOTES = [
  '排查范围：packages/db/src 里每一个装着库查询的 Promise.all（含别名、数组变量、Promise.resolve([]) 占位）逐个过；只有会提前返回、留下还在跑的查询占着连接和锁的才改。改后 db/src 里再没有 Promise.all 包库查询（allSettledOrThrow 自己内部的 Promise.allSettled 不算，它本来就等全部落定）。',
  '改的 7 处（这个 PR）：carpool-spend.ts carpoolWindowSpend、daily-brief.ts dailyBriefStatus、engine-route-facts.ts routeFactsForPurpose、feishu-push.ts feishuPushFacts、probe.ts routeProbeTargets、session-org.ts sessionOrgFacts、channel-models.ts channelModelDiff——都是并行取出互不依赖的几段数据后拼一个对象，一条失败以前立刻返回，其余还在别的连接上跑。',
  '随 #2181 的 PR 进主线的 4 处（根因那次）：pool-runs.ts openPoolRuns、endedPoolRuns、poolRunUsage，各自两条查询并行；schedule.ts scheduleHealth 里的三条（latest、latestSuccess、latestFinished）。它们和上面 7 处一样都改成 allSettledOrThrow；公共小工具 all-settled.ts 也是 #2181 加在 pool-runs.ts、这个 PR 没动它，直接复用。',
  '不用改的：db/src 其余 Promise.all 都没有——routing-effort、routing-apply、requests、local-claims 这些是 db.transaction()（单条连接上一个串行流程，不是并行几段查询）；queries 之外的 Promise.all 不装库查询；session-org.ts、channel-models.ts 里 `? Promise.resolve([])` 的占位是并发数组的一项，已经在 allSettledOrThrow 里。db/test 里的 Promise.all（pool-runs、routing-order、ops 几条）是测试为了并发起多笔写、故意快的，测试里撞锁不是要修的场景，不动。',
  '验法：npx vitest run packages/db/test/all-settled.test.ts packages/db/test/query-promise-all.test.ts（可控假查询钉「一条先失败时等其余都落定才抛」；卫生检查扫 queries 新写的 Promise.all 包库查询）；真库死锁复现在 packages/db/test/quota.test.ts 的 it.skipIf(!realTestPgUrl())，本机没设 FLEET_TEST_PG_URL 时跳过、CI 的 pg 台跑。',
] as const;

/** 引擎开 PR 的「做了什么」。#1303 多写根因，#1406 多写三条陈年提醒的处置，#1733 多写取舍和验法，#1983 多写等合并检查转红的断点和旁路，#2261 多写排查范围和改了哪几处，其余单子仍是原来两句。 */
export function taskPrDid(issueNumber: number, round: number, fileCount: number): string[] {
  const did = [`按 #${issueNumber} 的要求动手（第 ${round} 轮）`, `改了 ${fileCount} 个文件`];
  if (issueNumber === 1303) did.push(CONFLICT_HANDOFF_CAUSE);
  if (issueNumber === 1406) did.push(...ALERT_FILING_PR_NOTES);
  if (issueNumber === 1733) did.push(...FOUNDERS_INBOX_PR_NOTES);
  if (issueNumber === 1983) did.push(...MERGE_WAIT_RED_PR_NOTES);
  if (issueNumber === 2261) did.push(...ALLSETTLED_PR_NOTES);
  return did;
}
