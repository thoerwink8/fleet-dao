// 旧会话留下的追问（#928、#939）：v3 三段流程里没有「AI 追问」这一环——动手会话没有 fleet 令牌、发不出 fleet ask，
// 引擎的任务工作流也没有收「回答」的地方（它只听继续、放弃、路由叫醒，shared/task-signals.ts）。
// 库里还有的追问只来自还没删的旧会话：不再接回答（回答只落库、没人读，等于骗人），只能「关闭」把它标成已处理。
// 驾驶舱的回答接口和飞书里回复追问卡都走这里的同一句话，不各说各的。
import { LEGACY_ASK_CLOSED_ANSWER } from '@fleet-dao/shared';
import type { Deps } from './deps.ts';
import type { Actor, AuditVia } from './ports.ts';

export const ASKS_NOT_RECEIVED_CODE = 'asks_not_received';

export const ASKS_NOT_RECEIVED_WHY =
  '新流程不再收追问回答：现在的动手会话发不出追问，这条是旧会话留下的，不会有人读到你的回答。要把它收掉，在通知中心点「关闭」。';

/** 把一条旧追问标成已处理：写库和操作记录（ask.close）同一事务；已经处理过不改。 */
export async function closeLegacyAsk(
  deps: Pick<Deps, 'store'>,
  input: { askId: string; taskId: string; by: Actor; via: AuditVia },
): Promise<'ok' | 'already_answered' | 'not_found'> {
  const { askId, taskId, by, via } = input;
  // 关闭复用库里「答过」这一列（answerAsk 同一事务写库 + 操作记录）：库表没有「已关闭」，加列要迁移，不值得。
  // 写进去的是 LEGACY_ASK_CLOSED_ANSWER 这一句、不是任何人的回答；读 answer 的地方要认它。
  return deps.store.answerAsk(
    { askId, answer: LEGACY_ASK_CLOSED_ANSWER, by },
    { actor: by, action: 'ask.close', target: `task:${taskId}`, after: { askId }, via, ok: true },
  );
}
