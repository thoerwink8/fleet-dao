// @vitest-environment happy-dom
// 发版一条龙（#2026）：确认框里直接摆预检清单、有卡住项时确认键灰着并写哪项；发版在走时画九步时间线（每一步状态对应的字）；
// 做完了写发后体检结论；「上一趟发完了」那句和法国接活脚本实际做的一致（只恢复引擎总开关，各仓接活开关发版不动）。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}));

import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, FrancePreflightResponse, Jobs, ReleaseCard } from '../api/types';
import { checkLine, lastLine, preflightItems, stepRows, timelineHead } from '../lib/release-timeline';
import France from '../routes/france';
import { renderApp } from './harness';

afterEach(cleanup);

const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const ASOF = '2026-10-07T10:00:00.000Z';
const NOW = Date.parse('2026-10-07T10:10:00.000Z');
type Last = ReleaseCard['action']['last'];

const t = (min: number, sec = 0) => new Date(Date.parse(ASOF) + min * 60_000 + sec * 1000).toISOString();

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

const NONE: Last = { state: 'none', target: null, at: null, why: null, phase: null };

function card(last: Last = NONE): ReleaseCard {
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
    gap: { state: 'ahead', count: 1, prs: [{ number: 1230, title: '刷新耗时表' }], nonPr: 0 },
    lastDone: { state: 'unreadable', why: '测试里不读' },
    action: { state: 'ready', reasons: [], installed: true, last },
    asOf: ASOF,
  };
}

function preflight(lines: string[]): FrancePreflightResponse {
  const stuck = lines.filter((l) => l.startsWith('[卡住]'));
  return {
    state: 'done',
    command: '后端自己读事实（不起任何进程）',
    code: stuck.length > 0 ? 2 : 0,
    signal: null,
    stdout: ['—— 发版预检 ——', ...lines, stuck.length > 0 ? '结论：不能发。' : '结论：能发。', ''].join('\n'),
    stderr: stuck.join('\n'),
    durationMs: 10,
    timedOut: false,
    truncated: false,
    asOf: ASOF,
  };
}

function api(over: { card?: ReleaseCard; preflight?: () => Promise<FrancePreflightResponse> } = {}) {
  const inner = createMockApi({ live: false });
  const calls = { preflight: 0 };
  const a = {
    ...inner,
    env: () => Promise.resolve(envOk()),
    jobs: () => Promise.resolve({ asOf: ASOF, jobs: [] } satisfies Jobs),
    franceReleaseCard: () => Promise.resolve(over.card ?? card()),
    francePreflight: () => {
      calls.preflight += 1;
      return over.preflight ? over.preflight() : Promise.resolve(preflight(['[通过] 主线 CI：绿']));
    },
  } as MockApi;
  return { api: a as unknown as FleetApi, calls };
}

describe('确认框里直接显示预检清单（#2026）', () => {
  test('打开框就现跑一遍预检，[通过]/[卡住]/[留意] 每项一行；有卡住项时「确认发布」灰着并写清哪项', async () => {
    const { api: a, calls } = api({
      preflight: () =>
        Promise.resolve(
          preflight([
            '[通过] 主线 CI：绿（2005b290aaaa 刷新耗时表）',
            '[卡住] 别的发布：有一趟还没了结（第 3 步「等收尾」）',
            '[留意] 引擎总开关：开着',
          ]),
        ),
    });
    renderApp(<France />, { api: a, route: '/france' });
    fireEvent.click(await screen.findByRole('button', { name: '发布到法国' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).queryAllByText(/主线 CI：绿/)).toHaveLength(1));
    expect(calls.preflight).toBe(1);
    const items = dialog.querySelectorAll('[data-preflight-item]');
    expect([...items].map((x) => x.getAttribute('data-preflight-item'))).toEqual(['ok', 'block', 'info']);
    const ok = within(dialog).getByRole('button', { name: '确认发布' });
    expect(ok.hasAttribute('disabled')).toBe(true);
    const why = dialog.querySelector('[data-preflight-blocked]');
    expect(why?.textContent).toBe('有 1 项卡住，确认键先灰着：别的发布：有一趟还没了结（第 3 步「等收尾」）');
  });

  test('预检全过：确认键能点；预检没跑成也灰着并写原因（不当成能发）', async () => {
    const good = api({
      preflight: () => Promise.resolve(preflight(['[通过] 主线 CI：绿', '[留意] 引擎总开关：开着'])),
    });
    renderApp(<France />, { api: good.api, route: '/france' });
    fireEvent.click(await screen.findByRole('button', { name: '发布到法国' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(dialog.querySelectorAll('[data-preflight-item]')).toHaveLength(2));
    expect(within(dialog).getByRole('button', { name: '确认发布' }).hasAttribute('disabled')).toBe(false);
    expect(dialog.querySelector('[data-preflight-blocked]')).toBeNull();
    cleanup();

    const bad = api({ preflight: () => Promise.reject(new Error('网络断了')) });
    renderApp(<France />, { api: bad.api, route: '/france' });
    fireEvent.click(await screen.findByRole('button', { name: '发布到法国' }));
    const d2 = await screen.findByRole('alertdialog');
    await waitFor(() =>
      expect(d2.querySelector('[data-preflight-blocked]')?.textContent).toContain('预检没跑成'),
    );
    expect(within(d2).getByRole('button', { name: '确认发布' }).hasAttribute('disabled')).toBe(true);
  });
});

const timeline = (phase: number, over: Partial<NonNullable<Last['timeline']>> = {}) => ({
  phase,
  startedAt: t(0),
  steps: Array.from({ length: 9 }, (_, i) => (i <= phase ? t(i, 30 * i) : null)),
  waiting: null,
  laggards: [],
  ...over,
});

describe('九步时间线：每一步状态对应的文案', () => {
  test('在走：走过的写用了多久，当前那步写在等什么和这一步已用多久，后面的写没到', () => {
    const rows = stepRows(
      timeline(3, { waiting: '等法国在跑的 1 个会话收尾（execute(abcdef12)）' }),
      'running',
      null,
      NOW,
    );
    expect(rows.map((r) => r.state)).toEqual([
      'done',
      'done',
      'done',
      'current',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(rows[0]).toMatchObject({ name: '预检', text: '走过了 · 用了 1 分钟' });
    expect(rows[3]).toMatchObject({
      name: '等收尾',
      text: '在等：等法国在跑的 1 个会话收尾（execute(abcdef12)） · 这一步已用 5 分钟',
    });
    expect(rows[4]).toMatchObject({ name: '发版', text: '没到' });
    expect(timelineHead(timeline(3), 'running', NOW)).toBe('走到第 3 步「等收尾」 · 一共已用 10 分钟');
  });

  test('没写在等什么：用这一步默认在干的事', () => {
    expect(stepRows(timeline(4), 'running', null, NOW)[4]?.text).toMatch(
      /^在等：跑 release\.sh · 这一步已用/,
    );
    expect(stepRows(timeline(6), 'running', null, NOW)[6]?.text).toMatch(/^在等：发后体检/);
  });

  test('卡住、没成：当前那步写原因（卡住带拖后腿的）；做完了九步都走过', () => {
    const blocked = stepRows(
      timeline(3, { laggards: ['会话 execute(abcdef12)'] }),
      'blocked',
      '等了 13 分钟，法国还有 1 个会话在跑',
      NOW,
    );
    expect(blocked[3]).toMatchObject({
      state: 'blocked',
      text: '卡住了（会话 execute(abcdef12)）：等了 13 分钟，法国还有 1 个会话在跑',
    });
    const failed = stepRows(timeline(5), 'failed', 'release.sh --check 有红', NOW);
    expect(failed[5]).toMatchObject({ state: 'failed', text: '没成：release.sh --check 有红' });
    expect(timelineHead(timeline(5), 'failed', NOW)).toMatch(/^停在第 5 步「等部署」/);
    const done = stepRows(timeline(8), 'done', null, NOW);
    expect(done.every((r) => r.state === 'done')).toBe(true);
    expect(timelineHead(timeline(8), 'done', NOW)).toMatch(/^九步都走完了/);
  });

  test('页面上：发版在走时发版卡画九步，当前那步标「在走」', async () => {
    const last: Last = {
      state: 'running',
      target: `提交 ${HEAD.slice(0, 12)}`,
      at: t(9),
      why: null,
      phase: '第 3 步「等收尾」',
      timeline: timeline(3, { waiting: '等法国在跑的 1 个会话收尾（execute(abcdef12)）' }),
    };
    const { api: a } = api({ card: card(last) });
    renderApp(<France />, { api: a, route: '/france' });
    const tl = await screen.findByText(/走到第 3 步「等收尾」/);
    const box = tl.closest('[data-release-timeline]');
    expect(box?.getAttribute('data-release-timeline')).toBe('running');
    const steps = box?.querySelectorAll('li[data-status]') ?? [];
    expect(steps).toHaveLength(9);
    // 当前那步是「在走」（processing），走过的是 success，没到的是 default
    expect(steps[3]?.getAttribute('data-status')).toBe('processing');
    expect(steps[2]?.getAttribute('data-status')).toBe('success');
    expect(steps[4]?.getAttribute('data-status')).toBe('default');
    expect(steps[3]?.textContent).toContain('在等：等法国在跑的 1 个会话收尾');
  });
});

describe('发后体检和「上一趟发完了」的说法', () => {
  const check = (ok: boolean) => ({
    ok,
    items: [
      { name: '目标提交在用', ok: true, text: '法国在用的就是 2005b290aaaa' },
      { name: '没有新异常', ok, text: ok ? '比发版前没有新的卡住报警' : '发版后新出现 1 条卡住报警' },
      { name: '各仓接活开关没被动过', ok: true, text: '3 个仓和发版前一样' },
    ],
    at: t(30),
  });

  test('checkLine：通过 / 没通过：哪几项', () => {
    expect(checkLine(check(true))).toEqual({ text: '发后体检：通过', ok: true });
    expect(checkLine(check(false))).toEqual({ text: '发后体检：没通过：没有新异常', ok: false });
  });

  test('「上一趟发完了」只说恢复了引擎总开关、接活开关发版不动，不再写死「接活开关已恢复」', () => {
    const line = lastLine({ ...NONE, state: 'done', target: '提交 2005b290aaaa', at: t(30) }, NOW);
    expect(line?.text).toContain('引擎总开关已恢复到发版前（开着的开回、关着的保持关）');
    expect(line?.text).toContain('各仓接活开关发版不动');
    expect(line?.text).not.toContain('接活开关已恢复');
    expect(line?.tone).toBe('ok');
    expect(lastLine({ ...NONE, state: 'done', at: t(30), check: check(false) }, NOW)?.tone).toBe('warn');
  });

  test('页面上：做完了画「发后体检：没通过：哪几项」和每项一行', async () => {
    const last: Last = {
      state: 'done',
      target: `提交 ${HEAD.slice(0, 12)}`,
      at: t(30),
      why: null,
      phase: '第 8 步「派清单」',
      timeline: timeline(8),
      check: check(false),
    };
    const { api: a } = api({ card: card(last) });
    renderApp(<France />, { api: a, route: '/france' });
    const head = await screen.findByText('发后体检：没通过：没有新异常');
    const box = head.closest('[data-release-check]');
    expect(box?.getAttribute('data-release-check')).toBe('bad');
    expect(box?.querySelectorAll('[data-check-item="bad"]')).toHaveLength(1);
    expect(box?.querySelectorAll('[data-check-item="ok"]')).toHaveLength(2);
    expect(document.querySelector('[data-release-timeline]')).toBeNull();
  });

  test('preflightItems：后端「名字：等级 详情」一项一行，读不到算卡住', () => {
    expect(
      preflightItems(
        '主线头和 CI：通过 绿（2005b290aaaa）\n别的发布是否在走：卡住 有一趟在走\n引擎总开关：留意 关着。发完保持关\n法国在跑的会话数：读不到 drain.json 读不成\n',
      ),
    ).toEqual([
      { kind: 'ok', text: '主线头和 CI：绿（2005b290aaaa）' },
      { kind: 'block', text: '别的发布是否在走：有一趟在走' },
      { kind: 'info', text: '引擎总开关：关着。发完保持关' },
      { kind: 'block', text: '法国在跑的会话数：读不到，drain.json 读不成' },
    ]);
  });

  test('preflightItems：老写法 [通过]/[卡住]/[留意] 也认', () => {
    expect(
      preflightItems('—— 发版预检 ——\n[通过] a\n[卡住] b\n[留意] c\n结论：不能发（1 项卡住）。\n'),
    ).toEqual([
      { kind: 'ok', text: 'a' },
      { kind: 'block', text: 'b' },
      { kind: 'info', text: 'c' },
    ]);
  });
});
