// 卡住报警立案（#1406）：超过 24 小时没人处理的开一张未排期的单，单号写回正文开头。
// 每条失败路径都故意造一次；GitHub 写不进的后面还有一条：合并时刻读不到不跳过，放最后。
import { doneSection, parseMd, requiredSectionProblems } from '@fleet-dao/conventions';
import type { AlertStage } from '@fleet-dao/core';
import type { AlertRow } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  type AlertFiling,
  type AlertRepo,
  type AlertSweepDeps,
  alertRepoFromText,
  FILE_LABELS,
  sweepAlerts,
} from '../src/jobs/alert-sweep.ts';
import { beijingDayStart } from '../src/jobs/reconcile-common.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-09T03:00:00.000Z');

const row = (over: Partial<AlertRow> & Pick<AlertRow, 'dedupeKey'>): AlertRow => {
  const createdAt = over.createdAt ?? new Date(NOW.getTime() - 25 * HOUR);
  return {
    id: over.id ?? over.dedupeKey,
    dedupeKey: over.dedupeKey,
    level: over.level ?? 'alert',
    taskId: over.taskId ?? null,
    title: over.title ?? '合并队列判断出错',
    body: over.body ?? '原来的正文',
    link: over.link ?? null,
    createdAt,
    updatedAt: over.updatedAt ?? createdAt,
    resolvedAt: over.resolvedAt ?? null,
    resolvedBy: over.resolvedBy ?? null,
  };
};

const unclaimed = (ids: readonly string[]) =>
  new Map(ids.map((id) => [id, { stage: 'unclaimed' as const, line: '没人在修' }]));

interface Opened {
  repo: AlertRepo;
  key: string;
  title: string;
  body: string;
  labels: readonly string[];
  milestone: null;
}

function harness(
  rows: AlertRow[],
  over: {
    now?: () => Date;
    handling?: AlertSweepDeps['handling'] | 'omit';
    filedToday?: AlertFiling['filedToday'];
    issueState?: AlertFiling['issueState'];
    openIssue?: AlertFiling['openIssue'];
    prMergedAt?: AlertSweepDeps['prMergedAt'];
    doneItems?: AlertSweepDeps['doneItems'];
  } = {},
) {
  const opened: Opened[] = [];
  const recorded: { repo: string; dedupeKey: string; number: number }[] = [];
  const updated: string[] = [];
  const inserted: { dedupeKey: string }[] = [];
  let n = 40;
  const filing: AlertFiling = {
    repoOf: async (alert) => alertRepoFromText(alert.dedupeKey, alert.link),
    filedToday: over.filedToday ?? (async () => 0),
    issueState: over.issueState ?? (async () => ({ state: 'open', closedAt: null })),
    async openIssue(input) {
      opened.push(input);
      if (over.openIssue) return over.openIssue(input);
      n += 1;
      return { number: n };
    },
    async recordFiled(input) {
      recorded.push({
        repo: `${input.repo.owner}/${input.repo.name}`,
        dedupeKey: input.dedupeKey,
        number: input.number,
      });
    },
  };
  const handling: AlertSweepDeps['handling'] | undefined =
    over.handling === 'omit' ? undefined : (over.handling ?? (async (ids) => unclaimed(ids)));
  const deps: AlertSweepDeps = {
    workflows: {
      state: async () => ({ state: 'missing' }),
      view: async () => {
        throw new Error('不该问工作流');
      },
    },
    taskState: async () => null,
    approval: async () => null,
    stageRoutable: async () => ({ kind: 'none', detail: '没有' }),
    alerts: {
      listOpen: async () => ({ alerts: rows.filter((a) => a.resolvedAt === null), truncated: false }),
      byKey: async (key) => rows.find((a) => a.dedupeKey === key) ?? null,
      latestByPrefix: async () => null,
      resolve: async (x) => {
        const hit = rows.find((a) => a.dedupeKey === x.dedupeKey);
        if (!hit || hit.resolvedAt) return hit ? 'already_resolved' : 'not_found';
        hit.resolvedAt = (over.now ?? (() => NOW))();
        hit.resolvedBy = x.by;
        hit.body = `已撤：${x.why}\n\n${hit.body}`;
        return 'ok';
      },
      raise: async () => {},
      insertOnce: async (input) => {
        inserted.push({ dedupeKey: input.dedupeKey });
        return { created: false };
      },
      updateOpen: async (x) => {
        const hit = rows.find((a) => a.dedupeKey === x.dedupeKey);
        if (!hit || hit.resolvedAt) return 'not_open';
        if (x.body !== undefined) {
          hit.body = x.body;
          updated.push(x.dedupeKey);
        }
        return 'ok';
      },
    },
    ...(handling ? { handling } : {}),
    filing,
    prMergedAt: over.prMergedAt ?? (async () => new Date((over.now ?? (() => NOW))().getTime() - DAY)),
    ...(over.doneItems ? { doneItems: over.doneItems } : {}),
    now: over.now ?? (() => NOW),
    log: () => {},
  };
  return {
    opened,
    recorded,
    updated,
    inserted,
    run: () =>
      sweepAlerts(
        deps,
        rows.filter((a) => a.resolvedAt === null),
        false,
      ),
  };
}

const stage = (id: string, name: AlertStage) => [id, { stage: name, line: name }] as const;

describe('卡住报警立案', () => {
  it('满足条件：开一张未排期的缺陷单，四节齐，单号写回正文开头', async () => {
    const alert = row({
      dedupeKey: 'wf:failure:acme/widgets:rule',
      title: '合并队列判断出错',
      body: '正文里提到 #12，不是立案标记',
    });
    const h = harness([alert]);
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(part.found).toBe(1);
    expect(h.opened).toHaveLength(1);
    const opened = h.opened[0];
    expect(opened).toMatchObject({
      repo: { owner: 'acme', name: 'widgets' },
      key: 'alert-file:wf:failure:acme/widgets:rule',
      title: '合并队列判断出错',
      labels: [...FILE_LABELS],
      milestone: null,
    });
    expect(opened?.labels).toEqual(['缺陷']);
    const doc = parseMd('body.md', opened?.body ?? '');
    expect(requiredSectionProblems(doc)).toEqual([]);
    expect(doneSection(doc)).toBe('ok');
    expect(opened?.body).toContain('合并队列判断出错');
    expect(opened?.body).toContain('正文里提到 #12，不是立案标记');
    expect(opened?.body).toContain('无（AI 发现：提醒 wf:failure:acme/widgets:rule 第 1 天没人处理）');
    expect(opened?.body).toContain('- 这条提醒的条件不再成立（对账撤掉它）');
    expect(opened?.body).not.toContain('已立案：');
    expect(alert.body.startsWith('已立案：#41（2026-10-09）\n\n')).toBe(true);
    expect(alert.body).toContain('正文里提到 #12，不是立案标记');
    expect(h.recorded).toEqual([{ repo: 'acme/widgets', dedupeKey: alert.dedupeKey, number: 41 }]);
  });

  it('正文开头已有单号的不再开；关了不满 7 天不再开；满 7 天换新键再开一张', async () => {
    // 最近又报过（updatedAt 是现在）：过期兜底不撤，才轮得到「单关了再隔 7 天」。
    const fresh = new Date(NOW.getTime() - 10 * DAY);
    const open = row({
      id: 'open',
      dedupeKey: 'wf:failure:acme/widgets:open',
      body: '已立案：#9（2026-10-01）\n\n原来的正文',
      createdAt: fresh,
      updatedAt: NOW,
    });
    const young = row({
      id: 'young',
      dedupeKey: 'wf:failure:acme/widgets:young',
      body: '已立案：#7（2026-10-01）\n\n原来的正文',
      createdAt: fresh,
      updatedAt: NOW,
    });
    const old = row({
      id: 'old',
      dedupeKey: 'wf:failure:acme/widgets:old',
      body: '已立案：#8（2026-10-01）\n\n原来的正文',
      createdAt: fresh,
      updatedAt: NOW,
    });
    const h = harness([open, young, old], {
      issueState: async (_repo, number) => {
        if (number === 7) return { state: 'closed', closedAt: new Date(NOW.getTime() - 3 * DAY) };
        if (number === 8) return { state: 'closed', closedAt: new Date(NOW.getTime() - 8 * DAY) };
        return { state: 'open', closedAt: null };
      },
    });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened.map((o) => o.key)).toEqual(['alert-file:wf:failure:acme/widgets:old:after:8']);
    expect(h.opened[0]?.body).not.toContain('已立案：');
    expect(h.opened[0]?.body).toContain('原来的正文');
    expect(open.body).toBe('已立案：#9（2026-10-01）\n\n原来的正文');
    expect(young.body).toBe('已立案：#7（2026-10-01）\n\n原来的正文');
    expect(old.body.startsWith('已立案：#41（2026-10-09）\n\n')).toBe(true);
    expect(old.body).toContain('原来的正文');
    expect(old.body).not.toContain('#8');
  });

  it('关了但不知道什么时候关的：先记下看见的时刻，这一轮不开；隔满 7 天再开', async () => {
    let now = NOW;
    // reconcile:* 过期兜底不碰，隔了 8 天提醒还在，才走「看见已关之后再隔 7 天」。
    const alert = row({
      dedupeKey: 'reconcile:pr:acme/widgets#9',
      body: '已立案：#7（2026-10-01）\n\n原来的正文',
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });
    const h = harness([alert], {
      now: () => now,
      issueState: async () => ({ state: 'closed', closedAt: null }),
    });
    const first = await h.run();
    expect(first.found).toBe(0);
    expect(first.unchecked).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(alert.body).toBe(`已立案：#7（2026-10-01，已关 ${NOW.toISOString()}）\n\n原来的正文`);

    now = new Date(NOW.getTime() + 8 * DAY);
    const second = await h.run();
    expect(second.unchecked).toEqual([]);
    expect(h.opened.map((o) => o.key)).toEqual(['alert-file:reconcile:pr:acme/widgets#9:after:7']);
    expect(h.opened[0]?.body).not.toContain('已立案：');
    expect(alert.body.startsWith('已立案：#41（2026-10-17）\n\n')).toBe(true);
    expect(alert.body).toContain('原来的正文');
    expect(alert.body).not.toContain('已关');
  });

  it('静默、有人处理、等创始人拍、不到 24 小时、要人拍、自己会撤的不开；reconcile 还开着的开', async () => {
    const silenced = row({ id: 's', dedupeKey: 'wf:failure:acme/widgets:silenced' });
    const fixing = row({ id: 'p', dedupeKey: 'wf:failure:acme/widgets:pr' });
    const waiting = row({ id: 'w', dedupeKey: 'wf:failure:acme/widgets:wait' });
    const fresh = row({
      id: 'f',
      dedupeKey: 'wf:failure:acme/widgets:fresh',
      createdAt: new Date(NOW.getTime() - 23 * HOUR),
    });
    const decision = row({ id: 'd', dedupeKey: 'ask:acme/widgets:human', level: 'decision' });
    const canary = row({ id: 'c', dedupeKey: 'canary:acme/widgets:broken' });
    const missing = row({ id: 'm', dedupeKey: 'wf:failure:acme/widgets:missing' });
    const reconcile = row({
      id: 'r',
      dedupeKey: 'reconcile:pr:acme/widgets#9',
      title: '机器人开的 PR 没经合并队列合',
    });
    const h = harness([silenced, fixing, waiting, fresh, decision, canary, missing, reconcile], {
      handling: async () =>
        new Map([
          stage('s', 'silenced'),
          stage('p', 'pr_open'),
          stage('w', 'waiting_founder'),
          stage('f', 'unclaimed'),
          stage('d', 'unclaimed'),
          stage('c', 'unclaimed'),
          stage('r', 'unclaimed'),
        ]),
    });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened.map((o) => o.key)).toEqual(['alert-file:reconcile:pr:acme/widgets#9']);
    expect(h.opened[0]?.body).toContain('无（AI 发现：提醒 reconcile:pr:acme/widgets#9 第 1 天没人处理）');
    expect(h.opened[0]?.labels).toEqual(['缺陷']);
    expect(reconcile.body.startsWith('已立案：#')).toBe(true);
    for (const kept of [silenced, fixing, waiting, fresh, decision, canary, missing]) {
      expect(kept.body, kept.dedupeKey).not.toContain('已立案：');
    }
  });

  it('一次最多 2 张，老的先开；一个仓今天满 4 张就跳过，别的仓还能开', async () => {
    const hours = (h: number) => new Date(NOW.getTime() - h * HOUR);
    const old = row({ id: '1', dedupeKey: 'wf:failure:acme/widgets:old', createdAt: hours(30) });
    const mid = row({ id: '2', dedupeKey: 'wf:failure:acme/widgets:mid', createdAt: hours(28) });
    const newest = row({ id: '3', dedupeKey: 'wf:failure:acme/widgets:new', createdAt: hours(26) });
    const capped = harness([old, mid, newest]);
    expect((await capped.run()).unchecked).toEqual([]);
    expect(capped.opened.map((o) => o.key)).toEqual([
      'alert-file:wf:failure:acme/widgets:old',
      'alert-file:wf:failure:acme/widgets:mid',
    ]);
    expect(newest.body).not.toContain('已立案：');

    const full = row({ id: 'full', dedupeKey: 'wf:failure:acme/widgets:full', createdAt: hours(30) });
    const other = row({ id: 'other', dedupeKey: 'wf:failure:other/repo:open', createdAt: hours(26) });
    const daily = harness([full, other], {
      filedToday: async (repo) => (repo.name === 'widgets' ? 4 : 0),
    });
    expect((await daily.run()).unchecked).toEqual([]);
    expect(daily.opened.map((o) => o.repo)).toEqual([{ owner: 'other', name: 'repo' }]);
    expect(full.body).not.toContain('已立案：');
    expect(other.body.startsWith('已立案：#')).toBe(true);
  });

  it('认不出仓的不开，也不把这一轮记成没查成', async () => {
    const alert = row({ dedupeKey: 'wf:failure:no-repo', link: 'https://example.com/not-a-repo' });
    const h = harness([alert]);
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(part.found).toBe(0);
    expect(h.opened).toEqual([]);
    expect(alert.body).toBe('原来的正文');
  });

  it('谁在处理没接上：这一轮不立案', async () => {
    const alert = row({ dedupeKey: 'wf:failure:acme/widgets:rule' });
    const h = harness([alert], { handling: 'omit' });
    const part = await h.run();
    expect(part.unchecked).toEqual(['谁在处理没接上，这一轮不立案']);
    expect(h.opened).toEqual([]);
    expect(alert.body).not.toContain('已立案：');
  });

  it('北京时间今天从 0 点算', () => {
    expect(beijingDayStart(NOW).toISOString()).toBe('2026-10-08T16:00:00.000Z');
  });

  it('【故意造出的失败】GitHub 写不进：不回写单号，记没立成', async () => {
    const alert = row({ dedupeKey: 'wf:failure:acme/widgets:down' });
    const h = harness([alert], {
      openIssue: async () => {
        throw new Error('GitHub 502');
      },
    });
    const part = await h.run();
    expect(part.found).toBe(0);
    expect(part.unchecked).toEqual(['提醒 wf:failure:acme/widgets:down 没立成：GitHub 502']);
    expect(h.updated).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(alert.body).toBe('原来的正文');
    expect(h.opened).toHaveLength(1);
  });

  it('已合并超过 7 天的 reconcile:pr、reconcile:ledger 不立案、不再每天重推，驾驶舱只留原来那一条', async () => {
    const mergedAt = new Date(NOW.getTime() - 8 * DAY);
    const origin = row({
      id: 'pr',
      dedupeKey: 'reconcile:pr:acme/widgets#389',
      title: '机器人开的 PR 没经合并队列合',
      createdAt: new Date(NOW.getTime() - 11 * DAY),
    });
    const ledger = row({
      id: 'led',
      dedupeKey: 'reconcile:ledger:acme/widgets#1230',
      title: '合了的 PR 记账不全',
      createdAt: new Date(NOW.getTime() - 11 * DAY),
    });
    const child = row({
      id: 'child',
      dedupeKey: 'remind:pr:2026-10-08',
      title: '还没处理：机器人开的 PR 没经合并队列合',
      body: '昨天推的',
    });
    const h = harness([origin, ledger, child], { prMergedAt: async () => mergedAt });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.inserted).toEqual([]);
    expect(origin.resolvedAt).toBeNull();
    expect(ledger.resolvedAt).toBeNull();
    expect(origin.body).not.toContain('已立案：');
    expect(ledger.body).not.toContain('已立案：');
    expect(child.resolvedAt).not.toBeNull();
    expect(child.body.startsWith('已撤：')).toBe(true);
    expect(child.body).toContain('不再每天重推');
  });

  it('合并未满 7 天、刚好满 7 天的 reconcile:pr 仍立案', async () => {
    const six = row({ id: 'six', dedupeKey: 'reconcile:pr:acme/widgets#9' });
    const exact = row({ id: 'exact', dedupeKey: 'reconcile:pr:acme/widgets#10' });
    const h = harness([six, exact], {
      prMergedAt: async (_repo, number) => {
        if (number === 9) return new Date(NOW.getTime() - 6 * DAY);
        if (number === 10) return new Date(NOW.getTime() - 7 * DAY);
        throw new Error(`不该问 #${number}`);
      },
    });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened.map((o) => o.key).sort()).toEqual(
      ['alert-file:reconcile:pr:acme/widgets#10', 'alert-file:reconcile:pr:acme/widgets#9'].sort(),
    );
    expect(six.body.startsWith('已立案：#')).toBe(true);
    expect(exact.body.startsWith('已立案：#')).toBe(true);
    expect(h.opened.every((o) => o.body.includes('- 这条提醒的条件不再成立（对账撤掉它）'))).toBe(true);
    expect(h.opened.every((o) => !o.body.includes('diff 里看得到'))).toBe(true);
    expect(h.inserted).toHaveLength(2);
  });

  it('不是 reconcile 的提醒照常立案，也不去问 PR 的合并时刻', async () => {
    const alert = row({ dedupeKey: 'wf:failure:acme/widgets:rule' });
    const h = harness([alert], {
      prMergedAt: async () => {
        throw new Error('不该问合并时刻');
      },
    });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.body).toContain('- 这条提醒的条件不再成立（对账撤掉它）');
    expect(h.opened[0]?.body).toContain('- 造成这条提醒的问题已经改掉，diff 里看得到');
    expect(alert.body.startsWith('已立案：#')).toBe(true);
  });

  it('怎么算做完只有「提醒的条件不再成立」、又不会自己撤的，不开单，正文写没有可做的事', async () => {
    const alert = row({ dedupeKey: 'wf:failure:acme/widgets:rule' });
    const h = harness([alert], {
      doneItems: () => ['- 这条提醒的条件不再成立（对账撤掉它）'],
    });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(alert.body.startsWith('没有可做的事，已跳过立案\n\n')).toBe(true);
    expect(alert.body).toContain('原来的正文');
    expect(alert.body).not.toContain('已立案：');
  });

  it('【故意造出的失败】读不到 PR 的合并时刻：不跳过，记没查成', async () => {
    const alert = row({ dedupeKey: 'reconcile:pr:acme/widgets#9' });
    const h = harness([alert], {
      prMergedAt: async () => {
        throw new Error('GitHub 502');
      },
    });
    const part = await h.run();
    expect(h.opened).toHaveLength(1);
    expect(alert.body.startsWith('已立案：#')).toBe(true);
    expect(part.unchecked).toEqual([
      '提醒 reconcile:pr:acme/widgets#9 的 PR 合并时刻没查成，不跳过：GitHub 502',
    ]);
  });
});
