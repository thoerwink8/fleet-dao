// 流程配置副本那一步（jobs/flow-config.ts）不接库、不接 GitHub 的边界：仓刚被删、提醒写不进去、全组织默认读不了，
// 都照实记下，不挡别的仓；真库、假 GitHub 走一整轮的在 github-reconcile.test.ts。
import { FLOW_REPLICA_MAX_AGE_MINUTES, resolveFlowConfig, type Source } from '@fleet-dao/core';
import type { FlowReplicaState, FlowReplicaWrite } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  type FlowConfigJobDeps,
  flowAlertKey,
  ORG_FLOW_ALERT_KEY,
  syncFlowConfigs,
} from '../src/jobs/flow-config.ts';
import { GITHUB_RECONCILE_JOB } from '../src/jobs/github-reconcile.ts';
import { readOrgDefault } from '../src/real/github-reconcile.ts';

const NOW = new Date('2026-09-27T08:00:00.000Z');
const COMMIT = 'c'.repeat(40);

function state(over: Partial<FlowReplicaState> = {}): FlowReplicaState {
  return {
    repoId: 'repo-1',
    owner: 'acme',
    name: 'widgets',
    syncedAt: new Date(NOW.getTime() - 5 * 60_000),
    error: null,
    unread: null,
    testCommand: 'pnpm test:changed',
    config: { formatVersion: 1, testCommand: 'pnpm test:changed' },
    source: 'project',
    commit: COMMIT,
    checkedAt: new Date(NOW.getTime() - 5 * 60_000),
    ...over,
  };
}

function deps(over: Partial<FlowConfigJobDeps> = {}) {
  const writes: { repoId: string; w: FlowReplicaWrite }[] = [];
  const alerts: { key: string; title: string; body: string }[] = [];
  const resolved: string[] = [];
  const logs: { level: string; message: string }[] = [];
  const d: FlowConfigJobDeps = {
    list: async () => [state()],
    orgDefault: readOrgDefault,
    read: async () => ({
      commit: COMMIT,
      file: { kind: 'text', text: JSON.stringify({ formatVersion: 1, testCommand: 'pnpm test:changed' }) },
    }),
    write: async (repoId, w) => {
      writes.push({ repoId, w });
      return 'ok';
    },
    alert: async (key, title, body) => {
      alerts.push({ key, title, body });
    },
    resolve: async (key) => {
      resolved.push(key);
    },
    now: () => NOW,
    log: (level, message) => logs.push({ level, message }),
    ...over,
  };
  return { d, writes, alerts, resolved, logs };
}

describe('流程配置副本那一步', () => {
  it('停派的时限和看门狗判对账过期是同一条线：改一边要一起改', () => {
    expect(FLOW_REPLICA_MAX_AGE_MINUTES).toBe(GITHUB_RECONCILE_JOB.expectEveryMinutes);
  });

  it('随引擎发布的全组织默认读得到、认得出', async () => {
    const org = await readOrgDefault();
    expect(org.kind).toBe('text');
    expect(resolveFlowConfig(org, { kind: 'missing' }).ok).toBe(true);
  });

  it('读成、认得出：写副本，撤掉这个仓和全组织的提醒', async () => {
    const { d, writes, resolved, alerts } = deps();
    expect(await syncFlowConfigs(d)).toEqual({
      repos: [{ repo: 'acme/widgets', outcome: 'synced', source: 'project', blocked: false }],
    });
    expect(writes).toEqual([
      {
        repoId: 'repo-1',
        w: expect.objectContaining({ write: 'synced', commit: COMMIT, testCommand: 'pnpm test:changed' }),
      },
    ]);
    expect(resolved).toEqual([ORG_FLOW_ALERT_KEY, flowAlertKey({ owner: 'acme', name: 'widgets' })]);
    expect(alerts).toEqual([]);
  });

  it('列出来之后仓被删了（写回 not_found）：记成 gone，不装作写上了', async () => {
    const { d } = deps({ write: async () => 'not_found' });
    expect((await syncFlowConfigs(d)).repos).toEqual([
      { repo: 'acme/widgets', outcome: 'gone', why: '列出来之后这个仓从库里删了', blocked: false },
    ]);
  });

  it('【失败】提醒写不进去：停派照样生效（副本照写），记一条 error 日志，不挡下一个仓', async () => {
    const { d, writes, logs } = deps({
      list: async () => [state(), state({ repoId: 'repo-2', name: 'other' })],
      read: async (repo) => ({
        commit: COMMIT,
        file: { kind: 'text', text: repo.name === 'widgets' ? '{' : JSON.stringify({ formatVersion: 1 }) },
      }),
      alert: async () => {
        throw new Error('库连不上');
      },
    });
    const got = await syncFlowConfigs(d);
    expect(got.repos.map((r) => [r.repo, r.outcome, r.blocked])).toEqual([
      ['acme/widgets', 'invalid', true],
      ['acme/other', 'synced', false],
    ]);
    expect(writes.map((x) => x.w.write)).toEqual(['invalid', 'synced']);
    expect(logs.some((l) => l.level === 'error' && l.message.includes('提醒没写进去'))).toBe(true);
  });

  it('【失败】全组织默认读不了（抛错）：按读不了算，所有仓停派，只报全组织那一条', async () => {
    const { d, alerts, writes } = deps({
      orgDefault: async () => {
        throw new Error('EACCES');
      },
    });
    const got = await syncFlowConfigs(d);
    expect(got.repos[0]).toMatchObject({
      outcome: 'invalid',
      blocked: true,
      why: '全组织默认：读不了（EACCES）',
    });
    expect(writes[0]?.w).toEqual({ write: 'invalid', why: '全组织默认：读不了（EACCES）' });
    expect(alerts.map((a) => a.key)).toEqual([ORG_FLOW_ALERT_KEY]);
  });

  it('【失败】全组织默认不在：同样全部停派（不拿别的顶）', async () => {
    const missing: Source = { kind: 'missing' };
    const { d } = deps({ orgDefault: async () => missing });
    expect((await syncFlowConfigs(d)).repos[0]).toMatchObject({
      outcome: 'invalid',
      why: expect.stringMatching(/^全组织默认：找不到 packages\/core\/flow\.default\.json/),
    });
  });

  it('【失败】没查成、副本还新：只记原因、不报提醒；从没同步成过的没查成：停派并报提醒', async () => {
    const unread = { read: async () => Promise.reject(new Error('GitHub 回 502')) };
    const fresh = deps(unread);
    expect((await syncFlowConfigs(fresh.d)).repos[0]).toMatchObject({ outcome: 'unread', blocked: false });
    expect(fresh.writes[0]?.w).toEqual({ write: 'unread', why: 'GitHub 回 502' });
    expect(fresh.alerts).toEqual([]);

    const never = deps({
      ...unread,
      list: async () => [
        state({ syncedAt: null, source: null, commit: null, testCommand: null, config: null }),
      ],
    });
    expect((await syncFlowConfigs(never.d)).repos[0]).toMatchObject({ outcome: 'unread', blocked: true });
    expect(never.alerts).toEqual([
      {
        key: 'flow-config:acme/widgets',
        title: 'acme/widgets 停派：流程配置副本不能用（这一轮没查成）',
        body: expect.stringMatching(/还没从仓里同步过流程配置.*最近一次没查成：GitHub 回 502/),
      },
    ]);
  });
});
