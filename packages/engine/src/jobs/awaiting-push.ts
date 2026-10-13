// 等你的事往飞书推一条（提需求 F1 #2051 通知四类里的「等你拍板」「引擎问你」），每小时对账里跑。
// 每件事（提醒或提问的编号）只推一次，推过记在提醒表里（飞书推送的去重键，记下后立刻标成已处理，不占驾驶舱「提醒」的位置）。
// 没配 webhook、没配驾驶舱地址、推不出去、记不下「推过」：这一件记没查成，不当成推过（推不出去时不记已推）。
// 只看 AWAITING_WINDOW_MS 以内出现的（读的一侧按 since 筛）：上线第一轮不把积压的老事一次推完；一轮最多推 AWAITING_MAX_PER_RUN 条，
// 多出来的下一轮接着推，并照实记「还有几条没推」。
import { errMessage } from '@fleet-dao/shared/util';
import { clip, type SweepPart } from './reconcile-common.ts';

export interface AwaitingItem {
  kind: 'decision' | 'ask';
  id: string;
  taskId: string | null;
  title: string;
  detail: string;
}

export const AWAITING_WINDOW_MS = 24 * 60 * 60_000;
export const AWAITING_MAX_PER_RUN = 10;

export const awaitingPushKey = (kind: AwaitingItem['kind'], id: string): string => `feishu:${kind}:${id}`;
export const AWAITING_PUSH_TITLE: Readonly<Record<AwaitingItem['kind'], string>> = {
  decision: '等你拍板，已推飞书',
  ask: '引擎问你，已推飞书',
};

export interface AwaitingPushDeps {
  now: () => Date;
  /** since 以后出现、还没处理的等你的事，早的在前。读不到照抛，不许回空列表冒充「没有」。 */
  list: (since: Date) => Promise<readonly AwaitingItem[]>;
  /** 这个键记下过的正文；没有回 null。读不了照抛。 */
  sentBody: (dedupeKey: string) => Promise<string | null>;
  /** 记下推过（并标成已处理）。写不进照抛。 */
  markSent: (input: { dedupeKey: string; title: string; body: string; link: string }) => Promise<void>;
  /** 没配、推不出去照抛。抛出的话里不带 webhook 地址。 */
  send: (text: string) => Promise<void>;
  /** 驾驶舱某一页的完整链接；没配照抛。 */
  cockpit: (path: string) => string;
}

/** 链接落在哪一页：有任务就是任务页，没有（引擎自己的提醒）落在提醒页。 */
export const awaitingPath = (item: AwaitingItem): string =>
  item.taskId ? `/tasks/${item.taskId}` : '/notifications';

export function awaitingText(item: AwaitingItem, link: string): string {
  const head = item.kind === 'decision' ? '等你拍板' : '引擎问你';
  const lines = [`${head}：${clip(item.title, 200)}`];
  if (item.detail.trim() !== '' && item.detail !== item.title) lines.push(clip(item.detail, 300));
  lines.push(`驾驶舱：${link}`);
  return lines.join('\n');
}

export async function pushAwaitingMe(deps: AwaitingPushDeps): Promise<SweepPart> {
  let items: readonly AwaitingItem[];
  try {
    items = await deps.list(new Date(deps.now().getTime() - AWAITING_WINDOW_MS));
  } catch (err) {
    return {
      failed: `等你的事没读成：${errMessage(err)}`,
      scanned: 0,
      found: 0,
      unchecked: [],
    };
  }
  const part: SweepPart = { scanned: items.length, found: 0, unchecked: [] };
  let sentThisRun = 0;
  let left = 0;
  for (const item of items) {
    const key = awaitingPushKey(item.kind, item.id);
    const what = item.kind === 'decision' ? '等你拍板' : '引擎问你';
    try {
      if ((await deps.sentBody(key)) !== null) continue;
    } catch (err) {
      part.unchecked.push(`${what}：查推过没有没查成：${errMessage(err)}`);
      continue;
    }
    if (sentThisRun >= AWAITING_MAX_PER_RUN) {
      left += 1;
      continue;
    }
    let text: string;
    let link: string;
    try {
      link = deps.cockpit(awaitingPath(item));
      text = awaitingText(item, link);
    } catch (err) {
      part.unchecked.push(`${what}：${errMessage(err)}`);
      continue;
    }
    try {
      await deps.send(text);
    } catch (err) {
      part.unchecked.push(`${what}，飞书没推成：${errMessage(err)}`);
      continue;
    }
    sentThisRun += 1;
    part.found += 1;
    try {
      await deps.markSent({ dedupeKey: key, title: AWAITING_PUSH_TITLE[item.kind], body: text, link });
    } catch (err) {
      part.unchecked.push(`${what}的飞书已经推出去了，但没记下（下一小时可能再推一次）：${errMessage(err)}`);
    }
  }
  if (left > 0)
    part.unchecked.push(
      `等你的事还有 ${left} 件这一轮没推（一轮最多 ${AWAITING_MAX_PER_RUN} 条），下一轮接着推`,
    );
  return part;
}
