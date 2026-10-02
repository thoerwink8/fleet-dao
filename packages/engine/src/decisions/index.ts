// 流程判断的唯一入口。工作流经本地活动 `decide` 调它：每次判断的结果记进历史，重放时直接取历史里的答案、
// 不重算——改判断条件（阈值、分类表、默认值）不会让在途任务的历史对不上（windsurf-dao#1633、#1813）。
// 工作流文件只许 `import type` 这里的东西；直接调用会把判断搬回工作流、失去这层保护（test/structure.test.ts 盯着）。
//
// #556-2：Fusion 的那些判断（简报校验、验收、验证结论、状态机、Lead 方案和审查、PR 正文、关单评论）和库主键（newIds）
// 都随 Fusion 的工作流一起删了；留的是 task.ts（#632）用的两样：上限（limits）和失败分流（failure）。

import { type Limits, resolveLimits } from '../limits.ts';
import { type FailureInput, type FailureTriage, type NextAction, nextAction } from './failure.ts';

export interface DecisionMap {
  limits: { input: Partial<Limits> | undefined; output: Limits };
  failure: { input: FailureInput; output: NextAction };
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
    failure: (input) => (triage ? nextAction(input, triage) : nextAction(input)),
  };
  return async (kind, input) => {
    const fn = table[kind] as ((input: unknown) => unknown) | undefined;
    if (!fn) throw new Error(`没有这种判断：${String(kind)}`);
    return fn(input) as DecisionMap[typeof kind]['output'];
  };
}

export * from './failure.ts';
export * from './types.ts';
