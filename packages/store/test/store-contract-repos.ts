// Store 契约：加进 / 移出驾驶舱，以及每人自己的 GitHub 用户令牌。内存版和 Postgres 版过同一套。
import { beforeEach, describe, expect, it } from 'vitest';
import { DEV_USER_ID, devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { NewAuditEntry, Store } from '../src/ports.ts';
import { type MakeStore, T0 } from './store-contract.ts';

const OTHER_UUID = '99999999-0000-4000-8000-000000000000';

const importAudit = (): NewAuditEntry => ({
  actor: { kind: 'user', id: DEV_USER_ID },
  action: 'repo.import',
  target: 'github:acme/widget',
  via: 'cockpit',
  ok: true,
});

const removeAudit = (repoId: string): Omit<NewAuditEntry, 'before' | 'after' | 'ok' | 'error'> => ({
  actor: { kind: 'user', id: DEV_USER_ID },
  action: 'repo.remove',
  target: `repo:${repoId}`,
  via: 'cockpit',
});

export function describeRepoImportContract(name: string, make: MakeStore): void {
  describe(`Store 契约（加仓移仓）：${name}`, () => {
    let store: Store;
    const clock = { now: new Date(T0) };
    beforeEach(async () => {
      clock.now = new Date(T0);
      store = (await make(devFixtures(T0), clock)).store;
    });

    it('新仓插一行且不打开自动派单，再导一次不重复记', async () => {
      const first = await store.importRepo(
        { owner: 'Acme', name: 'widget', defaultBranch: 'trunk', testCommand: 'pnpm test' },
        importAudit(),
      );
      expect(first.created).toBe(true);
      expect(first.repo).toMatchObject({
        owner: 'Acme',
        name: 'widget',
        defaultBranch: 'trunk',
        testCommand: 'pnpm test',
        autoDispatchSince: null,
        ciPolicy: 'force',
      });
      const listed = await store.listRepos();
      expect(listed.some((r) => r.id === first.repo.id)).toBe(true);
      const again = await store.importRepo(
        { owner: 'acme', name: 'Widget', defaultBranch: 'trunk', testCommand: 'pnpm test' },
        importAudit(),
      );
      expect(again.created).toBe(false);
      expect(again.repo.id).toBe(first.repo.id);
      expect(again.auditId).toBeUndefined();
      const { items } = await store.listAudit({ target: 'github:acme/widget', limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ action: 'repo.import', ok: true });
      expect(JSON.stringify(items[0]?.after)).toContain('"autoDispatchSince":null');
    });

    it('已经在驾驶舱里的仓不再插、不记', async () => {
      const before = await store.listAudit({ limit: 50 });
      const got = await store.importRepo(
        { owner: 'Example', name: 'Canary', defaultBranch: 'main', testCommand: 'pnpm check' },
        { ...importAudit(), target: 'github:example/canary' },
      );
      expect(got.created).toBe(false);
      expect(got.repo.id).toBe(IDS.repo);
      expect(got.repo.autoDispatchSince).toBeNull();
      const after = await store.listAudit({ limit: 50 });
      expect(after.items).toHaveLength(before.items.length);
    });

    it('有任务或 PR 的仓移不走，记一条失败；空仓能移走', async () => {
      const blocked = await store.removeRepo(IDS.repo, removeAudit(IDS.repo));
      expect(blocked).toMatchObject({ status: 'in_use', owner: 'example', name: 'canary', alerts: 0 });
      if (blocked === 'not_found' || blocked.status !== 'in_use') throw new Error('应该移不走');
      expect(blocked.tasks).toBeGreaterThan(0);
      expect(blocked.pulls).toBeGreaterThan(0);
      expect(await store.getRepo(IDS.repo)).not.toBeNull();
      const failed = await store.listAudit({ target: `repo:${IDS.repo}`, limit: 10 });
      expect(failed.items[0]).toMatchObject({ action: 'repo.remove', ok: false, error: 'in_use' });

      const imported = await store.importRepo(
        { owner: 'acme', name: 'widget', defaultBranch: 'main', testCommand: 'pnpm test' },
        importAudit(),
      );
      const removed = await store.removeRepo(imported.repo.id, removeAudit(imported.repo.id));
      expect(removed).toMatchObject({ status: 'removed', owner: 'acme', name: 'widget' });
      expect(await store.getRepo(imported.repo.id)).toBeNull();
      expect(await store.removeRepo(imported.repo.id, removeAudit(imported.repo.id))).toBe('not_found');
      expect(await store.removeRepo('not-a-uuid', removeAudit('not-a-uuid'))).toBe('not_found');
    });

    it('令牌按人和 App 分开存，不出现在仓列表和操作记录里', async () => {
      await store.saveGithubToken({
        userId: DEV_USER_ID,
        role: 'agent',
        githubLogin: 'person',
        accessToken: 'tok-agent',
        refreshToken: 'tok-refresh',
      });
      expect(await store.getGithubToken(DEV_USER_ID, 'agent')).toMatchObject({
        githubLogin: 'person',
        accessToken: 'tok-agent',
        refreshToken: 'tok-refresh',
      });
      expect(await store.getGithubToken(DEV_USER_ID, 'engine')).toBeNull();
      expect(await store.getGithubToken(OTHER_UUID, 'agent')).toBeNull();
      expect(await store.getGithubToken('not-a-uuid', 'agent')).toBeNull();
      await store.saveGithubToken({
        userId: DEV_USER_ID,
        role: 'agent',
        githubLogin: 'person',
        accessToken: 'tok-agent-2',
      });
      expect((await store.getGithubToken(DEV_USER_ID, 'agent'))?.accessToken).toBe('tok-agent-2');
      expect((await store.getGithubToken(DEV_USER_ID, 'agent'))?.refreshToken).toBeUndefined();
      const dumped = JSON.stringify(await store.listRepos()) + JSON.stringify(await store.listAudit({ limit: 20 }));
      expect(dumped).not.toContain('tok-agent-2');
      expect(dumped).not.toContain('tok-refresh');
      await store.deleteGithubToken(DEV_USER_ID, 'agent');
      expect(await store.getGithubToken(DEV_USER_ID, 'agent')).toBeNull();
      await store.deleteGithubToken('not-a-uuid', 'agent');
    });
  });
}
