// 该画出哪些快捷操作（task-actions.tsx 的 availableActions，#901、#820 片 3）：引擎的任务工作流听暂停、继续、叫停，
// 换模型后端回 409 action_not_supported，所以不画——画出来点了只会弹一句「做不到」。暂停着的单不再给「暂停」。
import { describe, expect, test } from 'vitest';
import type { BoardSubtask } from '../api/types';
import { type ActionTarget, availableActions } from '../components/task-actions';

const base: ActionTarget = { taskId: 't1', issueNumber: 12, title: '给驾驶舱加状态', state: 'running' };
// 只有 availableActions 会读的字段，够用就行
const sub = { id: 's1', index: 0, activity: { stage: 'execute', routeId: 'r1' } } as unknown as BoardSubtask;

describe('availableActions：只画引擎真有人听的动作', () => {
  test('在跑的需求：暂停、继续、叫停；没有换模型（哪怕它有在跑的会话）', () => {
    const list = availableActions({ ...base, activity: { stage: 'execute', routeId: 'r1' } as never });
    expect(list).toEqual(['pause', 'resume', 'stop']);
    expect(list).not.toContain('reroute');
  });

  test('暂停着的需求：不再给「暂停」（后端也回 409 already_paused），只给继续、叫停', () => {
    expect(availableActions({ ...base, paused: '已暂停：被人暂停（frank）' })).toEqual(['resume', 'stop']);
  });

  test('卡在旧追问上的需求（asking）也没有「回答」：新流程没有收追问回答的地方（#928）；子任务上什么都没有', () => {
    const asking = availableActions({ ...base, state: 'asking' });
    expect(asking).toEqual(['pause', 'resume', 'stop']);
    expect(asking as string[]).not.toContain('answer');
    expect(availableActions({ ...base, sub })).toEqual([]);
  });

  test('已结束的（做完、叫停、没做完）一个都不画，暂停着的也一样', () => {
    for (const state of ['done', 'stopped', 'failed'] as const) {
      expect(availableActions({ ...base, state }), state).toEqual([]);
      expect(availableActions({ ...base, state, paused: '已暂停：…' }), state).toEqual([]);
    }
  });
});
