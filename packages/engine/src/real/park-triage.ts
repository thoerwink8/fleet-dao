// 法国指挥官会话（jobs/park-triage.ts，#3294 第 2 片）的真装配。
//
// 改这里之前必须知道：
// - 会话怎么起：和整理待办同一段（real/read-only-session.ts）——选路按用途 commander（路由页「指挥官」一栏，创始人在那里指派模型；
//   默认 grok-4.7 → sonnet-5.5 → opus-5.5）、主线的只读检出、不带 GitHub 令牌。会话只交裁决，所有动手都在这里的引擎代码里：
//   继续 / 放弃是发 Temporal 信号，重做走 shared 的 redoTask（和驾驶舱、命令行的「重做」同一份判断），拆单只有「开子单」一种 GitHub 写操作。
// - 开关是设置 engine.commander（驾驶舱设置页能关）：没设过算开；值认不出按关并说明，不当成开。
// - 操作记录经 recordEngineAudit 写，actor 是 engine:commander、target 是 commander；「认领」和「执行」各一条（jobs/park-triage.ts 看认领判是否处理过）。
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
import {
  type GenerationView,
  generationLife,
  MAX_TASK_GENERATION,
  type RedoOutcome,
  readTaskGenerations,
  redoCanStop,
  redoTask,
} from '@fleet-dao/shared/task-redo';
import { errMessage } from '@fleet-dao/shared/util';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { type Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { COMMANDER_ACTOR } from '../commander-contract.ts';
import { triageKindOf } from '../decisions/park-triage.ts';
import type { IntakeRepo } from '../jobs/intake.ts';
import {
  COMMANDER_AUDIT_ACT,
  COMMANDER_AUDIT_CLAIM,
  COMMANDER_AUDIT_REDO,
  COMMANDER_AUDIT_RETRY,
  type CommanderRedoOutcome,
  PARK_TRIAGE_CAP_ALERT_KEY,
  PARK_TRIAGE_REDO_START_TRIES,
  type ParkTriageDeps,
  REDO_FAILURE_PHASES,
  type RedoJournal,
  type RedoJournalRec,
  type RedoTrail,
} from '../jobs/park-triage.ts';
import type { ParkedRetryRow } from '../jobs/parked-retry.ts';
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
/** 重做前叫停停着的上一代：等它收尾终止最多多久。 */
const ABANDON_WAIT_MS = 60_000;

export interface ParkTriageWiring extends GroomWiring {
  temporal: { use<T>(fn: (client: Pick<Client, 'workflow' | 'connection'>) => Promise<T>): Promise<T> };
  taskQueue: string;
  /** 叫停后等旧代终态用的时钟；只有测试传假的，生产不传。 */
  clock?: { nowMs(): number; sleep(ms: number): Promise<void> };
}

export function parkTriageJob(w: ParkTriageWiring): () => ParkTriageDeps {
  const now = w.now ?? (() => new Date());
  const log: ParkTriageDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const clock = w.clock ?? {
    nowMs: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
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

  type TemporalClient = Pick<Client, 'workflow' | 'connection'>;
  /** 叫停没等到终态：已经把请求发出去了，旧代之后可能才结束。 */
  class StopUnconfirmedError extends Error {}

  /** 旧代现在到底是在跑还是已终止：读失败原样抛，绝不当成已终止。 */
  const lifeOf = async (client: TemporalClient, id: string) => {
    const described = await client.connection.withDeadline(Date.now() + SIGNAL_TIMEOUT_MS, () =>
      client.workflow.getHandle(id).describe(),
    );
    return generationLife(described.status.name);
  };

  /** 这张单全部代次的真实状态（含 run 身份）；某一代查不清就整体失败，不跳过去猜。 */
  const readGenerations = (client: TemporalClient, row: ParkedRetryRow) =>
    readTaskGenerations({ owner: row.owner, name: row.name }, row.issueNumber, async (id) => {
      try {
        const described = await client.connection.withDeadline(Date.now() + SIGNAL_TIMEOUT_MS, () =>
          client.workflow.getHandle(id).describe(),
        );
        return {
          life: generationLife(described.status.name),
          record: { workflowId: id, runId: described.runId },
        };
      } catch (err) {
        return err instanceof WorkflowNotFoundError ? { life: 'missing' } : { life: 'unknown' };
      }
    });

  const trailOf = (generations: readonly GenerationView[]): RedoTrail => ({
    fromGeneration: generations.length,
    runs: generations.map((g) => ({
      workflowId: g.workflowId,
      runId: (g.record as { runId: string }).runId,
    })),
  });

  type Gate =
    | { kind: 'ready' }
    | { kind: 'exists'; workflowId: string; generation: number }
    | { kind: 'waiting'; why: string }
    | { kind: 'final'; why: string };

  /**
   * 每次起新代之前都走这一关：现读全部代次，旧代 run 身份必须和叫停前记下的一致，且都真实终止；
   * 已经有更高的一代就不再起。读不到、还在跑只是等（waiting）；身份对不上、旧代不见了是不能再接续（final）。
   */
  const gateOf = async (client: TemporalClient, row: ParkedRetryRow, trail: RedoTrail): Promise<Gate> => {
    const read = await readGenerations(client, row);
    if (!read.ok) return { kind: 'waiting', why: read.why };
    const gens = read.generations;
    for (const known of trail.runs) {
      const seen = gens.find((g) => g.workflowId === known.workflowId);
      if (!seen) return { kind: 'final', why: `旧代 ${known.workflowId} 现在读不到了，身份对不上，不再接续` };
      const runId = (seen.record as { runId: string }).runId;
      if (runId !== known.runId)
        return {
          kind: 'final',
          why: `旧代 ${known.workflowId} 的 run 身份变了（记下的 ${known.runId}，现在 ${runId}），不再接续`,
        };
    }
    if (gens.length < trail.fromGeneration)
      return {
        kind: 'final',
        why: `现在只有 ${gens.length} 代，少于叫停前的 ${trail.fromGeneration} 代，不再接续`,
      };
    const next = gens[trail.fromGeneration];
    if (next) return { kind: 'exists', workflowId: next.workflowId, generation: next.generation };
    const alive = gens.filter((g) => g.life !== 'terminated');
    if (alive.length > 0)
      return {
        kind: 'waiting',
        why: `旧代 ${alive.map((g) => g.workflowId).join('、')} 终态未确认（仍在运行）`,
      };
    return { kind: 'ready' };
  };

  /** 叫停发出后等旧代终止最多 ABANDON_WAIT_MS；读不到状态不算终止，等不到抛 StopUnconfirmedError。 */
  const waitTerminal = async (client: TemporalClient, id: string) => {
    const deadline = clock.nowMs() + ABANDON_WAIT_MS;
    let last = '一直没读到状态';
    while (clock.nowMs() < deadline) {
      try {
        if ((await lifeOf(client, id)) === 'terminated') return;
        last = '仍在运行';
      } catch (err) {
        last = `读状态失败：${errMessage(err)}`;
      }
      await clock.sleep(200);
    }
    throw new StopUnconfirmedError(`叫停 ${id} 后还没停，没有另起（最后一次：${last}）`);
  };

  /** 起新代。已经有这个编号（开着或已结束）回 already_exists，不覆盖旧记录。 */
  const startGeneration = async (
    row: ParkedRetryRow,
    repo: IntakeRepo,
    title: string,
    id: string,
  ): Promise<'started' | 'already_exists'> => {
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
  };

  /** 终态账写不进只记警告：新代已经起了（或已存在），不能因此把成功改报失败；账上留着待接续，下一轮会读到新代已存在。 */
  const journalBestEffort = async (journal: RedoJournal, rec: RedoJournalRec) => {
    try {
      await journal(rec);
    } catch (err) {
      log('warn', '指挥官：重做接续账没写进，账上仍是待接续，下一轮核对', {
        phase: rec.phase,
        error: errMessage(err),
      });
    }
  };

  const redo: ParkTriageDeps['redoTask'] = async (row, workflowId, journal) => {
    const repo = await findRepo(row.owner, row.name);
    const title = await readTaskTitle(w.db, row.taskId);
    if (!repo || title === null) return { ok: false, why: `读不到仓或任务标题，没有重做（${workflowId}）` };
    return w.temporal.use(async (client): Promise<CommanderRedoOutcome> => {
      const read = await readGenerations(client, row);
      if (!read.ok) return read;
      const trail = trailOf(read.generations);
      // idle：什么都没发；stop：叫停已写账并发出；old-terminal：旧代已重核终止，起新代前；start：起新代请求已写账并发出
      let phase: 'idle' | 'stop' | 'old-terminal' | 'start' = 'idle';
      // 接续账里已经有这一轮的第一笔（后续调度才有东西可接）
      let ledgered = false;
      let existing: { workflowId: string; generation: number } | null = null;
      let outcome: RedoOutcome;
      try {
        outcome = await redoTask({
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
            // 先记账再叫停：账写不进就不发，回执才能如实写「任务没动」
            if (phase === 'idle') {
              await journal({ phase: 'stop-requested', trail });
              ledgered = true;
              phase = 'stop';
            }
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
            await waitTerminal(client, id);
          },
          start: async (id) => {
            // 起之前把全部旧代的真实终态和 run 身份再核一遍，不信前面的等待结果
            const gate = await gateOf(client, row, trail);
            if (gate.kind === 'exists') {
              existing = { workflowId: gate.workflowId, generation: gate.generation };
              return 'already_exists';
            }
            if (gate.kind !== 'ready') throw new StopUnconfirmedError(gate.why);
            phase = 'old-terminal';
            await journal({
              phase: 'start-requested',
              trail,
              newWorkflowId: id,
              generation: trail.fromGeneration + 1,
            });
            ledgered = true;
            phase = 'start';
            const started = await startGeneration(row, repo, title, id);
            if (started === 'already_exists')
              existing = { workflowId: id, generation: trail.fromGeneration + 1 };
            return started;
          },
        });
      } catch (err) {
        const why = errMessage(err);
        if (phase === 'idle') return { ok: false, why };
        if (phase === 'stop') {
          await journalBestEffort(journal, { phase: 'stop-unconfirmed', why });
          return { ok: false, why, stage: 'stop-unconfirmed' };
        }
        // 旧代已重核终止、起新代的账还没写进去：账上没有这一轮的第一笔就是什么都没发，不假装有后续
        if (!ledgered) return { ok: false, why };
        await journalBestEffort(journal, { phase: 'start-unconfirmed', why });
        return { ok: false, why, stage: 'start-unconfirmed' };
      }
      const found = existing as { workflowId: string; generation: number } | null;
      if (found) {
        await journalBestEffort(journal, {
          phase: 'exists',
          newWorkflowId: found.workflowId,
          generation: found.generation,
        });
        return { ok: true, workflowId: found.workflowId, generation: found.generation, existing: true };
      }
      if (outcome.ok) {
        await journalBestEffort(journal, {
          phase: 'started',
          newWorkflowId: outcome.workflowId,
          generation: outcome.generation,
        });
        return outcome;
      }
      // 没起成又没抛错：要么什么都没动（旧代真在跑被拒），要么叫停已执行但不能另起（例如代数到顶）
      if (phase === 'idle') return outcome;
      await journalBestEffort(journal, { phase: 'given-up', why: outcome.why });
      return { ok: false, why: outcome.why, stage: 'final' };
    });
  };

  const resume: ParkTriageDeps['resumeRedo'] = async (pending, opts, journal) => {
    const { row, trail } = pending;
    const repo = await findRepo(row.owner, row.name);
    const title = await readTaskTitle(w.db, row.taskId);
    if (!repo || title === null)
      return {
        ok: false,
        stage: 'waiting',
        why: `读不到仓或任务标题，这一轮不接续（${pending.workflowId}）`,
      };
    return w.temporal.use(async (client): Promise<CommanderRedoOutcome> => {
      const gate = await gateOf(client, row, trail);
      if (gate.kind === 'final') return { ok: false, stage: 'final', why: gate.why };
      if (gate.kind === 'waiting') return { ok: false, stage: 'waiting', why: gate.why };
      if (gate.kind === 'exists') {
        await journalBestEffort(journal, {
          phase: 'exists',
          newWorkflowId: gate.workflowId,
          generation: gate.generation,
        });
        return { ok: true, workflowId: gate.workflowId, generation: gate.generation, existing: true };
      }
      const generation = trail.fromGeneration + 1;
      if (generation > MAX_TASK_GENERATION)
        return { ok: false, stage: 'final', why: `已经重做到第 ${MAX_TASK_GENERATION} 代，不再另起` };
      if (!opts.canStart)
        return {
          ok: false,
          stage: 'final',
          why: `旧代已终止但新代还没起，而接续已过 24 小时或起新代已试满 ${PARK_TRIAGE_REDO_START_TRIES} 次，不再起`,
        };
      const id = taskWorkflowId({ owner: row.owner, name: row.name }, row.issueNumber, generation);
      try {
        await journal({ phase: 'start-requested', trail, newWorkflowId: id, generation });
      } catch (err) {
        return { ok: false, stage: 'waiting', why: `接续账没写进，没有起新代：${errMessage(err)}` };
      }
      let started: 'started' | 'already_exists';
      try {
        started = await startGeneration(row, repo, title, id);
      } catch (err) {
        const why = errMessage(err);
        await journalBestEffort(journal, { phase: 'start-unconfirmed', why });
        return { ok: false, stage: 'start-unconfirmed', why };
      }
      await journalBestEffort(journal, {
        phase: started === 'started' ? 'started' : 'exists',
        newWorkflowId: id,
        generation,
      });
      return { ok: true, workflowId: id, generation, ...(started === 'started' ? {} : { existing: true }) };
    });
  };

  const redoJournal: ParkTriageDeps['redoJournal'] = async ({ row, workflowId, parkSeq, rec }) => {
    const failure = REDO_FAILURE_PHASES.includes(rec.phase);
    await recordEngineAudit(w.db, {
      action: COMMANDER_AUDIT_REDO,
      target: COMMANDER_AUDIT_TARGET,
      actorId: COMMANDER_ACTOR,
      after: {
        taskId: row.taskId,
        ref: `${row.owner}/${row.name}#${row.issueNumber}`,
        owner: row.owner,
        name: row.name,
        issueNumber: row.issueNumber,
        workflowId,
        parkSeq,
        phase: rec.phase,
        ...(rec.trail ? { trail: rec.trail } : {}),
        ...(rec.newWorkflowId ? { newWorkflowId: rec.newWorkflowId } : {}),
        ...(rec.generation ? { generation: rec.generation } : {}),
        ...(rec.why ? { why: rec.why } : {}),
      },
      reason: `重做接续账：${rec.phase}`,
      ok: !failure,
      ...(failure ? { error: (rec.why ?? rec.phase).slice(0, 1000) } : {}),
      at: now(),
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
    redoJournal,
    resumeRedo: resume,
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
    async audit({ item, action, reason, ok, error, source }) {
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
