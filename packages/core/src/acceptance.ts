// Lead 验收副手交回的一块（docs/decisions/0003-fusion-flow.md 第 5 条）：收下、打回（最多 2 次），再不行 Lead 自己接手。
// 事实先过，Lead 说收也不收：空交付；测试没过或没跑成（没跑成 ≠ 没过 ≠ 过了）；碰到别的块简报里的文件（几块一起干时
// 各改各的，0003 第 5 条）。简报外、别的块也没认领的文件不算事实：Lead 看过收下就收下，交回 outside 给外壳记进状态和
// PR 正文；Lead 打回的列进理由。别把它改回「简报外一律不收」：一张单一块时根本没有别人的文件、Lead 也没法改派，
// #246 就是这样注定白转两轮、第 3 轮 Lead 接手。
// 旧的需求工作流（engine 的 decisions/delivery.ts，#250 删）同样是方案外的照收、记下来；它没有 Lead 逐轮看改动，
// 所以另有一道「一个文件都对不上方案就退回」的机械挡，这里这件事归 Lead 验收和第 5 步别家验证管。
import { type Brief, outsideBrief } from './brief.ts';
import { filesUnder } from './config.ts';
import { FLOW_LIMITS } from './flow.ts';

export interface SidekickDelivery {
  /** 这块改了哪些文件（引擎从提交里读，不信副手自己报的）。 */
  changedFiles: readonly string[];
  /** 这个会话最后一次跑测试的结果；not-run = 没跑成或没跑。 */
  tests: 'green' | 'red' | 'not-run';
}

/** 同一张单里别的块：块名和它简报里只许改的文件（以 / 结尾的是目录）。 */
export interface OtherBlock {
  block: string;
  files: readonly string[];
}

export interface AcceptanceInput {
  brief: Brief;
  /** 同一张单里别的块（#252 母单多块时才有）；一张单一块明着给空数组，不给算认不出。 */
  otherBlocks: readonly OtherBlock[];
  delivery: SidekickDelivery;
  /** Lead 看过改动的结论，带理由。 */
  lead: { verdict: 'accept' | 'reject'; why: string };
  /** 这一块已经打回过几次。 */
  reworks: number;
}

export type AcceptanceDecision =
  /** outside：Lead 收下的简报外文件（别的块都没认领的），没有是空数组。 */
  | { decision: 'accept'; outside: string[] }
  | { decision: 'rework'; why: string[] }
  | { decision: 'takeover'; why: string[] };

export function decideAcceptance(input: AcceptanceInput): AcceptanceDecision {
  if (!Number.isInteger(input.reworks) || input.reworks < 0) {
    throw new Error(`打回次数认不出：${String(input.reworks)}`);
  }
  const others: readonly OtherBlock[] | undefined = input.otherBlocks;
  if (!Array.isArray(others) || others.some((o) => !o?.block?.trim() || !Array.isArray(o.files))) {
    throw new Error('别的块认不出：每块要有块名和它简报里的文件；一张单一块就明着给空数组');
  }
  const why: string[] = [];
  const { changedFiles, tests } = input.delivery;
  if (changedFiles.length === 0) why.push('空交付：一个文件都没改');
  const outside = outsideBrief(input.brief, changedFiles);
  const claimed = new Set<string>();
  for (const other of others) {
    const hit = filesUnder(other.files, outside);
    for (const file of hit) claimed.add(file);
    if (hit.length) why.push(`碰了别的块「${other.block}」的文件：${hit.join('、')}（归那一块改，撤回来）`);
  }
  const unclaimed = outside.filter((file) => !claimed.has(file));
  if (tests === 'red') why.push('测试没过');
  if (tests === 'not-run') why.push('没跑成测试（没跑不等于过了）');
  if (input.lead.verdict === 'reject') {
    const reason = input.lead.why.trim();
    if (!reason) throw new Error('Lead 打回要写理由');
    why.push(`Lead 打回：${reason}`);
    if (unclaimed.length) why.push(`简报外改了：${unclaimed.join('、')}（留不留照 Lead 的理由办）`);
  }
  if (why.length === 0) return { decision: 'accept', outside: unclaimed };
  return input.reworks < FLOW_LIMITS.reworks ? { decision: 'rework', why } : { decision: 'takeover', why };
}
