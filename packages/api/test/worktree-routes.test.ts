// 资源页「清理没用的工作树」按钮的两个口（#1993）：POST 记一条 worktrees.cleanup.request，GET 读清单和最近几次清理。
// 故意造出的失败：引擎没开 / 没连上不记成点过；已经有一次在排队 409；清单认不出不当成「没有树」；操作记录读不到 503。
import {
  WORKTREE_ACTION,
  WORKTREE_TARGET,
  WorktreeCleanupResponseSchema,
  type WorktreeInventory,
  WorktreesResponseSchema,
} from '@fleet-dao/shared';
import { devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { PublicHealthError } from '../src/health.ts';
import { errorCode, harness, T0, write } from './harness.ts';

const PATH = '/api/worktrees';
const engineOn = [{ name: 'engine', check: async () => {} }];
const engine = { kind: 'engine' as const, id: 'engine:worktrees' };
type H = ReturnType<typeof harness>;

const cleanupRows = (h: H) => h.store.data.audit.filter((a) => a.target === WORKTREE_TARGET);

async function read(h: H, cookie: string) {
  const res = await h.cockpit.request(PATH, { headers: { cookie } });
  expect(res.status).toBe(200);
  return WorktreesResponseSchema.parse(await res.json());
}

const inventory: WorktreeInventory = {
  takenAt: T0.toISOString(),
  trigger: 'hourly',
  root: '/var/lib/fleet-work',
  trees: [
    {
      repo: 'acme/web',
      tree: '12-a1b2c3d4',
      what: '需求 #12 的主树',
      issueNumber: 12,
      state: 'leftover',
      why: '有没推的提交：1 个',
      size: { state: 'ok', bytes: 4096 },
    },
  ],
  removed: [],
  repos: [{ repo: 'acme/web', mirror: { state: 'ok', bytes: 1024 } }],
  unchecked: [],
};

describe('POST /api/worktrees/cleanup', () => {
  it('点一下：记一条 worktrees.cleanup.request（操作人是登录的人），读回是「排队」', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    const res = await h.cockpit.request(`${PATH}/cleanup`, write('POST', s, { reason: '树太多' }));
    expect(res.status).toBe(200);
    const body = WorktreeCleanupResponseSchema.parse(await res.json());
    const rows = cleanupRows(h);
    expect(rows.map((a) => [a.action, a.actor.kind, a.via])).toEqual([[WORKTREE_ACTION.request, 'user', 'cockpit']]);
    expect(rows[0]?.after).toEqual({ requestId: body.requestId });
    expect(rows[0]?.reason).toBe('树太多');
    const got = await read(h, s.cookie);
    expect(got.cleanups[0]).toMatchObject({ requestId: body.requestId, status: 'queued' });
  });

  it('引擎做完：读回删了哪些、拒了哪些和原因', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    const { requestId } = WorktreeCleanupResponseSchema.parse(
      await (await h.cockpit.request(`${PATH}/cleanup`, write('POST', s, {}))).json(),
    );
    for (const [action, after] of [
      [WORKTREE_ACTION.start, { requestId }],
      [
        WORKTREE_ACTION.done,
        {
          requestId,
          result: {
            removed: ['acme_web/3-old'],
            refused: [{ tree: 'acme_web/12-a1b2c3d4', state: 'leftover', why: '有没推的提交：1 个' }],
            unchecked: [],
          },
        },
      ],
    ] as const) {
      await h.store.appendAudit({ actor: engine, action, target: WORKTREE_TARGET, after, via: 'engine', ok: true });
    }
    const got = await read(h, s.cookie);
    expect(got.cleanups[0]).toMatchObject({
      status: 'done',
      result: { removed: ['acme_web/3-old'], refused: [{ state: 'leftover', why: '有没推的提交：1 个' }] },
    });
  });

  it('【故意造出的失败】已经有一次在排队：409 cleanup_busy，不记第二条', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    expect((await h.cockpit.request(`${PATH}/cleanup`, write('POST', s, {}))).status).toBe(200);
    const again = await h.cockpit.request(`${PATH}/cleanup`, write('POST', s, {}));
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('cleanup_busy');
    expect(cleanupRows(h)).toHaveLength(1);
  });

  it('【故意造出的失败】引擎没开 409、没连上 503：都不记成点过', async () => {
    const off = harness({ config: { engineOff: true } });
    const s1 = await off.login();
    const r1 = await off.cockpit.request(`${PATH}/cleanup`, write('POST', s1, {}));
    expect(r1.status).toBe(409);
    expect(await errorCode(r1)).toBe('engine_off');
    expect(cleanupRows(off)).toEqual([]);

    const down = harness({
      health: [
        {
          name: 'engine',
          check: async () => {
            throw new PublicHealthError('engine_offline', '引擎不在线');
          },
        },
      ],
    });
    const s2 = await down.login();
    const r2 = await down.cockpit.request(`${PATH}/cleanup`, write('POST', s2, {}));
    expect(r2.status).toBe(503);
    expect(cleanupRows(down)).toEqual([]);
  });
});

describe('GET /api/worktrees', () => {
  it('引擎还没出过清单：inventory 是 null、没有 inventoryWhy（页面写「还没出过」，不画成 0 棵树）', async () => {
    const h = harness();
    const s = await h.login();
    const got = await read(h, s.cookie);
    expect(got.inventory).toBeNull();
    expect(got.inventoryWhy).toBeUndefined();
    expect(got.cleanups).toEqual([]);
  });

  it('有清单：原样读回每棵树的状态、原因和大小', async () => {
    const h = harness({ data: { ...devFixtures(T0), worktreeInventory: inventory } });
    const s = await h.login();
    expect((await read(h, s.cookie)).inventory).toEqual(inventory);
  });

  it('【故意造出的失败】库里的清单认不出：inventory 是 null、inventoryWhy 写原因，不当成没有树', async () => {
    const h = harness({ data: { ...devFixtures(T0), worktreeInventory: { trees: 'x' } } });
    const s = await h.login();
    const got = await read(h, s.cookie);
    expect(got.inventory).toBeNull();
    expect(got.inventoryWhy).toMatch(/没读成/);
  });

  it('【故意造出的失败】操作记录读不到：503 worktrees_unreadable', async () => {
    const h = harness();
    const s = await h.login();
    h.store.listAudit = async () => {
      throw new Error('库连不上');
    };
    const res = await h.cockpit.request(PATH, { headers: { cookie: s.cookie } });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('worktrees_unreadable');
  });
});
