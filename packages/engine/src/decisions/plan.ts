// 方案校验与「不撞车」调度：纯函数，经 decide 本地活动调用，结果进历史。

import { normalizeHolds } from '../holds.ts';

export type SubtaskStage = 'execute' | 'ui';
export type Risk = 'low' | 'normal' | 'high';

/** 写方案的会话交出来的一条子任务（未经校验）。 */
export interface PlannedSubtask {
  key: string;
  title: string;
  /** 会改哪些文件或目录；前缀相同即算同一块地方。没写 = 整个仓，跟谁都撞。 */
  touches?: string[];
  dependsOn?: string[];
  stage?: SubtaskStage;
  /** low = 纯文档这类，不要第二意见。 */
  risk?: Risk;
  acceptance?: string[];
  /** 人闸：会对外发布（release）、花钱（spend）、删数据（delete）的，合并前要人批。 */
  holds?: string[];
}

/** 校验、规整后的子任务。 */
export interface SubtaskSpec {
  key: string;
  index: number;
  title: string;
  touches: string[];
  dependsOn: string[];
  stage: SubtaskStage;
  secondOpinion: boolean;
  acceptance: string[];
  /** 人闸标记，规整过（小写、去重、排好序）。老输入没有这个字段 = 没有人闸。 */
  holds?: string[];
}

export type PlanDecision = { ok: true; subtasks: SubtaskSpec[] } | { ok: false; problems: string[] };

/** 「整个仓」。 */
export const WHOLE_REPO = '*';
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 规整一条改动位置：统一分隔符、去掉 `./` 与首尾斜杠；通配符从第一个通配符处截成前缀（宁可多撞，不可漏撞）。 */
export function normalizeTouch(raw: string): string {
  let p = raw.trim().replaceAll('\\', '/');
  const glob = p.search(/[*?[{]/);
  if (glob >= 0) p = p.slice(0, glob);
  p = p
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return p === '' || p === '.' ? WHOLE_REPO : p;
}

function normalizeTouches(raw: readonly string[] | undefined): string[] {
  const out = [...new Set((raw ?? []).map(normalizeTouch))];
  return out.length === 0 || out.includes(WHOLE_REPO) ? [WHOLE_REPO] : out.sort();
}

function pathsOverlap(a: string, b: string): boolean {
  if (a === WHOLE_REPO || b === WHOLE_REPO) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** 两组改动位置是否会改到同一块地方（按路径段前缀判）。 */
export function touchesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => pathsOverlap(x, y)));
}

function findCycle(list: readonly PlannedSubtask[]): string[] | null {
  const deps = new Map(list.map((s) => [s.key, s.dependsOn ?? []]));
  const color = new Map<string, 'grey' | 'black'>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    if (color.get(key) === 'black') return null;
    if (color.get(key) === 'grey') return [...stack.slice(stack.indexOf(key)), key];
    color.set(key, 'grey');
    stack.push(key);
    for (const d of deps.get(key) ?? []) {
      const cycle = visit(d);
      if (cycle) return cycle;
    }
    stack.pop();
    color.set(key, 'black');
    return null;
  };
  for (const s of list) {
    const cycle = visit(s.key);
    if (cycle) return cycle;
  }
  return null;
}

export interface PlanInput {
  subtasks: readonly PlannedSubtask[] | undefined;
  maxSubtasks: number;
  /** 整个需求的人闸（分诊判出的、人工加的），每个子任务都带上。 */
  holds?: readonly string[] | undefined;
}

export function validatePlan(input: PlanInput): PlanDecision {
  const list = input.subtasks ?? [];
  const problems: string[] = [];
  if (list.length === 0) problems.push('方案里没有子任务');
  if (list.length > input.maxSubtasks) {
    problems.push(`子任务有 ${list.length} 个，超过上限 ${input.maxSubtasks}：把改同一块地方的零碎活合并`);
  }
  const keys = new Set<string>();
  for (const s of list) {
    if (!KEY.test(s.key)) problems.push(`子任务编号「${s.key}」不合规：只许小写字母、数字、连字符，最长 32`);
    if (keys.has(s.key)) problems.push(`子任务编号「${s.key}」重复`);
    keys.add(s.key);
    if (!s.title?.trim()) problems.push(`子任务「${s.key}」没有标题`);
  }
  for (const s of list) {
    for (const d of s.dependsOn ?? []) {
      if (d === s.key) problems.push(`子任务「${s.key}」依赖了自己`);
      else if (!keys.has(d)) problems.push(`子任务「${s.key}」依赖的「${d}」不存在`);
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(list);
    if (cycle) problems.push(`依赖成环：${cycle.join(' → ')}`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    subtasks: list.map((s, index) => ({
      key: s.key,
      index,
      title: s.title.trim(),
      touches: normalizeTouches(s.touches),
      dependsOn: [...new Set(s.dependsOn ?? [])],
      stage: s.stage === 'ui' ? 'ui' : 'execute',
      secondOpinion: s.risk !== 'low',
      acceptance: s.acceptance ?? [],
      holds: normalizeHolds([...(input.holds ?? []), ...(s.holds ?? [])]),
    })),
  };
}

export type SchedState = 'pending' | 'running' | 'merged' | 'failed' | 'stopped';

export interface SchedItem {
  key: string;
  touches: readonly string[];
  dependsOn: readonly string[];
  state: SchedState;
}

export interface WaitReason {
  key: string;
  /** deps = 等依赖；overlap = 等改同一块地方的子任务；capacity = 等需求内并发空位。 */
  kind: 'deps' | 'overlap' | 'capacity';
  on: string[];
}

export interface RunnableDecision {
  start: string[];
  waiting: WaitReason[];
  /** 依赖（直接或间接）没做成，永远起不来的。 */
  unreachable: { key: string; because: string[] }[];
}

export interface RunnableInput {
  items: readonly SchedItem[];
  maxParallel: number;
}

/** 依赖都已合并、改动位置不和在跑的相交、并发没满的，按方案顺序起。 */
export function pickRunnable(input: RunnableInput): RunnableDecision {
  const items = input.items;
  const byKey = new Map(items.map((i) => [i.key, i]));
  const dead = new Set(items.filter((i) => i.state === 'failed' || i.state === 'stopped').map((i) => i.key));
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items) {
      if (i.state !== 'pending' || dead.has(i.key)) continue;
      if (i.dependsOn.some((d) => dead.has(d) || !byKey.has(d))) {
        dead.add(i.key);
        grew = true;
      }
    }
  }
  const unreachable = items
    .filter((i) => i.state === 'pending' && dead.has(i.key))
    .map((i) => ({ key: i.key, because: i.dependsOn.filter((d) => dead.has(d) || !byKey.has(d)) }));

  const running = items.filter((i) => i.state === 'running');
  const max = Math.max(1, Math.floor(input.maxParallel));
  const start: SchedItem[] = [];
  const waiting: WaitReason[] = [];
  for (const i of items) {
    if (i.state !== 'pending' || dead.has(i.key)) continue;
    const unmet = i.dependsOn.filter((d) => byKey.get(d)?.state !== 'merged');
    if (unmet.length > 0) {
      waiting.push({ key: i.key, kind: 'deps', on: unmet });
      continue;
    }
    const clash = [...running, ...start]
      .filter((o) => touchesOverlap(i.touches, o.touches))
      .map((o) => o.key);
    if (clash.length > 0) {
      waiting.push({ key: i.key, kind: 'overlap', on: clash });
      continue;
    }
    if (running.length + start.length >= max) {
      waiting.push({ key: i.key, kind: 'capacity', on: [...running, ...start].map((o) => o.key) });
      continue;
    }
    start.push(i);
  }
  return { start: start.map((i) => i.key), waiting, unreachable };
}
