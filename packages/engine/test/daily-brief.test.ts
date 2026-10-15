// 每日简报（jobs/daily-brief.ts，决定 0096）：发布历史怎么认上线、四块怎么写、写不进/评论没发成怎么记；看门狗「今天的简报送到没」。
// 库那一头（对 PR、开单时刻、送达判法）在 packages/db/test/daily-brief.test.ts 用真库测。
import type { BriefNote, BriefPull, DailyBriefStatus, ExecutorLineStat, ScheduleResult } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  BRIEF_ISSUE,
  type CompareResult,
  DAILY_BRIEF_JOB,
  type DailyBriefDeps,
  DailyBriefFailedError,
  liveAt,
  liveSwitches,
  median,
  runDailyBriefJob,
  shippedByIssue,
} from '../src/jobs/daily-brief.ts';
import { briefAlertKey, watchDailyBrief } from '../src/jobs/watchdog-brief.ts';

const sha = (c: string) => c.repeat(40);
// 北京时间 2026-10-15 08:30
const NOW = new Date('2026-10-15T00:30:00Z');
const at = (iso: string) => new Date(iso);

const HISTORY = [
  `2026-10-13T10:00:00Z ${sha('a')} release`, // 前天（北京 10-13 18:00）切过去、昨天零点在用的
  `2026-10-14T02:00:00Z ${sha('b')} release auto`, // 北京 10-14 10:00
  `2026-10-14T03:00:00Z ${sha('9')} release unmerged`, // 不在主线上：不算
  `2026-10-14T09:00:00Z ${sha('c')} release`, // 北京 10-14 17:00
  `2026-10-14T09:05:00Z ${sha('c')} unhealthy`,
  `2026-10-14T09:06:00Z ${sha('b')} auto-rollback`,
  `2026-10-14T12:00:00Z ${sha('d')} release`, // 北京 10-14 20:00，昨天最后在用的
  `2026-10-14T17:00:00Z ${sha('e')} release`, // 北京 10-15 01:00：今天的，不算昨天
  '',
].join('\n');

/** a → b 多 1 个提交（b），a → c 多 b、c，a → d 多 b、c、d（新到旧）。 */
function compareFake(base: string, head: string): CompareResult {
  const chain = [sha('b'), sha('c'), sha('d')];
  const upTo = chain.indexOf(head);
  if (base !== sha('a') || upTo < 0) return { status: 'diverged', aheadBy: 0, recent: [] };
  const recent = chain
    .slice(0, upTo + 1)
    .reverse()
    .map((s) => ({ sha: s, title: `提交 ${s.slice(0, 1)} 的标题 (#${s.slice(0, 1)})` }));
  return { status: 'ahead', aheadBy: recent.length, recent };
}

function makeDeps(over: Partial<DailyBriefDeps> = {}) {
  const published: { dedupeKey: string; title: string; body: string; link: string }[] = [];
  const comments: { issueNumber: number; key: string; body: string }[] = [];
  const finished: ScheduleResult[] = [];
  const compares: string[] = [];
  const resolvedDaily: { dedupeKey: string; by: string; why: string }[] = [];
  const pulls: BriefPull[] = [
    // b：开单 10-14 01:00Z，10-14 02:00Z 上线 → 60 分钟；c：开单 08:00Z、09:00Z 上线（之后回退、d 再带上）→ 60 分钟
    {
      number: 201,
      title: 'b',
      mergeSha: sha('b'),
      issueOpenedAt: at('2026-10-14T01:00:00Z'),
      issues: [{ number: 31, title: '单 31 的标题' }],
    },
    {
      number: 202,
      title: 'c',
      mergeSha: sha('c'),
      issueOpenedAt: at('2026-10-14T08:00:00Z'),
      issues: [{ number: 31, title: '单 31 的标题' }],
    },
    { number: 203, title: 'd', mergeSha: sha('d'), issueOpenedAt: null, issues: [] },
  ];
  const decision: BriefNote = {
    id: 'n1',
    dedupeKey: 'pool-hold:x',
    title: '账号池 x 整池暂停：要你拍',
    link: '/quota',
    createdAt: at('2026-10-14T22:30:00Z'),
    issue: { repo: 'acme/fleet-dao', number: 77 },
  };
  const stats: ExecutorLineStat[] = [
    {
      days: 7,
      line: 'engine',
      nOpened: 40,
      nMerged: 30,
      openToMergeP50Min: 12.4,
      openToMergeP90Min: 50,
      oneRoundRate: 0.467,
      reworkPushesAvg: 1.2,
      nObserved7d: 0,
      fixedWithin7dRate: null,
    },
  ];
  const deps: DailyBriefDeps = {
    history: async () => HISTORY,
    selfRepo: async () => ({ owner: 'acme', name: 'fleet-dao', id: 'repo-1' }),
    compare: async (_repo, base, head) => {
      compares.push(`${base.slice(0, 1)}...${head.slice(0, 1)}`);
      return compareFake(base, head);
    },
    pulls: async () => pulls,
    issueTitle: async (_repo, n) => `GitHub 上单 ${n} 的标题`,
    decisions: async () => [decision],
    alerts: async () => [],
    dailies: async () => [],
    stopped: async () => [
      {
        repo: 'acme/fleet-dao',
        number: 88,
        title: '挂了的单',
        state: 'failed',
        lastProblem: '动手 3 轮都没过',
      },
    ],
    lineStats: async () => stats,
    publish: async (x) => {
      published.push(x);
    },
    comment: async (x) => {
      comments.push(x);
      return { url: 'https://github.com/acme/fleet-dao/issues/1055#c1' };
    },
    resolveDaily: async (x) => {
      resolvedDaily.push(x);
      return 'ok';
    },
    runs: {
      start: async () => 5,
      finish: async (_id, result) => {
        finished.push(result);
      },
    },
    now: () => NOW,
    log: () => {},
    ...over,
  };
  return { deps, published, comments, finished, compares, resolvedDaily };
}

describe('发布历史', () => {
  it('只认切过去的事件、不认 unmerged；按时间排；认不出的行照抛', () => {
    const s = liveSwitches(HISTORY);
    expect(s.map((x) => x.sha.slice(0, 1))).toEqual(['a', 'b', 'c', 'b', 'd', 'e']);
    expect(liveAt(s, at('2026-10-13T16:00:00Z'))?.sha).toBe(sha('a'));
    expect(liveAt(s, at('2026-10-14T16:00:00Z'))?.sha).toBe(sha('d'));
    expect(liveAt(s, at('2026-10-13T00:00:00Z'))).toBeNull();
    expect(() => liveSwitches('2026-10-14T00:00:00Z 不是提交号 release')).toThrow('认不出');
  });

  it('中位：奇数取中间、偶数取两个的平均、空是 null', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('runDailyBriefJob', () => {
  it('四块写齐：昨天上线了 b、c、d，要你拍带链接，停下的单，指标；推飞书一条、#1055 一条评论，记 ok', async () => {
    const d = makeDeps();
    const r = await runDailyBriefJob(d.deps);
    expect(r.outcome).toBe('ok');
    expect(d.finished).toEqual([r]);
    expect(d.published).toHaveLength(1);
    const p = d.published[0];
    expect(p?.dedupeKey).toBe('feishu:brief:2026-10-15');
    expect(p?.title).toBe('【每日简报】2026-10-15');
    expect(p?.link).toBe('/notifications');
    const body = p?.body ?? '';
    expect(body).toContain('在用版本 ddddddd');
    expect(body).toContain('多 3 个提交');
    // 按单归并：单 31 一行（2 个 PR），没挂单的 PR 合成一行
    expect(body).toContain('· #31 单 31 的标题（2 个 PR）— https://github.com/acme/fleet-dao/issues/31');
    expect(body).toContain('· 没挂单的 PR 1 个');
    expect(body).not.toContain('提交 d 的标题');
    expect(body).not.toContain('eeeeeee');
    expect(body).toContain('二、要你拍的（1 条）');
    expect(body).toContain(
      '账号池 x 整池暂停：要你拍（开了 2 小时）— https://github.com/acme/fleet-dao/issues/77',
    );
    expect(body).toContain('https://github.com/acme/fleet-dao/issues/88 挂了的单（failed：动手 3 轮都没过）');
    expect(body).toContain('没有开着的卡住报警');
    // b 60 分钟、c 60 分钟（第一次上线是 09:00Z 那一版，后来退回又被 d 带上）；d 对不上单不进中位
    expect(body).toContain('开单→上线中位：60 分钟（昨天上线、对得上单的 2 个 PR）');
    expect(body).toContain(
      '法国引擎（近 7 天开的 PR 40 个、合了 30 个）：一轮做成率 47%，开 PR→合并中位 12 分钟',
    );
    expect(body).toContain('本机：近 7 天没有开 PR');
    // 公开仓：#1055 评论里不写驾驶舱地址
    expect(d.comments).toHaveLength(1);
    expect(d.comments[0]?.issueNumber).toBe(BRIEF_ISSUE);
    expect(d.comments[0]?.key).toBe('daily-brief:2026-10-15');
    expect(d.comments[0]?.body).toContain('### 【每日简报】2026-10-15');
    expect(d.comments[0]?.body).toContain(
      `- #31 单 31 的标题（2 个 PR）— https://github.com/acme/fleet-dao/issues/31${String.fromCharCode(10)}- 没挂单的 PR 1 个${String.fromCharCode(10)}${String.fromCharCode(10)}全部：`,
    );
    expect(d.comments[0]?.body).not.toMatch(/https:\/\/(?!github\.com\/)/);
    expect(d.compares.every((c) => c.startsWith('a...'))).toBe(true);
  });

  it('零点到 08:30 之间起来补昨天那一格：不发、不评论，记 unscanned；手动触发照发', async () => {
    const early = new Date('2026-10-14T20:38:00Z'); // 北京 10-15 04:38，发版重启后定时器补的
    const d = makeDeps({ now: () => early });
    const r = await runDailyBriefJob(d.deps);
    expect(r.outcome).toBe('unscanned');
    expect(d.published).toEqual([]);
    expect(d.comments).toEqual([]);
    expect(d.finished).toEqual([r]);
    const m = makeDeps({ now: () => early });
    expect((await runDailyBriefJob(m.deps, { manual: true })).outcome).toBe('ok');
    expect(m.published).toHaveLength(1);
  });

  it('手动触发：另一个键、另一个标题，不冒充当天定时那一条', async () => {
    const d = makeDeps();
    await runDailyBriefJob(d.deps, { manual: true });
    expect(d.published[0]?.dedupeKey).toMatch(/^feishu:brief:2026-10-15:manual-/);
    expect(d.published[0]?.title).toBe('【每日简报·手动触发】2026-10-15');
    expect(d.comments[0]?.key).toMatch(/^daily-brief:2026-10-15:manual-/);
  });

  it('昨天没切版本：写「没有新上线的」', async () => {
    const d = makeDeps({ history: async () => `2026-10-13T20:00:00Z ${sha('a')} release\n` });
    await runDailyBriefJob(d.deps);
    expect(d.published[0]?.body).toContain('没有新上线的。在用版本 aaaaaaa');
    expect(d.published[0]?.body).toContain('开单→上线中位：昨天上线的提交里没有对得上单的 PR');
  });

  it('【故意造出的失败】某一块读不到：那一块写「没查成」，照样发，记 partial', async () => {
    const d = makeDeps({
      history: async () => null,
      lineStats: async () => {
        throw new Error('relation "pull_requests" does not exist');
      },
    });
    const r = await runDailyBriefJob(d.deps);
    expect(r.outcome).toBe('partial');
    const body = d.published[0]?.body ?? '';
    expect(body).toContain('没查成：这台没有发布目录（不是法国），读不到发布历史');
    expect(body).toContain('开单→上线中位：没查成');
    expect(body).toContain(
      '一轮做成率、开 PR→合并中位：没查成：读交付指标：relation "pull_requests" does not exist',
    );
    expect(d.comments).toHaveLength(1);
  });

  it('【故意造出的失败】#1055 评论没发成：记 failed 再抛，不记成功', async () => {
    const d = makeDeps({
      comment: async () => {
        throw new Error('GitHub 回了 403');
      },
    });
    await expect(runDailyBriefJob(d.deps)).rejects.toBeInstanceOf(DailyBriefFailedError);
    expect(d.finished[0]).toEqual({ outcome: 'failed', why: '每日简报没发成：GitHub 回了 403' });
    expect(DAILY_BRIEF_JOB.id).toBe('daily-brief');
  });

  it('【故意造出的失败】提醒写不进库：记 failed，不去发 #1055', async () => {
    const d = makeDeps({
      publish: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(runDailyBriefJob(d.deps)).rejects.toBeInstanceOf(DailyBriefFailedError);
    expect(d.comments).toEqual([]);
  });

  it('日报写进简报并发出后才收；简报自己那一行不收；没发成不收；没收成记 partial', async () => {
    const daily = (dedupeKey: string, title: string): BriefNote => ({
      id: dedupeKey,
      dedupeKey,
      title,
      link: '/france',
      createdAt: at('2026-10-14T12:00:00Z'),
      issue: null,
    });
    const rows = [
      daily('release:done:abcdef123456:1', '发版成功 abcdef123456'),
      daily('feishu:brief:2026-10-14', '昨天的简报'),
    ];
    const d = makeDeps({ dailies: async () => rows });
    const r = await runDailyBriefJob(d.deps);
    expect(r.outcome).toBe('ok');
    expect(r).toMatchObject({ found: 1 });
    const body = d.published[0]?.body ?? '';
    expect(body).toContain('五、日报（1 条）');
    expect(body).toContain('发版成功 abcdef123456');
    expect(body).not.toContain('昨天的简报');
    expect(d.resolvedDaily).toEqual([
      {
        dedupeKey: 'release:done:abcdef123456:1',
        by: 'engine:daily-brief',
        why: '已收进 2026-10-15 简报',
      },
    ]);

    const commented = makeDeps({
      dailies: async () => rows,
      comment: async () => {
        throw new Error('GitHub 回了 403');
      },
    });
    await expect(runDailyBriefJob(commented.deps)).rejects.toBeInstanceOf(DailyBriefFailedError);
    expect(commented.resolvedDaily).toEqual([]);

    const published = makeDeps({
      dailies: async () => rows,
      publish: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(runDailyBriefJob(published.deps)).rejects.toBeInstanceOf(DailyBriefFailedError);
    expect(published.resolvedDaily).toEqual([]);

    const broken = makeDeps({
      dailies: async () => rows,
      resolveDaily: async () => {
        throw new Error('库断了');
      },
    });
    const partial = await runDailyBriefJob(broken.deps);
    expect(partial.outcome).toBe('partial');
    expect(partial.why).toContain('库断了');
    expect(broken.published).toHaveLength(1);
    expect(broken.comments).toHaveLength(1);

    const unread = makeDeps({
      dailies: async () => {
        throw new Error('读不到日报');
      },
    });
    const missed = await runDailyBriefJob(unread.deps);
    expect(missed.outcome).toBe('partial');
    expect(unread.published[0]?.body).toContain('五、日报');
    expect(unread.published[0]?.body).toContain('没查成：读日报：读不到日报');
    expect(unread.resolvedDaily).toEqual([]);
  });

  it('日报超过 15 条时只把正文里逐条写到的标已收进，第 16 条留着', async () => {
    const daily = (n: number): BriefNote => ({
      id: `d${n}`,
      dedupeKey: `release:done:${n.toString(16).padStart(12, '0')}:1`,
      title: `日报第 ${n} 条`,
      link: '/france',
      createdAt: at('2026-10-14T12:00:00Z'),
      issue: null,
    });
    const rows = Array.from({ length: 16 }, (_, i) => daily(i + 1));
    const d = makeDeps({ dailies: async () => rows });
    const r = await runDailyBriefJob(d.deps);
    expect(r.outcome).toBe('ok');
    expect(r).toMatchObject({ found: 15 });
    const body = d.published[0]?.body ?? '';
    expect(body).toContain('五、日报（16 条）');
    expect(body).toContain('日报第 1 条');
    expect(body).toContain('日报第 15 条');
    expect(body).toContain('……另 1 条');
    expect(body).not.toContain('日报第 16 条');
    expect(d.resolvedDaily.map((x) => x.dedupeKey)).toEqual(rows.slice(0, 15).map((x) => x.dedupeKey));
    expect(
      d.resolvedDaily.every((x) => x.by === 'engine:daily-brief' && x.why === '已收进 2026-10-15 简报'),
    ).toBe(true);
  });
});

describe('昨天上线了什么：按单归并、整节一屏', () => {
  const repo = { owner: 'acme', name: 'fleet-dao' };
  const CMP = 'https://github.com/acme/fleet-dao/compare/aaa...bbb';
  const pr = (number: number, issues: BriefPull['issues'], title = `PR ${number}`): BriefPull => ({
    number,
    title,
    mergeSha: `m${number}`,
    issueOpenedAt: null,
    issues,
  });
  const run = (
    prs: BriefPull[],
    extraCommits = 0,
    title: (n: number) => Promise<string> = async (n) => `GitHub 单 ${n}`,
  ) => {
    const commits = [
      ...prs.map((p) => ({ sha: p.mergeSha, title: p.title ?? '' })),
      ...Array.from({ length: extraCommits }, (_, i) => ({ sha: `x${i}`, title: '直推' })),
    ];
    return shippedByIssue(commits, new Map(prs.map((p) => [p.mergeSha, p])), repo, CMP, title);
  };

  it('一天几十个 PR：整节（加头一行）不超过 10 行，超出的单折成「另 N 张单」+ compare 链接', async () => {
    const prs: BriefPull[] = [];
    for (let i = 1; i <= 40; i++) prs.push(pr(i, [{ number: 100 + i, title: `单 ${100 + i}` }]));
    for (let i = 41; i <= 55; i++) prs.push(pr(i, []));
    const lines = await run(prs);
    expect(lines.length + 1).toBeLessThanOrEqual(10);
    expect(lines).toContain('· 没挂单的 PR 15 个');
    expect(lines.at(-1)).toBe(`另 ${40 - (lines.length - 2)} 张单没列；全部：${CMP}`);
    expect(lines.filter((l) => l.startsWith('· #'))).toHaveLength(lines.length - 2);
  });

  it('排序：创始人引导/决定相关的在前，其次 PR 多的', async () => {
    const prs = [
      pr(1, [{ number: 11, title: '普通修复' }]),
      ...[2, 3, 4].map((n) => pr(n, [{ number: 12, title: '另一个大改' }])),
      pr(5, [{ number: 13, title: '落创始人引导：简报' }]),
      ...[6, 7, 8, 9, 10, 11, 12, 13].map((n) => pr(n, [{ number: 20 + n, title: `填充 ${n}` }])),
    ];
    const lines = await run(prs);
    expect(lines[0]).toContain('#13');
    expect(lines[1]).toContain('#12');
    expect(lines[1]).toContain('（3 个 PR）');
  });

  it('一个 PR 关多张单各算一行；库里没标题的现读 GitHub；没对上 PR 的提交单独计数', async () => {
    const lines = await run(
      [
        pr(1, [
          { number: 5, title: null },
          { number: 6, title: '六' },
        ]),
      ],
      2,
    );
    expect(lines).toContain('· #5 GitHub 单 5（1 个 PR）— https://github.com/acme/fleet-dao/issues/5');
    expect(lines).toContain('· #6 六（1 个 PR）— https://github.com/acme/fleet-dao/issues/6');
    expect(lines).toContain('· 2 个提交没对上 PR 记录');
    expect(lines.at(-1)).toBe(`全部：${CMP}`);
  });

  it('【故意造出的失败】库里和 GitHub 都读不到单标题：写「标题没查成」；置顶进度单 #1055 不当成一张单归并', async () => {
    const lines = await run(
      [pr(1, [{ number: 5, title: null }]), pr(2, [{ number: BRIEF_ISSUE, title: '进度' }]), pr(3, [])],
      0,
      async () => {
        throw new Error('GitHub 回了 502');
      },
    );
    expect(lines).toContain('· #5 （标题没查成）（1 个 PR）— https://github.com/acme/fleet-dao/issues/5');
    expect(lines.some((l) => l.includes(`#${BRIEF_ISSUE}`))).toBe(false);
    expect(lines).toContain('· 没挂单的 PR 2 个');
  });

  it('【故意造出的失败】读不到 PR↔单关联：写明没查成、给 compare 链接、记 partial，不写成「没有挂单」', async () => {
    const d = makeDeps({
      pulls: async () => {
        throw new Error('connection refused');
      },
    });
    const r = await runDailyBriefJob(d.deps);
    expect(r.outcome).toBe('partial');
    const body = d.published[0]?.body ?? '';
    expect(body).toContain('没查成：读 PR 和单的关联：connection refused，没法按单归并');
    expect(body).toContain('compare/aaaaaaaaaaaa...dddddddddddd');
    expect(body).not.toContain('没挂单的 PR');
    expect(body).toContain('开单→上线中位：没查成');
  });
});

describe('watchDailyBrief（看门狗：今天的简报送到没）', () => {
  // 北京 2026-10-15 09:10
  const now = new Date('2026-10-15T01:10:00Z');
  const status = (o: Partial<DailyBriefStatus> = {}): DailyBriefStatus => ({
    day: '2026-10-15',
    notification: null,
    run: null,
    ...o,
  });
  function alerts(
    open: { dedupeKey: string; title: string; body: string }[] = [],
    resolvedBy: string | null = null,
  ) {
    const raised: string[] = [];
    const resolved: string[] = [];
    return {
      raised,
      resolved,
      api: {
        openByPrefix: async () => open,
        byKey: async () =>
          resolvedBy === null ? null : { title: '', body: '', resolvedAt: now, resolvedBy },
        raise: async (x: { dedupeKey: string }) => {
          raised.push(x.dedupeKey);
        },
        resolve: async (x: { dedupeKey: string }) => {
          resolved.push(x.dedupeKey);
          return 'ok' as const;
        },
      },
    };
  }

  it('09:00 以后一轮都没起：报 watchdog:brief:<今天>（卡住报警）；昨天那条还开着就撤', async () => {
    const a = alerts([{ dedupeKey: briefAlertKey('2026-10-14'), title: 't', body: 'b' }]);
    const r = await watchDailyBrief(
      { status: async () => status(), here: async () => true, alerts: a.api, log: () => {} },
      now,
    );
    expect(r).toEqual({ scanned: 1, found: 1, problems: [] });
    expect(a.raised).toEqual([briefAlertKey('2026-10-15')]);
    expect(a.resolved).toEqual([briefAlertKey('2026-10-14')]);
  });

  it('送到了：撤掉今天那条', async () => {
    const a = alerts([{ dedupeKey: briefAlertKey('2026-10-15'), title: 't', body: 'b' }]);
    const ok = status({
      run: { outcome: 'ok', why: null, startedAt: now },
      notification: { id: 'x', createdAt: now, deliveredAt: now, attempts: 1, lastError: null },
    });
    await watchDailyBrief(
      { status: async () => ok, here: async () => true, alerts: a.api, log: () => {} },
      now,
    );
    expect(a.raised).toEqual([]);
    expect(a.resolved).toEqual([briefAlertKey('2026-10-15')]);
  });

  it('今天那条人点了「处理」：同一天不再打开', async () => {
    const a = alerts([], 'founder');
    await watchDailyBrief(
      { status: async () => status(), here: async () => true, alerts: a.api, log: () => {} },
      now,
    );
    expect(a.raised).toEqual([]);
  });

  it('不是法国（没有发布目录）：不看，也不撤', async () => {
    const a = alerts([{ dedupeKey: briefAlertKey('2026-10-14'), title: 't', body: 'b' }]);
    const r = await watchDailyBrief(
      { status: async () => status(), here: async () => false, alerts: a.api, log: () => {} },
      now,
    );
    expect(r).toEqual({ scanned: 0, found: 0, problems: [] });
    expect(a.raised).toEqual([]);
    expect(a.resolved).toEqual([]);
  });

  it('【故意造出的失败】读不到：这一步记没查成，不撤不报', async () => {
    const a = alerts([{ dedupeKey: briefAlertKey('2026-10-15'), title: 't', body: 'b' }]);
    const r = await watchDailyBrief(
      {
        status: async () => {
          throw new Error('connection refused');
        },
        here: async () => true,
        alerts: a.api,
        log: () => {},
      },
      now,
    );
    expect(r.problems[0]).toContain('connection refused');
    expect(a.resolved).toEqual([]);
    expect(a.raised).toEqual([]);
  });
});
