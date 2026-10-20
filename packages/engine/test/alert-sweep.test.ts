// 卡住报警立案（#1406）：超过 24 小时没人处理的开一张未排期的单，单号写回正文开头。
// 每条失败路径都故意造一次；GitHub 写不进的后面还有一条：合并时刻读不到不跳过，放最后。
import {
  doneSection,
  offDiffAcceptanceItems,
  parseMd,
  requiredSectionProblems,
} from '@fleet-dao/conventions';
import type { AlertStage } from '@fleet-dao/core';
import type { AlertRow } from '@fleet-dao/db';
import { checkoutNotificationProblem } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { CheckoutStageError, checkoutAlertKey, checkoutBlockedAlert } from '../src/cold-verify-run.ts';
import {
  type AlertFiling,
  type AlertRepo,
  type AlertSweepDeps,
  alertRepoFromText,
  EXPIRE_AFTER_MS,
  eligibleToFile,
  FILE_LABELS,
  renderAlertIssueBody,
  SELF_RESOLVING_PREFIXES,
  sweepAlerts,
} from '../src/jobs/alert-sweep.ts';
import { beijingDayStart, RECONCILE_ACTOR } from '../src/jobs/reconcile-common.ts';

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
    raisedAt: over.raisedAt ?? createdAt,
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
    lateReviews?: AlertSweepDeps['lateReviews'];
    doneItems?: AlertSweepDeps['doneItems'];
    workflows?: AlertSweepDeps['workflows'];
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
    workflows: over.workflows ?? {
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
    ...(over.lateReviews ? { lateReviews: over.lateReviews } : {}),
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

/** 历史证据类立案的验收。只给 reconcile:pr: / reconcile:ledger:，不写「条件不再成立」。 */
const HISTORICAL_DONE = [
  '- 真实来源与完整回执齐全的，可按现有规则核实；缺证据的明确 historical_unproven，并通过已有可信 ops 历史审计处置记录精确身份、证据、缺口和后续责任。不能声称历史条件已经消失。测试与 diff 都不得把缺证据写成条件已消失',
  '- 不得伪造正常 merge 账、不得晋升 backfill、不得伪造具体 head 的真人批准、不得按 PR 号或 local 分支名豁免；读取失败保留未知，不清卡凑绿',
] as const;

const RECOVERABLE_DONE = [
  '- 这条提醒的条件不再成立（对账撤掉它）',
  '- 造成这条提醒的问题已经改掉，diff 里看得到',
] as const;

function doneLines(body: string): string[] {
  const marker = '## 怎么算做完\n\n';
  const start = body.indexOf(marker);
  if (start < 0) return [];
  return (body.slice(start + marker.length).split('\n## ')[0] ?? '')
    .split('\n')
    .filter((line) => line.length > 0);
}

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
    expect(opened?.labels).toEqual(['缺陷', '域:engine', '性质:bug']);
    const doc = parseMd('body.md', opened?.body ?? '');
    expect(requiredSectionProblems(doc)).toEqual([]);
    expect(doneSection(doc)).toBe('ok');
    expect(opened?.body).toContain('合并队列判断出错');
    expect(opened?.body).toContain('正文里提到 #12，不是立案标记');
    expect(opened?.body).toContain('无（AI 发现：提醒 wf:failure:acme/widgets:rule 第 1 天没人处理）');
    expect(doneLines(opened?.body ?? '')).toEqual([...RECOVERABLE_DONE]);
    expect(opened?.body).not.toContain('historical_unproven');
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
    const stall = row({ id: 'c', dedupeKey: 'watchdog:merge:acme/widgets:after-3' });
    const missing = row({ id: 'm', dedupeKey: 'wf:failure:acme/widgets:missing' });
    const reconcile = row({
      id: 'r',
      dedupeKey: 'reconcile:pr:acme/widgets#9',
      title: '机器人开的 PR 没经合并队列合',
    });
    const h = harness([silenced, fixing, waiting, fresh, decision, stall, missing, reconcile], {
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
    expect(h.opened[0]?.labels).toEqual(['缺陷', '域:engine', '性质:bug']);
    expect(reconcile.body.startsWith('已立案：#')).toBe(true);
    for (const kept of [silenced, fixing, waiting, fresh, decision, stall, missing]) {
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
    const h = harness([origin, ledger], { prMergedAt: async () => mergedAt });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.inserted).toEqual([]);
    expect(origin.resolvedAt).toBeNull();
    expect(ledger.resolvedAt).toBeNull();
    expect(origin.body).not.toContain('已立案：');
    expect(ledger.body).not.toContain('已立案：');
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
    for (const opened of h.opened) {
      expect(doneLines(opened.body)).toEqual([...HISTORICAL_DONE]);
      expect(opened.body).not.toContain('这条提醒的条件不再成立');
    }
    expect(h.inserted, '不再写再提醒').toEqual([]);
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
    expect(doneLines(h.opened[0]?.body ?? '')).toEqual([...RECOVERABLE_DONE]);
    expect(h.opened[0]?.body).not.toContain('historical_unproven');
    expect(alert.body.startsWith('已立案：#')).toBe(true);
  });

  it('只有 reconcile:pr 与 reconcile:ledger 写历史证据验收，普通可恢复告警仍用原模板', async () => {
    const pr = row({
      id: 'pr',
      dedupeKey: 'reconcile:pr:acme/widgets#21',
      title: '机器人开的 PR 没经合并队列合',
    });
    const ledger = row({
      id: 'led',
      dedupeKey: 'reconcile:ledger:acme/widgets#22',
      title: '合了的 PR 记账不全',
    });
    const filed = harness([pr, ledger]);
    const part = await filed.run();
    expect(part.unchecked).toEqual([]);
    expect(filed.opened.map((o) => o.key).sort()).toEqual([
      'alert-file:reconcile:ledger:acme/widgets#22',
      'alert-file:reconcile:pr:acme/widgets#21',
    ]);
    for (const opened of filed.opened) {
      expect(doneLines(opened.body)).toEqual([...HISTORICAL_DONE]);
      expect(opened.body).not.toContain('这条提醒的条件不再成立');
      expect(opened.body).toContain('真实来源与完整回执齐全的，可按现有规则核实');
      expect(opened.body).toContain('historical_unproven');
      expect(opened.body).toContain('已有可信 ops 历史审计处置记录精确身份、证据、缺口和后续责任');
      expect(opened.body).toContain('不能声称历史条件已经消失');
      expect(opened.body).toContain('不得伪造正常 merge 账');
      expect(opened.body).toContain('不得晋升 backfill');
      expect(opened.body).toContain('不得伪造具体 head 的真人批准');
      expect(opened.body).toContain('不得按 PR 号或 local 分支名豁免');
      expect(opened.body).toContain('读取失败保留未知，不清卡凑绿');
      const doc = parseMd('body.md', opened.body);
      expect(requiredSectionProblems(doc)).toEqual([]);
      expect(doneSection(doc)).toBe('ok');
      expect(offDiffAcceptanceItems(doneLines(opened.body).join('\n'))).toEqual([]);
    }

    const ordinary = renderAlertIssueBody(
      { dedupeKey: 'wf:failure:acme/widgets:rule', title: '合并队列判断出错', body: '原来的正文' },
      1,
    );
    const workflow = renderAlertIssueBody(
      { dedupeKey: 'reconcile:workflow:task-1', title: '开着的单没有着落', body: '原来的正文' },
      1,
    );
    const nearMiss = renderAlertIssueBody(
      { dedupeKey: 'reconcile:preview:acme/widgets#9', title: '别的核对', body: '原来的正文' },
      1,
    );
    expect(doneLines(ordinary)).toEqual([...RECOVERABLE_DONE]);
    expect(ordinary).not.toContain('historical_unproven');
    expect(doneLines(workflow)).toEqual(['- 这条提醒的条件不再成立（对账撤掉它）']);
    expect(workflow).not.toContain('historical_unproven');
    expect(doneLines(nearMiss)).toEqual(['- 这条提醒的条件不再成立（对账撤掉它）']);
    expect(nearMiss).not.toContain('historical_unproven');
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

  it('刚报出来、还没到 24 小时的 reconcile:pr 不去问合并时刻，也不记没查成', async () => {
    const alert = row({
      dedupeKey: 'reconcile:pr:acme/widgets#7',
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    const h = harness([alert], {
      prMergedAt: async () => {
        throw new Error('不该问合并时刻');
      },
    });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.inserted).toEqual([]);
    expect(alert.body).toBe('原来的正文');
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

describe('日报超过 48 小时由这一轮收掉', () => {
  it('超过 48 小时的 daily 收掉；刚好 48 小时、更近的日报、开着的 alert 和 decision 都不收', async () => {
    const old = row({
      dedupeKey: 'release:start:abcdef123456:1',
      level: 'daily',
      title: '发版开始',
      createdAt: new Date(NOW.getTime() - 3 * DAY),
      updatedAt: new Date(NOW.getTime() - 3 * DAY),
    });
    const fresh = row({
      dedupeKey: 'release:done:abcdef123456:2',
      level: 'daily',
      title: '发版成功',
      createdAt: new Date(NOW.getTime() - 47 * HOUR),
      updatedAt: new Date(NOW.getTime() - 47 * HOUR),
    });
    const exact = row({
      dedupeKey: 'release:start:bbbbbbbbbbbb:3',
      level: 'daily',
      title: '刚好 48 小时',
      createdAt: new Date(NOW.getTime() - 48 * HOUR),
      updatedAt: new Date(NOW.getTime() - 48 * HOUR),
    });
    const touched = row({
      dedupeKey: 'release:done:ccccddddcccc:9',
      level: 'daily',
      title: '三天前建立、刚才又更新',
      createdAt: new Date(NOW.getTime() - 3 * DAY),
      updatedAt: NOW,
    });
    const freshAlert = row({
      dedupeKey: 'wf:failure:still-open',
      level: 'alert',
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
      updatedAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    const decision = row({
      dedupeKey: 'someone:asks-human',
      level: 'decision',
      title: '等你拍',
      createdAt: new Date(NOW.getTime() - 4 * DAY),
      updatedAt: new Date(NOW.getTime() - 4 * DAY),
    });
    const h = harness([old, fresh, exact, touched, freshAlert, decision]);
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(part.found).toBe(2);
    expect(old.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(old.body.startsWith('已撤：超过 48 小时自动收')).toBe(true);
    expect(touched.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(touched.body.startsWith('已撤：超过 48 小时自动收')).toBe(true);
    expect(fresh.resolvedAt).toBeNull();
    expect(exact.resolvedAt).toBeNull();
    expect(freshAlert.resolvedAt).toBeNull();
    expect(decision.resolvedAt).toBeNull();
  });

  it('createdAt 在 30 小时前、10 分钟前刚重开的不再推、不立案；同一条这一次挂满 25 小时照推、照立案', async () => {
    const key = 'wf:failure:acme/widgets:reopen';
    const reopened = row({
      id: 'reopen',
      dedupeKey: key,
      title: '额度读不到：grok',
      createdAt: new Date(NOW.getTime() - 30 * HOUR),
      raisedAt: new Date(NOW.getTime() - 10 * 60_000),
      updatedAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    const held = harness([reopened]);
    const heldPart = await held.run();
    expect(heldPart.unchecked).toEqual([]);
    expect(heldPart.found).toBe(0);
    expect(held.inserted).toEqual([]);
    expect(held.opened).toEqual([]);

    const hung = row({
      id: 'hung',
      dedupeKey: key,
      title: '额度读不到：grok',
      createdAt: new Date(NOW.getTime() - 30 * HOUR),
      raisedAt: new Date(NOW.getTime() - 25 * HOUR),
      updatedAt: new Date(NOW.getTime() - 25 * HOUR),
    });
    const pushed = harness([hung]);
    const pushedPart = await pushed.run();
    expect(pushedPart.unchecked).toEqual([]);
    expect(pushed.inserted, '不再写再提醒').toEqual([]);
    expect(pushed.opened.map((o) => o.key)).toEqual([`alert-file:${key}`]);
    expect(pushed.opened[0]?.body).toContain('第 1 天没人处理');
  });
});

describe('冷验收检出报警不落三天过期兜底', () => {
  const HEAD = 'a'.repeat(40);
  const checkoutTask = checkoutAlertKey('task:thoerwink8/fleet-dao#3067', HEAD);
  const checkoutHead = checkoutAlertKey(undefined, HEAD);
  const unknownKey = 'wf:failure:account-banned';
  const legacyKey = 'cold-verify:checkout-dir:legacy';
  const otherColdKey = 'cold-verify:archive:task:thoerwink8/fleet-dao#3067';

  it('真实 checkoutAlertKey 在 3 天边界和更久都不因 TTL 撤，普通未知键仍按原边界撤', async () => {
    expect(checkoutTask).toBe('cold-verify:checkout:task:thoerwink8/fleet-dao#3067');
    expect(checkoutHead.startsWith('cold-verify:checkout:head:')).toBe(true);
    expect(SELF_RESOLVING_PREFIXES).toContain('cold-verify:checkout:');
    expect(SELF_RESOLVING_PREFIXES).not.toContain('cold-verify:');
    expect(SELF_RESOLVING_PREFIXES).not.toContain('cold-verify:checkout-dir');
    expect(SELF_RESOLVING_PREFIXES).not.toContain('cold-verify:checkout-dir:');
    expect(eligibleToFile(checkoutTask)).toBe(false);
    expect(eligibleToFile(checkoutHead)).toBe(false);
    expect(eligibleToFile(unknownKey)).toBe(true);
    expect(eligibleToFile(legacyKey)).toBe(true);
    expect(eligibleToFile(otherColdKey)).toBe(true);

    const ages = [
      { idle: EXPIRE_AFTER_MS, expireOthers: false },
      { idle: EXPIRE_AFTER_MS + 864, expireOthers: true },
      { idle: 30 * DAY, expireOthers: true },
    ];
    for (const task of ['running', 'done', null] as const) {
      for (const age of ages) {
        const reads = { task: 0, state: 0, view: 0 };
        const resolved: { dedupeKey: string; why: string }[] = [];
        const updatedAt = new Date(NOW.getTime() - age.idle);
        const open = [checkoutTask, checkoutHead, unknownKey, legacyKey, otherColdKey].map((dedupeKey) =>
          row({
            dedupeKey,
            taskId: '3067',
            title: '冷验收放不进 PR 头的完整检出',
            createdAt: updatedAt,
            updatedAt,
          }),
        );
        const deps: AlertSweepDeps = {
          workflows: {
            state: async () => {
              reads.state += 1;
              return task === 'running' ? { state: 'running' } : { state: 'closed', status: 'COMPLETED' };
            },
            view: async () => {
              reads.view += 1;
              return { parked: false, waiting: null, doing: '检出', approval: null };
            },
          },
          taskState: async () => {
            reads.task += 1;
            return task;
          },
          approval: async () => null,
          stageRoutable: async () => ({ kind: 'none', detail: '没有' }),
          alerts: {
            listOpen: async () => ({ alerts: open, truncated: false }),
            byKey: async (key) => open.find((a) => a.dedupeKey === key) ?? null,
            latestByPrefix: async () => null,
            resolve: async (x) => {
              resolved.push({ dedupeKey: x.dedupeKey, why: x.why });
              return 'ok';
            },
            raise: async () => {},
            insertOnce: async () => ({ created: false }),
            updateOpen: async () => 'ok',
          },
          now: () => NOW,
          log: () => {},
        };
        const part = await sweepAlerts(deps, open, false);
        expect(part.unchecked, `${task ?? '未知'} / ${age.idle}`).toEqual([]);
        expect(reads, `${task ?? '未知'} / ${age.idle}`).toEqual({ task: 0, state: 0, view: 0 });
        const gone = resolved.map((r) => r.dedupeKey).sort();
        if (age.expireOthers) {
          expect(gone, `${task ?? '未知'} / ${age.idle}`).toEqual(
            [legacyKey, otherColdKey, unknownKey].sort(),
          );
          expect(resolved.every((r) => r.why.startsWith('过期：'))).toBe(true);
        } else {
          expect(gone, `${task ?? '未知'} / ${age.idle}`).toEqual([]);
        }
        expect(resolved.some((r) => r.dedupeKey === checkoutTask || r.dedupeKey === checkoutHead)).toBe(
          false,
        );
      }
    }
  });

  it('挂满 24 小时的停下提醒（task:*:park:*）和指挥官那条（commander:*:park:*）不开单，交法国指挥官', async () => {
    const parkKey = 'task:thoerwink8/fleet-dao#3207:park:1';
    const commanderKey = `commander:${parkKey}`;
    expect(eligibleToFile(parkKey)).toBe(false);
    expect(eligibleToFile(commanderKey)).toBe(false);
    expect(eligibleToFile('task:thoerwink8/fleet-dao#3207:failure:WT1')).toBe(true);
    const since = new Date(NOW.getTime() - 30 * HOUR);
    const park = row({
      dedupeKey: parkKey,
      taskId: 't-3207',
      title: '改动超出体量预算：新增 9550 行，预算 3000 行，收窄过一次仍超',
      createdAt: since,
      updatedAt: since,
    });
    const commander = row({ dedupeKey: commanderKey, taskId: 't-3207', createdAt: since, updatedAt: since });
    const h = harness([park, commander], {
      workflows: {
        state: async () => ({ state: 'running' }),
        view: async () => ({
          parked: true,
          waiting: { kind: 'human', detail: '挂起：改动超出体量预算', since: since.toISOString() },
          doing: '停下等人',
          approval: null,
        }),
      },
    });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(park.resolvedAt).toBeNull();
    expect(park.body).not.toContain('已立案：');
    expect(commander.body).not.toContain('已立案：');
  });

  it('检出前缀不走自动兜底立案，普通未知键仍立案', async () => {
    const stale = new Date(NOW.getTime() - 30 * DAY);
    const checkout = row({
      dedupeKey: checkoutTask,
      taskId: '3067',
      title: '冷验收放不进 PR 头的完整检出',
      createdAt: stale,
      updatedAt: stale,
    });
    const unknown = row({
      dedupeKey: 'wf:failure:acme/widgets:plain',
      createdAt: new Date(NOW.getTime() - 25 * HOUR),
      updatedAt: new Date(NOW.getTime() - 25 * HOUR),
    });
    const h = harness([checkout, unknown]);
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(checkout.resolvedAt).toBeNull();
    expect(checkout.body).toBe('原来的正文');
    expect(h.opened.map((o) => o.key)).toEqual(['alert-file:wf:failure:acme/widgets:plain']);
    expect(unknown.body.startsWith('已立案：#')).toBe(true);
  });
});

describe('合并后才到的「要求改」提醒（late-review）条件没了由对账撤', () => {
  const key = 'late-review:thoerwink8/fleet-dao#3178:5565465101';
  const unreadKey = 'late-review-unread:thoerwink8/fleet-dao#3178';
  const eventKey = 'late-review:thoerwink8/fleet-dao#3178:0';
  // 开了不止 3 天：要是落到过期兜底或立案，下面的断言会看到
  const old = new Date(NOW.getTime() - 4 * DAY);

  it('评审不再是未解决的「要求改」（被撤、审查者后来通过）：撤，写明原因；读的是键里的仓和 PR', async () => {
    const alert = row({ dedupeKey: key, createdAt: old });
    const asked: string[] = [];
    const h = harness([alert], {
      lateReviews: async (repo, number) => {
        asked.push(`${repo.owner}/${repo.name}#${number}`);
        return [];
      },
    });
    const part = await h.run();
    expect(part.unchecked).toEqual([]);
    expect(asked).toEqual(['thoerwink8/fleet-dao#3178']);
    expect(alert.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(alert.body).toContain('review 5565465101 已经不是还没解决的「要求改」了');
    expect(h.opened).toEqual([]);
  });

  it('这条评审还没解决：不撤、不过期、不立案（要人跟进的事）；别的评审没解决不算它', async () => {
    const still = row({ dedupeKey: key, createdAt: old });
    const h = harness([still], { lateReviews: async () => [5565465101, 7] });
    expect((await h.run()).unchecked).toEqual([]);
    expect(still.resolvedAt).toBeNull();
    expect(h.opened).toEqual([]);
    expect(eligibleToFile(key)).toBe(false);
    expect(eligibleToFile(unreadKey)).toBe(false);

    const other = row({ dedupeKey: key, createdAt: old });
    const h2 = harness([other], { lateReviews: async () => [7] });
    await h2.run();
    expect(other.resolvedAt).not.toBeNull();
  });

  it('没读成评审 / 事件没带评审号：认不出是哪一条，PR 上一条没解决的都没有才撤', async () => {
    for (const k of [unreadKey, eventKey]) {
      const kept = row({ dedupeKey: k, createdAt: old });
      await harness([kept], { lateReviews: async () => [42] }).run();
      expect(kept.resolvedAt).toBeNull();
      const gone = row({ dedupeKey: k, createdAt: old });
      await harness([gone], { lateReviews: async () => [] }).run();
      expect(gone.resolvedAt).not.toBeNull();
    }
  });

  it('【故意造出的失败】读评审失败或没接上读法：不撤，记没查成', async () => {
    const a = row({ dedupeKey: key, createdAt: old });
    const failed = await harness([a], {
      lateReviews: async () => {
        throw new Error('HTTP 502');
      },
    }).run();
    expect(a.resolvedAt).toBeNull();
    expect(failed.unchecked).toHaveLength(1);
    expect(failed.unchecked[0]).toContain('HTTP 502');

    const b = row({ dedupeKey: key, createdAt: old });
    const unwired = await harness([b]).run();
    expect(b.resolvedAt).toBeNull();
    expect(unwired.unchecked[0]).toContain('没接上读评审的口子');
  });
});

describe('alert-sweep 补的前缀不挡历史 checkout 归档的格式校验', () => {
  const HEAD = 'a'.repeat(40);
  const WF = 'task:acme/widgets#12';
  const alert = checkoutBlockedAlert({
    dir: '/var/lib/fleet-work/_tmp/verify-0f0e0d0c-0b0a-4908-8706-050403020100',
    head: HEAD,
    workflowId: WF,
    error: new CheckoutStageError('archive', 'fatal: not a valid object name', {
      mirrorDir: '/var/lib/fleet-github/mirrors/acme/widgets.git',
      missingObject: true,
    }),
  });
  const problem = (body: string) =>
    checkoutNotificationProblem({ title: alert.title, body }, { workflowId: WF, head: HEAD });

  it('引擎原文通过；真 sweep 写的「已立案」「没有可做的事」前缀（单独、叠加、已关）也通过', async () => {
    expect(problem(alert.body)).toBeUndefined();

    // 用真 sweep 在一条非 checkout 键上写前缀（checkout 键不立案），正文换成真引擎报警正文。
    const filed = row({ dedupeKey: 'wf:failure:acme/widgets:rule', body: alert.body });
    expect((await harness([filed]).run()).unchecked).toEqual([]);
    expect(filed.body.startsWith('已立案：#41（2026-10-09）\n\n')).toBe(true);
    expect(problem(filed.body)).toBeUndefined();

    const skipped = row({ dedupeKey: 'wf:failure:acme/widgets:rule', body: alert.body });
    const skipHarness = harness([skipped], { doneItems: () => ['- 这条提醒的条件不再成立（对账撤掉它）'] });
    expect((await skipHarness.run()).unchecked).toEqual([]);
    expect(skipped.body.startsWith('没有可做的事，已跳过立案\n\n')).toBe(true);
    expect(problem(skipped.body)).toBeUndefined();

    // 叠加：先跳过立案、后又有了单号（单号写在最前），以及已关的单号标记
    expect(problem(`已立案：#41（2026-10-09）\n\n${skipped.body}`)).toBeUndefined();
    expect(
      problem(
        `没有可做的事，已跳过立案\n\n已立案：#7（2026-10-01，已关 ${NOW.toISOString()}）\n\n${alert.body}`,
      ),
    ).toBeUndefined();
  });

  it('不是 sweep 写的前缀、残缺前缀、前缀后面接的不是引擎原文：仍拒', () => {
    for (const body of [
      `已立案：#41\n\n${alert.body}`,
      `已立案：#0（2026-10-09）\n\n${alert.body}`,
      `已立案：#41（2026-10-09）${alert.body}`,
      `没有可做的事，已跳过立案${alert.body}`,
      `没有可做的事\n\n${alert.body}`,
      `补充说明：已处理\n\n${alert.body}`,
      `已立案：#41（2026-10-09）\n\n${alert.body}另附一句。`,
      `已立案：#41（2026-10-09）\n\n没有可做的事，已跳过立案`,
      '已立案：#41（2026-10-09）',
      `${'已立案：#41（2026-10-09）\n\n'.repeat(5)}${alert.body}`,
    ])
      expect(problem(body)).toBeDefined();
  });
});
