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
import { LOCAL_LABEL, type StandardPath } from '@fleet-dao/conventions';
import {
  type Db,
  expiredLocalClaims,
  extendLocalLease,
  finishScheduleRun,
  firstTaskCreatedSince,
  intakeWorkloadSince,
  listIntakeRepos,
  mergedPrForIssue,
  readIntakeBreaker,
  recentEndedTasks,
  recordIntakeStart,
  requesterForRequestIssue,
  resolveAlertWithReason,
  settleExpiredLocalClaim,
  startScheduleRun,
  TASK_ADOPT_AUDIT_ACTION,
  taskAdoptsSince,
  taskFailureCount,
  taskStateByIssue,
  tasksCreatedSince,
  unexpiredLocalClaims,
  upsertAlert,
  writeIntakeBreaker,
  writeIntakeWaiting,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import { parseRepoProfile } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { actorFor, createPgStore, githubWhitelist, memberFor, type User } from '@fleet-dao/store';
import { type Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { WORKFLOW_TYPES } from '../contract.ts';
import { ORPHAN_TASK_ADOPT_NOTE } from '../jobs/dispatch-standing.ts';
import { requestGroom } from '../jobs/groom-request.ts';
import { type IntakeDeps, type IntakeRepo, prClaimedIssues } from '../jobs/intake.ts';
import { BREAKER_WINDOW } from '../jobs/intake-pick.ts';
import { liveLocalIssues } from '../jobs/local-leases.ts';
import { generationLife, readTaskGenerations } from '../jobs/redo.ts';
import { standardPathsList } from '../standard-paths-list.ts';
import type { TaskWorkflowInput } from '../task-contract.ts';
import { groomRequestDeps } from './groom-request.ts';

/** 拉单要用到的这几下（不要整个 GitHub）。 */
export type IntakeGitHub = Pick<
  GitHub,
  | 'readGroomFacts'
  | 'readIssuePlan'
  | 'readIssueStates'
  | 'readSpecDoc'
  | 'commentIssue'
  | 'addIssueLabel'
  | 'removeIssueLabel'
  | 'readRepoFile'
> & { claims: Pick<GitHub['claims'], 'openPulls'> };

/** 读这个仓档案里那份改标准清单。文件不在＝空清单；认不出、读不出内容照抛。 */
export async function readRepoStandardPaths(
  gh: Pick<GitHub, 'readRepoFile'>,
  repo: Pick<IntakeRepo, 'owner' | 'name' | 'profile'>,
): Promise<StandardPath[]> {
  const path = parseRepoProfile(repo.profile).standardPathsFile;
  const read = await gh.readRepoFile({ repo: { owner: repo.owner, name: repo.name }, path });
  if (read.file.kind === 'not_file') throw new Error(`读 ${path} 没成（${read.file.why}）`);
  return standardPathsList(read.file.kind === 'text' ? read.file.text : null);
}

/**
 * 开着接活的仓因档案没就绪不拉单（#2839）：why 是原因时推报警（同键原地更新），why 是 null（齐了）时撤掉。
 * 没有这条、已撤的，resolveAlertWithReason 回 not_found / already_resolved，不算错。
 */
export async function reportIntakeProfile(
  db: Db,
  repo: { owner: string; name: string },
  why: string | null,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const dedupeKey = `intake-profile:${slug}`;
  if (why === null) {
    await resolveAlertWithReason(db, { dedupeKey, by: 'engine', why: '仓档案齐了，拉单照常' });
    return;
  }
  await upsertAlert(db, {
    dedupeKey,
    level: 'alert',
    taskId: null,
    title: `${slug} 仓档案没就绪，拉单不拉这个仓`,
    body: `${why}\n\n补法：在法国跑 fleet-api project show ${slug} 看现状；把原有项和缺的项写成一整份 JSON，用 fleet-api project set-profile ${slug} --file - 写回（整份换掉，原有项要一起带上）。`,
  });
}

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
          weight: r.weight,
          autoDispatchSince: r.autoDispatchSince ? r.autoDispatchSince.toISOString() : null,
          profile: r.profile,
        }));
      },
      standardPaths: (repo) => readRepoStandardPaths(w.gh, repo),
      recordWaiting: ({ at, byRepo }) => writeIntakeWaiting(w.db, { at, byRepo, by: BREAKER_ACTOR }),
      profileAlert: ({ repo, why }) => reportIntakeProfile(w.db, repo, why),
      // 本机领单的租约（决定 0096）：到期的行、心跳（本机会话推来的 node_sessions）、PR 镜像都从库里读，摘标签用「引擎」机器人
      localLeases: {
        expired: (repo, at) => expiredLocalClaims(w.db, repo.id, at),
        unexpired: (repo, at) => unexpiredLocalClaims(w.db, repo.id, at),
        async liveIssues(repo, at) {
          return liveLocalIssues(await store.listNodeSessions(), `${repo.owner}/${repo.name}`, at);
        },
        mergedPr: (repo, issueNumber) => mergedPrForIssue(w.db, repo.id, issueNumber),
        async extend(taskId, until) {
          await extendLocalLease(w.db, taskId, until);
        },
        settle: (input) => settleExpiredLocalClaim(w.db, input),
        async unmarkLocal({ repo, issueNumber }) {
          await w.gh.removeIssueLabel({
            repo: { owner: repo.owner, name: repo.name },
            issueNumber,
            label: LOCAL_LABEL,
          });
        },
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
      // 前置单（正文「前置：」里写的）开没开着：一批一次问，读不到、有号查不到都抛，拉单按「等前置」算
      prerequisiteStates: (repo, numbers) =>
        w.gh.readIssueStates({ repo: { owner: repo.owner, name: repo.name }, numbers }),
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
        // 没结束的任务工作流里，任务行是 stalled 的（停下等人）不占名额（#1776）。行读不到照抛；没有行、仓不认识的算在干活。
        const repoIds = new Map((await listIntakeRepos(w.db)).map((r) => [`${r.owner}/${r.name}`, r.id]));
        let working = 0;
        let stalled = 0;
        for await (const wf of client.workflow.list({
          query: `WorkflowType = '${WORKFLOW_TYPES.task}' AND ExecutionStatus = 'Running'`,
        })) {
          const m = /^task:([^/]+\/[^#]+)#(\d+)(?::r\d+)?$/.exec(wf.workflowId);
          const repoId = m?.[1] === undefined ? undefined : repoIds.get(m[1]);
          if (m?.[2] === undefined || repoId === undefined) {
            working += 1;
            continue;
          }
          const row = await taskStateByIssue(w.db, repoId, Number(m[2]));
          if (row?.state === 'stalled') stalled += 1;
          else working += 1;
        }
        return { working, stalled };
      },
      failures: (repo, issueNumber) => taskFailureCount(w.db, repo.id, issueNumber),
      async startedSince(since) {
        // 老行的建出时刻不在这一小时里。接手成功才记 task.adopt，和新建的行加在一起，才是这一小时真正起了几条。
        const [created, adopted] = await Promise.all([
          tasksCreatedSince(w.db, since),
          taskAdoptsSince(w.db, since),
        ]);
        return created + adopted;
      },
      repoWorkload: (since) => intakeWorkloadSince(w.db, since),
      async breaker(repo) {
        const row = await readIntakeBreaker(w.db, repo.id);
        if (row?.state === 'open') {
          const trial = await firstTaskCreatedSince(w.db, row.at, repo.id);
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
          recent: await recentEndedTasks(w.db, {
            limit: BREAKER_WINDOW,
            after: row?.at ?? null,
            repoId: repo.id,
          }),
        };
      },
      async breakerChanged({ repo, event, at, why }) {
        if (event === 'recover') {
          const alertKey = `${BREAKER_ALERT_KEY}:${repo.id}`;
          await writeIntakeBreaker(w.db, { state: 'closed', at, by: BREAKER_ACTOR }, repo.id);
          await resolveAlertWithReason(w.db, { dedupeKey: alertKey, by: BREAKER_ACTOR, why, at });
          await upsertAlert(w.db, {
            dedupeKey: `${alertKey}:recovered:${at.toISOString()}`,
            level: 'daily',
            taskId: null,
            title: '引擎恢复拉单',
            body: why,
          });
          return;
        }
        await writeIntakeBreaker(w.db, { state: 'open', at, by: BREAKER_ACTOR }, repo.id);
        // 试探失败重新计冷却（retrip）不再推第二条：原来那条还开着
        if (event === 'trip') {
          await upsertAlert(w.db, {
            dedupeKey: `${BREAKER_ALERT_KEY}:${repo.id}`,
            level: 'alert',
            taskId: null,
            title: '引擎停拉单：最近的任务失败过半',
            body: `${why}。看是哪几张单、为什么失败；试探成功会自动恢复。`,
          });
        }
      },
      async start({ repo, issueNumber, title, body, author, tier }) {
        const member = memberFor(await usersOnce(), author);
        // 驾驶舱「提需求」开的单是「引擎」机器人开的，GitHub 上的作者认不出是谁（母单 #2047 第 B 片）：
        // 提出人以开单那一刻写进库的 requested_by 为准（按正文末尾「来自驾驶舱 需求 N」找）。只认自家机器人开的单。
        const requester =
          member?.role === 'bot'
            ? await requesterForRequestIssue(w.db, { repoId: repo.id, issueNumber, body })
            : null;
        const id = randomUUID();
        const slug = `${repo.owner}/${repo.name}`;
        const created = await store.createTaskFromIssue(
          {
            id,
            repoId: repo.id,
            issueNumber,
            title,
            rawRequest: body,
            requestedBy: requester?.requestedBy ?? member?.id ?? author?.login ?? 'github',
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
        if (tier !== undefined) {
          await recordIntakeStart(w.db, { repoId: repo.id, at: now(), tier, by: BREAKER_ACTOR });
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
