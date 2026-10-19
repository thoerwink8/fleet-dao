// 已结束任务的 checkout 失败卡：受管历史归档契约。内存版和 Postgres 版过同一套（入口见 store.memory.test.ts / store.pg.test.ts）。
// 只归档通知并记审计，不是「检出恢复」证明：不写 cold_verify.checkout_full、不改任务/run/其他通知。
import { beforeEach, describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import type { HistoricalCheckoutArchiveInput, NewAuditEntry, Store } from '../src/ports.ts';

const NOW = new Date('2026-10-19T05:00:00.000Z');
const NID = 'f0000000-0000-4000-8000-000000000099';
const LEGACY_NID = 'f0000000-0000-4000-8000-000000000098';
const OTHER_NID = 'f0000000-0000-4000-8000-000000000097';
const RUN_ID = 'd1000000-0000-4000-8000-000000013099';
const TEMPORAL_RUN_ID = 'temporal-checkout-history-1';
const WF = 'task:example/canary#13';
const HEAD = 'b'.repeat(40);
const RAISED_AT = '2026-10-19T03:10:00.000Z';
const LINK = 'https://github.com/example/canary/pull/39';
const OPEN_RUN_ID = 'd1000000-0000-4000-8000-000000013098';
const KEY = `cold-verify:checkout:${WF}`;

const alertBody = (head = HEAD) =>
  `目标 ${WF} 的 head ${head}，目录 /tmp/verify-13。失败在「从镜像 git archive」这一步，原始错误：fatal: not a valid object name。引擎镜像里取不出目标 head。`;

export interface CheckoutHistoryHarness {
  store: Store;
  /** 同一个键换代重开：清掉处理状态，raisedAt 换成新的。 */
  reopen(notificationId: string, raisedAt: string): Promise<void>;
  setTaskState(taskId: string, state: 'running' | 'done'): Promise<void>;
  addRun(run: { id: string; taskId?: string; workflowId: string; endedAt?: string }): Promise<void>;
  /** 让之后每次写 audit_log 都失败（模拟 appendAudit 失败）；返回恢复函数。只有真库能做。 */
  failAuditWrites?: () => Promise<() => Promise<void>>;
}

export type MakeCheckoutHistory = (data: Partial<MemoryData>) => Promise<CheckoutHistoryHarness>;

type RunPatch = Partial<NonNullable<MemoryData['segmentRuns']>[number]> & Record<string, unknown>;
type NotificationPatch = Partial<NonNullable<MemoryData['notifications']>[number]>;

function data(opts: { run?: RunPatch; notification?: NotificationPatch } = {}): Partial<MemoryData> {
  const d = devFixtures(NOW);
  d.segmentRuns = [
    ...(d.segmentRuns ?? []),
    {
      id: RUN_ID,
      segment: 'verify',
      taskId: IDS.task13,
      issueNumber: 13,
      model: 'opus-5.5',
      startedAt: '2026-10-19T03:00:00.000Z',
      endedAt: '2026-10-19T03:10:00.000Z',
      outcome: 'failed',
      prNumber: 39,
      workflowId: WF,
      temporalRunId: TEMPORAL_RUN_ID,
      failureReason: '缺对象',
      ...opts.run,
    } as unknown as NonNullable<MemoryData['segmentRuns']>[number],
  ];
  d.notifications = [
    ...(d.notifications ?? []),
    {
      id: NID,
      level: 'alert',
      title: '冷验收放不进 PR 头的完整检出（从镜像 git archive）',
      body: alertBody(),
      link: LINK,
      createdAt: RAISED_AT,
      raisedAt: RAISED_AT,
      dedupeKey: KEY,
      deliveries: [],
      ...opts.notification,
    },
    {
      id: LEGACY_NID,
      level: 'alert',
      title: '冷验收放不进 PR 头的完整检出（建检出目录）',
      body: alertBody(),
      createdAt: RAISED_AT,
      raisedAt: RAISED_AT,
      dedupeKey: 'cold-verify:checkout-dir',
      deliveries: [],
    },
    {
      id: OTHER_NID,
      level: 'alert',
      title: '冷验收放不进 PR 头的完整检出（获取待验精确头）',
      body: alertBody('c'.repeat(40)).replace(WF, 'task:example/canary#12'),
      createdAt: RAISED_AT,
      raisedAt: RAISED_AT,
      dedupeKey: 'cold-verify:checkout:task:example/canary#12',
      deliveries: [],
    },
  ];
  return d;
}

const baseInput = (over: Partial<HistoricalCheckoutArchiveInput> = {}): HistoricalCheckoutArchiveInput => ({
  notificationId: NID,
  dedupeKey: KEY,
  raisedAt: RAISED_AT,
  notificationBody: alertBody(),
  notificationLink: LINK,
  repo: 'example/canary',
  repoId: IDS.repo,
  taskId: IDS.task13,
  issueNumber: 13,
  workflowId: WF,
  runId: RUN_ID,
  temporalRunId: TEMPORAL_RUN_ID,
  runSegment: 'verify',
  runStartedAt: '2026-10-19T03:00:00.000Z',
  runEndedAt: '2026-10-19T03:10:00.000Z',
  runOutcome: 'failed',
  runPrNumber: 39,
  pr: 39,
  head: HEAD,
  operator: 'founder',
  reason: '旧卡已按完整事实归档',
  evidence: '任务已结束，原 verify run 与 merged PR head 精确对应。',
  gaps: '没有可靠证据证明当时 checkout 曾成功恢复。',
  responsibility: '保留验收责任，部署后由指挥官独立核验。',
  conclusion: 'historical_unproven',
  ...over,
});

const auditFor = (input: HistoricalCheckoutArchiveInput): NewAuditEntry => ({
  actor: { kind: 'ops', id: 'ops:checkout-history' },
  action: 'notification.checkout_history_archive',
  target: `notification:${input.notificationId}`,
  via: 'ops',
  ok: true,
  reason: input.reason,
  after: { ...input, conclusion: 'historical_unproven' },
});

async function notificationOf(store: Store, id: string) {
  const found = (await store.listNotifications({ status: 'all', limit: 100 })).items.find((n) => n.id === id);
  if (!found) throw new Error(`通知 ${id} 不见了`);
  return found;
}
const auditsOf = async (store: Store, id: string) =>
  (await store.listAudit({ target: `notification:${id}`, limit: 100 })).items;

export function describeCheckoutHistoryContract(name: string, make: MakeCheckoutHistory): void {
  describe(`checkout 历史归档契约：${name}`, () => {
    let h: CheckoutHistoryHarness;
    let store: Store;
    beforeEach(async () => {
      h = await make(data());
      store = h.store;
    });

    const untouched = async (id = NID) => {
      const n = await notificationOf(store, id);
      expect(n.resolvedAt).toBeUndefined();
      expect(n.resolvedBy).toBeUndefined();
      expect(await auditsOf(store, id)).toEqual([]);
    };

    it('成功：只撤这一张旧卡并记审计，不写 checkout_full、不改任务/run/其他通知', async () => {
      const facts = await store.readHistoricalCheckout(baseInput());
      expect(facts.activeRunIds).toEqual([]);
      expect(facts.run.id).toBe(RUN_ID);
      const taskBefore = await store.getTask(IDS.task13);
      const runsBefore = await store.listSegmentRuns(IDS.task13);
      const input = baseInput();
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('ok');
      const archived = await notificationOf(store, NID);
      expect(archived.resolvedBy).toBe('ops:checkout-history');
      expect(archived.resolvedAt).toBeDefined();
      expect(archived.body).toBe(alertBody());
      const [record, ...rest] = await auditsOf(store, NID);
      expect(rest).toEqual([]);
      expect(record).toMatchObject({
        action: 'notification.checkout_history_archive',
        via: 'ops',
        ok: true,
        actor: { kind: 'ops', id: 'ops:checkout-history' },
        after: { conclusion: 'historical_unproven', notificationBody: alertBody(), runOutcome: 'failed' },
      });
      expect(await store.getTask(IDS.task13)).toEqual(taskBefore);
      expect(await store.listSegmentRuns(IDS.task13)).toEqual(runsBefore);
      for (const id of [LEGACY_NID, OTHER_NID])
        expect((await notificationOf(store, id)).resolvedAt).toBeUndefined();
      const all = (await store.listAudit({ limit: 100 })).items;
      expect(all.some((a) => a.action.startsWith('cold_verify'))).toBe(false);
    });

    const wrongIdentity: [string, Partial<HistoricalCheckoutArchiveInput>][] = [
      ['错仓', { repo: 'other/repo' }],
      ['错单号', { issueNumber: 14 }],
      ['错任务', { taskId: IDS.task12 }],
      [
        '错工作流',
        { workflowId: 'task:example/canary#12', dedupeKey: 'cold-verify:checkout:task:example/canary#12' },
      ],
      ['无关 run（非 verify 段）', { runId: IDS.seg13manual2 }],
      ['不存在的 run', { runId: 'd1000000-0000-4000-8000-0000000130aa' }],
      ['错 Temporal run', { temporalRunId: 'temporal-other' }],
      ['错 head', { head: 'c'.repeat(40) }],
      ['错 PR 号', { pr: 40, runPrNumber: 40 }],
      [
        '老的无目标键',
        {
          notificationId: LEGACY_NID,
          dedupeKey: 'cold-verify:checkout-dir',
          notificationBody: alertBody(),
          notificationLink: null,
        },
      ],
      ['别的目标的通知', { notificationId: OTHER_NID }],
      ['错通知键', { dedupeKey: 'cold-verify:checkout:task:example/canary#12' }],
    ];
    for (const [label, over] of wrongIdentity) {
      it(`身份不符拒绝（${label}）：预检读不到，归档 conflict，什么都不写`, async () => {
        await expect(store.readHistoricalCheckout(baseInput(over))).rejects.toThrow();
        const input = baseInput(over);
        expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
        await untouched();
        await untouched(over.notificationId ?? NID);
      });
    }

    it('快照里的仓编号、正文、链接、run 起止/结局不符：conflict', async () => {
      for (const over of [
        { repoId: 'a0000000-0000-4000-8000-0000000000ff' },
        { notificationBody: '换过的正文' },
        { notificationLink: 'https://github.com/example/canary/pull/40' },
        { runStartedAt: '2026-10-19T02:00:00.000Z' },
        { runEndedAt: '2026-10-19T03:11:00.000Z' },
        { runOutcome: 'done' },
        { runPrNumber: 40 },
      ] as Partial<HistoricalCheckoutArchiveInput>[]) {
        const input = baseInput(over);
        expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
      }
      await untouched();
    });

    it('审计身份不对（别的动作/目标/操作者/失败态）不归档', async () => {
      const input = baseInput();
      const good = auditFor(input);
      for (const bad of [
        { ...good, action: 'notification.historical_audit' },
        { ...good, target: `notification:${OTHER_NID}` },
        { ...good, actor: { kind: 'ops' as const, id: 'ops:other' } },
        { ...good, via: 'cockpit' as const },
        { ...good, ok: false, error: 'x' },
      ]) {
        expect(await store.archiveHistoricalCheckout(input, bad)).toBe('conflict');
      }
      await untouched();
    });

    it('未知通知 not_found；非报警级别或标题/正文不像检出失败卡：不归档', async () => {
      const unknown = baseInput({ notificationId: 'f0000000-0000-4000-8000-0000000000aa' });
      expect(await store.archiveHistoricalCheckout(unknown, auditFor(unknown))).toBe('not_found');
      const variants: NotificationPatch[] = [
        { level: 'daily' },
        { title: '别的报警' },
        { body: alertBody('c'.repeat(40)) },
        { body: `目标 ${WF} 的 head ${HEAD}，目录 /x。` },
      ];
      for (const notification of variants) {
        const other = await make(data({ notification }));
        const input = baseInput({ notificationBody: notification.body ?? alertBody() });
        await expect(other.store.readHistoricalCheckout(input)).rejects.toThrow();
        expect(await other.store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
        expect((await notificationOf(other.store, NID)).resolvedAt).toBeUndefined();
      }
    });

    it('原 run 不是 verify 段 / 没有终态 / 不是同一 PR：拒绝', async () => {
      for (const run of [
        { segment: 'manual' },
        { endedAt: undefined, outcome: undefined },
        { prNumber: 38 },
        { workflowId: 'task:example/canary#13:r2' },
      ] as RunPatch[]) {
        const other = await make(data({ run }));
        await expect(other.store.readHistoricalCheckout(baseInput())).rejects.toThrow();
        const input = baseInput();
        expect(await other.store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
        expect((await notificationOf(other.store, NID)).resolvedAt).toBeUndefined();
      }
    });

    it('任务还有活执行（task_id 记了的 / 老兼容未记 task_id 的 / 重做代次的）：预检列出、归档 conflict', async () => {
      const input = baseInput();
      await h.addRun({ id: OPEN_RUN_ID, taskId: IDS.task13, workflowId: WF });
      expect((await store.readHistoricalCheckout(input)).activeRunIds).toEqual([OPEN_RUN_ID]);
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
      await untouched();

      for (const [id, workflowId] of [
        ['d1000000-0000-4000-8000-000000013097', WF],
        ['d1000000-0000-4000-8000-000000013096', `${WF}:r2`],
      ] as const) {
        const other = await make(data());
        await other.addRun({ id, workflowId });
        expect((await other.store.readHistoricalCheckout(input)).activeRunIds).toEqual([id]);
        expect(await other.store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
        expect((await notificationOf(other.store, NID)).resolvedAt).toBeUndefined();
      }
    });

    it('别的任务的活执行不挡；任务复活（不再是终态）则预检拒绝、归档 conflict', async () => {
      const input = baseInput();
      await h.addRun({ id: OPEN_RUN_ID, taskId: IDS.task12, workflowId: 'task:example/canary#12' });
      expect((await store.readHistoricalCheckout(input)).activeRunIds).toEqual([]);
      await h.setTaskState(IDS.task13, 'running');
      await expect(store.readHistoricalCheckout(input)).rejects.toThrow();
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
      await untouched();
      await h.setTaskState(IDS.task13, 'done');
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('ok');
    });

    it('预检后通知换代（同键重开、raisedAt 变了）：归档 conflict，新事故保持打开', async () => {
      const input = baseInput();
      await store.readHistoricalCheckout(input);
      const newer = '2026-10-19T04:00:00.000Z';
      await h.reopen(NID, newer);
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
      const n = await notificationOf(store, NID);
      expect(n.resolvedAt).toBeUndefined();
      expect(n.raisedAt).toBe(newer);
      expect(await auditsOf(store, NID)).toEqual([]);
    });

    it('已归档后同键重开新事故：旧请求重放 conflict，不撤新事故，不当成已落账', async () => {
      const input = baseInput();
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('ok');
      await h.reopen(NID, '2026-10-19T06:00:00.000Z');
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
      expect((await notificationOf(store, NID)).resolvedAt).toBeUndefined();
      expect(await auditsOf(store, NID)).toHaveLength(1);
    });

    it('幂等：同一完整已落账操作重放 already_archived；内容不同或不是我们撤的则 conflict', async () => {
      const input = baseInput();
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('ok');
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('already_archived');
      const changed = baseInput({ evidence: '换了一份证据' });
      expect(await store.archiveHistoricalCheckout(changed, auditFor(changed))).toBe('conflict');
      expect(await auditsOf(store, NID)).toHaveLength(1);

      // 通知已 resolved 但不是这条审计撤的（手工/通用 resolve）：不能凭「已处理」就假成功
      const manual = await make(
        data({ notification: { resolvedAt: '2026-10-19T04:30:00.000Z', resolvedBy: 'someone' } }),
      );
      expect(await manual.store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
      expect(await auditsOf(manual.store, NID)).toEqual([]);
      const spoof = await make(
        data({
          notification: { resolvedAt: '2026-10-19T04:30:00.000Z', resolvedBy: 'ops:checkout-history' },
        }),
      );
      expect(await spoof.store.archiveHistoricalCheckout(input, auditFor(input))).toBe('conflict');
    });

    it('并发：两个相同请求恰一个 ok、一个 already_archived，只一条审计', async () => {
      const input = baseInput();
      const results = await Promise.all([
        store.archiveHistoricalCheckout(input, auditFor(input)),
        store.archiveHistoricalCheckout(input, auditFor(input)),
      ]);
      expect([...results].sort()).toEqual(['already_archived', 'ok']);
      expect(await auditsOf(store, NID)).toHaveLength(1);
    });

    it('并发：内容不同的两个请求恰一个 ok、另一个 conflict，只一条审计', async () => {
      const a = baseInput({ reason: '甲' });
      const b = baseInput({ reason: '乙' });
      const results = await Promise.all([
        store.archiveHistoricalCheckout(a, auditFor(a)),
        store.archiveHistoricalCheckout(b, auditFor(b)),
      ]);
      expect([...results].sort()).toEqual(['conflict', 'ok']);
      expect(await auditsOf(store, NID)).toHaveLength(1);
    });

    it('并发：归档与新增活执行竞争，要么归档在前（活执行随后才来）要么 conflict，不出现「有活执行却已归档且当时可见」', async () => {
      const input = baseInput();
      const [result] = await Promise.all([
        store.archiveHistoricalCheckout(input, auditFor(input)),
        h.addRun({ id: OPEN_RUN_ID, workflowId: WF }),
      ]);
      const n = await notificationOf(store, NID);
      expect(result === 'ok' ? n.resolvedAt !== undefined : n.resolvedAt === undefined).toBe(true);
      expect(['ok', 'conflict']).toContain(result);
    });

    it('appendAudit 失败：整笔回滚，通知仍打开、没有审计；恢复后可正常归档', async () => {
      if (!h.failAuditWrites) return;
      const input = baseInput();
      const restore = await h.failAuditWrites();
      await expect(store.archiveHistoricalCheckout(input, auditFor(input))).rejects.toThrow();
      await untouched();
      await restore();
      expect(await store.archiveHistoricalCheckout(input, auditFor(input))).toBe('ok');
    });
  });
}
