// 该画出哪些快捷操作（task-actions.tsx 的 availableActions，#901）：引擎的任务工作流只听继续、叫停（外加回答，只落库），
// 暂停、换模型后端回 409 action_not_supported，所以不画——画出来点了只会弹一句「做不到」。
import { describe, expect, test } from 'vitest';
import type { BoardSubtask } from '../api/types';
import { type ActionTarget, availableActions } from '../components/task-actions';

const base: ActionTarget = { taskId: 't1', issueNumber: 12, title: '给驾驶舱加状态', state: 'running' };
// 只有 availableActions 会读的字段，够用就行
const sub = { id: 's1', index: 0, activity: { stage: 'execute', routeId: 'r1' } } as unknown as BoardSubtask;

describe('availableActions：只画引擎真有人听的动作', () => {
  test('在跑的需求：继续、叫停；没有暂停、没有换模型（哪怕它有在跑的会话）', () => {
    const list = availableActions({ ...base, activity: { stage: 'execute', routeId: 'r1' } as never });
    expect(list).toEqual(['resume', 'stop']);
    expect(list).not.toContain('pause');
    expect(list).not.toContain('reroute');
  });

  test('等人回答的需求多一个「回答」；子任务上什么都没有（叫停、继续对整个需求生效）', () => {
    expect(availableActions({ ...base, state: 'asking' })).toEqual(['answer', 'resume', 'stop']);
    expect(availableActions({ ...base, sub })).toEqual([]);
  });

  test('已结束的（做完、叫停、没做完）一个都不画', () => {
    for (const state of ['done', 'stopped', 'failed'] as const) {
      expect(availableActions({ ...base, state }), state).toEqual([]);
    }
  });
});
