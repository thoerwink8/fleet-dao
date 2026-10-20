// Store 契约：别的环境推来的快照（node_reports，看板多机）。内存版和 Postgres 版过同一套（store.memory.test.ts / store.pg.test.ts 调）。
import {
  type LocalSessionsReport,
  type NodeReport,
  nodeFreshness,
  type WorktreeInventory,
} from '@fleet-dao/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { devFixtures } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import { InvalidNodeReportError, type Store } from '../src/ports.ts';
import { type MakeStore, T0 } from './store-contract.ts';

const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

function report(
  over: { name?: string; reportedAt?: string; codeSha?: string; inFlight?: number } = {},
): NodeReport {
  const asOf = over.reportedAt ?? at(0);
  return {
    schemaVersion: 1,
    reportedAt: asOf,
    ...(over.codeSha === undefined ? {} : { codeSha: over.codeSha }),
    home: {
      decisions: [],
      running: [],
      done: [],
      health: {
        quota: { state: 'ok', detail: '够用' },
        routes: { state: 'ok', detail: '都通' },
        engine: { state: 'on' },
      },
      flow: [
        { segment: 'scope', inFlight: 0, samples: 0 },
        { segment: 'manual', inFlight: over.inFlight ?? 0, samples: 0 },
        { segment: 'verify', inFlight: 0, samples: 0 },
      ],
      asOf,
    },
    env: {
      name: { name: over.name ?? '本机' },
      asOf,
      facts: {
        engine: { ok: true, value: { state: 'on' } },
        master: {
          ok: true,
          value: {
            on: false,
            why: 'never_set',
            detail: '关着（从没设过，默认关）：不拉单、不派活、不起干活的会话；探针和健康检查照跑',
          },
        },
        version: { ok: false, reason: '没有发布标记' },
        sessions: { ok: true, value: { total: 0, byStage: {} } },
        pools: { ok: true, value: { count: 1, running: 0, unread: 0, stale: 0 } },
        health: { ok: true, value: { ok: true, total: 3, failing: [], notWired: [] } },
        schedule: { ok: true, value: { status: 'never' } },
      },
    },
  };
}

export function describeNodeStoreContract(name: string, make: MakeStore): void {
  describe(`Store 契约（别的环境推来的快照）：${name}`, () => {
    let store: Store;
    const clock = { now: new Date(T0) };
    const fresh = async (data: Partial<MemoryData> = devFixtures(T0)) => {
      clock.now = new Date(T0);
      store = (await make(data, clock)).store;
    };
    beforeEach(() => fresh());

    it('没收到过：列表空、按编号读是 null', async () => {
      expect(await store.listNodeReports()).toEqual([]);
      expect(await store.getNodeReport('local')).toBeNull();
    });

    it('覆盖写：同一环境再推，整行换成新的，只剩一行；收到的时刻是 Store 的钟', async () => {
      const first = await store.putNodeReport({ nodeId: 'local', report: report({ codeSha: 'aaaaaaa' }) });
      expect(first).toEqual({
        nodeId: 'local',
        displayName: '本机',
        schemaVersion: 1,
        codeSha: 'aaaaaaa',
        reportedAt: at(0),
        receivedAt: at(0),
      });
      clock.now = new Date(T0.getTime() + MIN);
      await store.putNodeReport({
        nodeId: 'local',
        report: report({ name: '本机 WSL', reportedAt: at(MIN), inFlight: 2 }),
      });
      const list = await store.listNodeReports();
      expect(list).toEqual([
        {
          nodeId: 'local',
          displayName: '本机 WSL',
          schemaVersion: 1,
          codeSha: undefined,
          reportedAt: at(MIN),
          receivedAt: at(MIN),
        },
      ]);
      const got = await store.getNodeReport('local');
      expect(got?.snapshot.home.flow[1]?.inFlight).toBe(2);
      expect(got?.snapshot.env.name.name).toBe('本机 WSL');
      expect(got?.codeSha).toBeUndefined();
    });

    it('各环境各一行，按编号排', async () => {
      await store.putNodeReport({ nodeId: 'wsl-2', report: report({ name: '二号' }) });
      await store.putNodeReport({ nodeId: 'local', report: report() });
      expect((await store.listNodeReports()).map((r) => r.nodeId)).toEqual(['local', 'wsl-2']);
    });

    it('新不新鲜按收到的时刻算，不信推送方的时钟', async () => {
      // 推送方的钟慢了一小时：照样算刚收到
      await store.putNodeReport({ nodeId: 'local', report: report({ reportedAt: at(-60 * MIN) }) });
      // 推送方的钟快了一小时：过了 3 分钟照样算失联
      await store.putNodeReport({ nodeId: 'ahead', report: report({ reportedAt: at(60 * MIN) }) });
      const received = new Map((await store.listNodeReports()).map((r) => [r.nodeId, r.receivedAt]));
      expect(nodeFreshness(received.get('local'), clock.now)).toBe('fresh');
      clock.now = new Date(T0.getTime() + 3 * MIN);
      expect(nodeFreshness(received.get('ahead'), clock.now)).toBe('stale');
      expect(nodeFreshness(received.get('local'), clock.now)).toBe('stale');
      expect(nodeFreshness(received.get('never'), clock.now)).toBe('never');
    });

    it('多余字段剥掉再存：不认的东西不落表', async () => {
      const r = report();
      await store.putNodeReport({
        nodeId: 'local',
        report: { ...r, home: { ...r.home, secret: 'x' } } as unknown as NodeReport,
      });
      const got = await store.getNodeReport('local');
      expect(got?.snapshot.home).not.toHaveProperty('secret');
      expect(got?.snapshot).toEqual({ home: r.home, env: r.env });
    });

    it('【故意造出的失败】坏载荷、未知版本、认不出的环境编号：抛 InvalidNodeReportError，什么都不写', async () => {
      await store.putNodeReport({ nodeId: 'local', report: report({ codeSha: 'aaaaaaa' }) });
      const bad: unknown[] = [
        { ...report(), schemaVersion: 2 },
        { ...report(), home: undefined },
        { ...report(), reportedAt: '昨天' },
      ];
      for (const r of bad) {
        await expect(
          store.putNodeReport({ nodeId: 'local', report: r as NodeReport }),
        ).rejects.toBeInstanceOf(InvalidNodeReportError);
      }
      await expect(store.putNodeReport({ nodeId: '本机', report: report() })).rejects.toBeInstanceOf(
        InvalidNodeReportError,
      );
      expect(await store.listNodeReports()).toEqual([
        expect.objectContaining({ nodeId: 'local', codeSha: 'aaaaaaa' }),
      ]);
    });

    it('【故意造出的失败】库里存着认不出的（别的版本、坏形状）：读的时候抛错，不当成没有；列表照列', async () => {
      const ok = report();
      await fresh({
        ...devFixtures(T0),
        nodeReports: [
          {
            nodeId: 'future',
            displayName: '新版',
            schemaVersion: 2,
            reportedAt: at(0),
            receivedAt: at(0),
            snapshot: { home: ok.home, env: ok.env },
          },
          {
            nodeId: 'broken',
            displayName: '坏的',
            schemaVersion: 1,
            reportedAt: at(0),
            receivedAt: at(0),
            snapshot: { home: ok.home } as unknown as Pick<NodeReport, 'home' | 'env'>,
          },
        ],
      });
      await expect(store.getNodeReport('future')).rejects.toThrow(/第 2 版/);
      await expect(store.getNodeReport('broken')).rejects.toBeInstanceOf(InvalidNodeReportError);
      expect((await store.listNodeReports()).map((r) => r.nodeId)).toEqual(['broken', 'future']);
    });

    // —— 本机会话（#1991）——
    const sessions = (over: Partial<LocalSessionsReport> = {}): LocalSessionsReport => ({
      schemaVersion: 1,
      reportedAt: at(0),
      machine: '创始人的电脑',
      sessions: [
        {
          id: 's-1',
          repo: 'thoerwink8/fleet-dao',
          branch: 'main',
          worktree: null,
          subagent: false,
          startedAt: at(-30 * MIN),
          lastSeenAt: at(-MIN),
          last: 'tool',
          lastTool: 'Bash',
        },
      ],
      problems: [],
      ...over,
    });

    it('本机会话：没收到过是空；收下后读得回，再推整行覆盖，收到的时刻用 Store 的钟', async () => {
      expect(await store.listNodeSessions()).toEqual([]);
      const first = await store.putNodeSessions({ nodeId: 'founder-pc', report: sessions() });
      expect(first.receivedAt).toBe(T0.toISOString());
      clock.now = new Date(T0.getTime() + 2 * MIN);
      await store.putNodeSessions({ nodeId: 'founder-pc', report: sessions({ sessions: [] }) });
      const got = await store.listNodeSessions();
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({
        nodeId: 'founder-pc',
        receivedAt: at(2 * MIN),
        report: { sessions: [] },
      });
    });

    it('【故意造出的失败】本机会话多带了内容（提示词）、环境编号认不出：拒收，什么都不写', async () => {
      const leaky = sessions();
      (leaky.sessions[0] as Record<string, unknown>).prompt = '帮我改登录页';
      await expect(store.putNodeSessions({ nodeId: 'founder-pc', report: leaky })).rejects.toBeInstanceOf(
        InvalidNodeReportError,
      );
      await expect(store.putNodeSessions({ nodeId: 'Bad Id', report: sessions() })).rejects.toBeInstanceOf(
        InvalidNodeReportError,
      );
      expect(await store.listNodeSessions()).toEqual([]);
    });

    it('【故意造出的失败】库里存着认不出的本机会话：读的时候抛错，不当成没有', async () => {
      await fresh({
        ...devFixtures(T0),
        nodeSessions: [{ nodeId: 'founder-pc', receivedAt: at(0), report: { sessions: 'x' } }],
      });
      await expect(store.listNodeSessions()).rejects.toBeInstanceOf(InvalidNodeReportError);
    });

    // —— 机器通行证（#3388）——
    const HASH_A = 'a'.repeat(64);
    const HASH_B = 'b'.repeat(64);
    const audit = (action: string, target = 'node:founder-pc') => ({
      actor: { kind: 'ops' as const, id: 'ops:node-key' },
      action,
      target,
      after: { fingerprint: 'aaaaaaaaaaaa' },
      via: 'ops' as const,
      ok: true,
    });
    const auditActions = async (target: string) =>
      (await store.listAudit({ target, limit: 50 })).items.map((a) => a.action);

    it('通行证：发、列、作废；同一事务记操作记录；已有有效的不能再发，作废的可以换新', async () => {
      expect(await store.listNodeKeys()).toEqual([]);
      expect(
        await store.createNodeKey(
          { nodeId: 'wsl-2', tokenHash: HASH_B, displayName: '二号' },
          audit('node_key.new', 'node:wsl-2'),
        ),
      ).toBe('created');
      expect(
        await store.createNodeKey(
          { nodeId: 'founder-pc', tokenHash: HASH_A, displayName: '创始人电脑' },
          audit('node_key.new'),
        ),
      ).toBe('created');
      expect(await store.listNodeKeys()).toEqual([
        {
          nodeId: 'founder-pc',
          tokenHash: HASH_A,
          displayName: '创始人电脑',
          createdAt: at(0),
          revokedAt: undefined,
        },
        { nodeId: 'wsl-2', tokenHash: HASH_B, displayName: '二号', createdAt: at(0), revokedAt: undefined },
      ]);
      // 已有有效的：不写、也不记操作记录
      expect(
        await store.createNodeKey(
          { nodeId: 'founder-pc', tokenHash: 'c'.repeat(64), displayName: 'x' },
          audit('node_key.new'),
        ),
      ).toBe('exists');
      expect(await auditActions('node:founder-pc')).toEqual(['node_key.new']);

      clock.now = new Date(T0.getTime() + MIN);
      expect(await store.revokeNodeKey('founder-pc', audit('node_key.revoke'))).toBe('revoked');
      expect(await store.revokeNodeKey('founder-pc', audit('node_key.revoke'))).toBe('already_revoked');
      expect(await store.revokeNodeKey('nobody', audit('node_key.revoke', 'node:nobody'))).toBe('not_found');
      const revoked = (await store.listNodeKeys()).find((k) => k.nodeId === 'founder-pc');
      expect(revoked?.revokedAt).toBe(at(MIN));
      expect((await auditActions('node:founder-pc')).sort()).toEqual(['node_key.new', 'node_key.revoke']);
      expect(await auditActions('node:nobody')).toEqual([]);

      // 作废的编号可以换一把新的：整行换掉，作废清空
      clock.now = new Date(T0.getTime() + 2 * MIN);
      expect(
        await store.createNodeKey(
          { nodeId: 'founder-pc', tokenHash: 'c'.repeat(64), displayName: '换新' },
          audit('node_key.new'),
        ),
      ).toBe('created');
      const again = (await store.listNodeKeys()).find((k) => k.nodeId === 'founder-pc');
      expect(again).toMatchObject({ tokenHash: 'c'.repeat(64), displayName: '换新', createdAt: at(2 * MIN) });
      expect(again?.revokedAt).toBeUndefined();
    });

    it('【故意造出的失败】哈希不是 64 位小写十六进制（比如把明文塞进来）：拒，什么都不写', async () => {
      for (const bad of ['plain-token', 'A'.repeat(64), 'a'.repeat(63)]) {
        await expect(
          store.createNodeKey(
            { nodeId: 'founder-pc', tokenHash: bad, displayName: 'x' },
            audit('node_key.new'),
          ),
        ).rejects.toThrow();
      }
      expect(await store.listNodeKeys()).toEqual([]);
      expect(await auditActions('node:founder-pc')).toEqual([]);
    });

    // —— 工作树清单（#1993）——
    it('工作树清单：没存过是 null；存着的读得回；坏的抛错，不当成没有树', async () => {
      expect(await store.getWorktreeInventory()).toBeNull();
      const inv: WorktreeInventory = {
        takenAt: at(0),
        trigger: 'hourly',
        root: '/var/lib/fleet-work',
        trees: [],
        removed: ['acme_web/16-e'],
        repos: [{ repo: 'acme/web', mirror: { state: 'ok', bytes: 1024 } }],
        unchecked: [],
      };
      await fresh({ ...devFixtures(T0), worktreeInventory: inv });
      expect(await store.getWorktreeInventory()).toEqual(inv);
      await fresh({ ...devFixtures(T0), worktreeInventory: { trees: 1 } });
      await expect(store.getWorktreeInventory()).rejects.toThrow(/认不出/);
    });
  });
}
