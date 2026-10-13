// 假后端的工作树清单（#1993）和本机会话（#1991）：形状照真后端（api/src/worktree-routes.ts、api/src/local-sessions.ts），数是编的。
// 地址开关（开发看样子用，真后端不读）：
// - ?mockWorktrees=none（引擎还没出过清单）/ unread（库里那份认不出）/ failed（整轮没跑成：根读不了）/ empty（没有树）；
// - ?mockLocal=stale（本机 9 分钟没推来：没上报）/ never（配了钥匙没推过）/ notWired（法国没配钥匙）。默认三个会话各一态：在跑、刚停、超过阈值没动。
import type { LocalSessions, Worktrees } from '../types';

const MIN = 60_000;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function param(name: string): string | null {
  return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(name);
}

/** 清单（默认样子）：每种状态都有一棵，两个仓有镜像，一个仓还没镜像过。 */
export function mockWorktrees(nowMs: number, cleanups: Worktrees['cleanups']): Worktrees {
  const mode = param('mockWorktrees');
  const iso = (agoMin: number) => new Date(nowMs - agoMin * MIN).toISOString();
  if (mode === 'none') return { inventory: null, cleanups, unreadable: 0 };
  if (mode === 'unread') {
    return {
      inventory: null,
      inventoryWhy: '工作树清单没读成：库里存的工作树清单认不出（字段 trees 不是列表）',
      cleanups,
      unreadable: 0,
    };
  }
  const repos: NonNullable<Worktrees['inventory']>['repos'] = [
    { repo: 'acme/orbit', mirror: { state: 'ok', bytes: Math.round(1.8 * GIB) } },
    { repo: 'acme/canary', mirror: { state: 'ok', bytes: 420 * MIB } },
    { repo: 'acme/website', mirror: { state: 'unread', why: '还没有镜像（这个仓还没起过会话）' } },
  ];
  if (mode === 'failed') {
    return {
      inventory: {
        takenAt: iso(12),
        trigger: 'hourly',
        root: '/var/lib/fleet-work',
        trees: [],
        removed: [],
        repos,
        failed: '工作树的根 /var/lib/fleet-work 读不了：EACCES',
        unchecked: [],
      },
      cleanups,
      unreadable: 0,
    };
  }
  const trees: NonNullable<Worktrees['inventory']>['trees'] =
    mode === 'empty'
      ? []
      : [
          {
            repo: 'acme/orbit',
            tree: '17-a1b2c3d4',
            what: '需求 #17 的主树',
            issueNumber: 17,
            state: 'running',
            why: '任务工作流 task-17 在跑',
            lastSessionAt: iso(2),
            size: { state: 'ok', bytes: Math.round(2.4 * GIB) },
          },
          {
            repo: 'acme/orbit',
            tree: '17-a1b2c3d4-sub-api',
            what: '需求 #17 的子任务「api」',
            issueNumber: 17,
            state: 'session',
            why: '会话 run-17-api 还没收场',
            lastSessionAt: iso(6),
            size: { state: 'ok', bytes: 610 * MIB },
          },
          {
            repo: 'acme/orbit',
            tree: '12-9f8e7d6c',
            what: '需求 #12 的主树',
            issueNumber: 12,
            state: 'leftover',
            why: '有没推的提交：2 个（分支 fleet/12-9f8e7d6c）',
            lastSessionAt: iso(3 * 24 * 60),
            size: { state: 'ok', bytes: Math.round(1.1 * GIB) },
          },
          {
            repo: 'acme/canary',
            tree: '8-55aa77cc',
            what: '需求 #8 的主树',
            issueNumber: 8,
            state: 'leftover',
            why: '有没提交的改动：src/app.ts 等 3 个文件',
            lastSessionAt: iso(26 * 60),
            size: { state: 'ok', bytes: 380 * MIB },
          },
          {
            repo: 'acme/canary',
            tree: '5-0c0ffee0',
            what: '需求 #5 的主树',
            issueNumber: 5,
            state: 'kept',
            why: '有 stash 1 条；创始人看过要人拍那条，决定留着',
            lastSessionAt: iso(9 * 24 * 60),
            size: { state: 'unread', why: 'du 超过 30 秒没跑完' },
          },
          {
            repo: 'acme/canary',
            tree: 'scratch',
            what: '认不出是哪张需求的树',
            state: 'unchecked',
            why: '目录名认不出是哪张需求的，不敢删',
            size: { state: 'ok', bytes: 12 * MIB },
          },
        ];
  return {
    inventory: {
      takenAt: iso(14),
      trigger: 'hourly',
      root: '/var/lib/fleet-work',
      trees,
      removed: mode === 'empty' ? [] : ['acme_orbit/3-deadbeef'],
      repos,
      unchecked: [],
    },
    cleanups,
    unreadable: 0,
  };
}

/** 假的清理记录：一次做完的（删了一棵、拒了三棵）。 */
export function seedCleanups(nowMs: number): Worktrees['cleanups'] {
  const iso = (agoMin: number) => new Date(nowMs - agoMin * MIN).toISOString();
  return [
    {
      requestId: 'cleanup-seed-1',
      by: 'u-founder',
      requestedAt: iso(180),
      startedAt: iso(180),
      doneAt: iso(179),
      status: 'done',
      result: {
        removed: ['acme_orbit/3-deadbeef'],
        refused: [
          {
            tree: 'acme_orbit/12-9f8e7d6c',
            state: 'leftover',
            why: '有没推的提交：2 个（分支 fleet/12-9f8e7d6c）',
          },
          {
            tree: 'acme_canary/8-55aa77cc',
            state: 'leftover',
            why: '有没提交的改动：src/app.ts 等 3 个文件',
          },
          { tree: 'acme_orbit/17-a1b2c3d4', state: 'running', why: '任务工作流 task-17 在跑' },
        ],
        unchecked: [],
      },
    },
  ];
}

/** 一次清理做完的结果：清单里剩下的树一棵都不删（都在用或有改动），照实拒并写原因。 */
export function cleanupResultOf(w: Worktrees): NonNullable<Worktrees['cleanups'][number]['result']> {
  const trees = w.inventory?.trees ?? [];
  return {
    removed: [],
    refused: trees.map((t) => ({
      tree: `${t.repo.replace('/', '_')}/${t.tree}`,
      state: t.state,
      why: t.why,
    })),
    unchecked: [],
  };
}

/** 本机会话（默认：创始人的电脑三个会话各一态）。 */
export function mockLocalSessions(nowMs: number): LocalSessions {
  const mode = param('mockLocal');
  const asOf = new Date(nowMs).toISOString();
  if (mode === 'notWired') {
    return {
      asOf,
      notWired: '法国没配 FLEET_NODE_KEYS，不收本机推来的会话（见 docs/ops.md「本机会话上报」）',
      nodes: [],
    };
  }
  const iso = (agoMs: number) => new Date(nowMs - agoMs).toISOString();
  const stale = mode === 'stale';
  const ago = stale ? 9 * MIN : 40_000;
  const lag = stale ? 9 * MIN : 40_000;
  const founder: LocalSessions['nodes'][number] =
    mode === 'never'
      ? { id: 'founder-pc', freshness: 'never', sessions: [], problems: [] }
      : {
          id: 'founder-pc',
          freshness: stale ? 'stale' : 'fresh',
          machine: '创始人的电脑',
          receivedAt: iso(ago),
          reportedAt: iso(ago + 1_000),
          problems: [],
          sessions: [
            {
              id: '6b291b3a-3a00-40c7',
              repo: 'thoerwink8/fleet-dao',
              branch: 'feat/1990-local-sessions',
              worktree: 'agent-af96ac01',
              subagent: false,
              startedAt: iso(95 * MIN),
              lastSeenAt: iso(lag + 20_000),
              last: 'tool',
              lastTool: 'Edit',
              state: stale ? 'idle' : 'running',
              idleMs: lag + 20_000,
            },
            {
              id: '6b291b3a-3a00-40c7~a41d476b',
              repo: 'thoerwink8/fleet-dao',
              branch: 'main',
              worktree: null,
              subagent: true,
              agentType: 'Explore',
              startedAt: iso(30 * MIN),
              lastSeenAt: iso(lag + 4 * MIN),
              last: 'stop',
              lastTool: 'Grep',
              state: 'stopped',
              idleMs: lag + 4 * MIN,
            },
            {
              id: 'c0de1234-77aa-4b1e',
              repo: 'thoerwink8/mirasim',
              branch: 'fix/ui-cli',
              worktree: 'ui-cli',
              subagent: false,
              startedAt: iso(4 * 60 * MIN),
              lastSeenAt: iso(lag + 47 * MIN),
              last: 'tool',
              lastTool: 'Bash',
              state: 'idle',
              idleMs: lag + 47 * MIN,
            },
          ],
        };
  return { asOf, nodes: [founder] };
}
