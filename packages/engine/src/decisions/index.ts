// 流程判断的唯一入口。工作流经本地活动 `decide` 调它：每次判断的结果记进历史，重放时直接取历史里的答案、
// 不重算——改判断条件（阈值、分类表、默认值）不会让在途任务的历史对不上（windsurf-dao#1633、#1813）。
// 工作流文件只许 `import type` 这里的东西；直接调用会把判断搬回工作流、失去这层保护（test/structure.test.ts 盯着）。
// 库主键也从这里出（newIds）：理由一样，要进历史。

import { type Limits, resolveLimits } from '../limits.ts';
import { checkDelivery, type DeliveryDecision, type DeliveryInput } from './delivery.ts';
import {
  type Classifier,
  classifyStructural,
  type FailureInput,
  type NextAction,
  nextAction,
} from './failure.ts';
import { type NewIdsInput, newIds } from './ids.ts';
import {
  afterMergeReturn,
  type MergeReturnDecision,
  type MergeReturnInput,
  type MergeStep,
  type MergeStepInput,
  mergeStep,
} from './merge.ts';
import {
  type PlanDecision,
  type PlanInput,
  pickRunnable,
  type RunnableDecision,
  type RunnableInput,
  validatePlan,
} from './plan.ts';
import { decideTriage, type TriageDecision, type TriageInput } from './triage.ts';
import { decideAfterVerify, type VerifyDecision, type VerifyInput } from './verify.ts';

export interface DecisionMap {
  limits: { input: Partial<Limits> | undefined; output: Limits };
  newIds: { input: NewIdsInput; output: string[] };
  triage: { input: TriageInput; output: TriageDecision };
  plan: { input: PlanInput; output: PlanDecision };
  runnable: { input: RunnableInput; output: RunnableDecision };
  failure: { input: FailureInput; output: NextAction };
  delivery: { input: DeliveryInput; output: DeliveryDecision };
  verify: { input: VerifyInput; output: VerifyDecision };
  mergeStep: { input: MergeStepInput; output: MergeStep };
  mergeReturn: { input: MergeReturnInput; output: MergeReturnDecision };
}

export type DecisionKind = keyof DecisionMap;

export type Decide = <K extends DecisionKind>(
  kind: K,
  input: DecisionMap[K]['input'],
) => Promise<DecisionMap[K]['output']>;

export interface DecideDeps {
  /** 错误分类表；不给就只用认结构化错误码的底表。 */
  classify?: Classifier;
}

type Table = { [K in DecisionKind]: (input: DecisionMap[K]['input']) => DecisionMap[K]['output'] };

export function createDecide(deps: DecideDeps = {}): Decide {
  const classify = deps.classify ?? classifyStructural;
  const table: Table = {
    limits: resolveLimits,
    newIds,
    triage: decideTriage,
    plan: validatePlan,
    runnable: pickRunnable,
    failure: (input) => nextAction(input, classify),
    delivery: checkDelivery,
    verify: decideAfterVerify,
    mergeStep,
    mergeReturn: afterMergeReturn,
  };
  return async (kind, input) => {
    const fn = table[kind] as ((input: unknown) => unknown) | undefined;
    if (!fn) throw new Error(`没有这种判断：${String(kind)}`);
    return fn(input) as DecisionMap[typeof kind]['output'];
  };
}

export * from './delivery.ts';
export * from './failure.ts';
export * from './ids.ts';
export * from './merge.ts';
export * from './plan.ts';
export * from './triage.ts';
export * from './verify.ts';
