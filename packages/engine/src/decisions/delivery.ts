// 交付对账：会话改的文件和方案点名的地方对得上吗（windsurf-dao#1572 的假完成：改了一堆，没一个是要改的）。
// 对不上一个都没有就退回返工，不进验证；改了方案外的文件照收，但记下来（「会改同一块的不同时跑」靠方案写的地方）。

import type { Limits } from '../limits.ts';
import { normalizeTouch, touchesOverlap, WHOLE_REPO } from './plan.ts';
import type { Feedback } from './verify.ts';

export interface DeliveryInput {
  touches: readonly string[];
  /** 这次会话相对起会话前的头改了哪些文件；插头没报就是没查成。 */
  changedFiles: readonly string[] | undefined;
  /** 已经因为对不上退回过几次。 */
  offPlanSoFar: number;
  limits: Pick<Limits, 'offPlanRounds'>;
}

export type DeliveryDecision =
  | { action: 'accept'; outside: string[]; note: string }
  | { action: 'rework'; feedback: Feedback[]; reason: string }
  | { action: 'escalate'; reason: string; detail: string };

export function checkDelivery(input: DeliveryInput): DeliveryDecision {
  const changed = [...(input.changedFiles ?? [])];
  if (input.changedFiles === undefined) {
    return { action: 'accept', outside: [], note: '改动清单没查成，先按交付接收' };
  }
  if (input.touches.includes(WHOLE_REPO)) return { action: 'accept', outside: [], note: '' };
  const outside = changed.filter((file) => !touchesOverlap([normalizeTouch(file)], input.touches));
  if (outside.length < changed.length) {
    return {
      action: 'accept',
      outside,
      note: outside.length > 0 ? `改了方案外的文件：${outside.join('、')}` : '',
    };
  }
  const detail = `方案要改：${input.touches.join('、')}；实际改了：${changed.join('、') || '（没有改动）'}`;
  if (input.offPlanSoFar >= input.limits.offPlanRounds) {
    return { action: 'escalate', reason: '改的文件和方案点名的地方一直对不上', detail };
  }
  return {
    action: 'rework',
    reason: '改的文件和方案点名的地方一个都对不上，回主会话重做',
    feedback: [
      {
        kind: 'plan',
        summary: '改的文件和方案点名的地方一个都对不上',
        items: [`方案要改：${input.touches.join('、')}`, `实际改了：${changed.join('、') || '（没有改动）'}`],
      },
    ],
  };
}
