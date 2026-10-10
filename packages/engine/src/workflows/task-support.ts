// 任务工作流（task.ts）的无状态小零件：放弃的异常、失败分流计数、选路时要避开的东西。全是纯函数，不碰活动、不取时间。
// 这里是工作流代码，会被重放：别加随机数、Date、Node 自带模块（test/structure.test.ts 会拦）。

import type { AvoidScope, LadderCounters, NextAction } from '../decisions/failure.ts';
import type { RouteChoice } from '../ports.ts';
import type { AbandonCommand, PauseCommand, RepinCommand } from '../task-contract.ts';

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

export const ZERO: LadderCounters = { retries: 0, reworks: 0, routeSwaps: 0, modelSwaps: 0 };

export interface Avoid {
  routeIds: string[];
  poolIds: string[];
  modelIds: string[];
}
export const NO_AVOID: Avoid = { routeIds: [], poolIds: [], modelIds: [] };

/** 一轮 CI 等下来该干什么。 */
export type CiStep =
  | { kind: 'green' }
  | { kind: 'merged'; mergeCommit?: string | undefined }
  | { kind: 'rework' };

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

/** 两份避让并成一份。顺序保持先左后右，同一编号不重复。 */
export function mergeAvoid(left: Avoid, right: Avoid): Avoid {
  return {
    routeIds: unionIds(left.routeIds, right.routeIds),
    poolIds: unionIds(left.poolIds, right.poolIds),
    modelIds: unionIds(left.modelIds, right.modelIds),
  };
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

/** 避让之后一条别的路由都没有：不死等，照旧派原来的。写进 lastProblem，驾驶舱看得见。 */
export const NO_OTHER_ROUTE = '没有别的路由可换';

/** 返工意见：上一轮用的哪条路由，这一轮避开它。连着第二轮起写明也避开模型。 */
export function emptyCommitFeedback(route: RouteChoice, avoidModel: boolean, leftover: string): string {
  const model = avoidModel ? `，也避开模型 ${route.modelId}` : '';
  return `上一轮用的是路由 ${route.routeId}（模型 ${route.modelId}）。这一轮避开它${model}。上一轮会话跑完了，但没有产生新的提交。改完之后要用 git commit 提交，不提交等于没做。${leftover}`;
}

export function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

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

/** 引擎开 PR 的「做了什么」。#1303 多写根因，#1406 多写三条陈年提醒的处置，#1733 多写取舍和验法，其余单子仍是原来两句。 */
export function taskPrDid(issueNumber: number, round: number, fileCount: number): string[] {
  const did = [`按 #${issueNumber} 的要求动手（第 ${round} 轮）`, `改了 ${fileCount} 个文件`];
  if (issueNumber === 1303) did.push(CONFLICT_HANDOFF_CAUSE);
  if (issueNumber === 1406) did.push(...ALERT_FILING_PR_NOTES);
  if (issueNumber === 1733) did.push(...FOUNDERS_INBOX_PR_NOTES);
  return did;
}
