// 拉单（jobs/intake.ts）的真装配（#632 S2-4b-3）：受管的仓和任务行从库里读，开着的单、现读一张单、读需求文档、留言都经「引擎」
// 机器人（@fleet-dao/github），作者白名单由 users 表拼（@fleet-dao/store，和后端收 webhook 同一份），起任务工作流和数在跑的
// 用这次活动自己的 Temporal 客户端。
//
// 改这里之前必须知道：
// - 起工作流的编号定死（taskWorkflowId），一律 REJECT_DUPLICATE（上一条跑完、停下的也不让同名再起）+ 冲突策略 FAIL：
//   同一张单任何时候最多一条。已经用过的回 already_exists，不报错。有一代在跑或已结束的不在这里重来（走重做）。
// - 任务行在起工作流之前建（按仓加单号唯一，同一事务写操作记录）：工作流第一步就往这一行写状态；起工作流失败了这一行留在
//   queued，下一轮问 Temporal 仍是没有任何一代，会再来一遍。queued / stopped 且没有任何一代的老行不另建：先改标题和原话、
//   叫停的改回排队，再起工作流。起成了才记「接手无工作流的老任务行」（这条计进每小时名额）。起不成把行放回去、不记。
//   不能等工作流起来再改：第一步会把行改成 running，那时再改会认成不是老行，标题和原话留在上一代，却仍记成接手成功。
// - 在跑的任务数查 Temporal 的可见性（WorkflowType 加 ExecutionStatus），读不到就让这一轮记没跑成：不拿 0 顶。
// - 白名单、成员名单每一轮读一次（拉单工厂每轮造一份新的），不跨轮缓存：停用一个人，下一轮就不再认他开的单。

import { randomUUID } from 'node:crypto';
import { LOCAL_LABEL } from '@fleet-dao/conventions';
import {
  type Db,
  finishScheduleRun,
  firstTaskCreatedSince,
  listIntakeRepos,
  readIntakeBreaker,
  recentEndedTasks,
  resolveAlertWithReason,
  startScheduleRun,
  TASK_ADOPT_AUDIT_ACTION,
  taskAdoptsSince,
  taskFailureCount,
  taskStateByIssue,
  tasksCreatedSince,
  upsertAlert,
  writeIntakeBreaker,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { actorFor, createPgStore, githubWhitelist, memberFor, type User } from '@fleet-dao/store';
import { type Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { WORKFLOW_TYPES } from '../contract.ts';
import { CANARY_ISSUE_TITLE_POSIX } from '../jobs/canary.ts';
import { normalizeCanarySlug } from '../jobs/canary-scope.ts';
import { ORPHAN_TASK_ADOPT_NOTE } from '../jobs/dispatch-standing.ts';
import { requestGroom } from '../jobs/groom-request.ts';
import { type IntakeDeps, prClaimedIssues } from '../jobs/intake.ts';
import { BREAKER_WINDOW } from '../jobs/intake-pick.ts';
import { generationLife, readTaskGenerations } from '../jobs/redo.ts';
import type { TaskWorkflowInput } from '../task-contract.ts';
import { groomRequestDeps } from './groom-request.ts';

/** 拉单要用到的这几下（不要整个 GitHub）。 */
export type IntakeGitHub = Pick<
  GitHub,
  'readGroomFacts' | 'readIssuePlan' | 'readSpecDoc' | 'commentIssue' | 'addIssueLabel'
> & { claims: Pick<GitHub['claims'], 'openPulls'> };

export interface IntakeWiring {
  db: Db;
  gh: IntakeGitHub;
  now?: () => Date;
  log?: IntakeDeps['log'];
  /** 起工作流最多等多久（毫秒）。 */
  startTimeoutMs?: number;
  /** 测试用：换掉「合并闸认冷验收了没有」（jobs/intake.ts 的 MERGE_GATE_REQUIRES_COLD_VERIFY）。 */
  gateLive?: boolean;
  /**
   * 别的环境的巡检仓（#1136）。读不到照抛，拉单这一轮记没跑成，不拿空名单顶。
   * 不给 = 没有别的环境（测试、还没接第二台）。
   */
  foreignCanaries?: () => Promise<readonly string[]>;
  /**
   * 这台引擎自己的巡检仓（FLEET_CANARY_REPO，owner/name）。
   * 给了：这个仓里标题是巡检单的任务行不计入每小时条数，拉单也认这个仓。不给 = 没有。
   */
  canaryRepo?: string | null;
}

/** 每小时条数里剔掉的巡检单。没配、认不出回 null（一条不剔，不当成某个仓）。 */
function hourlyExclude(raw: string | null | undefined): {
  owner: string;
  name: string;
  titlePosix: string;
} | null {
  const slug = normalizeCanarySlug(raw);
  if (!slug) return null;
  const slash = slug.indexOf('/');
  const owner = slug.slice(0, slash);
  const name = slug.slice(slash + 1);
  if (!owner || !name) return null;
  return { owner, name, titlePosix: CANARY_ISSUE_TITLE_POSIX };
}

const DEFAULT_START_TIMEOUT_MS = 15_000;
/** 熔断报警的编号和留痕的名字。 */
const BREAKER_ALERT_KEY = 'intake-breaker';
const BREAKER_ACTOR = 'engine:intake';

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
      ...(w.foreignCanaries ? { foreignCanaries: w.foreignCanaries } : {}),
      canaryRepo: w.canaryRepo ?? null,
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
            .map((m) => ({ number: m.number, title: m.title, description: m.description })),
        };
      },
      plan: (repo, issueNumber) =>
        w.gh.readIssuePlan({ repo: { owner: repo.owner, name: repo.name }, issueNumber }),
      async issueTask(repo, issueNumber) {
        return taskStateByIssue(w.db, repo.id, issueNumber);
      },
      async taskGenerations(repo, issueNumber) {
        const read = await readTaskGenerations(
          { owner: repo.owner, name: repo.name },
          issueNumber,
          async (workflowId) => {
            try {
              const described = await client.connection.withDeadline(Date.now() + startTimeoutMs, () =>
                client.workflow.getHandle(workflowId).describe(),
              );
              return { life: generationLife(described.status.name), record: null };
            } catch (err) {
              if (err instanceof WorkflowNotFoundError) return { life: 'missing' };
              return { life: 'unknown' };
            }
          },
        );
        if (!read.ok) return { ok: false, why: read.why };
        return { ok: true, lives: read.generations.map((g) => g.life) };
      },
      async openPrClaims(repo) {
        // openPulls 翻不完、读不到都抛：拉单这张单这一轮不拉，记没查成
        const pulls = await w.gh.claims.openPulls({ owner: repo.owner, name: repo.name });
        return prClaimedIssues(pulls);
      },
      async markLocal({ repo, issueNumber }) {
        await w.gh.addIssueLabel({
          repo: { owner: repo.owner, name: repo.name },
          issueNumber,
          label: LOCAL_LABEL,
        });
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
      failures: (repo, issueNumber) => taskFailureCount(w.db, repo.id, issueNumber),
      async startedSince(since) {
        // 老行的建出时刻不在这一小时里。接手成功才记 task.adopt，和新建的行加在一起，才是这一小时真正起了几条。
        const exclude = hourlyExclude(w.canaryRepo);
        const [created, adopted] = await Promise.all([
          tasksCreatedSince(w.db, since, exclude),
          taskAdoptsSince(w.db, since, exclude),
        ]);
        return created + adopted;
      },
      async breaker() {
        const row = await readIntakeBreaker(w.db);
        if (row?.state === 'open') {
          const trial = await firstTaskCreatedSince(w.db, row.at);
          const state = trial?.state;
          return {
            open: {
              since: row.at,
              trial:
                trial === null
                  ? null
                  : state === 'done'
                    ? 'done'
                    : state === 'failed' || state === 'stopped'
                      ? 'failed'
                      : 'running',
            },
            recent: [],
          };
        }
        return {
          open: null,
          recent: await recentEndedTasks(w.db, { limit: BREAKER_WINDOW, after: row?.at ?? null }),
        };
      },
      async breakerChanged({ event, at, why }) {
        if (event === 'recover') {
          await writeIntakeBreaker(w.db, { state: 'closed', at, by: BREAKER_ACTOR });
          await resolveAlertWithReason(w.db, { dedupeKey: BREAKER_ALERT_KEY, by: BREAKER_ACTOR, why, at });
          await upsertAlert(w.db, {
            dedupeKey: `${BREAKER_ALERT_KEY}:recovered:${at.toISOString()}`,
            level: 'daily',
            taskId: null,
            title: '引擎恢复拉单',
            body: why,
          });
          return;
        }
        await writeIntakeBreaker(w.db, { state: 'open', at, by: BREAKER_ACTOR });
        // 试探失败重新计冷却（retrip）不再推第二条：原来那条还开着
        if (event === 'trip') {
          await upsertAlert(w.db, {
            dedupeKey: BREAKER_ALERT_KEY,
            level: 'alert',
            taskId: null,
            title: '引擎停拉单：最近的任务失败过半',
            body: `${why}。看是哪几张单、为什么失败；试探成功会自动恢复。`,
          });
        }
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
        const orphan =
          !created.created && (created.task.state === 'queued' || created.task.state === 'stopped');
        // 先改行再起。工作流第一步会把状态写成 running，之后 prepare 会认成不是老行。
        let prepared: { title: string; rawRequest: string; state: 'queued' | 'stopped' } | null = null;
        if (orphan) {
          const ready = await store.prepareOrphanTask({
            taskId: created.task.id,
            title,
            rawRequest: body,
          });
          if (ready.status === 'not_found') {
            throw new Error(`任务 ${created.task.id} 要接手时却找不到这一行`);
          }
          if (ready.status === 'prepared') prepared = ready.before;
          else {
            log('warn', `拉单：${slug}#${issueNumber} 的任务行已经不是排队或叫停，不改标题，也不记接手成功`, {
              taskId: created.task.id,
            });
          }
        }
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
        } catch (error) {
          // 没起成：把改过的老行放回去，不记接手。下一轮还能再试，也不把这一次算进每小时名额。
          if (prepared) {
            const putBack = {
              taskId: created.task.id,
              title: prepared.title,
              rawRequest: prepared.rawRequest,
              state: prepared.state,
            };
            let restored: 'restored' | 'not_queued' | 'not_found';
            try {
              restored = await store.restoreOrphanTask(putBack);
            } catch (restoreErr) {
              throw new Error(
                `任务 ${created.task.id} 的工作流没起成（${errMessage(error)}），放回老行也没做成（${errMessage(restoreErr)}）`,
              );
            }
            if (restored === 'not_found') {
              throw new Error(
                `任务 ${created.task.id} 的工作流没起成（${errMessage(error)}），放回老行时却找不到这一行`,
              );
            }
            if (restored === 'not_queued') {
              log('warn', `拉单：${slug}#${issueNumber} 工作流没起成，老行已经不是排队，没有把标题放回去`, {
                taskId: created.task.id,
                error: errMessage(error),
              });
            }
          }
          if (error instanceof WorkflowExecutionAlreadyStartedError) return 'already_exists';
          throw error;
        }
        if (prepared) {
          // 行在起工作流之前已经改成当前这一代。这里只补操作记录；状态若已被第一步写成 running，也不再改回去。
          try {
            await store.appendAudit({
              actor: actorFor(member),
              action: TASK_ADOPT_AUDIT_ACTION,
              target: `task:${created.task.id}`,
              via: 'github',
              ok: true,
              reason: ORPHAN_TASK_ADOPT_NOTE,
              before: {
                state: prepared.state,
                title: prepared.title,
                rawRequest: prepared.rawRequest,
              },
              after: {
                state: 'queued',
                title,
                rawRequest: body,
                note: ORPHAN_TASK_ADOPT_NOTE,
              },
            });
          } catch (err) {
            throw new Error(
              `任务 ${created.task.id} 的工作流已经起了，接手的操作记录写不进（${errMessage(err)}）`,
            );
          }
        }
        return 'started';
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
      groomRequest: ({ repo, why }) =>
        requestGroom(groomRequestDeps(w.db, now), {
          repo: `${repo.owner}/${repo.name}`,
          source: 'auto',
          reason: `拉单一轮自己叫的：${why}`,
        }),
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      now,
      log,
    };
  };
}
