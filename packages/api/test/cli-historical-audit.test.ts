import { auditLog, idempotencyKeys, insertAlertOnce, notifications } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { createMemoryStore, createPgStore, devFixtures, IDS } from '@fleet-dao/store';
import { seedPg } from '@fleet-dao/store/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CliDeps, main } from '../src/cli.ts';
import { historicalAuditSource, parseHistoricalAudit } from '../src/historical-audit-cli.ts';

const now = new Date('2026-10-18T12:00:00Z');
const repo = 'example/canary';
const prUrl = `https://github.com/${repo}/pull/42`;
const key = `reconcile:pr:${repo}#42`;
const input = {
  notificationId: IDS.notification1,
  dedupeKey: key,
  repo,
  pr: 42,
  head: 'a'.repeat(40),
  evidenceIssue: `https://github.com/${repo}/issues/99`,
  conclusion: 'historical_unproven',
  evidence: '已核实真实 GitHub 合并来源',
  gaps: '没有原始正常队列回执，仅有历史补账',
  responsibility: '由运维保留此历史缺口，未来漏记另单修复',
};
const originalBody = '历史合并队列记录缺失，不能证明合前全部闸门';
const pull = {
  number: 42,
  state: 'closed',
  merged: true,
  html_url: prUrl,
  head: { sha: input.head },
  base: { repo: { full_name: repo } },
  merge_commit_sha: 'b'.repeat(40),
  merged_at: now.toISOString(),
  merged_by: { id: 100, login: 'actual-engine' },
};
const issue = {
  number: 99,
  html_url: input.evidenceIssue,
  body: `历史 ${prUrl} 缺少正常队列记录，原始事实不变`,
};
function fixture() {
  const data = devFixtures(now);
  const n = data.notifications?.find((n) => n.id === input.notificationId);
  if (!n) throw new Error('missing fixture');
  Object.assign(n, { dedupeKey: key, link: prUrl, body: originalBody });
  return data;
}
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

for (const backend of ['memory', 'pg'] as const)
  describe(`真实 CLI 分派与 ${backend} Store`, () => {
    async function setup(body: unknown = input) {
      const data = fixture();
      if (backend === 'pg') await seedPg(t.db, data);
      const store =
        backend === 'pg'
          ? createPgStore(t.db, { now: () => now })
          : createMemoryStore(data, { now: () => now });
      const out: string[] = [],
        err: string[] = [];
      const read = vi.fn(
        async (_repo: string, path: string): Promise<unknown> =>
          path.startsWith('pulls/') ? structuredClone(pull) : structuredClone(issue),
      );
      const close = vi.fn(async () => {});
      const deps: CliDeps = {
        env: { DATABASE_URL: 'postgres:///test', FLEET_OPS_OPERATOR: 'actual-operator' },
        now: () => now,
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        readStdin: async () => JSON.stringify(body),
        openStore: async () => ({ store, close }),
        openHistoricalAuditSource: async () => ({ source: { read }, close }),
      };
      const notification = async () =>
        (await store.listNotifications({ status: 'all', limit: 100 })).items.find(
          (n) => n.id === input.notificationId,
        );
      return {
        store,
        out,
        err,
        read,
        close,
        deps,
        notification,
        run: () => main(['historical-audit'], deps),
      };
    }

    it('现读真实来源后原子处置，保留正文/缺口；相同重放幂等，不同处置不覆盖', async () => {
      const s = await setup();
      expect(await s.run(), s.err.join()).toBe(0);
      expect(s.read.mock.calls).toEqual([
        [repo, 'pulls/42'],
        [repo, 'issues/99'],
      ]);
      expect(await s.notification()).toMatchObject({
        body: originalBody,
        dedupeKey: key,
        resolvedBy: 'ops:historical-audit',
      });
      const target = `notification:${input.notificationId}`;
      const audits = await s.store.listAudit({ target, limit: 100 });
      expect(audits.items).toHaveLength(1);
      expect(audits.items[0]).toMatchObject({
        actor: { kind: 'ops' },
        via: 'ops',
        action: 'notification.historical_audit',
        after: {
          conclusion: 'historical_unproven',
          gaps: input.gaps,
          responsibility: input.responsibility,
          operator: 'actual-operator',
          github: { head: input.head, mergedBy: pull.merged_by },
        },
      });
      expect(s.out.join()).toContain('历史合并队列仍未证明');
      expect(await s.run()).toBe(0);
      expect((await s.store.listAudit({ target, limit: 100 })).items).toEqual(audits.items);
      s.deps.readStdin = async () => JSON.stringify({ ...input, gaps: '换个缺口' });
      expect(await s.run()).toBe(1);
      expect((await s.store.listAudit({ target, limit: 100 })).items).toEqual(audits.items);
      if (backend === 'pg') {
        expect(await t.db.select().from(idempotencyKeys)).toEqual([]);
        expect(
          await insertAlertOnce(t.db, {
            dedupeKey: key,
            level: 'alert',
            taskId: null,
            title: '同一历史问题',
            body: originalBody,
          }),
        ).toMatchObject({ created: false });
        expect((await s.notification())?.resolvedAt).toBeDefined();
      }
    });

    it.each(['head', 'repo', 'number', 'read_failed', 'issue_pr', 'issue_wrong', 'issue_unrelated'] as const)(
      '%s 未核实不处置、不记成功审计',
      async (mode) => {
        const s = await setup();
        s.read.mockImplementation(async (_repo, path) => {
          if (mode === 'read_failed') throw new Error('GitHub unavailable');
          if (path.startsWith('pulls/'))
            return {
              ...pull,
              ...(mode === 'head' ? { head: { sha: 'c'.repeat(40) } } : {}),
              ...(mode === 'repo' ? { base: { repo: { full_name: 'other/repo' } } } : {}),
              ...(mode === 'number' ? { number: 43 } : {}),
            };
          return {
            ...issue,
            ...(mode === 'issue_pr' ? { pull_request: {} } : {}),
            ...(mode === 'issue_wrong' ? { number: 98 } : {}),
            ...(mode === 'issue_unrelated' ? { body: '其他问题' } : {}),
          };
        });
        expect(await s.run()).toBe(1);
        expect((await s.notification())?.resolvedAt).toBeUndefined();
        expect(
          (await s.store.listAudit({ target: `notification:${input.notificationId}`, limit: 100 })).items,
        ).toEqual([]);
        expect(s.out).toEqual([]);
      },
    );

    it('原通知读后变化、或已被普通处理，不能冒认此次审计成功', async () => {
      const s = await setup();
      const old = s.store.resolveNotification.bind(s.store);
      s.store.resolveNotification = async (args, entry) => {
        await old(
          { id: args.id, by: { kind: 'ops', id: 'another' } },
          {
            actor: { kind: 'ops', id: 'another' },
            action: 'notification.resolve',
            target: entry.target,
            via: 'ops',
            ok: true,
          },
        );
        return old(args, entry);
      };
      expect(await s.run()).toBe(1);
      expect((await s.notification())?.resolvedBy).toBe('another');
      expect(
        (await s.store.listAudit({ target: `notification:${input.notificationId}`, limit: 100 })).items.map(
          (a) => a.action,
        ),
      ).toEqual(['notification.resolve']);
    });

    it('通知快照错配拒绝', async () => {
      const s = await setup();
      expect(
        await s.store.resolveNotification(
          {
            id: input.notificationId,
            by: { kind: 'ops', id: 'test' },
            expected: { dedupeKey: key, body: '不同正文', link: prUrl },
          },
          { actor: { kind: 'ops', id: 'test' }, action: 'test', target: 'test', via: 'ops', ok: true },
        ),
      ).toBe('conflict');
      expect((await s.notification())?.resolvedAt).toBeUndefined();
    });
  });

it('参数错不连库；拒绝空缺口、伪正常结论及其他仓的证据链接', async () => {
  for (const body of [
    { ...input, gaps: '' },
    { ...input, conclusion: 'queue_proven' },
    { ...input, evidenceIssue: 'https://github.com/other/repo/issues/99' },
    { ...input, dedupeKey: key + '0' },
  ]) {
    expect(() => parseHistoricalAudit(JSON.stringify(body))).toThrow();
  }
  const openStore = vi.fn();
  const code = await main(['historical-audit'], {
    env: {},
    now: () => now,
    out() {},
    err() {},
    readStdin: async () => '{}',
    openStore,
  });
  expect(code).toBe(2);
  expect(openStore).not.toHaveBeenCalled();
});

it('生产 GitHub 适配器只用现有 engine 身份 GET 实际 PR/issue', async () => {
  const request = vi.fn(async () => ({ data: pull, status: 200, headers: new Headers() }));
  const source = historicalAuditSource({ request } as Parameters<typeof historicalAuditSource>[0]);
  expect(await source.read(repo, 'pulls/42')).toEqual(pull);
  expect(request).toHaveBeenCalledWith({
    method: 'GET',
    path: `/repos/${repo}/pulls/42`,
    auth: { as: 'engine', repo: { owner: 'example', name: 'canary' } },
  });
});

it('真数据库审计写失败回滚通知处理', async () => {
  await seedPg(t.db, fixture());
  await t.client.exec(`CREATE FUNCTION reject_historical_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'notification.historical_audit' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_historical_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_historical_audit();`);
  try {
    const store = createPgStore(t.db);
    const error: string[] = [];
    const code = await main(['historical-audit'], {
      env: { DATABASE_URL: 'postgres:///test', FLEET_OPS_OPERATOR: 'actual-operator' },
      now: () => now,
      out() {
        throw new Error('must not report success');
      },
      err: (s) => error.push(s),
      readStdin: async () => JSON.stringify(input),
      openStore: async () => ({ store, close: async () => {} }),
      openHistoricalAuditSource: async () => ({
        source: { read: async (_repo, path) => (path.startsWith('pulls/') ? pull : issue) },
        close: async () => {},
      }),
    });
    expect(code).toBe(1);
    expect(error.join()).toContain('未做成');
    expect(
      (await t.db.select().from(notifications).where(eq(notifications.id, input.notificationId)))[0]
        ?.resolvedAt,
    ).toBeNull();
    expect(await t.db.select().from(auditLog)).toEqual([]);
  } finally {
    await t.client.exec(
      'DROP TRIGGER reject_historical_audit ON audit_log; DROP FUNCTION reject_historical_audit();',
    );
  }
});
