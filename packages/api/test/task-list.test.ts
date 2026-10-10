// GET /api/tasks（任务列表，#1639）：按状态组、单号和标题筛，游标翻页，各组的数，花费读不到写原因，没登录拒绝。
// 状态分组的规则在 shared 的 task-list.ts，这里只验接口怎么用它。
import { TASK_LIST_GROUPS, type Task, TaskListResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { errorCode, harness, IDS, T0 } from './harness.ts';

const REPO = IDS.repo;
const uuid = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const minutesAgo = (m: number) => new Date(T0.getTime() - m * 60_000).toISOString();

function task(n: number, over: Partial<Task>): Task {
  return {
    id: uuid(n),
    repoId: REPO,
    issueNumber: n,
    title: `任务 ${n}`,
    rawRequest: `任务 ${n}`,
    requestedBy: IDS.founderA,
    state: 'running',
    priority: n,
    createdAt: minutesAgo(1000 - n),
    ...over,
  };
}

/** 样例里 #12 在跑、#13 做完，再加五张：排队、等你、失败、叫停、暂停。 */
const EXTRA: Task[] = [
  task(20, { state: 'queued', title: '博客列表分页' }),
  task(21, { state: 'failed', title: '部分退款的状态流转' }),
  task(22, { state: 'stopped', title: '巡检：每 6 小时跑一遍' }),
  task(23, { state: 'running', paused: '已暂停：创始人说先等等', title: '首页加定价区块' }),
  task(24, { state: 'stalled', title: '数据库夜间备份' }),
];

async function open(tasks: Task[] = EXTRA) {
  const h = harness();
  h.store.data.tasks.push(...tasks);
  const { cookie } = await h.login();
  const get = async (query = '') => {
    const res = await h.cockpit.request(`/api/tasks${query}`, { headers: { cookie } });
    return res;
  };
  return { h, get, cookie };
}

async function body(res: Response) {
  expect(res.status).toBe(200);
  return TaskListResponse.parse(await res.json());
}

describe('GET /api/tasks', () => {
  it('没登录：401，一行都不给', async () => {
    const h = harness();
    const res = await h.cockpit.request('/api/tasks');
    expect(res.status).toBe(401);
  });

  it('不带条件：所有仓所有状态都在，各组的数加起来是全部', async () => {
    const { get } = await open();
    const list = await body(await get());
    expect(list.items).toHaveLength(7);
    expect(list.counts).toEqual({
      all: 7,
      running: 1,
      queued: 1,
      waiting: 2,
      done: 1,
      failed: 1,
      stopped: 1,
    });
  });

  it('按状态筛：在跑、排队、等人（暂停和停滞算进去）、做完、失败、叫停各自只出自己那组', async () => {
    const { get } = await open();
    const ids = async (status: string) =>
      (await body(await get(`?status=${status}`))).items.map((i) => i.issueNumber).sort((a, b) => a - b);
    expect(await ids('running')).toEqual([12]);
    expect(await ids('queued')).toEqual([20]);
    expect(await ids('waiting')).toEqual([23, 24]);
    expect(await ids('done')).toEqual([13]);
    expect(await ids('failed')).toEqual([21]);
    expect(await ids('stopped')).toEqual([22]);
    for (const g of TASK_LIST_GROUPS) {
      const rows = (await body(await get(`?status=${g}`))).items;
      expect(new Set(rows.map((r) => r.group))).toEqual(new Set(rows.length ? [g] : []));
    }
  });

  it('各组的数不受状态筛选影响（切换标签时数不跳）', async () => {
    const { get } = await open();
    const all = await body(await get());
    const failedOnly = await body(await get('?status=failed'));
    expect(failedOnly.items).toHaveLength(1);
    expect(failedOnly.counts).toEqual(all.counts);
  });

  it('暂停的单：state 仍是 running，paused 带着那句话，分到等人', async () => {
    const { get } = await open();
    const row = (await body(await get('?status=waiting'))).items.find((i) => i.issueNumber === 23);
    expect(row).toMatchObject({ state: 'running', group: 'waiting', paused: '已暂停：创始人说先等等' });
  });

  it('按单号搜：数字（可带 #）精确找到那张；按标题搜：包含，不分大小写', async () => {
    const { get } = await open();
    const byIssue = await body(await get('?q=%2321'));
    expect(byIssue.items.map((i) => i.issueNumber)).toEqual([21]);
    const plain = await body(await get('?q=21'));
    expect(plain.items.map((i) => i.issueNumber)).toEqual([21]);
    const byTitle = await body(await get(`?q=${encodeURIComponent('分页')}`));
    expect(byTitle.items.map((i) => i.issueNumber)).toEqual([20]);
    const none = await body(await get('?q=不存在的标题'));
    expect(none.items).toEqual([]);
    expect(none.counts.all).toBe(0);
  });

  it('搜索词会缩小各组的数，仓筛选也是；仓编号不存在回空页、数都是 0', async () => {
    const { get } = await open();
    expect((await body(await get('?q=README'))).counts.all).toBe(1);
    const mine = await body(await get(`?repoId=${REPO}`));
    expect(mine.counts.all).toBe(7);
    const other = await body(await get('?repoId=b9999999-0000-4000-8000-000000000000'));
    expect(other.items).toEqual([]);
    expect(other.counts.all).toBe(0);
  });

  it('游标翻页：limit=3 分三页，不重不漏，最近更新在前，最后一页没有游标', async () => {
    const { get } = await open();
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const page = await body(await get(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      sizes.push(page.items.length);
      seen.push(...page.items.map((r) => r.taskId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(sizes).toEqual([3, 3, 1]);
    expect(new Set(seen).size).toBe(7);
    const all = await body(await get());
    expect(seen).toEqual(all.items.map((r) => r.taskId));
    const stamps = all.items.map((r) => r.updatedAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  it('刚好一页装下：没有下一页游标；游标看不懂回 400，不装成空页', async () => {
    const { get } = await open();
    expect((await body(await get('?limit=7'))).nextCursor).toBeUndefined();
    const bad = await get('?cursor=garbage');
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('invalid_cursor');
    expect((await get('?status=nope')).status).toBe(400);
    expect((await get('?limit=0')).status).toBe(400);
  });

  it('每一行：做完的没有「现在在哪一段」；花费读不到给 null 和原因，部分没读到标偏低；PR 号取流水上的', async () => {
    const { get } = await open();
    const list = await body(await get());
    const done = list.items.find((i) => i.issueNumber === 13);
    expect(done).toMatchObject({ group: 'done', segment: null, prNumber: 39, repo: 'example/canary' });
    expect(done?.cost.usd).toBeCloseTo(2.28, 6);
    expect(done?.cost.note).toContain('偏低');
    const queued = list.items.find((i) => i.issueNumber === 20);
    expect(queued).toMatchObject({ segment: 'scoping', model: null, prNumber: null });
    expect(queued?.cost.usd).toBeNull();
    expect(queued?.cost.note).toBeTruthy();
  });
});
