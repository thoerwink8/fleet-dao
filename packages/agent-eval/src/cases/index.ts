// 全部题的登记表。每种场景至少 1 道；顺序就是 --dry-run 和真跑的顺序。
// ui-builder、ui-verifier 不在这里：要浏览器，自动探查不做（见 ../types.ts 的 SKIPPED_SCENARIOS）。
import type { EvalCase } from '../types.ts';
import { ARCHITECT_CASES } from './architect.ts';
import { BRIEF_CASES } from './brief.ts';
import { CODE_TASK_CASES, REAL_CODE_TASK_CASES } from './code-tasks.ts';
import { READING_CASES } from './reading.ts';
import { REVIEW_CASES } from './review.ts';

const ORDER = [
  'scout',
  'log-digest',
  'triage',
  'review-screen',
  'fixer',
  'brief-drafter',
  'builder',
  'ci-triager',
  'groomer',
  'researcher',
  'standard-editor',
  'architect',
  'debugger',
  'reviewer',
];

export const ALL_CASES: readonly EvalCase[] = [
  ...READING_CASES,
  ...REVIEW_CASES,
  ...BRIEF_CASES,
  ...CODE_TASK_CASES,
  ...REAL_CODE_TASK_CASES,
  ...ARCHITECT_CASES,
].sort((a, b) => ORDER.indexOf(a.scenario) - ORDER.indexOf(b.scenario));
