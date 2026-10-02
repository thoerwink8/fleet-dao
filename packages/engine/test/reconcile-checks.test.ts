// 对账的核对（jobs/reconcile-checks.ts）：对上了不报、对不上报并写明哪条 PR 缺什么、条件没了撤、读不到不记 ok 且旧提醒不撤。
// 「开着的单都有着落」那一处随 Fusion 删了（#556），这里只测它留下的旧提醒怎么撤（retireWorkflowAlerts）。
// 人开的 PR 不报合并人这一条在 github 包的测试里（这里只认对账结果里 findings 的种类）。
import { randomUUID } from 'node:crypto';
import type { AlertRow, MergedPrLedger } from '@fleet-dao/db';
import type { MergedPrAuditReport, MergedPrFinding } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import {
  checkLedgers,
  checkMergedPrs,
  LEDGER_GRACE_MS,
  ledgerAlertKey,
  MERGED_PR_LOOKBACK_MS,
  type ReconcileCheckDeps,
  retireWorkflowAlerts,
  WORKFLOW_ALERT_PREFIX,
} from '../src/jobs/reconcile-checks.ts';

const NOW = new Date('2026-09-26T09:41:00.000Z');
const TASK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

interface Raised {
  dedupeKey: string;
  title: string;
  body: string;
  taskId: string | null;
  link?: string | undefined;
}

interface World {
  deps: ReconcileCheckDeps;
  raised: Raised[];
  resolved: { dedupeKey: string; why: string }[];
  inserted: { dedupeKey: string; title: string; body: string; link: string | null; created: boolean }[];
  ledgerCalls: { since: Date; prs: { owner: string; name: string; number: number }[] }[];
}

/** 对账结果：findings 照种类给，problems 跟着 text 排，found、fixed 照 github 包的算法数。 */
function audit(findings: MergedPrFinding[], over: Partial<MergedPrAuditReport> = {}): MergedPrAuditReport {
  return {
    outcome: findings.some((f) => f.kind === 'unchecked') ? 'partial' : 'ok',
    scanned: new Set(findings.map((f) => f.number)).size,
    found: findings.filter((f) => f.kind !== 'unchecked').length,
    fixed: findings.filter((f) => f.kind === 'mirror_fixed').length,
    problems: findings.map((f) => f.text),
    findings,
    ...over,
  };
}

function world(
  over: {
    repos?: { owner: string; name: string }[];
    audit?: ReconcileCheckDeps['auditMergedPrs'];
    open?: AlertRow[];
    listOpen?: ReconcileCheckDeps['alerts']['listOpen'];
    reposFn?: ReconcileCheckDeps['repos'];
    ledgers?: ReconcileCheckDeps['ledgers'];
  } = {},
): World {
  const raised: Raised[] = [];
  const resolved: World['resolved'] = [];
  const inserted: World['inserted'] = [];
  const ledgerCalls: World['ledgerCalls'] = [];
  const rows = [...(over.open ?? [])];
  const deps: ReconcileCheckDeps = {
    repos: over.reposFn ?? (async () => over.repos ?? []),
    auditMergedPrs: over.audit ?? (async () => audit([])),
    async ledgers(input) {
      ledgerCalls.push(input);
      return over.ledgers ? over.ledgers(input) : [];
    },
    alerts: {
      async listOpen(limit) {
        if (over.listOpen) return over.listOpen(limit);
        const alerts = rows.filter((r) => r.resolvedAt === null);
        return { alerts: alerts.slice(0, limit), truncated: alerts.length > limit };
      },
      async byKey(key) {
        return rows.find((r) => r.dedupeKey === key) ?? null;
      },
      async latestByPrefix() {
        return null;
      },
      async resolve(input) {
        resolved.push({ dedupeKey: input.dedupeKey, why: input.why });
        const row = rows.find((r) => r.dedupeKey === input.dedupeKey && r.resolvedAt === null);
        if (!row) return rows.some((r) => r.dedupeKey === input.dedupeKey) ? 'already_resolved' : 'not_found';
        row.resolvedAt = NOW;
        row.resolvedBy = input.by;
        row.body = `已撤：${input.why}\n\n${row.body}`;
        return 'ok';
      },
      async raise(input) {
        raised.push(input);
        const row = rows.find((r) => r.dedupeKey === input.dedupeKey);
        if (row) {
          row.title = input.title;
          row.body = input.body;
          row.taskId = input.taskId;
          row.link = input.link ?? null;
          row.resolvedAt = null;
          row.updatedAt = NOW;
          return;
        }
        rows.push({
          id: randomUUID(),
          dedupeKey: input.dedupeKey,
          level: input.level,
          taskId: input.taskId,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          createdAt: NOW,
          updatedAt: NOW,
          resolvedAt: null,
          resolvedBy: null,
        });
      },
      async insertOnce(input) {
        const existing = rows.find((r) => r.dedupeKey === input.dedupeKey);
        if (existing) {
          inserted.push({ ...input, created: false });
          return { created: false };
        }
        rows.push({
          id: randomUUID(),
          dedupeKey: input.dedupeKey,
          level: input.level,
          taskId: input.taskId,
          title: input.title,
          body: input.body,
          link: input.link,
          createdAt: NOW,
          updatedAt: NOW,
          resolvedAt: null,
          resolvedBy: null,
        });
        inserted.push({
          dedupeKey: input.dedupeKey,
          title: input.title,
          body: input.body,
          link: input.link,
          created: true,
        });
        return { created: true };
      },
      async updateOpen() {
        return 'not_open';
      },
    },
    now: () => NOW,
    log() {},
  };
  return { deps, raised, resolved, inserted, ledgerCalls };
}

function openAlert(dedupeKey: string, over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: randomUUID(),
    dedupeKey,
    level: 'alert',
    taskId: null,
    title: dedupeKey,
    body: '原来的正文',
    link: null,
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

describe('撤掉「开着的单都有着落」留下的旧提醒', () => {
  it('键以 reconcile:workflow: 开头的开着的提醒一律撤，写明原因；别的提醒不动', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const other = openAlert(`${WORKFLOW_ALERT_PREFIX}${OTHER}`);
    const keep = openAlert('reconcile:pr:acme/widgets#5');
    const w = world({ open: [old, other, keep] });
    const part = await retireWorkflowAlerts(w.deps);
    expect(part).toMatchObject({ scanned: 2, found: 2, unchecked: [] });
    expect(w.resolved.map((r) => r.dedupeKey).sort()).toEqual([old.dedupeKey, other.dedupeKey].sort());
    expect(w.resolved[0]?.why).toContain('随 Fusion');
    expect(keep.resolvedAt).toBeNull();
    // 再来一轮：已经撤完了，什么都不做
    expect(await retireWorkflowAlerts(w.deps)).toMatchObject({ scanned: 0, found: 0 });
  });

  it('【故意造出的失败】列不出没处理的提醒：这一部分 failed，不当成「没有旧提醒」', async () => {
    const w = world({
      listOpen: async () => {
        throw new Error('库连不上');
      },
    });
    const part = await retireWorkflowAlerts(w.deps);
    expect(part.failed).toContain('库连不上');
    expect(w.resolved).toEqual([]);
  });

  it('【故意造出的失败】提醒太多只列了一部分：照实记没查全，看到的照撤', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`);
    const w = world({ listOpen: async () => ({ alerts: [old], truncated: true }) });
    const part = await retireWorkflowAlerts(w.deps);
    expect(part.unchecked.join('；')).toContain('只看了前 1 条');
    expect(part.found).toBe(1);
  });

  it('【故意造出的失败】撤的时候抛错：记没查成，不算撤了', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`);
    const w = world({ open: [old] });
    w.deps.alerts.resolve = async () => {
      throw new Error('写库失败');
    };
    const part = await retireWorkflowAlerts(w.deps);
    expect(part.found).toBe(0);
    expect(part.unchecked.join('；')).toContain('没撤成');
  });
});

describe('合了的 PR：镜像、合并人、合并记录', () => {
  const sinceOf = (now: Date) => new Date(now.getTime() - MERGED_PR_LOOKBACK_MS);

  it('镜像没记成 merged：算发现，不报警', async () => {
    const seen: Date[] = [];
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async (_repo, since) => {
        seen.push(since);
        return audit([{ number: 7, kind: 'mirror_fixed', text: '#7 合并了但镜像里没有（已补）' }]);
      },
    });
    const part = await checkMergedPrs(w.deps);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(seen).toEqual([sinceOf(NOW)]);
    expect(w.inserted).toEqual([]);
  });

  it('【故意造出的失败】机器人开的 PR 合并人不是引擎、没有合并记录：报 reconcile:pr 提醒（#440 恢复：#431 就是这么漏的，合并前那几道核对可能没走）；同一张 PR 插过的不再重报', async () => {
    const report = audit([
      { number: 7, kind: 'not_merged_by_engine', text: '#7 不是「引擎」机器人合的（合并人 founder）' },
      { number: 7, kind: 'no_merge_record', text: '#7 合并了，但账上没有合并队列的合并记录' },
    ]);
    const w = world({ repos: [{ owner: 'acme', name: 'widgets' }], audit: async () => report });
    const part = await checkMergedPrs(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 2, unchecked: [] });
    expect(w.inserted).toHaveLength(1);
    const alert = w.inserted[0];
    if (!alert) throw new Error('该有一条 insertOnce 落过的提醒');
    expect(alert.dedupeKey).toBe('reconcile:pr:acme/widgets#7');
    expect(alert.created).toBe(true);
    expect(alert.title).toBe('机器人开的 PR 没经合并队列合：acme/widgets#7');
    expect(alert.body).toContain('#7 不是「引擎」机器人合的（合并人 founder）');
    expect(alert.body).toContain('#7 合并了，但账上没有合并队列的合并记录');
    expect(alert.body).toContain('不会自己撤');
    expect(alert.link).toBe('https://github.com/acme/widgets/pull/7');

    // 再来一轮（库里已有这条 insertOnce 落过的）：不应重复插
    await checkMergedPrs(w.deps);
    expect(w.inserted).toHaveLength(2);
    expect(w.inserted[1]?.dedupeKey).toBe('reconcile:pr:acme/widgets#7');
    expect(w.inserted[1]?.created).toBe(false);
  });

  it('【故意造出的失败】机器人开的 PR 合并人对、账上有合并记录：不报', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => audit([]),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part).toEqual({ scanned: 0, found: 0, unchecked: [] });
    expect(w.inserted).toEqual([]);
  });

  it('只有镜像补上的（人开的 PR 对账结果就是这样）：一样不报', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => audit([{ number: 9, kind: 'mirror_fixed', text: '#9 合并了但镜像里没有（已补）' }]),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.found).toBe(1);
    expect(w.inserted).toEqual([]);
  });

  it('【故意造出的失败】列 PR 失败（读不到 GitHub）：这个仓写进 unchecked，不记成查完了', async () => {
    const w = world({
      repos: [
        { owner: 'acme', name: 'widgets' },
        { owner: 'acme', name: 'other' },
      ],
      audit: async (repo) =>
        repo === 'acme/widgets'
          ? audit([], { outcome: 'unscanned', scanned: 0, why: '列合并的 PR 失败：403' })
          : audit([], { scanned: 1 }),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.failed).toBeUndefined();
    expect(part.unchecked).toEqual(['acme/widgets：列合并的 PR 失败：403']);
    expect(part.scanned).toBe(1);
  });

  it('审的时候抛错：这个仓写进 unchecked', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => {
        throw new Error('GitHub 连不上');
      },
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.unchecked).toEqual(['acme/widgets 审合并的 PR 没做成：GitHub 连不上']);
  });

  it('单张没查成：partial，写进 unchecked，不报警', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => audit([{ number: 7, kind: 'unchecked', text: '#7 没查成：502' }]),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.unchecked).toEqual(['acme/widgets 合并的 PR 没查全：#7 没查成：502']);
    expect(w.inserted).toEqual([]);
  });

  it('列不出受管的仓：这一部分 failed', async () => {
    const w = world({
      reposFn: async () => {
        throw new Error('库连不上');
      },
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.failed).toBe('列受管的仓没成：库连不上');
  });
});

describe('合了的 PR 对上的单记了账', () => {
  function ledger(over: Partial<MergedPrLedger> = {}): MergedPrLedger {
    return {
      owner: 'acme',
      name: 'widgets',
      prNumber: 88,
      prUpdatedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      headRef: 'fleet/160-abc',
      taskId: TASK,
      issueNumber: 160,
      taskState: 'done',
      sessions: [
        {
          runId: randomUUID(),
          stage: 'execute',
          startedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
          endedAt: new Date(NOW.getTime() - 4 * 60 * 60_000),
          outcome: 'ok',
          inputTokens: 1200,
          outputTokens: 300,
        },
        {
          runId: randomUUID(),
          stage: 'verify',
          startedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
          endedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
          outcome: 'ok',
          // 没读到：留空，关单评论写「没读到」，不算缺
          inputTokens: null,
          outputTokens: null,
        },
        {
          runId: randomUUID(),
          stage: 'execute',
          startedAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
          endedAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
          // 刚起就被限流：一个 token 都没花，照实记的 0 不算缺
          outcome: 'failed',
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
      ...over,
    };
  }
  type Session = MergedPrLedger['sessions'][number];

  it('会话都有结局、用量记了或留空（没跑成的 0 照实记）、单做完了：不报，按 26 小时回看', async () => {
    const w = world({ ledgers: async () => [ledger()] });
    const part = await checkLedgers(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
    expect(w.ledgerCalls[0]?.since).toEqual(new Date(NOW.getTime() - MERGED_PR_LOOKBACK_MS));
  });

  it('【故意造出的失败】缺什么报什么：会话没结局、跑成了的会话用量记成 0、单没记成做完，一条 PR 一条提醒，写明哪张单', async () => {
    const base = ledger();
    const w = world({
      ledgers: async () => [
        ledger({
          taskState: 'merging',
          sessions: [
            { ...(base.sessions[0] as Session), endedAt: null, outcome: null },
            { ...(base.sessions[1] as Session), inputTokens: 0, outputTokens: 0 },
            { ...(base.sessions[1] as Session), runId: randomUUID(), inputTokens: 0, outputTokens: null },
          ],
        }),
      ],
    });
    const part = await checkLedgers(w.deps);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(w.raised).toHaveLength(1);
    expect(w.raised[0]).toMatchObject({
      dedupeKey: ledgerAlertKey('acme', 'widgets', 88),
      taskId: TASK,
      title: '合了的 PR 记账不全：acme/widgets#88',
      link: 'https://github.com/acme/widgets/pull/88',
    });
    const body = w.raised[0]?.body ?? '';
    expect(body).toContain('单 #160：1 次会话没有结局（execute）');
    expect(body).toContain('单 #160：2 次跑成了的会话用量记成了 0');
    expect(body).toContain('单 #160：合并关单那一步没写完：库里这张单是「在合并」');
  });

  it('合并不满 30 分钟（关单那一步可能还在走）：不报', async () => {
    const w = world({
      ledgers: async () => [
        ledger({ taskState: 'merging', prUpdatedAt: new Date(NOW.getTime() - LEDGER_GRACE_MS + 1) }),
      ],
    });
    const part = await checkLedgers(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
  });

  it('补齐了撤；出了回看窗口的旧提醒点名复查；镜像里不再对得上的也撤；认不出的键不撤', async () => {
    const fixed = openAlert(ledgerAlertKey('acme', 'widgets', 88));
    const gone = openAlert(ledgerAlertKey('acme', 'gadgets', 7));
    const odd = openAlert('reconcile:ledger:认不出');
    const w = world({ open: [fixed, gone, odd], ledgers: async () => [ledger()] });
    const part = await checkLedgers(w.deps);
    expect(w.ledgerCalls[0]?.prs).toEqual([
      { owner: 'acme', name: 'widgets', number: 88 },
      { owner: 'acme', name: 'gadgets', number: 7 },
    ]);
    expect(part.found).toBe(2);
    expect(w.resolved.map((r) => r.why)).toEqual([
      '会话结局、用量、关单都记齐了',
      '镜像里这条 PR 不再是已合并、或对不上单了',
    ]);
    expect(part.unchecked).toEqual(['提醒 reconcile:ledger:认不出 认不出是哪条 PR，不撤']);
    expect(odd.resolvedAt).toBeNull();
  });

  it('【故意造出的失败】读库抛错：这一部分 failed，旧提醒不撤', async () => {
    const old = openAlert(ledgerAlertKey('acme', 'widgets', 88));
    const w = world({
      open: [old],
      ledgers: async () => {
        throw new Error('库连不上');
      },
    });
    const part = await checkLedgers(w.deps);
    expect(part.failed).toBe('读合了的 PR 和会话记账没成：库连不上');
    expect(w.resolved).toEqual([]);
    expect(old.resolvedAt).toBeNull();
  });

  it('列提醒抛错：照样查、照样报，记没查成，旧提醒不撤', async () => {
    const w = world({
      ledgers: async () => [ledger({ taskState: 'running' })],
      listOpen: async () => {
        throw new Error('提醒表读不了');
      },
    });
    const part = await checkLedgers(w.deps);
    expect(part.unchecked).toEqual(['列没处理的提醒没成，记账核对的旧提醒这一轮不复查、不撤：提醒表读不了']);
    expect(part.found).toBe(1);
    expect(w.resolved).toEqual([]);
  });
});
