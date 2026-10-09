// 该画出哪些能点的快捷操作（task-actions.tsx 的 availableActions，#901、#820 片 3、#856、#1496）：
// 引擎的任务工作流听暂停、继续、叫停、重做。中途换路由（reroute）后端固定 409，页面上没有这个动作。
// 已暂停不画「暂停」；在跑且没暂停不画「继续」。置灰的不进这份列表。
import { describe, expect, test } from 'vitest';
import type { BoardSubtask } from '../api/types';
import { type ActionTarget, availableActions } from '../components/task-actions';

const base: ActionTarget = { taskId: 't1', issueNumber: 12, title: '给驾驶舱加状态', state: 'running' };
// 只有 availableActions 会读的字段，够用就行
const sub = { id: 's1', index: 0, activity: { stage: 'execute', routeId: 'r1' } } as unknown as BoardSubtask;

describe('availableActions：只画引擎真有人听的动作', () => {
  test('在跑且没暂停：暂停、叫停；不给继续；没有换模型（哪怕它有在跑的会话）', () => {
    const list = availableActions({ ...base, activity: { stage: 'execute', routeId: 'r1' } as never });
    expect(list).toEqual(['pause', 'stop']);
    expect(list).not.toContain('resume');
    expect(list).not.toContain('reroute');
  });

  test('暂停着的需求：不再给「暂停」（后端也回 409 already_paused），只给继续、叫停', () => {
    expect(availableActions({ ...base, paused: '已暂停：被人暂停（frank）' })).toEqual(['resume', 'stop']);
  });

  test('卡在旧追问上的需求（asking）也没有「回答」：新流程没有收追问回答的地方（#928）；子任务上什么都没有', () => {
    const asking = availableActions({ ...base, state: 'asking' });
    expect(asking).toEqual(['pause', 'stop']);
    expect(asking as string[]).not.toContain('answer');
    expect(availableActions({ ...base, sub })).toEqual([]);
  });

  test('做完、失败一个都不画；已叫停只给重做', () => {
    for (const state of ['done', 'failed'] as const) {
      expect(availableActions({ ...base, state }), state).toEqual([]);
      expect(availableActions({ ...base, state, paused: '已暂停：…' }), state).toEqual([]);
    }
    expect(availableActions({ ...base, state: 'stopped' })).toEqual(['redo']);
    expect(availableActions({ ...base, state: 'stopped', paused: '已暂停：…' })).toEqual(['redo']);
  });

  test('挂起的单：没暂停给暂停、叫停、重做，不给继续；暂停着给继续、叫停、重做（工作流还在跑时由后端拒绝重做）', () => {
    expect(availableActions({ ...base, state: 'stalled' })).toEqual(['pause', 'stop', 'redo']);
    expect(availableActions({ ...base, state: 'stalled', paused: '已暂停：…' })).toEqual([
      'resume',
      'stop',
      'redo',
    ]);
  });
});
