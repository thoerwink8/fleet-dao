// 主页三块的挑法和写法（决定 0093）：要你拍的只放人闸和看门狗的卡；在跑的混排引擎和本机；上线了的按合并时刻算一版带了哪些 PR。
import { describe, expect, test } from 'vitest';
import type { LocalSessions, Notification } from '../../api/types';
import { formatClock } from '../../lib/format';
import { statusTextOf } from './running-card';
import {
  askItems,
  askLine,
  engineRow,
  localRows,
  prOfTitle,
  shippedRows,
  sortRunRows,
  watchdogRepair,
} from './today';
import type { HomeDone, HomeRunning } from './types';

const T0 = Date.parse('2026-10-14T12:00:00Z');
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString();

function note(over: Partial<Notification>): Notification {
  return {
    id: 'n',
    level: 'decision',
    title: '标题',
    body: '正文',
    createdAt: ago(10),
    deliveries: [],
    ...over,
  } as Notification;
}

describe('要你拍的', () => {
  test('只留没处理、没拍过的人闸和看门狗的卡；人闸在前，各自新的在前', () => {
    const items = askItems([
      note({ id: 'old-gate', createdAt: ago(30) }),
      note({ id: 'dog', level: 'alert', dedupeKey: 'watchdog:merge:acme/orbit:after-1', createdAt: ago(1) }),
      note({ id: 'new-gate', createdAt: ago(5) }),
      note({ id: 'other-alert', level: 'alert', dedupeKey: 'quota-read:supergrok' }),
      note({ id: 'daily', level: 'daily' }),
      note({ id: 'handled', resolvedAt: ago(2) }),
      note({ id: 'answered', answer: { optionId: 'hold', text: '先停着', at: ago(3), by: 'u' } }),
    ]);
    expect(items.map((i) => `${i.kind}:${i.n.id}`)).toEqual([
      'gate:new-gate',
      'gate:old-gate',
      'watchdog:dog',
    ]);
  });

  test('一行：要定什么取正文第一行，推荐哪个、为什么取推荐的那一项；没选项的不编推荐', () => {
    const n = note({
      title: '等你点头：发布 v2.3',
      body: '\n对外发布到生产。\n能一键回滚。',
      options: [
        { id: 'go', label: '发布', detail: '现在发', recommended: 'CI 全绿' },
        { id: 'hold', label: '先不发', detail: '压着' },
      ],
    });
    expect(askLine(n)).toEqual({ question: '对外发布到生产。', pick: '发布', why: 'CI 全绿' });
    expect(askLine(note({ body: '' }))).toEqual({ question: '标题', pick: null, why: null });
  });

  test('看门狗：有人在修写引擎或指挥官会话、修了多久、开了多久；还没人接只写开了多久', () => {
    const engine = watchdogRepair(
      note({
        level: 'alert',
        dedupeKey: 'watchdog:merge:acme/orbit:after-1',
        createdAt: ago(20),
        handling: {
          stage: 'pr_open',
          stageText: 'PR 开着',
          since: ago(12),
          who: '法国引擎',
          line: '法国引擎在修',
          problems: [],
        },
      }),
      T0,
    );
    expect(engine).toMatchObject({
      state: 'fixing',
      who: '法国引擎',
      text: '法国引擎在修 · 修了 12 分钟 · 开了 20 分钟',
    });
    const commander = watchdogRepair(
      note({
        level: 'alert',
        dedupeKey: 'watchdog:job:backup',
        createdAt: ago(8),
        handling: {
          stage: 'pr_open',
          stageText: 'PR 开着',
          since: ago(3),
          who: '指挥官会话',
          line: '指挥官会话在修',
          problems: [],
        },
      }),
      T0,
    );
    expect(commander.text).toBe('指挥官会话在修 · 修了 3 分钟 · 开了 8 分钟');
    const waiting = watchdogRepair(
      note({
        level: 'alert',
        dedupeKey: 'watchdog:merge:acme/orbit:after-2',
        createdAt: ago(15),
        handling: {
          stage: 'unclaimed',
          stageText: '没人在修',
          since: ago(15),
          line: '没人在修 · 15 分钟',
          problems: [],
        },
      }),
      T0,
    );
    expect(waiting).toMatchObject({ state: 'waiting', who: null, text: '还没人接 · 开了 15 分钟' });
  });

  test('谁在修没查成：不写成还没人接，开了多久照样写', () => {
    const missed = watchdogRepair(note({ createdAt: ago(5) }), T0, '谁在处理没查成：statement timeout');
    expect(missed.state).toBe('unknown');
    expect(missed.text).toBe('谁在处理没查成：statement timeout · 开了 5 分钟');
    expect(missed.text).not.toContain('还没人接');
  });
});

function running(over: Partial<HomeRunning>): HomeRunning {
  return {
    issueNumber: 12,
    title: '修登录',
    repo: 'acme/orbit',
    segment: 'doing',
    waitingReason: 'nothing',
    link: '/tasks/t-12',
    stageSince: ago(12),
    worker: 'Opus 5.5',
    ...over,
  };
}

describe('在跑的', () => {
  test('引擎的单：事、谁在做、第几段、没卡', () => {
    const row = engineRow(running({}), T0, { href: '/tasks/t-12', external: false });
    expect(row.what).toBe('#12 修登录');
    expect(row.who).toBe('法国引擎 · Opus 5.5');
    expect(row.progress).toBe('第 2/3 段 · 在动手 · 这一段 12 分钟');
    expect([row.tone, row.stuck]).toEqual(['run', '没卡']);
  });

  test('【故意造出的失败】最近一笔失败：标卡住了，原因写出来；停下等人写等你和引擎记的原因', () => {
    const bad = engineRow(running({ lastEvent: { text: '动手超时', at: ago(1), tone: 'trouble' } }), T0, {
      href: '/x',
      external: false,
    });
    expect([bad.tone, bad.stuck, bad.why]).toEqual(['fail', '卡住了', '动手超时']);
    const parked = engineRow(
      running({ waitingReason: 'parked', parked: '轮数用尽', worker: undefined }),
      T0,
      {
        href: '/x',
        external: false,
      },
    );
    expect([parked.tone, parked.stuck, parked.why]).toEqual(['human', '等你', '轮数用尽']);
    expect(parked.who).toBe('法国引擎 · 这一刻没有会话在跑');
  });

  test('排序：卡住、等你在前，正常在跑的在后', () => {
    const rows = sortRunRows([
      engineRow(running({ issueNumber: 1 }), T0, { href: '/a', external: false }),
      engineRow(running({ issueNumber: 2, lastEvent: { text: '挂了', at: ago(1), tone: 'trouble' } }), T0, {
        href: '/b',
        external: false,
      }),
    ]);
    expect(rows.map((r) => r.what)).toEqual(['#2 修登录', '#1 修登录']);
  });

  const session = (over: Partial<LocalSessions['nodes'][number]['sessions'][number]>) => ({
    id: 's1',
    repo: 'thoerwink8/fleet-dao',
    branch: 'rethink/cockpit3',
    worktree: 'cockpit3',
    subagent: false,
    startedAt: ago(40),
    lastSeenAt: ago(1),
    last: 'tool' as const,
    lastTool: 'Edit',
    state: 'running' as const,
    idleMs: 60_000,
    ...over,
  });

  test('本机：主会话一行，同一工作树在跑的子代理并进去；停了的不列；超过 15 分钟没动标黄', () => {
    const v = localRows(
      {
        asOf: ago(0),
        nodes: [
          {
            id: 'pc',
            machine: '创始人的电脑',
            freshness: 'fresh',
            problems: [],
            sessions: [
              session({}),
              session({ id: 's1~a', subagent: true, agentType: 'Explore' }),
              session({ id: 's2', branch: 'feat/x', worktree: 'x', state: 'idle', idleMs: 20 * 60_000 }),
              session({ id: 's3', branch: 'feat/done', state: 'stopped', last: 'stop' }),
            ],
          },
        ],
      },
      T0,
    );
    expect(v.kind).toBe('rows');
    if (v.kind !== 'rows') return;
    expect(v.rows.map((r) => [r.what, r.who, r.stuck])).toEqual([
      ['rethink/cockpit3 · thoerwink8/fleet-dao', '本机 创始人的电脑 · Claude Code · 带 1 个子代理', '没卡'],
      ['feat/x · thoerwink8/fleet-dao', '本机 创始人的电脑 · Claude Code', '20 分钟没动'],
    ]);
    expect(v.rows[0]?.progress).toBe('起了 40 分钟 · 最后在调 Edit');
  });

  test('【故意造出的失败】本机没上报：不占在跑的行，单列出来说清，不当成本机没在做事；没接上照实说', () => {
    const v = localRows(
      { asOf: ago(0), nodes: [{ id: 'pc', freshness: 'never', sessions: [], problems: [] }] },
      T0,
    );
    expect(v.kind === 'rows' && v.rows).toEqual([]);
    expect(v.kind === 'rows' && v.silent.map((n) => [n.id, n.never])).toEqual([['pc', true]]);
    expect(localRows({ asOf: ago(0), notWired: '没配钥匙', nodes: [] }, T0)).toEqual({
      kind: 'notWired',
      why: '没配钥匙',
    });
  });
});

describe('在跑的：本机领的单（决定 0096）', () => {
  const local = (over: Partial<HomeRunning> = {}) =>
    running({
      issueNumber: 2226,
      title: '本机领的活',
      segment: null,
      worker: undefined,
      executor: 'local',
      claimedBy: 'founder-pc',
      leaseUntil: new Date(T0 + 90 * 60_000).toISOString(),
      ...over,
    });
  const link = { href: '/tasks/t-1', external: false };

  test('写成「本机 · 哪台 · 租约到几点」，不冒充法国引擎，也不写还没记在哪一段', () => {
    const row = engineRow(local(), T0, link, (id) => (id === 'founder-pc' ? '创始人的电脑' : undefined));
    expect(row.who).toBe(
      `本机 · 创始人的电脑 · 租约到 ${formatClock(new Date(T0 + 90 * 60_000).toISOString())}`,
    );
    expect(row.who).not.toContain('法国引擎');
    expect(row.progress).toContain('本机在做');
    expect(row.progress).not.toContain('还没记在哪一段');
    expect([row.tone, row.stuck]).toEqual(['run', '没卡']);
    expect(statusTextOf(local())).toBe('本机在做');
  });

  test('机器名没对上写环境编号；通行证没记领取人写没记是哪台', () => {
    expect(engineRow(local(), T0, link).who).toMatch(/^本机 · founder-pc · /);
    expect(engineRow(local({ claimedBy: undefined }), T0, link).who).toMatch(/^本机 · 没记是哪台 · /);
  });

  test('租约过了点还没退回：标黄租约过期；没给到期时刻照实说', () => {
    const late = engineRow(local({ leaseUntil: new Date(T0 - 60_000).toISOString() }), T0, link);
    expect([late.tone, late.stuck]).toEqual(['stall', '租约过期']);
    expect(late.who).toContain('租约已过期');
    expect(engineRow(local({ leaseUntil: undefined }), T0, link).who).toContain('租约到期时刻没给');
  });

  test('引擎的单（没有 executor 的老快照也是）照旧写法国引擎', () => {
    expect(engineRow(running({ executor: 'engine' }), T0, link).who).toBe('法国引擎 · Opus 5.5');
    expect(engineRow(running({}), T0, link).who).toBe('法国引擎 · Opus 5.5');
  });
});

describe('上线了的', () => {
  const done = (prNumber: number, min: number, repo = 'acme/orbit'): HomeDone => ({
    prNumber,
    title: `PR ${prNumber} 的标题`,
    repo,
    mergedAt: ago(min),
    link: undefined,
  });
  const commit = (title: string | null, min: number, event: 'release' | 'rollback' = 'release') => ({
    sha: `${min}`.padEnd(40, '0'),
    short: `${min}`.padEnd(12, '0'),
    title,
    titleWhy: title === null ? 'GitHub 没读成' : null,
    at: ago(min),
    event,
  });

  test('提交标题末尾的号是这一版的头一个 PR；一句话去掉号', () => {
    expect(prOfTitle('主页改成三块 (#1745)')).toBe(1745);
    expect(prOfTitle('手工提交')).toBeNull();
    expect(prOfTitle(null)).toBeNull();
  });

  test('一版带的 PR = 上一版的头一个之后、这一版的头一个之前合的（同一个仓），新的在前', () => {
    const rows = shippedRows(
      [commit('三块 (#1745)', 50), commit('发版车 (#1741)', 180)],
      [
        done(1745, 55),
        done(1744, 58),
        done(1743, 66),
        done(9, 60, 'acme/site'),
        done(1741, 190),
        done(1742, 195),
      ],
    );
    expect(rows[0]?.what).toBe('三块');
    expect(rows[0]?.pr).toEqual({ number: 1745, repo: 'acme/orbit' });
    expect(rows[0]?.carried.map((d) => d.prNumber)).toEqual([1744, 1743]);
    expect(rows[0]?.carriedKnown).toBe(true);
  });

  test('【故意造出的失败】上一版的头一个不在最近合并的里：带的 PR 照列但标没列全；头一个也不在就一个都不列', () => {
    const rows = shippedRows(
      [commit('发版车 (#1741)', 180), commit('额度 (#1228)', 300, 'rollback'), commit(null, 400)],
      [done(1741, 190), done(1742, 195)],
    );
    expect(rows[0]?.carried.map((d) => d.prNumber)).toEqual([1742]);
    expect(rows[0]?.carriedKnown).toBe(false);
    expect(rows[1]?.carried).toEqual([]);
    expect(rows[1]?.carriedKnown).toBe(false);
    expect(rows[1]?.pr).toEqual({ number: 1228, repo: null });
    expect(rows[2]?.what).toBeNull();
    expect(rows[2]?.whatWhy).toBe('GitHub 没读成');
  });
});
