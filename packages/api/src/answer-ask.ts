// 回答 AI 的追问：驾驶舱的回答接口和飞书里回复追问卡走同一条路——写库和操作记录（同一事务）、发信号给工作流。
// fleet ask 不等回答（#259：当场按推荐先做），晚到的回答由引擎在下一个存档点看库。改发信号的去处（工作流编号怎么算）只改这里。
import type { Deps } from './deps.ts';
import type { Actor, AuditVia } from './ports.ts';
import { requirementWorkflowIdForTask } from './temporal.ts';

export async function answerAsk(
  deps: Pick<Deps, 'store' | 'workflows' | 'log'>,
  input: { askId: string; taskId: string; answer: string; by: Actor; via: AuditVia },
): Promise<'ok' | 'already_answered' | 'not_found'> {
  const { askId, taskId, answer, by, via } = input;
  const result = await deps.store.answerAsk(
    { askId, answer, by },
    { actor: by, action: 'ask.answer', target: `task:${taskId}`, after: { askId, answer }, via, ok: true },
  );
  if (result !== 'ok') return result;
  try {
    const workflowId = await requirementWorkflowIdForTask(deps.store, taskId);
    await deps.workflows.signal(workflowId, { name: 'answer', by: by.id, askId, answer });
  } catch (err) {
    // 回答已经写库：工作流收不到信号，也会在下一个存档点按库补看。
    deps.log.warn('回答已记下，但叫醒工作流没成功', { askId, error: String(err) });
  }
  return 'ok';
}
