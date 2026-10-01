// 「认领对得上」（#348，claim-status.ts）：PR 事件现读、判、和头上现有的比；认领变了重贴；每轮对账作废过了宽限期的、撤自动合并、
// 贴红、留言；改派关旧 PR（分支留着）。判法的边界表在 core 的 seat.test.ts，合并闸认它在 conventions 的 merge-gate.test.ts。
// 本机不再在库里认领（帅位座位整张删掉，#531）：测试里本机工人的认领由直接写库（store.data.claims）造出来。

import { randomUUID } from 'node:crypto';
import { CLAIM_MATCH_CONTEXT } from '@fleet-dao/conventions';
import { CLAIM_STATUS_CONTEXT, type IssueClaim } from '@fleet-dao/core';
import { describe, expect, it } from 'vitest';
import { CLAIM_STATUS_ALERT_KEY, createClaimStatus, refreshText } from '../src/claim-status.ts';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import { silentLogger } from '../src/log.ts';
import { createMemoryStore } from '../src/memory-store.ts';
import type { IngestedEvent } from '../src/ports.ts';
import { AGENT_BOT, fakeClaimsGitHub } from './fake-claims-github.ts';

const T0 = new Date('2026-09-27T08:00:00.000Z');
const SLUG = 'example/canary';
const REPO = { id: IDS.repo, owner: 'example', name: 'canary' };

async function setup() {
  const clock = { now: new Date(T0) };
  const store = createMemoryStore(devFixtures(T0), { now: () => clock.now });
  const gh = fakeClaimsGitHub();
  const alerts: string[] = [];
  const claims = createClaimStatus({
    store,
    github: gh,
    log: silentLogger,
    alerts: {
      raise: async (key, title) => {
        alerts.push(`raise ${key} ${title}`);
      },
      resolve: async (key) => {
        alerts.push(`resolve ${key}`);
      },
    },
  });
  /** 直接在本机的认领账里塞一份本机工人的认领（帅位座位整张删掉 #531：本机不再经 Store 拿，这里照老样子造出来）。 */
  const take = (issueNumber: number, label = 'w1'): IssueClaim => {
    const at = clock.now.toISOString();
    const claim: IssueClaim = {
      repoId: IDS.repo,
      issueNumber,
      claimId: randomUUID(),
      ownerKind: 'worker',
      ownerMachine: '本机',
      ownerLabel: label,
      seatScope: 'main',
      seatTerm: 1,
      state: 'claimed',
      workflowId: null,
      prNumbers: [],
      graceMinutes: 120,
      claimedAt: at,
      heartbeatAt: at,
      updatedAt: at,
      endedAt: null,
      endReason: null,
      note: null,
    };
    store.data.claims.push(claim);
    return claim;
  };
  const body = (issue: number, claimId?: string) =>
    `**做了什么**：x\n**需求**：#${issue}\n**认领**：${claimId ?? ''}\n**档位**：CI 绿就合`;
  const event = (number: number, action = 'opened'): IngestedEvent => ({
    deliveryId: `d-${number}-${action}`,
    source: 'webhook',
    event: 'pull_request',
    action,
    repo: SLUG,
    wake: false,
    receivedAt: T0.toISOString(),
    payload: { pull_request: { number } },
  });
  const tick = (minutes: number) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
  };
  return { store, gh, claims, alerts, take, body, event, tick };
}

describe('贴状态', () => {
  it('合并闸认的 context 和引擎贴的是同一个（两个包各写一份，钉住）', () => {
    expect(CLAIM_STATUS_CONTEXT).toBe(CLAIM_MATCH_CONTEXT);
  });

  it('PR 开了：现读 PR、按认领贴 success；同样的再来一次不再贴；正文认领号改错了贴 failure', async () => {
    const t = await setup();
    const c = t.take(40);
    t.gh.addPull(SLUG, { number: 5, body: t.body(40, c.claimId) });
    expect(await t.claims.onPullEvent(t.event(5))).toBe('claim_status=success');
    expect(t.gh.latest(SLUG, 5)).toMatchObject({ context: CLAIM_STATUS_CONTEXT, state: 'success' });
    expect(t.gh.latest(SLUG, 5)?.description).toContain('#40 归 本机/w1，认领号对得上');
    expect(await t.claims.onPullEvent(t.event(5, 'synced'))).toBe('claim_status=same');
    expect(t.gh.statuses).toHaveLength(1);
    // 事件里带的是旧的：照现读的判（正文已经改成别的认领号）
    const pull = t.gh.pulls.get(`${SLUG}#5`);
    if (!pull) throw new Error('PR 没了');
    pull.body = t.body(40, '00000000-0000-4000-8000-000000000000');
    expect(await t.claims.onPullEvent(t.event(5, 'edited'))).toBe('claim_status=failure');
  });

  it('不改判的事件、关了的 PR、别的事件：不贴', async () => {
    const t = await setup();
    t.gh.addPull(SLUG, { number: 6, body: t.body(41), state: 'closed' });
    expect(await t.claims.onPullEvent(t.event(6, 'labeled'))).toBe('claim_status=skip_labeled');
    expect(await t.claims.onPullEvent(t.event(6))).toBe('claim_status=closed');
    expect(await t.claims.onPullEvent({ ...t.event(6), event: 'issues' })).toBeUndefined();
    expect(t.gh.statuses).toHaveLength(0);
  });

  it('引擎的认领：引擎（干活的机器人）开的 PR success，人开的 failure', async () => {
    const t = await setup();
    const e = await t.store.claimForEngine({
      repoId: IDS.repo,
      issueNumber: 42,
      workflowId: 'req:example/canary#42',
      actor: { kind: 'engine', id: 'github-intake' },
    });
    if (!e.ok) throw new Error('引擎没拿到');
    t.gh.addPull(SLUG, { number: 7, body: t.body(42), author: AGENT_BOT });
    t.gh.addPull(SLUG, { number: 8, body: t.body(42) });
    expect(await t.claims.onPullEvent(t.event(7))).toBe('claim_status=success');
    expect(await t.claims.onPullEvent(t.event(8))).toBe('claim_status=failure');
  });

  it('【故意造出的失败】贴不上（没有 statuses 写权限这类）、读不到 PR、PR 号认不出：抛错，不当成贴上了', async () => {
    const t = await setup();
    t.gh.addPull(SLUG, { number: 9, body: t.body(43) });
    t.gh.failNext.setStatus = '安装令牌没有 statuses 写权限';
    await expect(t.claims.onPullEvent(t.event(9))).rejects.toThrow('statuses 写权限');
    t.gh.failNext.readPull = 'GitHub 502';
    await expect(t.claims.onPullEvent(t.event(9))).rejects.toThrow('502');
    await expect(t.claims.onPullEvent({ ...t.event(9), payload: {} })).rejects.toThrow(
      '认不出 pull_request.number',
    );
    expect(t.gh.statuses).toHaveLength(0);
  });

  it('【故意造出的失败】引擎机器人的登录名和合并闸认的对不上：不贴、明确报错', async () => {
    const t = await setup();
    t.gh.login = 'someone-else[bot]';
    t.gh.addPull(SLUG, { number: 10, body: t.body(44) });
    await expect(t.claims.onPullEvent(t.event(10))).rejects.toThrow('合并闸只认');
    expect(t.gh.statuses).toHaveLength(0);
  });

  it('认领变了重贴：只贴挂这张单的开着的 PR；没贴成的记进 problems', async () => {
    const t = await setup();
    t.gh.addPull(SLUG, { number: 11, body: t.body(45) });
    t.gh.addPull(SLUG, { number: 12, body: t.body(46) });
    const r = await t.claims.refreshIssue(REPO, 45);
    expect(r).toEqual({ checked: 1, posted: [11], problems: [] });
    expect(t.gh.latest(SLUG, 11)?.description).toContain('#45 没有认领记录');
    expect(t.gh.latest(SLUG, 12)).toBeUndefined();
    const c = t.take(45);
    t.gh.failNext.setStatus = '网络断了';
    const bad = await t.claims.refreshIssue(REPO, 45);
    expect(bad.problems).toEqual(['#11：网络断了']);
    expect(refreshText(bad)).toContain('没贴成：#11：网络断了');
    expect(c.claimId).toBeTruthy();
    expect(refreshText({ error: '这里没接 GitHub' })).toContain('没重贴成（这里没接 GitHub）');
  });
});

describe('每轮对账', () => {
  it('过了宽限期没心跳的本机认领作废：它的 PR 先撤自动合并、再贴红、留一句（第二轮不重复留言）；别人的 PR 不撤', async () => {
    const t = await setup();
    const c = t.take(50);
    t.gh.addPull(SLUG, { number: 20, body: t.body(50, c.claimId), autoMerge: true });
    // 同一张单上别人开的（正文没写这份认领号）：判红但不撤它的自动合并、不留言
    t.gh.addPull(SLUG, { number: 21, body: t.body(50), autoMerge: true });
    t.tick(121);
    const r = await t.claims.sweep();
    expect(r.voided.map((v) => v.claimId)).toEqual([c.claimId]);
    expect(r.disabled).toEqual([`${SLUG}#20`]);
    expect(r.commented).toBe(1);
    expect(r.problems).toEqual([]);
    expect(t.gh.writes.slice(0, 3)).toEqual([
      `disable ${SLUG}#20`,
      `status ${SLUG}@sha20 failure`,
      `comment ${SLUG}#20`,
    ]);
    expect(t.gh.pulls.get(`${SLUG}#21`)?.autoMerge).toBe(true);
    expect(t.gh.latest(SLUG, 20)?.description).toContain('没人拿着');
    expect(t.gh.comments[0]?.key).toBe(`claim-voided:${c.claimId}`);
    expect(t.alerts).toEqual([`resolve ${CLAIM_STATUS_ALERT_KEY}`]);
    const second = await t.claims.sweep();
    expect(second).toMatchObject({ voided: [], posted: 0, commented: 0, disabled: [] });
  });

  it('【故意造出的失败】撤自动合并没成：记进 problems、报提醒，不贴（下一轮再撤）；列不出 PR 的仓也报', async () => {
    const t = await setup();
    const c = t.take(51);
    t.gh.addPull(SLUG, { number: 22, body: t.body(51, c.claimId), autoMerge: true });
    t.tick(121);
    t.gh.failNext.disableAutoMerge = 'GraphQL 出错';
    const r = await t.claims.sweep();
    expect(r.problems).toEqual([`${SLUG}#22：GraphQL 出错`]);
    expect(t.gh.latest(SLUG, 22)).toBeUndefined();
    expect(t.alerts[0]).toContain(`raise ${CLAIM_STATUS_ALERT_KEY}`);
    // 下一轮撤成了、贴了，提醒撤掉
    const again = await t.claims.sweep();
    expect(again.disabled).toEqual([`${SLUG}#22`]);
    expect(t.alerts.at(-1)).toBe(`resolve ${CLAIM_STATUS_ALERT_KEY}`);
    t.gh.failNext.openPulls = '限流了';
    const listed = await t.claims.sweep();
    expect(listed.problems.some((p) => p.includes('开着的 PR 没列出来：限流了'))).toBe(true);
    expect(listed.reposScanned).toBe(listed.reposTotal - 1);
  });
});

describe('改派关旧 PR', () => {
  it('旧认领自己的 PR：撤自动合并、留言指向新主、关掉；别人的不关、按新认领重贴', async () => {
    const t = await setup();
    const old = t.take(60);
    t.gh.addPull(SLUG, { number: 30, body: t.body(60, old.claimId), autoMerge: true });
    t.gh.addPull(SLUG, { number: 31, body: t.body(60) });
    const r = await t.store.claimForEngine({
      repoId: IDS.repo,
      issueNumber: 60,
      workflowId: 'req:example/canary#60',
      actor: { kind: 'engine', id: 'github-intake' },
      founder: '换 w2',
    });
    if (!r.ok || !r.voided) throw new Error('没改派');
    const closed = await t.claims.closeForReassign(REPO, r.voided, {
      to: '引擎',
      why: '创始人原话：换 w2',
    });
    expect(closed).toEqual({ closed: [30], problems: [] });
    expect(t.gh.writes).toEqual([
      `disable ${SLUG}#30`,
      `comment ${SLUG}#30`,
      `close ${SLUG}#30`,
      `status ${SLUG}@sha31 failure`,
    ]);
    expect(t.gh.pulls.get(`${SLUG}#31`)?.state).toBe('open');
  });

  it('【故意造出的失败】关不掉的记进 problems，不算关了', async () => {
    const t = await setup();
    const old = t.take(61);
    t.gh.addPull(SLUG, { number: 32, body: t.body(61, old.claimId) });
    t.gh.failNext.closePull = '403';
    const closed = await t.claims.closeForReassign(REPO, old, { to: '引擎', why: '创始人原话：x' });
    expect(closed.closed).toEqual([]);
    expect(closed.problems).toEqual(['#32：403']);
  });
});
