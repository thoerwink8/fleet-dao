// e2e 备库里的提需求（母单 #2047 第 D 片）：创始人甲当拍板人，灌三条走页面要用的需求。
// 走和线上同一个存储（request-store-pg.ts）建、发、改、提交，不手拼行；只有「已结案·做」要真开单，e2e 没接 GitHub，
// 那一条建好后直接把行改成结案、挂上 #12（和看板上那张单同号），并补一条和线上同一句的系统消息。
import { type Db, requestMessages, requests, users } from '@fleet-dao/db';
import { DEV_USER_ID, IDS } from '@fleet-dao/store';
import { eq } from 'drizzle-orm';
import { pgRequests } from '../../src/request-store-pg.ts';

export interface SeededRequests {
  /** 创始人乙提的、草稿齐了、等甲拍板。 */
  pending: number;
  /** 甲自己提的、已结案·做、开了 #12。 */
  closed: number;
  /** 甲提的、乙也说过话（不能删）。 */
  shared: number;
}

export async function seedRequests(db: Db, now: Date): Promise<SeededRequests> {
  await db.update(users).set({ decidesRequests: true }).where(eq(users.id, DEV_USER_ID));
  const port = pgRequests(db, () => now);
  const draft = {
    scene: '任务列表几个仓混在一起，看不出哪张单是哪个仓的',
    modules: 'packages/web/src/routes/tasks.tsx\n域: api\n性质: process',
    done: ['任务列表顶上能选仓，选了只剩那个仓的单'],
  };

  const pending = await port.create(IDS.founderB, {
    repoId: IDS.repo,
    body: '任务列表能不能按仓筛？',
    channel: 'web',
    title: '任务列表按仓筛',
  });
  await port.editDraft(pending, IDS.founderB, { baseVersion: 1, patch: draft });
  await port.act(pending, IDS.founderB, { action: 'submit', draftVersion: 2 });

  const closed = await port.create(DEV_USER_ID, {
    repoId: IDS.repo,
    body: '设置页那几个密钥能不能一起填？',
    channel: 'web',
    title: '设置页密钥一次填好',
  });
  await port.editDraft(closed, DEV_USER_ID, { baseVersion: 1, patch: draft });
  const [row] = await db
    .update(requests)
    .set({
      status: 'closed_do',
      deciderId: DEV_USER_ID,
      closedAt: now,
      issueRefs: [{ repo: 'example/canary', number: 12, state: 'open', stateAt: now.toISOString() }],
    })
    .where(eq(requests.seq, closed))
    .returning({ id: requests.id });
  if (!row) throw new Error(`需求 ${closed} 没建成`);
  await db.insert(requestMessages).values({
    requestId: row.id,
    kind: 'system',
    body: '创始人甲 确定开单（草稿第 2 版），已结案。开出 #12：https://github.com/example/canary/issues/12',
    createdAt: now,
  });

  const shared = await port.create(DEV_USER_ID, {
    repoId: IDS.repo,
    body: '额度页能不能按账号池折叠？',
    channel: 'web',
    title: '额度页按账号池折叠',
  });
  await port.send(shared, IDS.founderB, {
    body: '我也想要，顺便把用完的放最后',
    channel: 'web',
    mentions: [],
  });

  return { pending, closed, shared };
}
