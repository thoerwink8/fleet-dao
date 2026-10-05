// 驾驶舱动作 → 发给 Temporal 的信号 → 引擎收：这条链上驾驶舱后端这一半的钉子（#901，chain-first）。
// 起因：后端发信号一直用旧的需求工作流编号 req:<仓>#<号> 和 pause/resume/stop 这些信号名，引擎里只有
// task:<仓>#<号> 这一种工作流、只听 taskContinue / taskAbandon / taskRouteWake——点了「继续」「叫停」发给一个不存在的
// 工作流，一律回 409。这里用真的 createTemporalWorkflowControl 接一个假 Temporal 客户端，记下它真正收到的
// 工作流编号和信号名。引擎那一半（真工作流收得到这些名字）在 packages/engine/test/task-signals.test.ts，两边共用 shared/task-signals.ts。
import { TASK_SIGNAL_NAMES } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { createTemporalWorkflowControl, type TemporalClientLike } from '../src/temporal.ts';
import { DEV_USER_ID, errorCode, harness, IDS, write } from './harness.ts';

/** 假 Temporal 客户端：记下发给谁、什么信号名、什么参数；missing 里的编号当作「没有这条工作流」。 */
function fakeTemporal(missing: ReadonlySet<string> = new Set()) {
  const sent: { workflowId: string; name: string; arg: unknown }[] = [];
  const client: TemporalClientLike = {
    connection: { withDeadline: (_deadline, fn) => fn() },
    workflow: {
      getHandle: (workflowId) => ({
        async signal(name, arg) {
          if (missing.has(workflowId)) {
            throw Object.assign(new Error('workflow not found'), { name: 'WorkflowNotFoundError' });
          }
          sent.push({ workflowId, name, arg });
        },
      }),
    },
  };
  return { sent, control: createTemporalWorkflowControl(client) };
}

// task12 在 example/canary 仓、issue 号 12（store 的样例数据）：引擎起它的工作流编号就是下面这个。
const TASK12_WORKFLOW_ID = 'task:example/canary#12';

describe('驾驶舱动作发的信号，工作流编号和信号名对得上引擎', () => {
  it('「继续」：发给 task:<仓>#<号>，信号名 taskContinue，参数是 { by }', async () => {
    const t = fakeTemporal();
    const h = harness({ workflows: t.control });
    const s = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'resume' }),
    );
    expect(res.status).toBe(200);
    expect(t.sent).toEqual([
      { workflowId: TASK12_WORKFLOW_ID, name: 'taskContinue', arg: { by: DEV_USER_ID } },
    ]);
    expect(TASK_SIGNAL_NAMES.continue).toBe('taskContinue');
  });

  it('「叫停」：taskAbandon，参数 { by, reason }；没写原因也补一句话（引擎的约定里 reason 必填）', async () => {
    const t = fakeTemporal();
    const h = harness({ workflows: t.control });
    const s = await h.login();
    const post = (body: unknown) =>
      h.cockpit.request(`/api/tasks/${IDS.task12}/actions`, write('POST', s, body));
    expect((await post({ action: 'stop', reason: '需求变了' })).status).toBe(200);
    expect((await post({ action: 'stop' })).status).toBe(200);
    expect(t.sent.map((x) => [x.workflowId, x.name])).toEqual([
      [TASK12_WORKFLOW_ID, 'taskAbandon'],
      [TASK12_WORKFLOW_ID, 'taskAbandon'],
    ]);
    expect(t.sent[0]?.arg).toEqual({ by: DEV_USER_ID, reason: '需求变了' });
    expect(t.sent[1]?.arg).toEqual({ by: DEV_USER_ID, reason: '驾驶舱上点了叫停' });
    expect(TASK_SIGNAL_NAMES.abandon).toBe('taskAbandon');
  });

  it('引擎没有的动作（暂停、换路由）：409 action_not_supported 带人话原因，不写操作记录、不发信号', async () => {
    const t = fakeTemporal();
    const h = harness({ workflows: t.control });
    const s = await h.login();
    const before = h.store.data.audit.length;
    for (const body of [{ action: 'pause' }, { action: 'reroute', routeId: 'rt-mirasim-kimi' }]) {
      const res = await h.cockpit.request(`/api/tasks/${IDS.task12}/actions`, write('POST', s, body));
      expect(res.status, body.action).toBe(409);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('action_not_supported');
      expect(json.error.message).toContain('叫停');
    }
    expect(t.sent).toEqual([]);
    expect(h.store.data.audit.length).toBe(before);
  });

  it('这张单没有在跑的任务工作流（做完、被放弃、还没拉起）：409 workflow_gone，原因写在话里，记 ok=false', async () => {
    const t = fakeTemporal(new Set([TASK12_WORKFLOW_ID]));
    const h = harness({ workflows: t.control });
    const s = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'resume' }),
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('workflow_gone');
    expect(h.store.data.audit.slice(-1)).toMatchObject([
      { action: 'task.resume', ok: false, error: 'workflow_gone' },
    ]);
  });

  it('任务所在的仓不在库里：拼不出工作流编号，回 404 workflow_target_not_found，不是笼统的 502', async () => {
    const t = fakeTemporal();
    const h = harness({ workflows: t.control });
    const s = await h.login();
    const task = h.store.data.tasks.find((x) => x.id === IDS.task12);
    if (!task) throw new Error('样例数据里要有 task12');
    h.store.data.repos = h.store.data.repos.filter((r) => r.id !== task.repoId);
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'resume' }),
    );
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('workflow_target_not_found');
    expect(t.sent).toEqual([]);
  });
});
