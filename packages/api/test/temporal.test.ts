import { describe, expect, it } from 'vitest';
import { WorkflowGoneError } from '../src/ports.ts';
import { createTemporalWorkflowControl, type TemporalClientLike } from '../src/temporal.ts';

function fakeClient(fail?: Error) {
  const sent: { workflowId: string; name: string; arg: unknown }[] = [];
  const client: TemporalClientLike = {
    workflow: {
      getHandle: (workflowId) => ({
        async signal(name, arg) {
          if (fail) throw fail;
          sent.push({ workflowId, name, arg });
        },
      }),
    },
  };
  return { client, sent };
}

describe('Temporal 信号', () => {
  it('按任务找到工作流，信号名就是 TaskSignal 的 name，其余字段是参数', async () => {
    const { client, sent } = fakeClient();
    const control = createTemporalWorkflowControl(client, { workflowIdForTask: (id) => `task/${id}` });
    await control.signal('t1', { name: 'reroute', by: 'u1', routeId: 'r2', subtaskId: 's1' });
    expect(sent).toEqual([
      { workflowId: 'task/t1', name: 'reroute', arg: { by: 'u1', routeId: 'r2', subtaskId: 's1' } },
    ]);
  });

  it('工作流不存在或已结束：WorkflowGoneError；别的错原样抛', async () => {
    const notFound = Object.assign(new Error('workflow not found for ID: task/t1'), {
      name: 'WorkflowNotFoundError',
    });
    const gone = createTemporalWorkflowControl(fakeClient(notFound).client, {
      workflowIdForTask: (id) => id,
    });
    await expect(gone.signal('t1', { name: 'pause', by: 'u1' })).rejects.toBeInstanceOf(WorkflowGoneError);

    const down = createTemporalWorkflowControl(fakeClient(new Error('14 UNAVAILABLE')).client, {
      workflowIdForTask: (id) => id,
    });
    await expect(down.signal('t1', { name: 'pause', by: 'u1' })).rejects.toThrow('UNAVAILABLE');
  });
});
