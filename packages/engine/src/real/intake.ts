// 拉单（jobs/intake.ts）的真装配（#632 S2-4b-3）：受管的仓和任务行从库里读，开着的单、现读一张单、读需求文档、留言都经「引擎」
// 机器人（@fleet-dao/github），作者白名单由 users 表拼（@fleet-dao/store，和后端收 webhook 同一份），起任务工作流和数在跑的
// 用这次活动自己的 Temporal 客户端。
//
// 改这里之前必须知道：
// - 起工作流的编号定死（taskWorkflowId），一律 REJECT_DUPLICATE（上一条跑完、停下的也不让同名再起）+ 冲突策略 FAIL：
//   同一张单任何时候最多一条，重开的单不会自己重来。已经用过的回 already_exists，不报错。
// - 任务行在起工作流之前建（按仓加单号唯一，同一事务写操作记录）：工作流第一步就往这一行写状态；起工作流失败了这一行留在
//   queued，下一轮 dispatched 仍说「没派过」，会再来一遍。
// - 在跑的任务数查 Temporal 的可见性（WorkflowType 加 ExecutionStatus），读不到就让这一轮记没跑成：不拿 0 顶。
// - 白名单、成员名单每一轮读一次（拉单工厂每轮造一份新的），不跨轮缓存：停用一个人，下一轮就不再认他开的单。

import { randomUUID } from 'node:crypto';
import {
  type Db,
  finishScheduleRun,
  listIntakeRepos,
  startScheduleRun,
  taskStateByIssue,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { actorFor, createPgStore, githubWhitelist, memberFor, type User } from '@fleet-dao/store';
import { type Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { WORKFLOW_TYPES } from '../contract.ts';
import type { IntakeDeps } from '../jobs/intake.ts';
import type { TaskWorkflowInput } from '../task-contract.ts';

/** 拉单要用到的这几下（不要整个 GitHub）。 */
export type IntakeGitHub = Pick<GitHub, 'readGroomFacts' | 'readIssuePlan' | 'readSpecDoc' | 'commentIssue'>;

export interface IntakeWiring {
  db: Db;
  gh: IntakeGitHub;
  now?: () => Date;
  log?: IntakeDeps['log'];
  /** 起工作流最多等多久（毫秒）。 */
  startTimeoutMs?: number;
  /** 测试用：换掉「合并闸认冷验收了没有」（jobs/intake.ts 的 MERGE_GATE_REQUIRES_COLD_VERIFY）。 */
  gateLive?: boolean;
}

const DEFAULT_START_TIMEOUT_MS = 15_000;

/** 给 EngineJobs.intake 用的工厂。 */
export function intakeJob(w: IntakeWiring): (client: Client, taskQueue: string) => IntakeDeps {
  const now = w.now ?? (() => new Date());
  const log: IntakeDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const store = createPgStore(w.db, { now });
  const startTimeoutMs = w.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  return (client, taskQueue) => {
    // 成员名单这一轮读一次（白名单、建任务行的「谁要的」都用它）
    let users: Promise<User[]> | undefined;
    const usersOnce = () => {
      users ??= store.listUsers();
      return users;
    };
    return {
      async repos() {
        return (await listIntakeRepos(w.db)).map((r) => ({
          id: r.id,
          owner: r.owner,
          name: r.name,
          defaultBranch: r.defaultBranch,
          testCommand: r.testCommand,
          autoDispatchSince: r.autoDispatchSince ? r.autoDispatchSince.toISOString() : null,
        }));
      },
      async whitelist() {
        return githubWhitelist(await usersOnce());
      },
      async openIssues(repo) {
        const facts = await w.gh.readGroomFacts({ repo: { owner: repo.owner, name: repo.name } });
        return {
          issues: facts.issues.map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body,
            // 账号删了、编号或类型读不到：认不出的人不在白名单里
            author:
              i.author !== null && i.authorId !== null && i.authorType !== null
                ? { login: i.author, id: i.authorId, type: i.authorType }
                : null,
            createdAt: i.createdAt,
            labels: i.labels,
            milestone: i.milestone,
          })),
          openMilestones: facts.milestones
            .filter((m) => m.state === 'open')
            .map((m) => ({ number: m.number, title: m.title })),
        };
      },
      plan: (repo, issueNumber) =>
        w.gh.readIssuePlan({ repo: { owner: repo.owner, name: repo.name }, issueNumber }),
      async dispatched(repo, issueNumber) {
        const task = await taskStateByIssue(w.db, repo.id, issueNumber);
        return task !== null && task.state !== 'queued';
      },
      async readSpecDoc({ repo, path }) {
        const doc = await w.gh.readSpecDoc({ repo: { owner: repo.owner, name: repo.name }, path });
        return doc ? { content: doc.content } : null;
      },
      async runningTasks() {
        let n = 0;
        for await (const _ of client.workflow.list({
          query: `WorkflowType = '${WORKFLOW_TYPES.task}' AND ExecutionStatus = 'Running'`,
        })) {
          n += 1;
        }
        return n;
      },
      async start({ repo, issueNumber, title, body, author }) {
        const member = memberFor(await usersOnce(), author);
        const id = randomUUID();
        const slug = `${repo.owner}/${repo.name}`;
        const created = await store.createTaskFromIssue(
          {
            id,
            repoId: repo.id,
            issueNumber,
            title,
            rawRequest: body,
            requestedBy: member?.id ?? author?.login ?? 'github',
          },
          {
            actor: actorFor(member),
            action: 'task.create',
            target: `task:${id}`,
            via: 'github',
            ok: true,
            after: { repo: slug, issueNumber, title, by: 'engine:intake' },
          },
        );
        const input: TaskWorkflowInput = {
          schemaVersion: 1,
          taskId: created.task.id,
          repo: {
            id: repo.id,
            owner: repo.owner,
            name: repo.name,
            defaultBranch: repo.defaultBranch,
            testCommand: repo.testCommand,
          },
          issueNumber,
          title,
        };
        try {
          await client.connection.withDeadline(Date.now() + startTimeoutMs, () =>
            client.workflow.start(WORKFLOW_TYPES.task, {
              taskQueue,
              workflowId: taskWorkflowId(repo, issueNumber),
              args: [input],
              workflowIdConflictPolicy: 'FAIL',
              workflowIdReusePolicy: 'REJECT_DUPLICATE',
            }),
          );
          return 'started';
        } catch (error) {
          if (error instanceof WorkflowExecutionAlreadyStartedError) return 'already_exists';
          throw error;
        }
      },
      async comment({ repo, issueNumber, key, body }) {
        const posted = await w.gh.commentIssue({
          repo: { owner: repo.owner, name: repo.name },
          issueNumber,
          key,
          body,
        });
        return { created: posted.created };
      },
      ...(w.gateLive === undefined ? {} : { gateLive: w.gateLive }),
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      now,
      log,
    };
  };
}
