// Store 契约：任务列表（listTasks，#1639）。内存版和 Postgres 版过同一套（store.memory.test.ts / store.pg.test.ts 调）。
// 「最近更新」靠 backdateState 把每张单的状态变化时刻摆成想要的样子，两个实现的排法才对得上。
import type { Task } from '@fleet-dao/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import { InvalidCursorError, type Store } from '../src/ports.ts';
import { type MakeStore, T0 } from './store-contract.ts';

const MIN = 60_000;
const OTHER_REPO = '99999999-0000-4000-8000-000000000000';
const uuid = (n: number) => `b2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const minutesBefore = (m: number) => new Date(T0.getTime() - m * MIN);

interface Spec {
  n: number;
  state: Task['state'];
  /** 最近一次状态变化在 T0 之前多少分钟。 */
  changed: number;
  title?: string;
  paused?: string;
}

const SPECS: Spec[] = [
  { n: 1, state: 'running', changed: 5, title: '登录页加验证码' },
  { n: 2, state: 'queued', changed: 10, title: '博客列表分页' },
  { n: 3, state: 'done', changed: 20, title: 'README 加一行当前时间' },
  { n: 4, state: 'failed', changed: 30, title: '部分退款的状态流转' },
  { n: 5, state: 'stopped', changed: 40, title: '巡检' },
  { n: 6, state: 'running', changed: 50, title: '首页加定价区块', paused: '已暂停：先等等' },
  { n: 7, state: 'stalled', changed: 60, title: '数据库夜间备份' },
  { n: 8, state: 'asking', changed: 70, title: '站内通知提醒' },
  // 最后两张最近一次变化在同一刻：翻页跨过它们也不漏不重（同一时刻按编号倒序）
  { n: 9, state: 'done', changed: 80, title: '100% 覆盖率' },
  { n: 10, state: 'done', changed: 80, title: '1000 个商品导入' },
];

export function describeTaskListContract(name: string, make: MakeStore): void {
  describe(`${name}：任务列表（listTasks）`, () => {
    let store: Store;
    const clock = { now: T0 };
    beforeEach(async () => {
      const base = devFixtures(T0);
      const tasks: Task[] = SPECS.map((s) => ({
        id: uuid(s.n),
        repoId: IDS.repo,
        issueNumber: s.n,
        title: s.title ?? `任务 ${s.n}`,
        rawRequest: s.title ?? `任务 ${s.n}`,
        requestedBy: IDS.founderA,
        state: s.state,
        priority: s.n,
        createdAt: minutesBefore(1000 + s.n).toISOString(),
        ...(s.paused === undefined ? {} : { paused: s.paused }),
      }));
      const under = await make({ users: base.users ?? [], repos: base.repos ?? [], tasks }, clock);
      store = under.store;
      for (const s of SPECS) await under.backdateState(uuid(s.n), minutesBefore(s.changed));
    });

    const page = (q: Parameters<Store['listTasks']>[0]) => store.listTasks(q);
    const issues = (items: { task: Task }[]) => items.map((i) => i.task.issueNumber);

    it('按最近更新从新到旧；同一时刻按编号倒序；带每张单的最近更新时刻', async () => {
      const got = await page({ limit: 50 });
      expect(issues(got.items)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 9].map((n) => n));
      expect(got.items[0]?.updatedAt).toBe(minutesBefore(5).toISOString());
      expect(got.nextCursor).toBeUndefined();
    });

    it('不限 7 天窗口：很早以前就结束的单也在', async () => {
      const got = await page({ limit: 50 });
      expect(got.items.map((i) => i.task.state)).toContain('done');
      expect(got.items).toHaveLength(10);
    });

    it('各组的数：暂停和停滞、旧追问算等人；暂停的单带 paused', async () => {
      const got = await page({ limit: 50 });
      expect(got.counts).toEqual({ running: 1, queued: 1, waiting: 3, done: 3, failed: 1, stopped: 1 });
      expect(got.items.find((i) => i.task.issueNumber === 6)?.task).toMatchObject({
        state: 'running',
        paused: '已暂停：先等等',
      });
    });

    it('按组筛：只出这一组，各组的数不跟着变', async () => {
      const all = await page({ limit: 50 });
      for (const [group, expected] of [
        ['running', [1]],
        ['queued', [2]],
        ['waiting', [6, 7, 8]],
        ['done', [3, 10, 9]],
        ['failed', [4]],
        ['stopped', [5]],
      ] as const) {
        const got = await page({ group, limit: 50 });
        expect(issues(got.items), group).toEqual(expected);
        expect(got.counts).toEqual(all.counts);
      }
    });

    it('翻页：limit=3 分四页，跨过同一时刻的两张也不漏不重，最后一页没有游标', async () => {
      const seen: number[] = [];
      const sizes: number[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 6; i++) {
        const got = await page({ limit: 3, ...(cursor === undefined ? {} : { cursor }) });
        sizes.push(got.items.length);
        seen.push(...issues(got.items));
        cursor = got.nextCursor;
        if (cursor === undefined) break;
      }
      expect(sizes).toEqual([3, 3, 3, 1]);
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 9]);
    });

    it('刚好一页装下：没有下一页游标', async () => {
      expect((await page({ limit: 10 })).nextCursor).toBeUndefined();
      expect((await page({ limit: 9 })).nextCursor).toBeDefined();
    });

    it('游标看不懂：抛 InvalidCursorError，不装成空页', async () => {
      await expect(page({ limit: 5, cursor: 'garbage' })).rejects.toBeInstanceOf(InvalidCursorError);
      await expect(page({ limit: 5, cursor: 'nope|b2000000' })).rejects.toBeInstanceOf(InvalidCursorError);
    });

    it('搜索：数字（可带 #）按单号精确，标题包含不分大小写；% 当普通字符，不是通配', async () => {
      expect(issues((await page({ q: '#7', limit: 50 })).items)).toEqual([7]);
      expect(issues((await page({ q: '7', limit: 50 })).items)).toEqual([7]);
      expect(issues((await page({ q: 'readme', limit: 50 })).items)).toEqual([3]);
      expect(issues((await page({ q: '100%', limit: 50 })).items)).toEqual([9]);
      expect(issues((await page({ q: '%', limit: 50 })).items)).toEqual([9]);
      expect(issues((await page({ q: '  ', limit: 50 })).items)).toHaveLength(10);
      expect((await page({ q: '没有这个', limit: 50 })).items).toEqual([]);
    });

    it('搜索词缩小各组的数；仓筛选：别的仓、看不懂的编号都是空页、数全 0', async () => {
      expect((await page({ q: '100%', limit: 50 })).counts).toEqual({
        running: 0,
        queued: 0,
        waiting: 0,
        done: 1,
        failed: 0,
        stopped: 0,
      });
      expect((await page({ repoId: IDS.repo, limit: 50 })).items).toHaveLength(10);
      for (const repoId of [OTHER_REPO, 'nope']) {
        const got = await page({ repoId, limit: 50 });
        expect(got.items).toEqual([]);
        expect(Object.values(got.counts).reduce((a, b) => a + b, 0)).toBe(0);
      }
    });
  });
}
