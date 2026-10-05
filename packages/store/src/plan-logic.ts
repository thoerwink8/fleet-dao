/**
 * 会话最近一条 plan 进度 → 计划步骤，两套 Store 共用（getPlans）。
 * 改这里之前必须知道：payload 是会话写进来的，不可信——没有 steps、不是数组、某一步缺 title 或 state 的都跳过，不抛；
 * index 按留下来的顺序重编。
 */
import type { Step } from '@fleet-dao/shared';

export function planSteps(payload: unknown): Step[] {
  const raw =
    typeof payload === 'object' && payload !== null ? (payload as { steps?: unknown }).steps : undefined;
  return (Array.isArray(raw) ? raw : [])
    .filter(
      (s): s is { title: string; state: Step['state'] } =>
        typeof s === 'object' && s !== null && typeof s.title === 'string' && typeof s.state === 'string',
    )
    .map((s, index) => ({ index, title: s.title, state: s.state }));
}
