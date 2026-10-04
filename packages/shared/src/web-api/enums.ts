// 驾驶舱接口约定（web-api）：与 domain.ts 一一对应的枚举（运行时校验）和编译期闸。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import type {
  BillingKind,
  HostId,
  ProgressKind,
  QuotaStatus,
  QuotaUnit,
  QuotaWindowKind,
  ReadingKind,
  RouteProbeState,
  RunOutcome,
  ScheduleOutcome,
  SegmentKind,
  SegmentOutcome,
  SegmentTier,
  StageKind,
  StepState,
  SubtaskState,
  TaskState,
} from '../domain.ts';
import { SEGMENT_KINDS, SEGMENT_OUTCOMES, SEGMENT_TIERS } from '../segment-runs.ts';
import type { Same } from './internal.ts';

// —— 与 domain.ts 一一对应的枚举（domain.ts 只有类型，这里给运行时校验）——

export const StageKindSchema = z.enum([
  'triage',
  'spec',
  'plan',
  'execute',
  'ui',
  'review',
  'verify',
  'research',
  'judge',
]);
export const TaskStateSchema = z.enum([
  'queued',
  'triaging',
  'asking',
  'planning',
  'running',
  'merging',
  'done',
  'stopped',
  'failed',
  'stalled',
]);
export const SubtaskStateSchema = z.enum([
  'pending',
  'waiting_deps',
  'waiting_slot',
  'running',
  'verifying',
  'in_merge_queue',
  'merged',
  'stopped',
  'failed',
  'stalled',
]);
export const StepStateSchema = z.enum(['pending', 'in_progress', 'done']);
export const BillingKindSchema = z.enum(['subscription', 'metered']);
export const ReadingKindSchema = z.enum(['measured', 'estimated']);
export const QuotaWindowKindSchema = z.enum([
  '5h',
  '7d',
  '7d_model',
  'month_usd',
  'points',
  'period_usd',
  'other',
]);
export const HostIdSchema = z.enum(['claude-code', 'codex', 'cursor-agent', 'grok', 'mirasim', 'api-shell']);
export const RunOutcomeSchema = z.enum(['ok', 'failed', 'stopped', 'stalled']);
export const ProgressKindSchema = z.enum(['plan', 'say', 'tool', 'file', 'test', 'ask', 'done', 'blocked']);
export const QuotaStatusSchema = z.enum(['allowed', 'warning', 'limit_reached']);
export const QuotaUnitSchema = z.enum(['percent', 'usd', 'tokens', 'points']);
export const ScheduleOutcomeSchema = z.enum(['ok', 'partial', 'unscanned', 'failed']);
export const RouteProbeStateSchema = z.enum(['ok', 'failed', 'not_wired', 'skipped']);
export const SegmentKindSchema = z.enum(SEGMENT_KINDS);
export const SegmentTierSchema = z.enum(SEGMENT_TIERS);
export const SegmentOutcomeSchema = z.enum(SEGMENT_OUTCOMES);

/** 编译期闸：上面的枚举和 domain.ts 的联合类型必须一字不差，改了一边没改另一边 `tsc` 当场报错。 */
export const ENUMS_MATCH_DOMAIN: [
  Same<z.infer<typeof StageKindSchema>, StageKind>,
  Same<z.infer<typeof TaskStateSchema>, TaskState>,
  Same<z.infer<typeof SubtaskStateSchema>, SubtaskState>,
  Same<z.infer<typeof StepStateSchema>, StepState>,
  Same<z.infer<typeof BillingKindSchema>, BillingKind>,
  Same<z.infer<typeof ReadingKindSchema>, ReadingKind>,
  Same<z.infer<typeof QuotaWindowKindSchema>, QuotaWindowKind>,
  Same<z.infer<typeof HostIdSchema>, HostId>,
  Same<z.infer<typeof RunOutcomeSchema>, RunOutcome>,
  Same<z.infer<typeof ProgressKindSchema>, ProgressKind>,
  Same<z.infer<typeof QuotaStatusSchema>, QuotaStatus>,
  Same<z.infer<typeof QuotaUnitSchema>, QuotaUnit>,
  Same<z.infer<typeof ScheduleOutcomeSchema>, ScheduleOutcome>,
  Same<z.infer<typeof RouteProbeStateSchema>, RouteProbeState>,
  Same<z.infer<typeof SegmentKindSchema>, SegmentKind>,
  Same<z.infer<typeof SegmentTierSchema>, SegmentTier>,
  Same<z.infer<typeof SegmentOutcomeSchema>, SegmentOutcome>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
