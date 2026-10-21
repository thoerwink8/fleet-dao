// fleet-api task correct-merged：已经结束、却被误记 abandoned 的真实已合任务，受管纠正运行账。
// 典型：单子在 PR 合并后、旧引擎来得及收尾前被关，工作流按 issue-closed 路径以 abandoned 收场（Temporal 已 COMPLETED），
// 任务行停在 stopped/abandoned。这时给工作流发信号没用，只能改库里的任务账。
//
// 边界（都是为了不把「单子关了」当成「做完了」）：
// - 预检只读：现读 GitHub PR（精确仓、PR 号、最终 head、真实合并提交、基线分支、PR 指向这张单）、Temporal 原 run（已 COMPLETED、
//   是这个编号最新的 run、结果就是 abandoned 且带的 PR/head 与请求一致）、库里任务账（stopped + abandoned、没有活 run、没换代、不是本机领的），
//   打印精确对象、拟改成什么，以及执行要带的 --task / --seen。
// - 执行：身份和事实全部重读一遍，--seen 摘要必须和现在一致（预检之后任务账、run 集合、GitHub/Temporal 证据变了就拒绝），
//   然后由 Store.correctMergedAbandoned 在一个事务里 CAS 改任务行并写操作记录（记录写不进，任务不动）。
// - 不改旧 run、不动 Temporal 历史、不重开或关闭 issue、不发信号、不起工人、不碰验收责任（任务虽转 done，未结验收照旧在账上）。
// - 同一请求重复是幂等（回「已纠正过」，不再写）；换 PR、head、合并提交、run 或证据的请求一律拒绝，不冒充成功。

import { createHash } from 'node:crypto';
import { type Task, taskWorkflowId } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import type { HistoricalAuditSource } from './historical-audit-cli.ts';
import {
  type IntakeRepo,
  judgeMergedCorrection,
  MERGED_CORRECTION_ACTION,
  type MergedCorrectionFacts,
  type MergedCorrectionInput,
  mergedCorrectionTarget,
  type Store,
  type WorkflowControl,
  WorkflowGoneError,
  WorkflowTargetNotFoundError,
  WorkflowUnavailableError,
} from './ports.ts';

/** cli.ts 的 operatorName 在没经 bin/fleet-api 直接跑 node 时给的后缀：没有可信的实际操作者，不许执行。 */
const UNTRUSTED_OPERATOR = '没经 bin/fleet-api';

export interface CorrectMergedRequest {
  repo: IntakeRepo;
  task: Task;
  pr: number;
  head: string;
  mergeCommit: string;
  /** 原 Temporal run 编号。 */
  run: string;
  execute: boolean;
  /** 执行必带：预检打印的任务编号和摘要。 */
  expectTask?: string | undefined;
  seen?: string | undefined;
  note: string;
  operator: string;
}

export interface CorrectMergedDeps {
  store: Pick<Store, 'readMergedCorrection' | 'correctMergedAbandoned'>;
  workflows: WorkflowControl;
  /** 只读 GET GitHub（和 historical-audit 同一份引擎安装凭据）；没接就拒绝。 */
  pulls: HistoricalAuditSource | undefined;
}

export type CorrectMergedOutcome = { ok: true; text: string } | { ok: false; result: string };

const Pull = z.object({
  number: z.number().int(),
  state: z.string(),
  merged: z.boolean(),
  html_url: z.string(),
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  merge_commit_sha: z.string().nullable(),
  merged_at: z.string().nullable(),
  merged_by: z.object({ login: z.string() }).nullable().optional(),
});

const WorkflowResult = z.object({
  outcome: z.string(),
  prNumber: z.number().nullable(),
  head: z.string().nullable(),
});

const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 预检打印、执行比对的摘要：任务账快照、run 集合和已核证据任一变化都会变。 */
function seenDigest(facts: MergedCorrectionFacts, evidenceKey: string): string {
  const { ledger, runs, task } = facts;
  return sha256({
    task: task.id,
    state: task.state,
    ...ledger,
    runIds: runs.map((r) => r.id).sort(),
    evidenceKey,
  }).slice(0, 16);
}

const mentionsIssue = (text: string, repoFull: string, issue: number): boolean =>
  new RegExp(`(^|[^\\w/])#${issue}(?!\\d)`).test(text) ||
  text.toLowerCase().includes(`github.com/${repoFull.toLowerCase()}/issues/${issue}`);

export async function correctMerged(
  req: CorrectMergedRequest,
  deps: CorrectMergedDeps,
): Promise<CorrectMergedOutcome> {
  const { repo, task, execute } = req;
  const repoFull = `${repo.owner}/${repo.name}`;
  const ref = `${repoFull}#${task.issueNumber}`;
  const workflowId = taskWorkflowId(repo, task.issueNumber);
  const fail = (result: string): CorrectMergedOutcome => ({ ok: false, result });

  if (execute) {
    if (!req.operator.trim() || req.operator.includes(UNTRUSTED_OPERATOR))
      return fail('没有可信的实际操作者（要经 bin/fleet-api 跑，带 FLEET_OPS_OPERATOR），不执行纠正');
    if (req.expectTask !== task.id)
      return fail(`--task 要写预检打印的任务编号 ${task.id}，现在给的是 ${req.expectTask ?? '没给'}`);
    if (!req.seen) return fail('执行要带预检打印的 --seen，不凭当前最新状态直接改');
  }
  if (!deps.pulls) return fail('这个入口没接上 GitHub 只读，不能核真实合并');
  const readClosed = deps.workflows.closedTaskWorkflow;
  if (!readClosed) return fail('这个入口没接上 Temporal 只读核原 run（控制缺 closedTaskWorkflow）');
  // 「最新一代」只能现查，不能回退成请求里的旧编号：没接上就拒绝，免得对陈旧代次执行
  const latestOf = deps.workflows.runningTaskWorkflow;
  if (!latestOf)
    return fail(
      '这个入口没接上最新一代工作流的查询（控制缺 runningTaskWorkflow），不能确认原 run 是最新一代',
    );

  // —— 1. GitHub：真实已合并的精确 PR ——
  let rawPull: unknown;
  try {
    rawPull = await deps.pulls.read(repoFull, `pulls/${req.pr}`);
  } catch (err) {
    return fail(`读 GitHub PR #${req.pr} 没成（结果未知，不当成已合并）：${errMessage(err)}`);
  }
  const parsed = Pull.safeParse(rawPull);
  if (!parsed.success) return fail(`GitHub 回的 PR #${req.pr} 形状认不出，不当成已合并`);
  const pull = parsed.data;
  if (pull.number !== req.pr) return fail(`GitHub 回的是 PR #${pull.number}，不是请求的 #${req.pr}`);
  if (pull.base.repo.full_name.toLowerCase() !== repoFull.toLowerCase())
    return fail(`PR #${req.pr} 属于 ${pull.base.repo.full_name}，不是 ${repoFull}`);
  if (!pull.merged || pull.state !== 'closed' || !pull.merged_at)
    return fail(
      `PR #${req.pr} 在 GitHub 上没有合并（state=${pull.state}，merged=${pull.merged}），单子关了不算做完`,
    );
  if (pull.head.sha !== req.head)
    return fail(`PR #${req.pr} 合的头是 ${pull.head.sha}，不是请求的 ${req.head}`);
  if (pull.merge_commit_sha !== req.mergeCommit)
    return fail(
      `PR #${req.pr} 的真实合并提交是 ${pull.merge_commit_sha ?? '读不到'}，不是请求的 ${req.mergeCommit}`,
    );
  if (pull.base.ref !== repo.defaultBranch)
    return fail(`PR #${req.pr} 合进的是 ${pull.base.ref}，不是默认分支 ${repo.defaultBranch}`);
  if (!mentionsIssue(`${pull.title ?? ''}\n${pull.body ?? ''}`, repoFull, task.issueNumber))
    return fail(`PR #${req.pr} 的标题和正文没有指向 ${ref}，不能认作这张单的交付`);

  // —— 2. Temporal：原 run 已结束、是最新的一代、结果就是误记的 abandoned ——
  let closure: Awaited<ReturnType<typeof readClosed>>;
  try {
    const latestId = await latestOf.call(
      deps.workflows,
      { owner: repo.owner, name: repo.name },
      task.issueNumber,
    );
    if (latestId !== workflowId)
      return fail(`这张单已经有更新的一代工作流 ${latestId}，原 ${workflowId} 不是最新，拒绝陈旧请求`);
    closure = await readClosed(workflowId, req.run);
  } catch (err) {
    if (err instanceof WorkflowGoneError || err instanceof WorkflowTargetNotFoundError)
      return fail(`原工作流 ${workflowId} 的 run ${req.run} 在 Temporal 里查不到`);
    if (err instanceof WorkflowUnavailableError) return fail('Temporal 暂时连不上，结果未知，没有纠正');
    return fail(`核原工作流 run 没成（结果未知）：${errMessage(err)}`);
  }
  if (closure.workflowId !== workflowId || closure.runId !== req.run)
    return fail('Temporal 回的工作流或 run 与请求不一致');
  if (closure.status !== 'COMPLETED')
    return fail(`原 run 的状态是 ${closure.status}，不是已 COMPLETED，不能纠正`);
  if (closure.latestRunId !== req.run)
    return fail(`${workflowId} 之后又起过新的 run ${closure.latestRunId}，请求的 run 不是最新，拒绝陈旧请求`);
  const result = WorkflowResult.safeParse(closure.result);
  if (!result.success) return fail('原 run 的返回值认不出，不能确认它当初记的是什么');
  if (result.data.outcome !== 'abandoned')
    return fail(`原 run 当初记的结果是 ${result.data.outcome}，不是 abandoned，用不着这条纠正`);
  if (result.data.prNumber !== req.pr || result.data.head !== req.head)
    return fail(
      `原 run 记的 PR/head 是 #${result.data.prNumber}/${result.data.head}，与请求的 #${req.pr}/${req.head} 不一致`,
    );

  // —— 3. 库：任务账 ——
  let facts: MergedCorrectionFacts | null;
  try {
    facts = await deps.store.readMergedCorrection({
      repoId: repo.id,
      taskId: task.id,
      issueNumber: task.issueNumber,
    });
  } catch (err) {
    return fail(`读任务账没成（结果未知）：${errMessage(err)}`);
  }
  if (!facts) return fail('库里读不到这张任务的任务账');

  const evidence = {
    repo: repoFull,
    issue: task.issueNumber,
    taskId: task.id,
    workflowId,
    run: req.run,
    pull: {
      number: pull.number,
      url: pull.html_url,
      head: pull.head.sha,
      mergeCommit: pull.merge_commit_sha,
      mergedAt: pull.merged_at,
      mergedBy: pull.merged_by?.login ?? null,
      baseRef: pull.base.ref,
      baseRepo: pull.base.repo.full_name,
      state: pull.state,
      // 认定「这个 PR 指向这张单」用的标题和正文：整体进摘要，审计留原文（正文只截前 4000 字，完整性靠 bodySha256）
      title: pull.title ?? null,
      bodySha256: sha256(pull.body ?? null),
      body: (pull.body ?? '').slice(0, 4000),
      linksIssue: true,
    },
    workflow: { status: closure.status, closeTime: closure.closeTime ?? null, result: result.data },
  };
  const evidenceKey = sha256(evidence);
  const seen = seenDigest(facts, evidenceKey);
  const doing = `PR #${req.pr} 已合并（${req.mergeCommit.slice(0, 7)}）；运行账经受管纠正，原记 abandoned，验收责任不受影响`;
  const input: MergedCorrectionInput = {
    repoId: repo.id,
    taskId: task.id,
    issueNumber: task.issueNumber,
    workflowId,
    temporalRunId: req.run,
    pr: req.pr,
    head: req.head,
    mergeCommit: req.mergeCommit,
    expected: {
      phase: facts.ledger.phase ?? '',
      doing: facts.ledger.doing,
      updatedAt: facts.ledger.updatedAt,
      runIds: facts.runs.map((r) => r.id),
    },
    doing,
    evidenceKey,
  };
  const verdict = judgeMergedCorrection(facts, input);
  if (verdict.result === 'not_found' || verdict.result === 'conflict') return fail(verdict.why);

  const summary =
    `${ref}（任务 ${task.id}）：工作流 ${workflowId} 的 run ${req.run} 已 COMPLETED，当初记 abandoned；` +
    `GitHub 上 PR #${req.pr} 已合并，头 ${req.head}，合并提交 ${req.mergeCommit}`;
  if (verdict.result === 'already_corrected')
    return {
      ok: true,
      text: `已纠正过（同一请求，幂等，没有再写）：${summary}；任务现为 ${facts.task.state}`,
    };

  if (!execute) {
    return {
      ok: true,
      text:
        `预检通过（只读，没改任何数据）：${summary}。拟把任务从 stopped/abandoned 改成 done，` +
        '保留原 abandoned 结论、原 run 和 Temporal 历史，不关 issue、不动验收责任。要执行：' +
        `fleet-api task correct-merged ${repoFull} ${task.issueNumber} --pr ${req.pr} --head ${req.head} ` +
        `--merge ${req.mergeCommit} --run ${req.run} --execute --task ${task.id} --seen ${seen} --note "<为什么>"`,
    };
  }

  if (req.seen !== seen)
    return fail('预检之后任务账、run 集合或 GitHub/Temporal 证据变了（--seen 对不上），请重新预检');

  const by = `服务器上 ${req.operator} 跑的 fleet-api task correct-merged ${ref}`;
  const done = await deps.store.correctMergedAbandoned(input, {
    actor: { kind: 'ops', id: 'ops:task' },
    action: MERGED_CORRECTION_ACTION,
    target: mergedCorrectionTarget(task.id),
    via: 'ops',
    ok: true,
    reason: `${req.note}（${by}）`,
    before: {
      state: facts.task.state,
      ...facts.ledger,
      runIds: input.expected.runIds,
      workflowId,
      temporalRunId: req.run,
      workflowResult: result.data,
    },
    after: {
      who: req.operator,
      issue: ref,
      note: req.note,
      taskId: task.id,
      pr: req.pr,
      head: req.head,
      mergeCommit: req.mergeCommit,
      temporalRunId: req.run,
      workflowId,
      evidenceKey,
      evidence,
      state: 'done',
      phase: 'done',
      doing,
    },
  });
  if (done.result === 'not_found' || done.result === 'conflict') return fail(`没纠正：${done.why}`);
  return {
    ok: true,
    text:
      done.result === 'already_corrected'
        ? `已纠正过（同一请求，幂等，没有再写）：${summary}`
        : `已纠正：${summary}；任务改为 done，原 abandoned 结论、原 run 和 Temporal 历史保留在操作记录里，issue 与验收责任没动`,
  };
}
