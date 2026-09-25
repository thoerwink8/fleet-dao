// 一个需求走过的五段：分诊 → 需求 → 方案 → 执行 → 合并。看板的迷你时间线和任务详情的阶段条共用。
import type { BoardTask, StageKind, TaskState } from '../api/types';
import type { Tone } from './status';

export type PhaseKey = 'triage' | 'spec' | 'plan' | 'execute' | 'merge';

export interface Phase {
  key: PhaseKey;
  label: string;
  tone: Tone;
  /** 完成 / 进行中 / 还没到。 */
  state: 'done' | 'active' | 'pending';
  /** 进行中的那段用的模型和路由（来自 activity）。 */
  modelName?: string;
  routeId?: string;
  /** 这一段已经干了多久（毫秒），只有进行中的那段有。 */
  ms?: number;
  detail?: string;
}

// 需求走到哪一段了：之前的段就算看板上没有会话信息也当作做完了。
const REACHED: Record<TaskState, number> = {
  queued: 0,
  triaging: 0,
  asking: 2,
  planning: 1,
  running: 3,
  merging: 4,
  stalled: 3,
  failed: 3,
  stopped: 3,
  done: 5,
};

const FRONT: { key: PhaseKey; stage: StageKind; label: string }[] = [
  { key: 'triage', stage: 'triage', label: '分诊' },
  { key: 'spec', stage: 'spec', label: '需求' },
  { key: 'plan', stage: 'plan', label: '方案' },
];

export function taskPhases(t: BoardTask, now: number): Phase[] {
  const a = t.activity;
  let reached = REACHED[t.state];
  // 写方案这段分两步：先写需求文档、再写方案；看正在跑的是哪一步。
  if (t.state === 'planning' && a?.stage === 'plan') reached = 2;

  const phases: Phase[] = FRONT.map(({ key, stage, label }, i): Phase => {
    if (a && a.stage === stage) {
      const p: Phase = {
        key,
        label,
        tone: a.queued ? 'wait' : 'run',
        state: 'active',
        modelName: a.modelName,
        routeId: a.routeId,
        ms: now - Date.parse(a.since),
      };
      if (a.queued) p.detail = '排队中';
      return p;
    }
    if (i < reached) return { key, label, tone: 'done', state: 'done' };
    return { key, label, tone: 'wait', state: 'pending' };
  });

  if (t.state === 'asking') {
    const plan = phases[2];
    if (plan) Object.assign(plan, { tone: 'human', state: 'active', detail: '等你回答' });
  }

  const subs = t.subtasks;
  const exec: Phase = { key: 'execute', label: '执行', tone: 'wait', state: 'pending' };
  if (subs.length) {
    const states = subs.map((s) => s.state);
    const merged = states.filter((s) => s === 'merged').length;
    exec.detail = `${merged}/${subs.length} 个子任务`;
    if (states.includes('failed')) Object.assign(exec, { tone: 'fail', state: 'active' });
    else if (states.includes('stalled')) Object.assign(exec, { tone: 'stall', state: 'active' });
    else if (states.every((s) => s === 'merged' || s === 'in_merge_queue'))
      Object.assign(exec, { tone: 'done', state: 'done' });
    else if (states.some((s) => s === 'running' || s === 'verifying'))
      Object.assign(exec, { tone: 'run', state: 'active' });
    else Object.assign(exec, { tone: 'wait', state: 'active' });
  } else if (reached >= 4) Object.assign(exec, { tone: 'done', state: 'done' });

  const merge: Phase = { key: 'merge', label: '合并', tone: 'wait', state: 'pending' };
  if (subs.length && subs.every((s) => s.state === 'merged'))
    Object.assign(merge, { tone: 'done', state: 'done' });
  else if (subs.some((s) => s.state === 'in_merge_queue'))
    Object.assign(merge, { tone: 'run', state: 'active', detail: '排队合并' });
  else if (reached >= 5) Object.assign(merge, { tone: 'done', state: 'done' });

  if (t.state === 'done') {
    for (const p of [...phases, exec, merge]) Object.assign(p, { tone: 'done', state: 'done' });
  }
  return [...phases, exec, merge];
}
