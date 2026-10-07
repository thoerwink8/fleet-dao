// @vitest-environment happy-dom
// /france 页「发版」卡（#1231）：主线最新提交和 CI、法国在用的提交、差几个、最近做完的一个任务。
// 做完的标准：① 相差多个：写落后几个、列最近的 PR；② 相差 0：写「法国已经是最新」、不画差几个；
// ③ 读不到 GitHub、读不到法国在用的提交：那一行写「没查成 + 原因」，不拿「已经是最新」「0」顶；④ CI 红、在跑各画各的。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs, ReleaseCard } from '../api/types';
import France from '../routes/france';
import { renderApp } from '../test/harness';

afterEach(cleanup);

const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const ASOF = '2026-10-07T10:00:00.000Z';

function envOk(): EnvResponse {
  const fact = <T,>(value: T) => ({ ok: true as const, value });
  return {
    name: { name: '法国' },
    asOf: ASOF,
    facts: {
      engine: fact({ state: 'on' }),
      version: fact({ current: LIVE, behind: 3, detail: '在用', problems: [] }),
      sessions: fact({ total: 0, byStage: {} }),
      pools: fact({ count: 0, running: 0, unread: 0, stale: 0 }),
      health: fact({ ok: true, total: 0, failing: [], notWired: [] }),
      schedule: fact({ status: 'fresh', lastSuccessAt: ASOF, outcome: 'ok' }),
    },
  };
}

function baseCard(): ReleaseCard {
  return {
    mainline: {
      state: 'ok',
      commit: { sha: HEAD, short: HEAD.slice(0, 12), title: '刷新耗时表 (#1230)', at: ASOF },
      ci: { state: 'green' },
    },
    deployed: {
      state: 'ok',
      sha: LIVE,
      short: LIVE.slice(0, 12),
      title: '探针历史 (#1225)',
      titleWhy: null,
      deployedAt: ASOF,
      deployedAtWhy: null,
    },
    gap: {
      state: 'ahead',
      count: 7,
      prs: [
        { number: 1230, title: '刷新耗时表' },
        { number: 1229, title: '任务页暂停继续' },
      ],
      nonPr: 1,
    },
    lastDone: {
      state: 'ok',
      pr: { number: 1230, title: '刷新耗时表', mergedAt: ASOF },
      issue: { state: 'ok', number: 1192, title: '引擎每周刷新耗时表', alsoCloses: [] },
    },
    asOf: ASOF,
  };
}

function renderCard(card: ReleaseCard | Error) {
  const inner = createMockApi({ live: false });
  const api = {
    ...inner,
    env: () => Promise.resolve(envOk()),
    jobs: () => Promise.resolve({ asOf: ASOF, jobs: [] } satisfies Jobs),
    franceReleaseCard: card instanceof Error ? () => Promise.reject(card) : () => Promise.resolve(card),
  } as MockApi;
  return renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
}

async function rowOf(label: string): Promise<HTMLElement> {
  const dt = await screen.findByText(label);
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`「${label}」后面没有内容`);
  return dd;
}

describe('/france 页发版卡', () => {
  test('相差多个：四行都在，写落后 7 个、列 PR、CI 绿、最近做完带单', async () => {
    renderCard(baseCard());
    const main = await rowOf('主线最新');
    expect(within(main).getByText(HEAD.slice(0, 12))).toBeTruthy();
    expect(main.querySelector('[data-ci="green"]')?.textContent).toBe('CI 绿');
    const live = await rowOf('法国在用');
    expect(within(live).getByText(LIVE.slice(0, 12))).toBeTruthy();
    expect(within(live).getByText('探针历史 (#1225)')).toBeTruthy();
    const gap = await rowOf('差几个');
    expect(within(gap).getByText('法国落后 7 个提交')).toBeTruthy();
    expect(within(gap).getByText('任务页暂停继续', { exact: false })).toBeTruthy();
    expect(within(gap).getByText(/另有 1 个提交不是 PR 合并的/)).toBeTruthy();
    const done = await rowOf('最近做完');
    expect(within(done).getByText('PR #1230', { exact: false })).toBeTruthy();
    expect(done.textContent).toContain('合并');
    expect(within(done).getByText(/引擎每周刷新耗时表/)).toBeTruthy();
  });

  test('相差 0 个：写「法国已经是最新」，不出现落后几个', async () => {
    renderCard({ ...baseCard(), gap: { state: 'same' } });
    const gap = await rowOf('差几个');
    expect(within(gap).getByText('法国已经是最新')).toBeTruthy();
    expect(gap.textContent).not.toContain('落后');
  });

  test('读不到 GitHub：主线、差几个、最近做完三行写「没查成 + 原因」，不拿「已经是最新」顶', async () => {
    const why = 'GitHub 机器人的凭据没读到';
    renderCard({
      ...baseCard(),
      mainline: { state: 'unreadable', why: `读主线头失败：${why}` },
      gap: { state: 'unreadable', why: '主线头没读到，差几个算不出（不当成「已是最新」）' },
      lastDone: { state: 'unreadable', why: `读主线最近合并的 PR 失败：${why}` },
    });
    expect(within(await rowOf('主线最新')).getByText(/没查成：读主线头失败/)).toBeTruthy();
    const gap = await rowOf('差几个');
    expect(within(gap).getByText(/没查成：主线头没读到/)).toBeTruthy();
    expect(gap.textContent).not.toContain('法国已经是最新');
    expect(within(await rowOf('最近做完')).getByText(/没查成：读主线最近合并的 PR 失败/)).toBeTruthy();
  });

  test('读不到法国在用的提交：那一行写没查成 + 原因，差几个也没查成', async () => {
    renderCard({
      ...baseCard(),
      deployed: { state: 'unreadable', why: '读法国在用的提交失败：EACCES' },
      gap: { state: 'unreadable', why: '法国在用的提交没读到，差几个算不出（不当成「已是最新」）' },
    });
    expect(within(await rowOf('法国在用')).getByText(/没查成：读法国在用的提交失败：EACCES/)).toBeTruthy();
    expect(within(await rowOf('差几个')).getByText(/没查成：法国在用的提交没读到/)).toBeTruthy();
  });

  test('在用的提交号读到了、标题和发于何时各自没读到：各写原因，不拿空串顶', async () => {
    renderCard({
      ...baseCard(),
      deployed: {
        state: 'ok',
        sha: LIVE,
        short: LIVE.slice(0, 12),
        title: null,
        titleWhy: '读它的标题失败：403',
        deployedAt: null,
        deployedAtWhy: '读发布历史失败：ENOENT',
      },
    });
    const live = await rowOf('法国在用');
    expect(within(live).getByText(/没查成：读它的标题失败：403/)).toBeTruthy();
    expect(within(live).getByText(/没查成：读发布历史失败：ENOENT/)).toBeTruthy();
  });

  test('CI 红：红标加原因；关的单读不到：写没查成 + 单号', async () => {
    const red = baseCard();
    if (red.mainline.state === 'ok') red.mainline.ci = { state: 'red', detail: 'failure：单测红' };
    red.lastDone = {
      state: 'ok',
      pr: { number: 5, title: '某改动', mergedAt: ASOF },
      issue: { state: 'unreadable', number: 9, why: '读 #9 失败：404' },
    };
    renderCard(red);
    const main = await rowOf('主线最新');
    expect(main.querySelector('[data-ci="red"]')?.textContent).toBe('CI 红');
    expect(within(main).getByText('failure：单测红')).toBeTruthy();
    expect(within(await rowOf('最近做完')).getByText(/关的单 #9 没查成：读 #9 失败：404/)).toBeTruthy();
  });

  test('CI 在跑：黄标；PR 没写关哪张单：写明，不编单号', async () => {
    const pending = baseCard();
    if (pending.mainline.state === 'ok') {
      pending.mainline.ci = { state: 'pending', detail: '汇总检查还在跑' };
    }
    pending.lastDone = {
      state: 'ok',
      pr: { number: 5, title: '某改动', mergedAt: ASOF },
      issue: { state: 'none' },
    };
    renderCard(pending);
    expect((await rowOf('主线最新')).querySelector('[data-ci="pending"]')?.textContent).toBe('CI 在跑');
    expect(within(await rowOf('最近做完')).getByText('这个 PR 没写关哪张单')).toBeTruthy();
  });

  test('接口整个读不到：卡位置写加载失败，不画假数据', async () => {
    renderCard(new Error('后端 502'));
    expect(await screen.findByText(/发版卡/)).toBeTruthy();
    expect(screen.queryByText('法国已经是最新')).toBeNull();
  });
});
