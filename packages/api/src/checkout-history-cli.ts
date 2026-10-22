import { checkoutSourceProblem, type Store } from '@fleet-dao/store';
import { z } from 'zod';
import type { CheckoutExecutionReader } from './checkout-execution-reader.ts';

export const CHECKOUT_HISTORY_USAGE =
  '用法：fleet-api checkout-history [--archive]（标准输入读 JSON；默认只读预检，--archive 才按完整快照撤旧 checkout 卡，并明确记 historical_unproven）';

const Text = z.string().trim().min(1).max(8000);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Identity = z
  .object({
    notificationId: z.string().uuid(),
    dedupeKey: Text,
    repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    taskId: z.string().uuid(),
    issueNumber: z.number().int().positive(),
    workflowId: Text,
    runId: z.string().uuid(),
    // 旧 run 的 temporal_run_id 可以为空串（#3067）；非空时必须与 run 行一致。
    temporalRunId: z.string().trim().max(8000),
    executionRunId: z.string().uuid(),
    pr: z.number().int().positive(),
    head: Sha,
  })
  .strict();

const Archive = Identity.extend({
  raisedAt: z.string().datetime(),
  notificationBody: Text,
  notificationLink: z.string().max(2000).nullable(),
  repoId: z.string().uuid(),
  runSegment: Text,
  runStartedAt: z.string().datetime(),
  runEndedAt: z.string().datetime(),
  runOutcome: Text,
  runPrNumber: z.number().int().positive(),
  operator: Text,
  reason: Text,
  evidence: Text,
  gaps: Text,
  responsibility: Text,
  conclusion: z.literal('historical_unproven'),
}).strict();

export function parseCheckoutHistoryArgs(argv: readonly string[]): { archive: boolean } {
  if (argv.length === 0) return { archive: false };
  if (argv.length === 1 && argv[0] === '--archive') return { archive: true };
  throw new Error(CHECKOUT_HISTORY_USAGE);
}

export function parseCheckoutHistoryInput(text: string, archive: boolean) {
  const value: unknown = JSON.parse(text);
  return (archive ? Archive : z.union([Identity, Archive])).parse(value);
}

export async function runCheckoutHistory(input: {
  store: Pick<Store, 'readHistoricalCheckoutCandidate' | 'archiveHistoricalCheckout'>;
  reader: CheckoutExecutionReader;
  body: string;
  archive: boolean;
  operator: string;
}) {
  if (!input.operator.trim()) throw new Error('缺少实际 ops 操作者');
  const value = parseCheckoutHistoryInput(input.body, input.archive);
  const facts = await input.store.readHistoricalCheckoutCandidate(value);
  const observed = await input.reader.read({
    taskId: value.taskId,
    repo: value.repo,
    issueNumber: value.issueNumber,
    workflowId: value.workflowId,
    temporalRunId: value.executionRunId,
    prNumber: value.pr,
    head: value.head,
    runId: facts.run.id,
    runStartedAt: facts.run.startedAt,
    runEndedAt: facts.run.endedAt!,
  });
  if (observed.kind !== 'observed') throw new Error('可信 checkout 活动来源未核实：' + observed.code);
  const source = observed.proof;
  const problem = checkoutSourceProblem(value, facts, source);
  if (problem) throw new Error(problem);
  const current = await input.store.readHistoricalCheckoutCandidate(value);
  const snapshot = (f: typeof facts) =>
    JSON.stringify({
      notification: {
        body: f.notification.body,
        title: f.notification.title,
        raisedAt: f.notification.raisedAt,
        link: f.notification.link,
      },
      repo: f.repo.id,
      task: { id: f.task.id, state: f.task.state },
      run: f.run,
      pr: f.pullRequest,
      activeRunIds: f.activeRunIds,
    });
  if (snapshot(facts) !== snapshot(current)) throw new Error('读取可信来源期间候选事实已变化，请重新预检');
  if (!input.archive) {
    return {
      ok: true,
      mode: 'preflight',
      conclusion: 'historical_unproven',
      activeRunIds: facts.activeRunIds,
      facts,
      checkoutSource: source,
      message: facts.activeRunIds.length
        ? '只读预检：仍有执行中的 run，不能归档；历史检出恢复未证实'
        : '只读预检通过；原 execution 活动已绑定此 run 和精确 head，不证明历史检出恢复，未写任何数据',
    };
  }
  const archive = Archive.parse(value);
  if (archive.operator !== input.operator) throw new Error('输入 operator 与当前实际操作者不一致');
  if (facts.activeRunIds.length) throw new Error('仍有执行中的 run，不能归档');
  const result = await input.store.archiveHistoricalCheckout(
    archive,
    {
      actor: { kind: 'ops', id: 'ops:checkout-history' },
      action: 'notification.checkout_history_archive',
      target: `notification:${archive.notificationId}`,
      via: 'ops',
      ok: true,
      reason: archive.reason,
      before: {
        notificationId: archive.notificationId,
        dedupeKey: archive.dedupeKey,
        raisedAt: archive.raisedAt,
        repo: archive.repo,
        taskId: archive.taskId,
        workflowId: archive.workflowId,
        runId: archive.runId,
        temporalRunId: archive.temporalRunId,
        executionRunId: archive.executionRunId,
        pr: archive.pr,
        head: archive.head,
      },
      after: {
        ...archive,
        checkoutSource: source,
        originalTitle: facts.notification.title,
        runFailureReason: facts.run.failureReason ?? null,
        operator: input.operator,
        conclusion: 'historical_unproven',
      },
    },
    source,
  );
  if (result !== 'ok' && result !== 'already_archived') throw new Error(`历史 checkout 未归档：${result}`);
  return {
    ok: true,
    mode: 'archive',
    result,
    conclusion: 'historical_unproven',
    message: '已归档旧 checkout 通知；这不是恢复证明，未改变任务、run、PR 或验收责任',
  };
}
