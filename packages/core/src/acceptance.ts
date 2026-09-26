// Lead 验收副手交回的一块（docs/decisions/0003-fusion-flow.md 第 5 条）：收下、打回（最多 2 次），再不行 Lead 自己接手。
// 事实先过：空交付、改了简报外的文件、测试没过或没跑成，Lead 说收也不收——没跑成 ≠ 没过 ≠ 过了。
import { type Brief, outsideBrief } from './brief.ts';
import { FLOW_LIMITS } from './flow.ts';

export interface SidekickDelivery {
  /** 这块改了哪些文件（引擎从提交里读，不信副手自己报的）。 */
  changedFiles: readonly string[];
  /** 这个会话最后一次跑测试的结果；not-run = 没跑成或没跑。 */
  tests: 'green' | 'red' | 'not-run';
}

export interface AcceptanceInput {
  brief: Brief;
  delivery: SidekickDelivery;
  /** Lead 看过改动的结论，带理由。 */
  lead: { verdict: 'accept' | 'reject'; why: string };
  /** 这一块已经打回过几次。 */
  reworks: number;
}

export type AcceptanceDecision =
  | { decision: 'accept' }
  | { decision: 'rework'; why: string[] }
  | { decision: 'takeover'; why: string[] };

export function decideAcceptance(input: AcceptanceInput): AcceptanceDecision {
  if (!Number.isInteger(input.reworks) || input.reworks < 0) {
    throw new Error(`打回次数认不出：${String(input.reworks)}`);
  }
  const why: string[] = [];
  const { changedFiles, tests } = input.delivery;
  if (changedFiles.length === 0) why.push('空交付：一个文件都没改');
  const outside = outsideBrief(input.brief, changedFiles);
  if (outside.length) {
    why.push(`改了简报外的文件：${outside.join('、')}（要动别人的文件先回报 Lead 改派）`);
  }
  if (tests === 'red') why.push('测试没过');
  if (tests === 'not-run') why.push('没跑成测试（没跑不等于过了）');
  if (input.lead.verdict === 'reject') {
    const reason = input.lead.why.trim();
    if (!reason) throw new Error('Lead 打回要写理由');
    why.push(`Lead 打回：${reason}`);
  }
  if (why.length === 0) return { decision: 'accept' };
  return input.reworks < FLOW_LIMITS.reworks ? { decision: 'rework', why } : { decision: 'takeover', why };
}
