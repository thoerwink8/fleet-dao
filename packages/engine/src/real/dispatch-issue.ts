// 点名派单（jobs/dispatch-issue.ts，#1337）的真装配：库、GitHub、Temporal 都和拉单（real/intake.ts）用同一套，这里只把
// 拉单已经接好的几样（白名单、现读一张单、读需求文档、PR 挂单表、建任务行加起工作流）原样转过来，再补三样拉单没有的：
// 受管的仓按名字找、引擎总开关那一行、一张单以前的任务工作流失败了几条（顺着代数问 Temporal）。
//
// 改这里之前必须知道：
// - 起工作流还是 real/intake.ts 的 start（先建任务行，再用定死的编号起，REJECT_DUPLICATE）：已派过的不会重复派。
// - 失败几条：顺着第 1、2、3… 代问 Temporal，第一个不存在就停；已经结束又不是 COMPLETED 的算一次失败；
//   在跑的、问不清的（连不上、认不出状态）抛错，不当成 0。
// - 操作记录经 Store.appendAudit 写，记成「引擎」那一类，reason 写明谁（FLEET_OPS_OPERATOR）跑的哪条命令。

import { type Db, readEngineMasterRow } from '@fleet-dao/db';
import { MAX_TASK_GENERATION } from '@fleet-dao/shared/task-redo';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { createPgStore } from '@fleet-dao/store';
import { type Client, WorkflowNotFoundError } from '@temporalio/client';
import type { DispatchIssueDeps } from '../jobs/dispatch-issue.ts';
import { DISPATCH_ISSUE_AUDIT } from '../jobs/dispatch-issue.ts';
import type { IntakeRepo } from '../jobs/intake.ts';
import { type IntakeGitHub, intakeJob } from './intake.ts';

export interface DispatchIssueWiring {
  db: Db;
  gh: IntakeGitHub;
  client: Client;
  taskQueue: string;
  /** 谁跑的（FLEET_OPS_OPERATOR）；写进操作记录。 */
  operator: string;
  now?: () => Date;
}

/** 这些状态是「已经结束、而且不是做成的」。 */
const FAILED_STATUSES: ReadonlySet<string> = new Set([
  'FAILED',
  'TERMINATED',
  'TIMED_OUT',
  'CANCELED',
  'CANCELLED',
]);
const OK_STATUSES: ReadonlySet<string> = new Set(['COMPLETED']);

export function dispatchIssueDeps(w: DispatchIssueWiring): DispatchIssueDeps {
  const now = w.now ?? (() => new Date());
  const intake = intakeJob({ db: w.db, gh: w.gh, now })(w.client, w.taskQueue);
  const store = createPgStore(w.db, { now });
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  return {
    async findRepo(owner, name) {
      const all = await intake.repos();
      return all.find((r) => same(r.owner, owner) && same(r.name, name)) ?? null;
    },
    engineMasterRow: () => readEngineMasterRow(w.db),
    whitelist: () => intake.whitelist(),
    plan: (repo, issueNumber) => intake.plan(repo, issueNumber),
    async listIssue(repo, issueNumber) {
      const listed = await intake.openIssues(repo);
      return listed.issues.find((i) => i.number === issueNumber) ?? null;
    },
    dispatched: (repo, issueNumber) => intake.dispatched(repo, issueNumber),
    openPrClaims: (repo) => intake.openPrClaims(repo),
    readSpecDoc: (input) => intake.readSpecDoc(input),
    failedAttempts: (repo, issueNumber) => failedGenerations(w.client, repo, issueNumber),
    start: (input) => intake.start(input),
    async audit(entry) {
      const by = `服务器上 ${w.operator} 跑的 fleet-api dispatch-issue ${entry.repo} ${entry.issueNumber}`;
      await store.appendAudit({
        actor: { kind: 'engine', id: 'ops:dispatch-issue' },
        action: DISPATCH_ISSUE_AUDIT,
        target: `issue:${entry.repo}#${entry.issueNumber}`,
        after: {
          force: entry.force,
          ...(entry.note === undefined ? {} : { note: entry.note }),
          forced: entry.forced,
          result: entry.result,
        },
        reason: entry.note === undefined ? by : `${entry.note}（${by}）`,
        via: 'engine',
        ok: entry.ok,
        ...(entry.ok ? {} : { error: entry.result }),
      });
    },
  };
}

/** 这张单以前各代任务工作流里失败收场的有几条（顺着代数问，第一个不存在就停）。问不清照抛。 */
export async function failedGenerations(
  client: Pick<Client, 'workflow'>,
  repo: Pick<IntakeRepo, 'owner' | 'name'>,
  issueNumber: number,
): Promise<number> {
  let failed = 0;
  for (let generation = 1; generation <= MAX_TASK_GENERATION; generation++) {
    const id = taskWorkflowId(repo, issueNumber, generation);
    let status: string;
    try {
      status = (await client.workflow.getHandle(id).describe()).status.name;
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return failed;
      throw err;
    }
    if (FAILED_STATUSES.has(status)) failed += 1;
    else if (!OK_STATUSES.has(status) && status !== 'RUNNING' && status !== 'CONTINUED_AS_NEW') {
      throw new Error(`${id} 的状态 ${status} 认不出：数不清失败了几次，没查成`);
    }
  }
  return failed;
}
