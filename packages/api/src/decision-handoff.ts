// 「要你拍」拍完以后交给指挥官（#1915，「用户拍完之后，就应该交给指挥官去处理了」）：
// 答案存下的同时，往进度单 #1055 记一条待处理的引导「创始人已选：<选项或原文>（通知 <id>）」——指挥官会话开场钩子和
// `pnpm progress read` 读的就是这种评论（格式和 packages/conventions 的 progress.ts 同一份，记成无主，由指挥官认领）；
// 通知挂了任务的，再给那个任务的单留一句。法国上没有 gh：评论走引擎机器人的 GitHub 客户端（@fleet-dao/github 的 commentIssue），
// 不新造写法。没接上、没写成的照实回在 handoff 里，不拿「答案存下了」冒充「交出去了」。
// 双写（#3741 片 2b）：#1055 之外先直接往账本记一行 decision.handoff（writeHandoffLedger），写失败只警告、不挡 #1055。读方片 2c 才改。
import { NO_OWNER, ownerLine, PENDING_TAG, PROGRESS_ISSUE, progressStamp } from '@fleet-dao/conventions';
import { type DecisionAnswer, LEDGER_PROGRESS_TARGET_PREFIX } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { NotificationRecord, Store } from './ports.ts';
import { findSelfRepo } from './self-repo.ts';

export type HandoffResult = { ok: true; url: string } | { ok: false; why: string };

/** 往一张单上留言（幂等：同一个 key 只留一条）。真实现是引擎机器人的 commentIssue。 */
export interface DecisionCommenter {
  comment(input: {
    repo: { owner: string; name: string };
    issueNumber: number;
    key: string;
    body: string;
  }): Promise<{ url: string }>;
}

export const HANDOFF_NOT_WIRED = '没接上 GitHub（开发环境，或机器人凭据没读到）：答案存下了，没记到进度单';

/** 一句话说答案：点的选项写那一项的字，自己输入的写原文。 */
export const answerWords = (answer: DecisionAnswer): string =>
  answer.optionId === undefined ? `自己输入：${answer.text}` : answer.text;

/** 进度单那一条的正文：待处理的创始人引导（无主），原话就是他选的。 */
export function progressCommentBody(
  n: Pick<NotificationRecord, 'id' | 'title'>,
  answer: DecisionAnswer,
): string {
  return [
    `${PENDING_TAG}${progressStamp(new Date(answer.at))}`,
    ownerLine(NO_OWNER),
    '',
    `原话：创始人已选：${answerWords(answer)}（通知 ${n.id}）`,
    '',
    `要你拍的事：${n.title}`,
  ].join('\n');
}

/** 任务单上那一句。 */
export function taskCommentBody(n: Pick<NotificationRecord, 'id' | 'title'>, answer: DecisionAnswer): string {
  return `创始人在驾驶舱拍了「${n.title}」：${answerWords(answer)}（通知 ${n.id}，${progressStamp(new Date(answer.at))}）。`;
}

/**
 * 把答案交出去：进度单一条，挂了任务的任务单一条。两条各自成败，一条没成不拦另一条；commenter 没给的照实写没接上。
 */
export async function handOffDecision(
  deps: {
    store: Store;
    commenter?: DecisionCommenter | undefined;
    /** 账本写失败的警告（只警告、不挡 #1055）；不给就不出声。 */
    warn?: ((message: string, fields: Record<string, unknown>) => void) | undefined;
  },
  n: NotificationRecord,
  answer: DecisionAnswer,
): Promise<{ progress: HandoffResult; task?: HandoffResult }> {
  const { commenter, store } = deps;
  if (!answer.id) return { progress: { ok: false, why: '历史答案没有代次：不能自动交接，请重新作答' } };
  const key = `decision-answer:${n.id}:${answer.id}`;
  await writeHandoffLedger(deps, n, answer, key);
  const progress = await attempt(async () => {
    if (!commenter) throw new Error(HANDOFF_NOT_WIRED);
    const self = await findSelfRepo(store);
    if (!self) throw new Error('受管的仓里没有 fleet-dao：找不到进度单在哪个仓');
    return commenter.comment({
      repo: { owner: self.owner, name: self.name },
      issueNumber: PROGRESS_ISSUE,
      key,
      body: progressCommentBody(n, answer),
    });
  });
  if (!n.taskId) return { progress };
  const taskId = n.taskId;
  const task = await attempt(async () => {
    if (!commenter) throw new Error(HANDOFF_NOT_WIRED.replace('没记到进度单', '没留到任务单上'));
    const t = await store.getTask(taskId);
    if (!t) throw new Error(`通知挂的任务 ${taskId} 查不到`);
    const repo = (await store.listRepos()).find((r) => r.id === t.repoId);
    if (!repo) throw new Error(`任务 ${taskId} 的仓 ${t.repoId} 查不到`);
    return commenter.comment({
      repo: { owner: repo.owner, name: repo.name },
      issueNumber: t.issueNumber,
      key,
      body: taskCommentBody(n, answer),
    });
  });
  return { progress, task };
}

/**
 * 双写的账本那一半（#3741 片 2b，决定 0122）：kind decision.handoff，target progress:<fleet-dao>，text 带通知 id 和选项。
 * 幂等键就是 #1055 留言用的 key（通知 id + 答案代次），重放不重复。写不成只警告，不挡 #1055 和任务单留言。
 */
async function writeHandoffLedger(
  deps: { store: Store; warn?: ((message: string, fields: Record<string, unknown>) => void) | undefined },
  n: NotificationRecord,
  answer: DecisionAnswer,
  key: string,
): Promise<void> {
  try {
    const self = await findSelfRepo(deps.store);
    if (!self) throw new Error('受管的仓里没有 fleet-dao：找不到账本记在哪个仓');
    const repo = `${self.owner}/${self.name}`;
    await deps.store.appendLedgerNote({
      actorId: 'api:decision-handoff',
      action: 'decision.handoff',
      target: `${LEDGER_PROGRESS_TARGET_PREFIX}${repo}`,
      after: {
        nodeId: 'api',
        repo,
        text: `创始人已选：${answerWords(answer)}（通知 ${n.id}）。要你拍的事：${n.title}`,
        source: { kind: 'api', ref: `notification:${n.id}` },
        idempotencyKey: key,
        notificationId: n.id,
        answerId: answer.id,
      },
    });
  } catch (err) {
    deps.warn?.('「要你拍」的交接没写进账本（#1055 照写）', { notification: n.id, why: errMessage(err) });
  }
}

async function attempt(write: () => Promise<{ url: string }>): Promise<HandoffResult> {
  try {
    const { url } = await write();
    return { ok: true, url };
  } catch (err) {
    return { ok: false, why: errMessage(err) };
  }
}
