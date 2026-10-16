// 「要你拍」选完按动作执行：每种动作都调到对应的口；口抛错收成失败、不往外抛。
// 旧选项没写 action、写坏了的，读成 note-only。重查 GitHub App 没写仓，在调端口之前失败。
import type { FeishuPushFacts } from '@fleet-dao/db';
import type { SelfCheckItem } from '@fleet-dao/github';
import {
  DecisionOptionSchema,
  HANDED_TO_COMMANDER,
  POOL_HOLDS_SETTING,
  readDecisionAction,
  WORKTREE_DELETE_QUEUED,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  type DecisionActionPorts,
  executeDecisionAction,
  liveDecisionPorts,
  runFeishuPushRecheck,
  runGitHubAppRecheck,
} from '../src/decision-actions.ts';
import { harness } from './harness.ts';

function ports(fail?: string) {
  const calls: string[] = [];
  const p: DecisionActionPorts = {
    async deleteWorktree(path) {
      calls.push(`delete:${path}`);
      if (fail) throw new Error(fail);
    },
    async keep() {
      calls.push('keep');
      if (fail) throw new Error(fail);
    },
    async pausePool(poolId) {
      calls.push(`pause:${poolId}`);
      if (fail) throw new Error(fail);
    },
    async resumePool(poolId) {
      calls.push(`resume:${poolId}`);
      if (fail) throw new Error(fail);
    },
    async recheck(action) {
      calls.push(`recheck:${action.what}:${action.repo ?? ''}`);
      if (fail) throw new Error(fail);
    },
    async dropRepo(repo) {
      calls.push(`drop:${repo.owner}/${repo.name}`);
      if (fail) throw new Error(fail);
    },
    async noteOnly() {
      calls.push('note');
      if (fail) throw new Error(fail);
    },
  };
  return { calls, p };
}

const actor = { kind: 'user' as const, id: 'founder-a' };

describe('executeDecisionAction', () => {
  it('delete-worktree 调删工作树的口，结果记成交给引擎', async () => {
    const { calls, p } = ports();
    expect(await executeDecisionAction({ kind: 'delete-worktree', path: '/tmp/tree' }, p)).toEqual({
      ok: true,
      queued: true,
      text: WORKTREE_DELETE_QUEUED,
    });
    expect(calls).toEqual(['delete:/tmp/tree']);
  });

  it('keep 调留着', async () => {
    const { calls, p } = ports();
    const got = await executeDecisionAction({ kind: 'keep' }, p);
    expect(got.ok).toBe(true);
    expect(calls).toEqual(['keep']);
  });

  it('pause-pool 调整池暂停', async () => {
    const { calls, p } = ports();
    expect(await executeDecisionAction({ kind: 'pause-pool', poolId: 'claude-solo' }, p)).toMatchObject({
      ok: true,
      text: '账号池 claude-solo 已整池暂停',
    });
    expect(calls).toEqual(['pause:claude-solo']);
  });

  it('resume-pool 调放开', async () => {
    const { calls, p } = ports();
    expect(await executeDecisionAction({ kind: 'resume-pool', poolId: 'claude-solo' }, p)).toMatchObject({
      ok: true,
      text: '账号池 claude-solo 已放开',
    });
    expect(calls).toEqual(['resume:claude-solo']);
  });

  it('recheck 调重查', async () => {
    const gh = ports();
    expect(
      await executeDecisionAction({ kind: 'recheck', what: 'github-app', repo: 'acme/widgets' }, gh.p),
    ).toMatchObject({ ok: true, text: '已重查 acme/widgets 的 GitHub App，装好了' });
    expect(gh.calls).toEqual(['recheck:github-app:acme/widgets']);
    const fs = ports();
    expect(await executeDecisionAction({ kind: 'recheck', what: 'feishu-push' }, fs.p)).toMatchObject({
      ok: true,
      text: '已重查飞书推送，通了',
    });
    expect(fs.calls).toEqual(['recheck:feishu-push:']);
  });

  it('重查 GitHub App 没写仓：不调端口', async () => {
    const { calls, p } = ports();
    const got = await executeDecisionAction({ kind: 'recheck', what: 'github-app' }, p);
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.text).toContain('重查 GitHub App 要写是哪个仓');
    expect(calls).toEqual([]);
  });

  it('drop-repo 调移出仓', async () => {
    const { calls, p } = ports();
    expect(
      await executeDecisionAction({ kind: 'drop-repo', owner: 'acme', name: 'widgets' }, p),
    ).toMatchObject({
      ok: true,
      text: '已把 acme/widgets 移出监控',
    });
    expect(calls).toEqual(['drop:acme/widgets']);
  });

  it('note-only 调交给指挥官', async () => {
    const { calls, p } = ports();
    expect(await executeDecisionAction({ kind: 'note-only' }, p)).toEqual({
      ok: true,
      text: HANDED_TO_COMMANDER,
    });
    expect(calls).toEqual(['note']);
  });

  it('口抛错：收成失败，话是原因', async () => {
    const { calls, p } = ports('删不掉：目录还被占着');
    expect(await executeDecisionAction({ kind: 'delete-worktree', path: '/tmp/tree' }, p)).toEqual({
      ok: false,
      text: '删不掉：目录还被占着',
    });
    expect(calls).toEqual(['delete:/tmp/tree']);
  });
});

describe('readDecisionAction', () => {
  it('没写 action、写坏了的都按 note-only，不报错', () => {
    const bare = DecisionOptionSchema.parse({
      id: 'a',
      label: '甲',
      detail: '选甲',
      recommended: '甲稳',
    });
    expect(bare.action).toBeUndefined();
    expect(readDecisionAction(bare)).toEqual({ kind: 'note-only' });
    expect(readDecisionAction(undefined)).toEqual({ kind: 'note-only' });
    expect(readDecisionAction({ action: { kind: 'fly' } })).toEqual({ kind: 'note-only' });
  });
});

describe('runGitHubAppRecheck', () => {
  const item = (over: Partial<SelfCheckItem> = {}): SelfCheckItem => ({
    role: 'engine',
    repo: 'acme/widgets',
    ok: true,
    missing: [],
    extra: [],
    ...over,
  });

  it('凭据没接上、仓名不对、没查到、还没装好：抛原因；都装好了不抛', async () => {
    await expect(runGitHubAppRecheck(undefined, 'acme/widgets')).rejects.toThrow('凭据没读到');
    await expect(runGitHubAppRecheck(async () => [], 'widgets')).rejects.toThrow('owner/name');
    await expect(runGitHubAppRecheck(async () => [], 'acme/widgets')).rejects.toThrow('没查到');
    await expect(
      runGitHubAppRecheck(async () => [item({ ok: false, notInstalled: true, why: '没装' })], 'acme/widgets'),
    ).rejects.toThrow('没装');
    await expect(
      runGitHubAppRecheck(async () => [item(), item({ role: 'agent' })], 'acme/widgets'),
    ).resolves.toBeUndefined();
  });
});

describe('runFeishuPushRecheck', () => {
  const now = new Date('2026-10-16T00:00:00Z');
  const quiet: FeishuPushFacts = { status: null, stale: null, undelivered: 0, lastDeliveredAt: null };

  it('没配抛那句；通着不抛', async () => {
    await expect(
      runFeishuPushRecheck({ ...quiet, status: { configured: false, why: '认不出团队群', at: now } }, now),
    ).rejects.toThrow('认不出团队群');
    await expect(runFeishuPushRecheck(quiet, now)).resolves.toBeUndefined();
  });
});

describe('liveDecisionPorts', () => {
  it('pause-pool 写进整池暂停开关；已经停着的再选一次不改；resume-pool 拿掉', async () => {
    const h = harness();
    const live = liveDecisionPorts({
      store: h.store,
      actor,
      via: 'cockpit',
      handOff: async () => ({ progress: { ok: true, url: 'https://example.test/c' } }),
    });
    expect((await executeDecisionAction({ kind: 'pause-pool', poolId: 'claude-solo' }, live)).ok).toBe(true);
    const held = (await h.store.listSettings()).find((s) => s.key === POOL_HOLDS_SETTING);
    expect(held?.value).toMatchObject({
      'claude-solo': {
        decidedBy: '驾驶舱用户 founder-a',
        revokeWhen: '创始人在这条上选「修好了，放开」',
      },
    });
    const version = held?.version;
    expect((await executeDecisionAction({ kind: 'pause-pool', poolId: 'claude-solo' }, live)).ok).toBe(true);
    expect((await h.store.listSettings()).find((s) => s.key === POOL_HOLDS_SETTING)?.version).toBe(version);
    expect((await executeDecisionAction({ kind: 'resume-pool', poolId: 'claude-solo' }, live)).ok).toBe(true);
    const after = (await h.store.listSettings()).find((s) => s.key === POOL_HOLDS_SETTING);
    expect(after?.value).toEqual({});
  });

  it('drop-repo：还挂着没结束的需求移不走；空仓移得出去', async () => {
    const h = harness();
    const live = liveDecisionPorts({
      store: h.store,
      actor,
      via: 'cockpit',
      handOff: async () => ({ progress: { ok: true, url: 'https://example.test/c' } }),
    });
    const blocked = await executeDecisionAction(
      { kind: 'drop-repo', owner: 'example', name: 'canary' },
      live,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.text).toContain('没结束');
    expect((await h.store.listRepos()).some((r) => r.owner === 'example' && r.name === 'canary')).toBe(true);
    await h.store.addRepo(
      { owner: 'acme', name: 'empty', defaultBranch: 'main', testCommand: 'pnpm check' },
      { actor, action: 'repo.import.add', target: 'repo:acme/empty', via: 'cockpit', ok: true },
    );
    expect((await executeDecisionAction({ kind: 'drop-repo', owner: 'acme', name: 'empty' }, live)).ok).toBe(
      true,
    );
    expect((await h.store.listRepos()).some((r) => r.name === 'empty')).toBe(false);
  });

  it('删工作树只核路径（后端不删，交给引擎）；重查、交给指挥官没接上：失败，话里写没接上', async () => {
    const h = harness();
    const live = liveDecisionPorts({
      store: h.store,
      actor,
      via: 'cockpit',
      handOff: async () => ({ progress: { ok: false, why: '没接上' } }),
    });
    const queued = await executeDecisionAction({ kind: 'delete-worktree', path: '/tmp/tree' }, live);
    expect(queued).toMatchObject({ ok: true, queued: true });
    const relative = await executeDecisionAction({ kind: 'delete-worktree', path: 'tmp/tree' }, live);
    expect(relative.ok).toBe(false);
    expect(relative.text).toContain('绝对路径');
    const recheck = await executeDecisionAction(
      { kind: 'recheck', what: 'github-app', repo: 'acme/widgets' },
      live,
    );
    expect(recheck.ok).toBe(false);
    expect(recheck.ok === false && recheck.text).toContain('没接上');
    const note = await executeDecisionAction({ kind: 'note-only' }, live);
    expect(note).toEqual({ ok: false, text: '没接上' });
  });
});
