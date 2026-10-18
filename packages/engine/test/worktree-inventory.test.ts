// 工作树清单和一键清理（#1993）：每小时对账那一轮把每棵树的去向记成清单；一键清理跑同一份判据，
// 正被任务或会话用着的、人以前点过留着的拒删并写明原因；没人用的树都删，有没推的提交、没提交的改动也删（AI 产生的树，决定 0097、#2729）。
// 故意造出的失败：正被会话用着时拒删、看不了归谁时拒删、清单存不进库时照实记没做成。
import type { AlertRow, OpenSessionTree } from '@fleet-dao/db';
import {
  foldCleanupRequests,
  WORKTREE_ACTION,
  WORKTREE_REQUEST_TTL_MS,
  type WorktreeAuditRow,
  type WorktreeInventory,
  WorktreeInventorySchema,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  inventoryOf,
  runWorktreeCleanupRequests,
  type WorktreeCleanupDeps,
} from '../src/jobs/worktree-cleanup.ts';
import { sweepWorktrees, type WorktreeSweepDeps } from '../src/jobs/worktree-sweep.ts';
import type { TreeLeftovers } from '../src/real/user-git.ts';

const ROOT = '/var/lib/fleet-work';
const NOW = new Date('2026-10-13T08:00:00.000Z');
const MIB = 1024 * 1024;

type RepoLeft = Extract<TreeLeftovers, { kind: 'repo' }>;
const clean: RepoLeft = {
  kind: 'repo',
  dirty: [],
  dirtyCount: 0,
  stashes: 0,
  unpushed: [],
  unpushedCount: 0,
};

/**
 * 一个仓 acme_web 下六棵树：
 * 12-a 需求 #12 的任务工作流在跑；13-b 有没结束的会话；14-c 有没推的提交；15-d 有没提交的改动；16-e 干净、没人用；
 * notes 认不出是哪张需求的。
 */
function world(over: Partial<WorktreeSweepDeps> = {}) {
  const removed: string[] = [];
  const left: Record<string, TreeLeftovers> = {
    [`${ROOT}/acme_web/14-c`]: {
      ...clean,
      unpushed: ['abc1234 改登录页'],
      unpushedCount: 1,
    },
    [`${ROOT}/acme_web/15-d`]: { ...clean, dirty: [' M src/app.ts'], dirtyCount: 1 },
    [`${ROOT}/acme_web/16-e`]: clean,
  };
  const session: OpenSessionTree = {
    runId: '0a1b2c3d-0000-4000-8000-000000000001',
    stage: 'manual',
    queuedAt: new Date('2026-10-13T07:30:00.000Z'),
    path: `${ROOT}/acme_web/13-b`,
  };
  const deps: WorktreeSweepDeps = {
    root: ROOT,
    probeDir: '_route-probe',
    sessionTmpDir: '_tmp',
    machine: '法国',
    async listDir(dir) {
      if (dir === ROOT) return [{ name: 'acme_web', isDir: true }];
      if (dir === `${ROOT}/acme_web`)
        return ['12-a', '13-b', '14-c', '15-d', '16-e', 'notes'].map((name) => ({ name, isDir: true }));
      throw new Error(`用例没给 ${dir}`);
    },
    treeFor: (repo, branch) => `${ROOT}/${repo.owner}_${repo.name}/${branch.replace(/^fleet\//, '')}`,
    ownerOf: async () => 'fleet-agent-carpool',
    leftovers: async (dir) => {
      const l = left[dir];
      if (!l) throw new Error(`用例没给 ${dir} 里剩什么`);
      return l;
    },
    remove: async (dir) => {
      removed.push(dir);
      return { gone: true };
    },
    keepShots: async () => ({ outcome: 'none', head: '', branch: 'shots/0', files: [] }),
    issue: async () => null,
    prHeads: async () => [],
    subtaskTrees: async () => [],
    openSessions: async () => [session],
    workflows: {
      state: async (id) => (id === 'task:acme/web#12' ? { state: 'running' } : { state: 'missing' }),
    },
    alerts: {
      listOpen: async () => ({ alerts: [], truncated: false }),
      byKey: async () => null,
      latestByPrefix: async () => null,
      resolve: async () => 'not_found',
      raise: async () => {},
      insertOnce: async () => ({ created: true }),
      updateOpen: async () => 'not_open',
    },
    log: () => {},
    size: async (dir) => (dir.endsWith('12-a') ? 300 * MIB : 20 * MIB),
    lastSessions: async () =>
      new Map([
        [`${ROOT}/acme_web/14-c`, new Date('2026-10-10T08:00:00.000Z')],
        [`${ROOT}/acme_web/13-b`, session.queuedAt],
      ]),
    repos: async () => [
      { owner: 'acme', name: 'web' },
      { owner: 'acme', name: 'api' },
    ],
    mirrorBytes: async (repo) => (repo.name === 'web' ? 120 * MIB : null),
    ...over,
  };
  return { deps, removed };
}

const byTree = (inv: WorktreeInventory) => Object.fromEntries(inv.trees.map((t) => [t.tree, t]));

describe('一轮的清单（sweepWorktrees 带出 inventory）', () => {
  it('每棵树的去向：在跑、会话在用、认不出的留着；没人用的删了（干净的、有没推提交的、有没提交改动的都删，#2729）、不在清单里', async () => {
    const { deps, removed } = world();
    const part = await sweepWorktrees(deps, null);
    const inv = inventoryOf(part, { trigger: 'hourly', at: NOW, root: ROOT });
    expect(WorktreeInventorySchema.parse(inv)).toEqual(inv);
    const t = byTree(inv);
    expect(t['12-a']).toMatchObject({
      state: 'running',
      issueNumber: 12,
      size: { state: 'ok', bytes: 300 * MIB },
    });
    expect(t['12-a']?.why).toContain('task:acme/web#12');
    expect(t['13-b']).toMatchObject({ state: 'session', lastSessionAt: session13() });
    expect(t['13-b']?.why).toContain('没结束的会话');
    expect(t.notes).toMatchObject({ state: 'unchecked', what: '认不出' });
    // 没人用的三棵都删了
    expect([...removed].sort()).toEqual([
      `${ROOT}/acme_web/14-c`,
      `${ROOT}/acme_web/15-d`,
      `${ROOT}/acme_web/16-e`,
    ]);
    expect(inv.removed).toEqual(['acme_web/14-c', 'acme_web/15-d', 'acme_web/16-e']);
    expect(t['14-c']).toBeUndefined();
    expect(t['15-d']).toBeUndefined();
    expect(t['16-e']).toBeUndefined();
    // 每个受管仓一行，镜像量了；没有镜像写明（不写 0）
    expect(inv.repos).toEqual([
      { repo: 'acme/api', mirror: { state: 'unread', why: '这个仓还没有镜像' } },
      { repo: 'acme/web', mirror: { state: 'ok', bytes: 120 * MIB } },
    ]);
  });

  it('人以前（#2729 之前）点过「留着」的那棵：照旧留着，清单上记 kept、写明剩什么', async () => {
    const { deps, removed } = world({
      alerts: {
        ...world().deps.alerts,
        byKey: async (key) =>
          key === 'worktree:acme_web/14-c'
            ? ({ dedupeKey: key, resolvedAt: NOW, resolvedBy: 'u_founder' } as unknown as AlertRow)
            : null,
      },
    });
    const inv = inventoryOf(await sweepWorktrees(deps, null), { trigger: 'hourly', at: NOW, root: ROOT });
    expect(removed).not.toContain(`${ROOT}/acme_web/14-c`);
    expect(byTree(inv)['14-c']).toMatchObject({ state: 'kept' });
    expect(byTree(inv)['14-c']?.why).toContain('没推的提交 1 个');
  });

  it('【故意造出看不了归谁】拒删、写没查成，不当成干净的删', async () => {
    const { deps, removed } = world({
      ownerOf: async (dir) => {
        if (dir.endsWith('16-e')) throw new Error('fleet-agent-scope owner 退出码 1');
        return 'fleet-agent-carpool';
      },
    });
    const inv = inventoryOf(await sweepWorktrees(deps, null), { trigger: 'hourly', at: NOW, root: ROOT });
    expect(removed).not.toContain(`${ROOT}/acme_web/16-e`);
    expect(byTree(inv)['16-e']).toMatchObject({ state: 'unchecked' });
    expect(byTree(inv)['16-e']?.why).toContain('看不了归谁');
  });

  it('量不了大小：写原因，不写 0', async () => {
    const { deps } = world({
      size: async () => {
        throw new Error('du 退出码 1');
      },
    });
    const inv = inventoryOf(await sweepWorktrees(deps, null), { trigger: 'hourly', at: NOW, root: ROOT });
    expect(byTree(inv)['12-a']?.size).toEqual({ state: 'unread', why: '没量成：du 退出码 1' });
  });

  it('工作树的根读不了：整份写 failed，树不可信', async () => {
    const { deps } = world({
      listDir: async () => {
        throw new Error('EACCES');
      },
    });
    const inv = inventoryOf(await sweepWorktrees(deps, null), { trigger: 'hourly', at: NOW, root: ROOT });
    expect(inv.failed).toContain('EACCES');
    expect(inv.trees).toEqual([]);
  });
});

function session13(): string {
  return '2026-10-13T07:30:00.000Z';
}

describe('一键清理（runWorktreeCleanupRequests）', () => {
  function cleanup(over: Partial<WorktreeCleanupDeps> = {}, sweepOver: Partial<WorktreeSweepDeps> = {}) {
    const { deps: sweep, removed } = world(sweepOver);
    const audit: WorktreeAuditRow[] = [
      {
        at: new Date(NOW.getTime() - 10_000),
        action: WORKTREE_ACTION.request,
        actorId: 'u_founder',
        after: { requestId: 'r1' },
        ok: true,
        error: null,
      },
    ];
    const saved: WorktreeInventory[] = [];
    const deps: WorktreeCleanupDeps = {
      sweep: () => sweep,
      rows: async () => audit,
      recordStart: async (i) => {
        audit.push({
          at: i.at,
          action: WORKTREE_ACTION.start,
          actorId: 'engine',
          after: { requestId: i.requestId },
          ok: true,
          error: null,
        });
      },
      recordDone: async (i) => {
        audit.push({
          at: i.at,
          action: WORKTREE_ACTION.done,
          actorId: 'engine',
          after: { requestId: i.requestId, ...(i.result ? { result: i.result } : {}) },
          ok: i.ok,
          error: i.ok ? null : i.error,
        });
      },
      saveInventory: async (inv) => {
        saved.push(inv);
      },
      openAlerts: async () => [],
      now: () => NOW,
      log: () => {},
      ...over,
    };
    return { deps, audit, removed, saved };
  }

  it('接手一次点击：没人用的都删（有没推的提交、没提交的改动也删，#2729）；【故意造出】会话在用、任务在跑的拒删并写明原因；记操作记录', async () => {
    const { deps, audit, removed, saved } = cleanup();
    expect(await runWorktreeCleanupRequests(deps)).toBe('done');
    const gone = ['acme_web/14-c', 'acme_web/15-d', 'acme_web/16-e'];
    expect([...removed].sort()).toEqual(gone.map((g) => `${ROOT}/${g}`));
    const view = foldCleanupRequests(audit, NOW).requests[0];
    expect(view?.status).toBe('done');
    expect(view?.by).toBe('u_founder');
    expect(view?.result?.removed).toEqual(gone);
    const refused = Object.fromEntries((view?.result?.refused ?? []).map((r) => [r.tree, r]));
    expect(refused['acme_web/14-c']).toBeUndefined();
    expect(refused['acme_web/15-d']).toBeUndefined();
    expect(refused['acme_web/13-b']).toMatchObject({ state: 'session' });
    expect(refused['acme_web/12-a']).toMatchObject({ state: 'running' });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.trigger).toBe('cleanup');
    // 同一次点击不接第二回
    expect(await runWorktreeCleanupRequests(deps)).toBe('idle');
    expect(removed).toHaveLength(3);
  });

  it('没人点、点了太久没人接（作废）：不跑', async () => {
    const { deps, removed } = cleanup({ rows: async () => [] });
    expect(await runWorktreeCleanupRequests(deps)).toBe('idle');
    const old = cleanup({
      rows: async () => [
        {
          at: new Date(NOW.getTime() - WORKTREE_REQUEST_TTL_MS - 1),
          action: WORKTREE_ACTION.request,
          actorId: 'u',
          after: { requestId: 'r0' },
          ok: true,
          error: null,
        },
      ],
    });
    expect(await runWorktreeCleanupRequests(old.deps)).toBe('idle');
    expect([...removed, ...old.removed]).toEqual([]);
  });

  it('【故意造出记不上接手】不清（不然页面一直看到没人接手、下一眼又接一次）', async () => {
    const { deps, removed } = cleanup({
      recordStart: async () => {
        throw new Error('库连不上');
      },
    });
    expect(await runWorktreeCleanupRequests(deps)).toBe('failed');
    expect(removed).toEqual([]);
  });

  it('【故意造出清单存不进库】树照清，结果记 ok=false 写明清单没存成', async () => {
    const { deps, audit } = cleanup({
      saveInventory: async () => {
        throw new Error('磁盘满了');
      },
    });
    expect(await runWorktreeCleanupRequests(deps)).toBe('failed');
    const view = foldCleanupRequests(audit, NOW).requests[0];
    expect(view?.status).toBe('failed');
    expect(view?.error).toContain('清单没存成');
    expect(view?.result?.removed).toEqual(['acme_web/14-c', 'acme_web/15-d', 'acme_web/16-e']);
  });

  it('工作树的根读不了：记没做成，原因原样', async () => {
    const { deps, audit } = cleanup(
      {},
      {
        listDir: async () => {
          throw new Error('EACCES');
        },
      },
    );
    expect(await runWorktreeCleanupRequests(deps)).toBe('failed');
    expect(foldCleanupRequests(audit, NOW).requests[0]?.error).toContain('EACCES');
  });
});
