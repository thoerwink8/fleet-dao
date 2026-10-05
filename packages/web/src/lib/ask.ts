// AI 问创始人的一句（#259「问他不挡路」）在驾驶舱里怎么说：和飞书那张意图卡同一套说法。
// 带了范围的提问都不挡路：这张单范围内的按推荐先做、超出范围的另开单、碰要他点头的四类的先按推荐做到合并前等批。
// 演示版的产物不许出现内部叫法（build/scan.ts），这里的字一律用白话。
import type { Ask, TaskState } from '../api/types';

const HOLD_WORDS: Record<NonNullable<Ask['hold']>, string> = {
  release: '对外发布',
  spend: '花钱',
  delete: '删数据',
  standard: '改标准',
};

/** 还没回答时 AI 已经怎么做了、他现在改选会怎样。老式的（会话停着等回答）没有这一句。 */
export function askStanding(ask: Ask, taskState: TaskState): string | null {
  if (ask.status === 'answered' || !ask.scope) return null;
  const rec = ask.recommended ?? '';
  const merged = taskState === 'done';
  switch (ask.scope) {
    case 'task':
      return merged
        ? `已按推荐先做：${rec}。这张单已经合进去了，改选别的会另开后续单。`
        : `已按推荐先做：${rec}。改选别的，下个存档点交给 AI 改。`;
    case 'hold': {
      const gate = ask.hold ? HOLD_WORDS[ask.hold] : '没写哪类';
      return merged
        ? `碰了要你点头的事（${gate}）：已按推荐做（${rec}）并合进去了，改选别的会另开后续单。`
        : `碰了要你点头的事（${gate}）：先按推荐做（${rec}），合并前等你批。`;
    }
    case 'outside':
      return `超出这张单的范围：这张单绕开它接着做，另开一张单等你拍${ask.followUpIssue ? `（#${ask.followUpIssue}）` : ''}。`;
  }
}

/** 回答了之后怎么生效（按推荐先做了的、另开单的才有）。 */
export function askEffectText(ask: Ask): string | null {
  if (ask.status !== 'answered') return null;
  if (ask.scope === 'outside') {
    return ask.followUpIssue ? `记在 #${ask.followUpIssue} 上` : '记下了，等另开的单';
  }
  switch (ask.effect) {
    case 'confirmed':
      return '就是推荐的，已生效';
    case 'applied':
      return '已生效';
    case 'change':
      return '下个存档点生效';
    case 'follow-up':
      return ask.followUpIssue
        ? `这张单已经合进去了，另开了后续单 #${ask.followUpIssue}`
        : '这张单已经合进去了，会另开后续单';
    case 'recorded':
      return '这张单没做成就停了，只记下';
    case undefined:
      return null;
  }
}

/** 还能不能回答：按推荐先做了的、另开单的，单子合进去以后照样能改；叫停、失败的，还有老式的单子一结束，就不用再答了。 */
export function canAnswerAsk(ask: Ask, taskState: TaskState): boolean {
  if (ask.status === 'answered') return false;
  if (taskState === 'stopped' || taskState === 'failed') return false;
  return taskState !== 'done' || Boolean(ask.scope);
}
