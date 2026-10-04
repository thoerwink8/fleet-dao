// 回答 AI 的追问：驾驶舱的回答接口和飞书里回复追问卡走同一条路——写库和操作记录（同一事务）。
// 不发信号：引擎的任务工作流不听「回答」信号（它只听继续、放弃、路由叫醒，shared/task-signals.ts），
// 以前这里发的 answer 信号发给一个不存在的工作流、没人收（#901）。回答在库里，谁要看谁读库；停下等人的任务要人点「继续」。
import type { Deps } from './deps.ts';
import type { Actor, AuditVia } from './ports.ts';

export async function answerAsk(
  deps: Pick<Deps, 'store'>,
  input: { askId: string; taskId: string; answer: string; by: Actor; via: AuditVia },
): Promise<'ok' | 'already_answered' | 'not_found'> {
  const { askId, taskId, answer, by, via } = input;
  return deps.store.answerAsk(
    { askId, answer, by },
    { actor: by, action: 'ask.answer', target: `task:${taskId}`, after: { askId, answer }, via, ok: true },
  );
}
