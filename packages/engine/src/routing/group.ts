// 一条路由的被挡原因归成三类：能派 / 等得来 / 硬挡。
// 有一条硬挡就是硬挡（哪怕另有等得来的：等来了也还是派不了）；全是等得来的：显示时额度优先（光有空位没用），
// 其次熔断，最后空位。
import type { Block } from './types.ts';

export type BlockGroup =
  | { kind: 'ready' }
  | { kind: 'hard' }
  | {
      kind: 'wait';
      waitFor: 'slot' | 'quota' | 'breaker';
      /**
       * 最早能派的时刻：知道时刻的原因（额度清零、熔断到点）里最晚的那个——在那之前一定派不了，到时候还挡着的
       * （时刻不知道的、空位）再看。一个时刻都不知道、或只差空位，就不知道（随时可能好，按轮询间隔再看）。
       * 不能因为另有一个时刻不知道就整个不知道：等 3 天后清零的路由会每 30 秒轮询一次，空转 3 天。
       */
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
  const known = blocks.flatMap((b) => (b.wait === 'slot' || b.until === null ? [] : [Date.parse(b.until)]));
  const until = known.length > 0 ? Math.max(...known) : null;
  return { kind: 'wait', waitFor, until };
}
