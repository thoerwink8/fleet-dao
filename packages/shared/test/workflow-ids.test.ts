// 工作流编号的拼法（workflow-ids.ts）：引擎起工作流和驾驶舱后端发信号共用，改格式两边一起改。
// 任务工作流（#632）的编号定死：同一张单只有这一个编号，REJECT_DUPLICATE 才挡得住重复。
import { describe, expect, it } from 'vitest';
import {
  mergeQueueWorkflowId,
  requirementWorkflowId,
  subtaskWorkflowId,
  TASK_WORKFLOW_TYPE,
  taskWorkflowId,
} from '../src/workflow-ids.ts';

const repo = { owner: 'acme', name: 'demo' };

describe('taskWorkflowId', () => {
  it('一张单一个编号：task:<仓>#<单号>', () => {
    expect(taskWorkflowId(repo, 12)).toBe('task:acme/demo#12');
    expect(taskWorkflowId(repo, 12)).toBe(taskWorkflowId({ ...repo }, 12));
  });

  it('不同的单、不同的仓编号不同；和别的工作流的编号不撞（前缀各自一个）', () => {
    const ids = [
      taskWorkflowId(repo, 12),
      taskWorkflowId(repo, 13),
      taskWorkflowId({ owner: 'acme', name: 'other' }, 12),
      requirementWorkflowId(repo, 12),
      subtaskWorkflowId('abc'),
      mergeQueueWorkflowId(repo),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('类型名必须等于引擎 workflows/task.ts 导出的函数名', () => {
    expect(TASK_WORKFLOW_TYPE).toBe('taskWorkflow');
  });
});
