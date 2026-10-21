// 法国指挥官会话（jobs/park-triage.ts，#3294 第 2 片）的真装配。
//
// 改这里之前必须知道：
// - 会话怎么起：和整理待办同一段（real/read-only-session.ts）——选路按用途 commander（路由页「指挥官」一栏，创始人在那里指派模型；
//   默认 grok-4.7 → sonnet-5.5 → opus-5.5）、主线的只读检出、不带 GitHub 令牌。会话只交裁决，所有动手都在这里的引擎代码里：
//   继续 / 放弃是发 Temporal 信号，重做走 shared 的 redoTask（和驾驶舱、命令行的「重做」同一份判断），拆单只有「开子单」一种 GitHub 写操作。
// - 开关是设置 engine.commander（驾驶舱设置页能关）：没设过算开；值认不出按关并说明，不当成开。
// - 操作记录经 recordEngineAudit 写，actor 是 engine:commander、target 是 commander；「认领」和「执行」各一条（jobs/park-triage.ts 看认领判是否处理过）。
// - 重做叫停后，现有等待窗口内还没到终态：先把各代 runId 记进这条执行记录，后面的标准调度沿原裁决接续。
//   新代启动前重读全部旧代的终态和 runId。仍在跑、查不到或身份变了就拒绝，不拉长等待、不终止、不改任务行。
// - 提醒（诊断文字）经 upsertAlert 推：执行了的、贴「本机做」交本机指挥官的是 daily；留给人（要掏新钱、删了找不回、只有人能做）
//   是 decision（带选项和原因）；没成、会话没起成的是 alert。改标准的停下经 addIssueLabel 贴「本机做」（#3423）。
import {
  COMMANDER_AUDIT_TARGET,
  commanderAuditRows,
  countPurposeModels,
  finishScheduleRun,
  listCommanderAcceptanceTasks,
  listIntakeRepos,
  listStalledEngineTasks,
  readOpenParkAlert,
  readParkAlertBody,
  readSettingValue,
  readTaskRoundsForSpin,
  readTaskTitle,
  recordEngineAudit,
  resolveAlertWithReason,
  settleAcceptanceDuty,
  startScheduleRun,
  supersedeAcceptanceDuty,
  upsertAlert,
} from '@fleet-dao/db';
import { TASK_WORKFLOW_TYPE } from '@fleet-dao/shared';
import { generationLife, readTaskGenerations, redoCanStop, redoTask } from '@fleet-dao/shared/task-redo';
import { errMessage } from '@fleet-dao/shared/util';
import { type Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { COMMANDER_ACTOR } from '../commander-contract.ts';
import { triageKindOf } from '../decisions/park-triage.ts';
import {
  COMMANDER_AUDIT_ACT,
  COMMANDER_AUDIT_CLAIM,
  COMMANDER_AUDIT_RETRY,
  type CommanderRedoResult,
  PARK_TRIAGE_CAP_ALERT_KEY,
  type ParkTriageDeps,
  type RedoExecutionIdentity,
  type RedoFollowBlock,
  type RedoFollowIntent,
  type RedoFollowPhase,
  type RedoResumeContext,
  redoIntentId,
} from '../jobs/park-triage.ts';
import {
  taskAbandonSignal,
  taskContinueSignal,
  taskSettleMergedUpdate,
  taskStatusQuery,
} from '../task-contract.ts';
import { type GroomWiring, toRepo } from './groom.ts';
import { mapped } from './mirror.ts';
import { readOnlySessionRunner } from './read-only-session.ts';
import { isWorkflowGone } from './route-wake.ts';

/** 设置里的开关键（和驾驶舱 SETTING_SCHEMAS 同一个字符串）。 */
export const COMMANDER_SETTING = 'engine.commander';

const SIGNAL_TIMEOUT_MS = 5_000;
/** 重做前叫停停着的上一代：等它收尾终止最多多久。接续不拉长这个窗口。 */
export const ABANDON_WAIT_MS = 60_000;
const ABANDON_POLL_MS = 200;

export interface ParkTriageWiring extends GroomWiring {
  temporal: { use<T>(fn: (client: Pick<Client, 'workflow' | 'connection'>) => Promise<T>): Promise<T> };
  taskQueue: string;
  /**
   * 叫停后的现有等待窗口怎么睡。不传就是 setTimeout。
   * 测试注入 now 时，这里必须把 now 往前拨；生产不传，时钟用真实时间。
   */
  sleep?: (ms: number) => Promise<void>;
}

function runIdFromRecord(record: unknown): string | null {
  if (record === null || typeof record !== 'object') return null;
  const runId = (record as { runId?: unknown }).runId;
  return typeof runId === 'string' && runId !== '' ? runId : null;
}

function identitiesFrom(
  generations: readonly { workflowId: string; generation: number; record: unknown }[],
): RedoExecutionIdentity[] | null {
  if (generations.length === 0) return null;
  const out: RedoExecutionIdentity[] = [];
  for (const item of generations) {
    const runId = runIdFromRecord(item.record);
    if (runId === null) return null;
    out.push({ workflowId: item.workflowId, generation: item.generation, runId });
  }
  return out;
}

class RedoHalt extends Error {
  readonly follow: RedoFollowIntent;
  constructor(message: string, follow: RedoFollowIntent) {
    super(message);
    this.name = 'RedoHalt';
    this.follow = follow;
  }
}

type SeenExecution =
  | { life: 'running' | 'terminated'; runId: string }
  | { life: 'missing' }
  | { life: 'unknown' };

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

  const clock = () => now().getTime();
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const redo: ParkTriageDeps['redoTask'] = async (row, workflowId, resume) => {
    const context: RedoResumeContext = resume ?? {
      intentId: redoIntentId(workflowId, 0),
      parkSeq: 0,
      source: 'verdict',
      reason: '指挥官判重做',
    };
    const repo = await findRepo(row.owner, row.name);
    const title = await readTaskTitle(w.db, row.taskId);
    if (!repo || title === null) return { ok: false, why: `读不到仓或任务标题，没有重做（${workflowId}）` };
    return w.temporal.use(async (client) => {
      let seq = context.follow?.seq ?? 0;
      let stopSent = context.follow !== undefined;
      let identities: RedoExecutionIdentity[] = context.follow?.identities ?? [];
      const followOf = (phase: RedoFollowPhase, why: string, block?: RedoFollowBlock): RedoFollowIntent => {
        seq += 1;
        return {
          intentId: context.intentId,
          phase,
          why,
          identities,
          source: context.source,
          reason: context.reason,
          seq,
          ...(block ? { block } : {}),
        };
      };
      const persist = async (follow: RedoFollowIntent, ok: boolean) => {
        await recordEngineAudit(w.db, {
          action: COMMANDER_AUDIT_ACT,
          target: COMMANDER_AUDIT_TARGET,
          actorId: COMMANDER_ACTOR,
          after: {
            taskId: row.taskId,
            ref: `${row.owner}/${row.name}#${row.issueNumber}`,
            workflowId,
            parkSeq: context.parkSeq,
            action: 'redo',
            source: context.source,
            owner: row.owner,
            name: row.name,
            issueNumber: row.issueNumber,
            redoFollow: follow,
          },
          reason: context.reason,
          ok,
          ...(ok ? {} : { error: follow.why }),
          at: now(),
        });
      };
      const probe = async (id: string): Promise<SeenExecution> => {
        try {
          const described = await client.connection.withDeadline(Date.now() + SIGNAL_TIMEOUT_MS, () =>
            client.workflow.getHandle(id).describe(),
          );
          const runId = typeof described.runId === 'string' ? described.runId : '';
          if (runId === '') return { life: 'unknown' };
          const life = generationLife(described.status.name);
          return { life, runId };
        } catch (err) {
          if (err instanceof WorkflowNotFoundError || isWorkflowGone(err)) return { life: 'missing' };
          return { life: 'unknown' };
        }
      };
      const read = () =>
        readTaskGenerations({ owner: row.owner, name: row.name }, row.issueNumber, async (id) => {
          const seen = await probe(id);
          if (seen.life === 'missing' || seen.life === 'unknown') return { life: seen.life };
          return { life: seen.life, record: { workflowId: id, runId: seen.runId } };
        });
      const judge = (
        generations: readonly {
          workflowId: string;
          generation: number;
          life: 'running' | 'terminated';
          record: unknown;
        }[],
      ): { ok: true } | { ok: false; why: string; phase: RedoFollowPhase; block: RedoFollowBlock } => {
        if (identities.length === 0) {
          return {
            ok: false,
            why: '查不到叫停时的执行身份，没有另起',
            phase: 'stop_sent_unconfirmed',
            block: 'unknown',
          };
        }
        const byGen = new Map(generations.map((item) => [item.generation, item]));
        for (const expected of identities) {
          const item = byGen.get(expected.generation);
          const runId = item ? runIdFromRecord(item.record) : null;
          if (!item || item.workflowId !== expected.workflowId || runId === null) {
            return {
              ok: false,
              why: `查不到 ${expected.workflowId} 的执行身份，没有另起`,
              phase: 'stop_sent_unconfirmed',
              block: 'unknown',
            };
          }
          if (runId !== expected.runId) {
            return {
              ok: false,
              why: `执行身份变了（${expected.workflowId} 的 runId 从 ${expected.runId} 变成 ${runId}），没有另起`,
              phase: 'stop_sent_unconfirmed',
              block: 'identity',
            };
          }
          if (item.life !== 'terminated') {
            return {
              ok: false,
              why: `叫停 ${expected.workflowId} 后还没停，没有另起`,
              phase: 'stop_sent_unconfirmed',
              block: 'running',
            };
          }
        }
        for (const item of generations) {
          if (!identities.some((expected) => expected.generation === item.generation)) {
            return {
              ok: false,
              why: `编号 ${item.workflowId} 已经有记录，没有覆盖旧代，也没另起`,
              phase: 'start_failed',
              block: 'exists',
            };
          }
        }
        return { ok: true };
      };
      const refuse = async (
        why: string,
        phase: RedoFollowPhase,
        block: RedoFollowBlock,
        keepWhy: string,
      ): Promise<CommanderRedoResult> => {
        const follow = followOf(phase, keepWhy, block);
        try {
          await persist(follow, false);
        } catch (err) {
          log('error', '指挥官：重做接续没记进操作记录', { error: errMessage(err) });
        }
        return { ok: false, why, follow };
      };
      try {
        const listed = await read();
        if (!listed.ok) {
          if (!context.follow) return { ok: false, why: listed.why };
          return await refuse(listed.why, 'stop_sent_unconfirmed', 'unknown', context.follow.why);
        }
        if (!context.follow) {
          const fresh = identitiesFrom(listed.generations);
          if (fresh === null) return { ok: false, why: '查不到上一代的执行身份，没有另起' };
          identities = fresh;
        } else {
          const verdict = judge(listed.generations);
          if (!verdict.ok) return await refuse(verdict.why, verdict.phase, verdict.block, context.follow.why);
        }
        const outcome = await redoTask({
          list: async () => listed.generations,
          posture: async (id) => {
            try {
              const status = await withDeadline((c) => c.workflow.getHandle(id).query(taskStatusQuery));
              return redoCanStop(status.phase) ? 'parked' : 'running';
            } catch (err) {
              return isWorkflowGone(err) ? 'parked' : 'running';
            }
          },
          abandonParked: async (id) => {
            if (context.follow) {
              throw new RedoHalt(
                `叫停 ${id} 后还没停，没有另起`,
                followOf('stop_sent_unconfirmed', context.follow.why, 'running'),
              );
            }
            try {
              await withDeadline((c) =>
                c.workflow.getHandle(id).signal(taskAbandonSignal, {
                  by: COMMANDER_ACTOR,
                  reason: '指挥官判重做：先叫停停住的上一代',
                }),
              );
            } catch (err) {
              if (!isWorkflowGone(err)) {
                stopSent = true;
                const why = `叫停 ${id} 没确认发出：${errMessage(err)}`;
                throw new RedoHalt(why, followOf('stop_sent_unconfirmed', why, 'unknown'));
              }
            }
            stopSent = true;
            const marked = followOf('stop_sent_unconfirmed', `叫停 ${id} 已发送，终态未确认`, 'running');
            try {
              await persist(marked, false);
            } catch (err) {
              throw new RedoHalt(`叫停 ${id} 已发送，接续记录没写进：${errMessage(err)}`, marked);
            }
            const deadline = clock() + ABANDON_WAIT_MS;
            const matchedRun = identities.find((item) => item.workflowId === id)?.runId;
            while (clock() < deadline) {
              const seen = await probe(id);
              if (seen.life === 'terminated') {
                if (matchedRun !== undefined && seen.runId !== matchedRun) {
                  const why = `执行身份变了（${id} 的 runId 从 ${matchedRun} 变成 ${seen.runId}），没有另起`;
                  throw new RedoHalt(why, followOf('stop_sent_unconfirmed', why, 'identity'));
                }
                return;
              }
              if (seen.life === 'missing') {
                const why = `查不到 ${id} 的执行身份，没有另起`;
                throw new RedoHalt(why, followOf('stop_sent_unconfirmed', why, 'unknown'));
              }
              const left = deadline - clock();
              if (left <= 0) break;
              await sleep(Math.min(ABANDON_POLL_MS, left));
            }
            const why = `叫停 ${id} 后还没停，没有另起`;
            const failed = followOf('stop_sent_unconfirmed', why, 'running');
            try {
              await persist(failed, false);
            } catch (err) {
              log('error', '指挥官：叫停超时没记进操作记录', { error: errMessage(err) });
            }
            throw new RedoHalt(why, failed);
          },
          start: async (id) => {
            const again = await read();
            if (!again.ok) {
              throw new RedoHalt(
                again.why,
                followOf('stop_sent_unconfirmed', context.follow?.why || again.why, 'unknown'),
              );
            }
            const verdict = judge(again.generations);
            if (!verdict.ok) {
              throw new RedoHalt(
                verdict.why,
                followOf(verdict.phase, context.follow?.why || verdict.why, verdict.block),
              );
            }
            const next = await probe(id);
            if (next.life !== 'missing') {
              const why = `编号 ${id} 已经有记录，没有覆盖旧代，也没另起`;
              throw new RedoHalt(why, followOf('start_failed', context.follow?.why || why, 'exists'));
            }
            const pendingWhy = context.follow?.why || '旧代已终态，新代还没确认启动';
            await persist(followOf('old_terminal_pending_start', pendingWhy), false);
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
            } catch (err) {
              if (err instanceof WorkflowExecutionAlreadyStartedError) {
                const why = `编号 ${id} 已经有记录，没有覆盖旧代，也没另起`;
                throw new RedoHalt(why, followOf('start_failed', context.follow?.why || why, 'exists'));
              }
              throw new RedoHalt(
                `旧代已终态，新代启动失败：${errMessage(err)}`,
                followOf(
                  'start_failed',
                  context.follow?.why || `旧代已终态，新代启动失败：${errMessage(err)}`,
                  'start',
                ),
              );
            }
            const confirmed = await probe(id);
            if (confirmed.life !== 'running' && confirmed.life !== 'terminated') {
              throw new RedoHalt(
                `新代 ${id} 没有确认到执行，不算重做完成`,
                followOf(
                  'start_failed',
                  context.follow?.why || `新代 ${id} 没有确认到执行，不算重做完成`,
                  'start',
                ),
              );
            }
            const prior = context.follow?.why ?? '';
            try {
              await persist(followOf('started', prior || '新代已确认启动'), true);
            } catch (err) {
              log('error', '指挥官：新代已确认，接续记录没记进', { error: errMessage(err) });
            }
            return 'started';
          },
        });
        if (!outcome.ok) {
          if (!stopSent) return outcome;
          const why = outcome.why;
          return await refuse(why, 'start_failed', 'start', context.follow?.why || why);
        }
        if (!context.follow) return outcome;
        return {
          ok: true,
          workflowId: outcome.workflowId,
          generation: outcome.generation,
          follow: followOf('started', context.follow.why),
        };
      } catch (err) {
        if (err instanceof RedoHalt) return { ok: false, why: err.message, follow: err.follow };
        const why = errMessage(err);
        if (!stopSent) return { ok: false, why };
        return await refuse(why, 'stop_sent_unconfirmed', 'unknown', context.follow?.why || why);
      }
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
    async resolveCapAlert() {
      await resolveAlertWithReason(w.db, {
        dedupeKey: PARK_TRIAGE_CAP_ALERT_KEY,
        by: COMMANDER_ACTOR,
        why: '24 小时内的有效认领回到熔断上限以下',
        at: now(),
      });
    },
    tasks: () => listStalledEngineTasks(w.db),
    async acceptanceTasks() {
      const candidates = await listCommanderAcceptanceTasks(w.db, new Date(now().getTime() - 30 * 60_000));
      const open: typeof candidates = [];
      for (const candidate of candidates) {
        const state = await w.gh.readIssueState({
          repo: { owner: candidate.owner, name: candidate.name },
          issueNumber: candidate.issueNumber,
        });
        if (state.state === 'open') open.push(candidate);
      }
      return open;
    },
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
    openPark: (workflowId) => readOpenParkAlert(w.db, workflowId),
    async audits(since) {
      return (await commanderAuditRows(w.db, since)).map((r) => ({
        at: r.at,
        action: r.action,
        after: r.after,
        ok: r.ok,
      }));
    },
    async claim({ row, workflowId, park, requestId, kind, legacy, attempt }) {
      const triage = kind ?? triageKindOf(park);
      await recordEngineAudit(w.db, {
        action: COMMANDER_AUDIT_CLAIM,
        target: COMMANDER_AUDIT_TARGET,
        actorId: COMMANDER_ACTOR,
        after: {
          taskId: row.taskId,
          ref: `${row.owner}/${row.name}#${row.issueNumber}`,
          workflowId,
          parkSeq: park.seq,
          kind: triage,
          parkKind: park.kind,
          ...(park.code ? { code: park.code } : {}),
          ...(park.rule ? { rule: park.rule } : {}),
          ...(legacy ? { legacy: true } : {}),
          ...(attempt ? { attempt } : {}),
          title: park.title,
          requestId,
        },
        reason: `交指挥官会话看：停法 ${triage}，停下「${park.title}」`,
        ok: true,
        at: now(),
      });
    },
    async claimAcceptance({ task, requestId, attempt }) {
      const workflowId = `acceptance:${task.taskId}:${task.prNumber}:${task.head}`;
      await recordEngineAudit(w.db, {
        action: COMMANDER_AUDIT_CLAIM,
        target: COMMANDER_AUDIT_TARGET,
        actorId: COMMANDER_ACTOR,
        after: {
          taskId: task.taskId,
          ref: `${task.owner}/${task.name}#${task.issueNumber}`,
          workflowId,
          parkSeq: 0,
          kind: 'acceptance',
          prNumber: task.prNumber,
          head: task.head,
          ...(attempt ? { attempt } : {}),
          requestId,
        },
        reason: `交指挥官会话看验收责任：PR #${task.prNumber}，合并于 ${task.mergedAt.toISOString()}`,
        ok: true,
        at: now(),
      });
    },
    async acceptanceRetry({ task, attempt, why }) {
      const workflowId = `acceptance:${task.taskId}:${task.prNumber}:${task.head}`;
      await recordEngineAudit(w.db, {
        action: COMMANDER_AUDIT_RETRY,
        target: COMMANDER_AUDIT_TARGET,
        actorId: COMMANDER_ACTOR,
        after: {
          taskId: task.taskId,
          ref: `${task.owner}/${task.name}#${task.issueNumber}`,
          workflowId,
          parkSeq: 0,
          kind: 'acceptance',
          prNumber: task.prNumber,
          head: task.head,
          attempt,
        },
        reason: `验收责任会话没起成（第 ${attempt} 次），下一轮再看`,
        ok: false,
        error: why.slice(0, 1000),
        at: now(),
      });
    },
    async retry({ row, workflowId, park, attempt, why }) {
      await recordEngineAudit(w.db, {
        action: COMMANDER_AUDIT_RETRY,
        target: COMMANDER_AUDIT_TARGET,
        actorId: COMMANDER_ACTOR,
        after: {
          taskId: row.taskId,
          ref: `${row.owner}/${row.name}#${row.issueNumber}`,
          workflowId,
          parkSeq: park.seq,
          attempt,
        },
        reason: `指挥官会话没起成（第 ${attempt} 次），这一次停下下一轮再看`,
        ok: false,
        error: why.slice(0, 1000),
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
    async addLabel(repo, issueNumber, label) {
      await w.gh.addIssueLabel({ repo: { owner: repo.owner, name: repo.name }, issueNumber, label });
    },
    async audit({ item, action, reason, ok, error, source, detail }) {
      const redoFollow = detail?.redoFollow;
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
          kind: item.kind ?? triageKindOf(item.park),
          ...(item.detailHash ? { detailHash: item.detailHash } : {}),
          ...(source ? { source } : {}),
          owner: item.row.owner,
          name: item.row.name,
          issueNumber: item.row.issueNumber,
          ...(redoFollow !== undefined ? { redoFollow } : {}),
        },
        reason,
        ok,
        ...(ok ? {} : { error: error ?? '没成' }),
        at: now(),
      });
    },
    async acceptanceAudit({ task, duty, action, reason, ok, error }) {
      await recordEngineAudit(w.db, {
        action: COMMANDER_AUDIT_ACT,
        target: COMMANDER_AUDIT_TARGET,
        actorId: COMMANDER_ACTOR,
        after: {
          taskId: task.taskId,
          ref: `${task.owner}/${task.name}#${task.issueNumber}`,
          kind: 'acceptance',
          dutyId: duty.id,
          generation: duty.generation,
          repo: duty.repo,
          issue: duty.issueNumber,
          prNumber: duty.prNumber,
          head: duty.head,
          action,
        },
        reason,
        ok,
        ...(ok ? {} : { error: error ?? '没成' }),
        at: now(),
      });
    },
    async settleAcceptance({ duty, evidence }) {
      await settleAcceptanceDuty(
        w.db,
        {
          id: duty.id,
          generation: duty.generation,
          repo: duty.repo,
          issueNumber: duty.issueNumber,
          prNumber: duty.prNumber,
          head: duty.head,
          by: COMMANDER_ACTOR,
          evidence,
        },
        now(),
      );
    },
    async supersedeAcceptance({ source, target, evidence, coverage }) {
      await supersedeAcceptanceDuty(
        w.db,
        {
          source: {
            id: source.id,
            generation: source.generation,
            repo: source.repo,
            issueNumber: source.issueNumber,
            prNumber: source.prNumber,
            head: source.head,
          },
          target: {
            id: target.id,
            generation: target.generation,
            repo: target.repo,
            issueNumber: target.issueNumber,
            prNumber: target.prNumber,
            head: target.head,
          },
          by: COMMANDER_ACTOR,
          evidence,
          coverage,
        },
        now(),
      );
    },
    async closeAcceptanceTask(task, mergeCommit) {
      if (!task.workflowId) throw new Error('验收责任候选没有工作流编号，不能精确收尾');
      const status = await withDeadline((client) =>
        client.workflow.getHandle(task.workflowId as string).query(taskStatusQuery),
      );
      const close = status.mergedTaskClose;
      const token = close?.token;
      if (
        !close ||
        token === null ||
        token === undefined ||
        close.repo.owner.toLowerCase() !== task.owner.toLowerCase() ||
        close.repo.name.toLowerCase() !== task.name.toLowerCase() ||
        close.prNumber !== task.prNumber ||
        close.head !== task.head
      )
        throw new Error('工作流的合并收尾凭据与验收候选不符，不能关单');
      const receipt = {
        repo: { owner: task.owner, name: task.name },
        prNumber: task.prNumber,
        head: task.head,
        mergeCommit,
      };
      const outcome = await withDeadline((client) =>
        client.workflow
          .getHandle(task.workflowId as string, token.runId)
          .executeUpdate(taskSettleMergedUpdate, {
            args: [{ token, receipt }],
            updateId: `merged-task:${token.runId}:${token.generation}:${token.continued}:${task.prNumber}:${task.head}:${mergeCommit}`,
          }),
      );
      if (outcome !== 'accepted') throw new Error(`精确合并收尾没有受理：${outcome}`);
    },
    async notify(n) {
      await upsertAlert(w.db, {
        dedupeKey: n.key,
        level: n.level,
        taskId: n.taskId,
        title: n.title,
        body: n.body,
        ...(n.options ? { options: n.options } : {}),
        ...(n.reason ? { reason: n.reason } : {}),
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
