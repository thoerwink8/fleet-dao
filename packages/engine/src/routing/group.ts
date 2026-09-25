// 一条路由的被挡原因归成三类：能派 / 等得来 / 硬挡。
// 有一条硬挡就是硬挡；全是等得来的：有额度要等就算等额度（光有空位没用），其次熔断，最后空位。
import type { Block } from './types.ts';

export type BlockGroup =
  | { kind: 'ready' }
  | { kind: 'hard' }
  | {
      kind: 'wait';
      waitFor: 'slot' | 'quota' | 'breaker';
      /** 这一类原因全都解除的最早时刻（取它们里最晚的）；有一个不知道就不知道。空位永远不知道几点。 */
      until: number | null;
    };

export function groupOf(blocks: readonly Block[]): BlockGroup {
  if (blocks.length === 0) return { kind: 'ready' };
  if (blocks.some((b) => b.wait === null)) return { kind: 'hard' };
  const waitFor = blocks.some((b) => b.wait === 'quota')
    ? 'quota'
    : blocks.some((b) => b.wait === 'breaker')
      ? 'breaker'
      : 'slot';
  const relevant = blocks.filter((b) => b.wait === waitFor);
  const times = relevant.map((b) => (b.until === null ? null : Date.parse(b.until)));
  const until = times.every((t): t is number => t !== null) ? Math.max(...times) : null;
  return { kind: 'wait', waitFor, until };
}
