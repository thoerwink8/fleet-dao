// 流程判断的唯一入口。工作流经本地活动 `decide` 调它：每次判断的结果记进历史，重放时直接取历史里的答案、
// 不重算——改判断条件（阈值、分类表、默认值）不会让在途任务的历史对不上（windsurf-dao#1633、#1813）。
// 工作流文件只许 `import type` 这里的东西；直接调用会把判断搬回工作流、失去这层保护（test/structure.test.ts 盯着）。
// 库主键也从这里出（newIds）：理由一样，要进历史。
//
// #556-1：Fusion 流程的 triage / plan / runnable / delivery / verify / mergeStep / mergeReturn，加上只被
// Fusion 用的 state 机（fusionFlow）、流程配置接活（flowConfig / specDir / fusionSetup / riskPathsFileFor）、
// 问创始人不挡路的那几样（lateChanges / assumedLines / askTally）都跟着 workflows/{fusion,requirement,subtask,
// merge-queue}.ts 一起删了。这里留的是跑流程的零件（failure / newIds / limits）、554-1 三段还在用的
// 简报校验和验收（brief / parallelBriefs / acceptance / verdict）、开 PR 前验证（bodyCriteria / verifyLines）
// 和 Fusion 表单里留着的纯函数（leadPlan / leadReview / rebuttable / filesUnder / fusionPr / closeComment /
// fusionStart，它们的实现在 core 里没动，等 556-2 一起清）。

import {
  type AcceptanceDecision,
  type AcceptanceInput,
  type Brief,
  type BriefCheck,
  bodyCriteria,
  type CloseFacts,
  checkBrief,
  checkLeadPlan,
  checkLeadReview,
  checkParallel,
  closeComment,
  decideAcceptance,
  decideVerdict,
  type FlowDecision,
  type FlowEvent,
  type FlowState,
  type FusionPrFacts,
  type FusionPrParts,
  filesUnder,
  fusionPrParts,
  type LeadPlanCheck,
  type LeadReviewCheck,
  type Mode,
  nextFlow,
  type Rebuttable,
  rebuttable,
  startFlow,
  type VerdictDecision,
  type VerdictInput,
  type VerifiedRound,
  verificationLines,
} from '@fleet-dao/core';
import { type Limits, resolveLimits } from '../limits.ts';
import { type FailureInput, type FailureTriage, type NextAction, nextAction } from './failure.ts';
import { type NewIdsInput, newIds } from './ids.ts';

export interface DecisionMap {
  limits: { input: Partial<Limits> | undefined; output: Limits };
  newIds: { input: NewIdsInput; output: string[] };
  failure: { input: FailureInput; output: NextAction };
  brief: { input: unknown; output: BriefCheck };
  parallelBriefs: { input: Brief[]; output: { ok: true } | { ok: false; problems: string[] } };
  acceptance: { input: AcceptanceInput; output: AcceptanceDecision };
  verdict: { input: VerdictInput; output: VerdictDecision };
  /** 单子正文里「怎么算做完」逐条原文（正文写全了需求、主线上还没有需求文档的单，开 PR 前验证照它核，#295）。 */
  bodyCriteria: { input: { body: string }; output: { ok: string[] } | { error: string } };
  /** 开 PR 前验证写进 PR 正文的几行（「怎么验证的」「还欠什么」）。 */
  verifyLines: { input: VerifiedRound[]; output: { verified: string[]; owed: string[] } };
  /** 起步的状态（0 创单并讨论）：模式、是不是母单、验证最多几轮。 */
  fusionStart: { input: { mode: Mode; mother: boolean; verifyRounds: number }; output: FlowState };
  /** Fusion 状态机（开 PR 前验证的回环：挡了回哪一步、第几轮挡住）：实现在 core 的 flow.ts，没在工作流。 */
  fusionFlow: { input: { state: FlowState; event: FlowEvent }; output: FlowDecision };
  /** Lead 交回的方案和任务简报收不收。 */
  leadPlan: { input: { output: unknown; specDir: string; withRequirement?: boolean }; output: LeadPlanCheck };
  /** Lead 的最终审查收不收。 */
  leadReview: {
    input: { output: unknown; specDir: string; committed: string[] };
    output: LeadReviewCheck;
  };
  /** 验证挡住的几条原文（给 Lead 驳回用）。 */
  rebuttable: { input: import('@fleet-dao/core').VerifyReport; output: Rebuttable[] };
  /** 改到的文件里落在这几个路径下的（算不算页面代码）。 */
  filesUnder: { input: { paths: string[]; files: string[] }; output: string[] };
  /** PR 正文的几栏。 */
  fusionPr: { input: FusionPrFacts; output: FusionPrParts };
  /** 关单评论的正文：定一次、进历史，重试和重放都发同一份。 */
  closeComment: { input: CloseFacts; output: string };
}

export type DecisionKind = keyof DecisionMap;

export type Decide = <K extends DecisionKind>(
  kind: K,
  input: DecisionMap[K]['input'],
) => Promise<DecisionMap[K]['output']>;

export interface DecideDeps {
  /** 失败分流；不给就是 failure/classify.ts 的 classifyFailure（规则表 + 兜底梯）。演练「分流出错」时换掉。 */
  triage?: FailureTriage;
}

type Table = { [K in DecisionKind]: (input: DecisionMap[K]['input']) => DecisionMap[K]['output'] };

export function createDecide(deps: DecideDeps = {}): Decide {
  const triage = deps.triage;
  const table: Table = {
    limits: resolveLimits,
    newIds,
    failure: (input) => (triage ? nextAction(input, triage) : nextAction(input)),
    brief: checkBrief,
    parallelBriefs: checkParallel,
    acceptance: decideAcceptance,
    verdict: decideVerdict,
    bodyCriteria: ({ body }) => bodyCriteria(body),
    verifyLines: verificationLines,
    fusionStart: ({ mode, mother, verifyRounds }) => startFlow(mode, mother, { verifyRounds }),
    fusionFlow: ({ state, event }) => nextFlow(state, event),
    leadPlan: checkLeadPlan,
    leadReview: checkLeadReview,
    rebuttable,
    filesUnder: ({ paths, files }) => filesUnder(paths, files),
    fusionPr: fusionPrParts,
    closeComment,
  };
  return async (kind, input) => {
    const fn = table[kind] as ((input: unknown) => unknown) | undefined;
    if (!fn) throw new Error(`没有这种判断：${String(kind)}`);
    return fn(input) as DecisionMap[typeof kind]['output'];
  };
}

export * from './failure.ts';
export * from './ids.ts';
export * from './types.ts';
