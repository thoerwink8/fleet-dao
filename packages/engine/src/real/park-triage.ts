// 法国指挥官会话（jobs/park-triage.ts，#3294 第 2 片）的真装配。
//
// 改这里之前必须知道：
// - 会话怎么起：和整理待办同一段（real/read-only-session.ts）——选路按用途 commander（路由页「指挥官」一栏，创始人在那里指派模型；
//   默认 grok-4.7 → sonnet-5.5 → opus-5.5）、主线的只读检出、不带 GitHub 令牌。会话只交裁决，所有动手都在这里的引擎代码里：
//   继续 / 放弃是发 Temporal 信号，重做走 shared 的 redoTask（和驾驶舱、命令行的「重做」同一份判断），拆单只有「开子单」一种 GitHub 写操作。
// - 开关是设置 engine.commander（驾驶舱设置页能关）：没设过算开；值认不出按关并说明，不当成开。
// - 操作记录经 recordEngineAudit 写，actor 是 engine:commander、target 是 commander；「认领」和「执行」各一条（jobs/park-triage.ts 看认领判是否处理过）。
// - 提醒（诊断文字）经 upsertAlert 推：执行了的是 daily，留给人 / 没成的是 alert。
import {
  COMMANDER_AUDIT_TARGET,
  commanderAuditRows,
  countPurposeModels,
  finishScheduleRun,
  listIntakeRepos,
  listStalledEngineTasks,
  readParkAlertBody,
  readSettingValue,
  readTaskRoundsForSpin,
  readTaskTitle,
  recordEngineAudit,
  resolveAlertWithReason,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import { TASK_WORKFLOW_TYPE } from '@fleet-dao/shared';
import { generationLife, readTaskGenerations, redoCanStop, redoTask } from '@fleet-dao/shared/task-redo';
import { errMessage } from '@fleet-dao/shared/util';
import { type Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { COMMANDER_ACTOR } from '../commander-contract.ts';
import { COMMANDER_AUDIT_ACT, COMMANDER_AUDIT_CLAIM, type ParkTriageDeps } from '../jobs/park-triage.ts';
import { taskAbandonSignal, taskContinueSignal, taskStatusQuery } from '../task-contract.ts';
import { type GroomWiring, toRepo } from './groom.ts';
import { mapped } from './mirror.ts';
import { readOnlySessionRunner } from './read-only-session.ts';
import { isWorkflowGone } from './route-wake.ts';

/** 设置里的开关键（和驾驶舱 SETTING_SCHEMAS 同一个字符串）。 */
export const COMMANDER_SETTING = 'engine.commander';

const SIGNAL_TIMEOUT_MS = 5_000;
/** 重做前叫停停着的上一代：等它收尾终止最多多久。 */
const ABANDON_WAIT_MS = 60_000;

export interface ParkTriageWiring extends GroomWiring {
  temporal: { use<T>(fn: (client: Pick<Client, 'workflow' | 'connection'>) => Promise<T>): Promise<T> };
  taskQueue: string;
}

export function parkTriageJob(w: ParkTriageWiring): () => ParkTriageDeps {
  const now = w.now ?? (() => new Date());
  const log: ParkTriageDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const runSession = readOnlySessionRunner({ ...w, log }, { stage: 'commander', word: '指挥官' });
  const withDeadline = <T>(fn: (client: Pick<Client, 'workflow' | 'connection'>) => Promise<T>) =>
    w.temporal.use((client) =>
      client.connection.withDeadline(Date.now() + SIGNAL_TIMEOUT_MS, () => fn(client)),
    );
  const findRepo: ParkTriageDeps['findRepo'] = async (owner, name) => {
    const hit = (await listIntakeRepos(w.db)).find(
      (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
    );
    return hit ? toRepo(hit) : null;
  };

  const redo: ParkTriageDeps['redoTask'] = async (row, workflowId) => {
    const repo = await findRepo(row.owner, row.name);
    const title = await readTaskTitle(w.db, row.taskId);
    if (!repo || title === null) return { ok: false, why: `读不到仓或任务标题，没有重做（${workflowId}）` };
    return w.temporal.use(async (client) => {
      const lifeOf = async (id: string) => {
        const described = await client.connection.withDeadline(Date.now() + SIGNAL_TIMEOUT_MS, () =>
          client.workflow.getHandle(id).describe(),
        );
        return generationLife(described.status.name);
      };
      const read = await readTaskGenerations(
        { owner: row.owner, name: row.name },
        row.issueNumber,
        async (id) => {
          try {
            return { life: await lifeOf(id), record: { workflowId: id } };
          } catch (err) {
            return err instanceof WorkflowNotFoundError ? { life: 'missing' } : { life: 'unknown' };
          }
        },
      );
      if (!read.ok) return read;
      return redoTask({
        list: async () => read.generations,
        posture: async (id) => {
          try {
            const status = await withDeadline((c) => c.workflow.getHandle(id).query(taskStatusQuery));
            return redoCanStop(status.phase) ? 'parked' : 'running';
          } catch (err) {
            return isWorkflowGone(err) ? 'parked' : 'running';
          }
        },
        abandonParked: async (id) => {
          try {
            await withDeadline((c) =>
              c.workflow.getHandle(id).signal(taskAbandonSignal, {
                by: COMMANDER_ACTOR,
                reason: '指挥官判重做：先叫停停住的上一代',
              }),
            );
          } catch (err) {
            if (!isWorkflowGone(err)) throw err;
          }
          const deadline = Date.now() + ABANDON_WAIT_MS;
          while (Date.now() < deadline) {
            if ((await lifeOf(id).catch(() => 'terminated' as const)) !== 'running') return;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          throw new Error(`叫停 ${id} 后还没停，没有另起`);
        },
        start: async (id) => {
          try {
            await withDeadline((c) =>
              c.workflow.start(TASK_WORKFLOW_TYPE, {
                taskQueue: w.taskQueue,
                workflowId: id,
                args: [
                  {
                    schemaVersion: 1,
                    taskId: row.taskId,
                    repo: {
                      id: repo.id,
                      owner: repo.owner,
                      name: repo.name,
                      defaultBranch: repo.defaultBranch,
                      testCommand: repo.testCommand,
                    },
                    issueNumber: row.issueNumber,
                    title,
                  },
                ],
                workflowIdConflictPolicy: 'FAIL',
                workflowIdReusePolicy: 'REJECT_DUPLICATE',
              }),
            );
            return 'started';
          } catch (err) {
            if (err instanceof WorkflowExecutionAlreadyStartedError) return 'already_exists';
            throw err;
          }
        },
      });
    });
  };

  return () => ({
    async enabled() {
      try {
        const row = await readSettingValue(w.db, COMMANDER_SETTING);
        if (row === null || row.value === true) return { on: true };
        if (row.value === false) return { on: false, why: `设置 ${COMMANDER_SETTING} 关着` };
        return { on: false, why: `设置 ${COMMANDER_SETTING} 的值认不出（要 true 或 false），按关算` };
      } catch (err) {
        return { on: false, why: `设置 ${COMMANDER_SETTING} 读不到，按关算：${errMessage(err)}` };
      }
    },
    async purposeConfigured() {
      return (await countPurposeModels(w.db, 'commander')) > 0;
    },
    async resolveNoModelAlert() {
      await resolveAlertWithReason(w.db, {
        dedupeKey: 'commander:no-model',
        by: COMMANDER_ACTOR,
        why: '路由用途「指挥官」已配有模型；仅解除缺配置提醒，调用是否恢复仍待验证',
        at: now(),
      });
    },
    tasks: () => listStalledEngineTasks(w.db),
    async status(workflowId) {
      try {
        const s = await withDeadline((client) =>
          client.workflow.getHandle(workflowId).query(taskStatusQuery),
        );
        return { phase: s.phase, prNumber: s.prNumber, park: s.park };
      } catch (err) {
        if (isWorkflowGone(err)) return 'gone';
        throw err;
      }
    },
    async audits(since) {
      return (await commanderAuditRows(w.db, since)).map((r) => ({
        at: r.at,
        action: r.action,
        after: r.after,
      }));
    },
    async claim({ row, workflowId, park, requestId, whitelist }) {
      await recordEngineAudit(w.db, {
        action: COMMANDER_AUDIT_CLAIM,
        target: COMMANDER_AUDIT_TARGET,
        actorId: COMMANDER_ACTOR,
        after: {
          taskId: row.taskId,
          ref: `${row.owner}/${row.name}#${row.issueNumber}`,
          workflowId,
          parkSeq: park.seq,
          kind: park.kind,
          title: park.title,
          requestId,
          whitelist,
        },
        reason: `交指挥官会话看：停法 ${park.kind}，停下「${park.title}」`,
        ok: true,
        at: now(),
      });
    },
    detail: (workflowId, parkSeq) => readParkAlertBody(w.db, `${workflowId}:park:${parkSeq}`),
    async rounds(taskId) {
      const rows = await readTaskRoundsForSpin(w.db, taskId);
      return rows.map((r) => ({
        outcome: r.outcome,
        head: null,
        addedLines: r.addedLines,
        reworkSummary: r.reworkSummary,
      }));
    },
    findRepo,
    mainHead: async (repo) =>
      (await mapped(() => w.gh.fetchMainline({ repo: { owner: repo.owner, name: repo.name } }))).head,
    runSession,
    async continueTask(workflowId, command) {
      try {
        await withDeadline((client) =>
          client.workflow.getHandle(workflowId).signal(taskContinueSignal, command),
        );
        return 'sent';
      } catch (err) {
        if (isWorkflowGone(err)) return 'gone';
        throw err;
      }
    },
    async abandonTask(workflowId, reason) {
      try {
        await withDeadline((client) =>
          client.workflow.getHandle(workflowId).signal(taskAbandonSignal, { by: COMMANDER_ACTOR, reason }),
        );
        return 'sent';
      } catch (err) {
        if (isWorkflowGone(err)) return 'gone';
        throw err;
      }
    },
    redoTask: redo,
    async openIssue(repo, input) {
      const got = await w.gh.openIssue({
        repo: { owner: repo.owner, name: repo.name },
        key: input.key,
        title: input.title,
        body: input.body,
        labels: input.labels,
        milestone: null,
      });
      return { number: got.number };
    },
    async audit({ item, action, reason, ok, error }) {
      await recordEngineAudit(w.db, {
        action: COMMANDER_AUDIT_ACT,
        target: COMMANDER_AUDIT_TARGET,
        actorId: COMMANDER_ACTOR,
        after: {
          taskId: item.row.taskId,
          ref: `${item.row.owner}/${item.row.name}#${item.row.issueNumber}`,
          workflowId: item.workflowId,
          parkSeq: item.park.seq,
          action,
        },
        reason,
        ok,
        ...(ok ? {} : { error: error ?? '没成' }),
        at: now(),
      });
    },
    async notify(n) {
      await upsertAlert(w.db, {
        dedupeKey: n.key,
        level: n.level,
        taskId: n.taskId,
        title: n.title,
        body: n.body,
      });
    },
    async resolveAlert({ workflowId, park, why }) {
      await resolveAlertWithReason(w.db, {
        dedupeKey: `${workflowId}:park:${park.seq}`,
        by: COMMANDER_ACTOR,
        why,
        at: now(),
      });
    },
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
