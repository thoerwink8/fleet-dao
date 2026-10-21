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
  intakeTaskRow,
  listCommanderAcceptanceTasks,
  listIntakeRepos,
  listStalledEngineTasks,
  readOpenParkAlert,
  readParkAlertBody,
  readSettingValue,
  readTaskRoundsForSpin,
  recordEngineAudit,
  resolveAlertWithReason,
  settleAcceptanceDuty,
  startScheduleRun,
  supersedeAcceptanceDuty,
  taskContext,
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

  /** 起新代前的核对发现不能再接续的事实（身份对不上、旧代不见了）。 */
  class GateFinalError extends Error {}

  /** 钉住已核的 run：旧代的查询、叫停、读状态都指到记下的那一次执行，不会落到后来换掉的执行上。 */
  const pinned = (client: TemporalClient, id: string, runId: string) => client.workflow.getHandle(id, runId);

  /** 旧代这一次执行现在到底是在跑还是已终止：读失败原样抛，绝不当成已终止。 */
  const lifeOf = async (client: TemporalClient, id: string, runId: string) => {
    const described = await client.connection.withDeadline(Date.now() + SIGNAL_TIMEOUT_MS, () =>
      pinned(client, id, runId).describe(),
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

  const runIdOf = (g: GenerationView): string | null => {
    const runId = (g.record as { runId?: unknown } | null)?.runId;
    return typeof runId === 'string' && runId.trim() !== '' ? runId : null;
  };

  /**
   * 叫停前先把全部旧代的身份核成一份账：每一代都要有非空 run 编号、编号正好是第 i 代、裁决那一代在里面。
   * 缺任何一样就在任何副作用之前拒绝（不用强转，undefined 不会和 undefined 对上）。
   */
  const trailOf = (
    generations: readonly GenerationView[],
    row: ParkedRetryRow,
    verdictWorkflowId: string,
  ): { ok: true; trail: RedoTrail } | { ok: false; why: string } => {
    const runs: RedoTrail['runs'] = [];
    for (const [i, g] of generations.entries()) {
      const expect = taskWorkflowId({ owner: row.owner, name: row.name }, row.issueNumber, i + 1);
      const runId = runIdOf(g);
      if (g.workflowId !== expect || g.generation !== i + 1)
        return { ok: false, why: `第 ${i + 1} 代的编号对不上（读到 ${g.workflowId}），没有重做` };
      if (runId === null)
        return { ok: false, why: `旧代 ${g.workflowId} 读不到有效的 run 身份，没有叫停、没有重做` };
      runs.push({ workflowId: g.workflowId, runId });
    }
    if (runs.length === 0) return { ok: false, why: '没有上一代任务可重做' };
    if (!runs.some((r) => r.workflowId === verdictWorkflowId))
      return { ok: false, why: `裁决那一代 ${verdictWorkflowId} 不在这张单的代次里，没有重做` };
    return { ok: true, trail: { fromGeneration: runs.length, runs } };
  };

  type Owned =
    /** canAct：任务状态仍是停着/已放弃，才允许再动手（叫停、起新代）；否则只许只读确认。 */
    | { ok: true; repo: IntakeRepo; title: string; canAct: boolean; state: string }
    /** unknown：读不到，保持待接续；mismatch：已读到的事实说明这不是同一个引擎任务了。 */
    | { ok: false; kind: 'unknown' | 'mismatch'; why: string };
  const ACTIVE_STATES: readonly string[] = ['stalled', 'stopped'];

  /**
   * 每次接续/动手之前，从现有可信任务/仓记录核当前归属：账里的 task id/ref 必须就是库里这张任务，仍归引擎（executor=engine）。
   * 「是不是同一个引擎任务」和「允许再动手」分开：状态不是停着/已放弃（例如新代已起、任务行已被工作流改成 running）
   * 只让 canAct=false——仍可只读确认新代是否存在，但不准叫停、不准 Start。旧账、标题能读到都不算授权。
   */
  const verifyOwnership = async (row: ParkedRetryRow): Promise<Owned> => {
    try {
      const ctx = await taskContext(w.db, row.taskId);
      if (ctx === null)
        return { ok: false, kind: 'mismatch', why: `库里没有任务 ${row.taskId}，账和任务对不上` };
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      if (
        !same(ctx.repo.owner, row.owner) ||
        !same(ctx.repo.name, row.name) ||
        ctx.issueNumber !== row.issueNumber
      )
        return {
          ok: false,
          kind: 'mismatch',
          why: `任务 ${row.taskId} 在库里是 ${ctx.repo.owner}/${ctx.repo.name}#${ctx.issueNumber}，和账上的 ${row.owner}/${row.name}#${row.issueNumber} 对不上`,
        };
      const current = await intakeTaskRow(w.db, ctx.repo.id, ctx.issueNumber);
      if (current === null || current.id !== row.taskId)
        return { ok: false, kind: 'mismatch', why: `这张单现在对应的任务不是 ${row.taskId}` };
      if (current.executor !== 'engine')
        return {
          ok: false,
          kind: 'mismatch',
          why: `任务现在 executor=${current.executor}，不属于引擎，不再动手`,
        };
      const repo = await findRepo(row.owner, row.name);
      if (repo === null || repo.id !== ctx.repo.id)
        return { ok: false, kind: 'unknown', why: `读不到受管的仓 ${row.owner}/${row.name}，这一轮不动手` };
      return {
        ok: true,
        repo,
        title: ctx.title,
        canAct: ACTIVE_STATES.includes(current.state),
        state: current.state,
      };
    } catch (err) {
      return { ok: false, kind: 'unknown', why: `核任务归属时读库失败：${errMessage(err)}` };
    }
  };

  type Gate =
    | { kind: 'ready' }
    | { kind: 'exists'; workflowId: string; generation: number }
    /** alive：身份已核对上、但还没终止的旧代（接续可对其中仍停着的补发叫停）；读不到时没有。 */
    | { kind: 'waiting'; why: string; alive?: GenerationView[] }
    | { kind: 'final'; why: string };

  /**
   * 每次起新代之前都走这一关：现读全部代次。先核全部旧代——run 身份必须和叫停前记下的一致、数量不能少、且都真实终止；
   * 旧代没核完（还在跑/读不到）一律等，哪怕新代已经存在也不能报完成；旧代都核完了，新代已存在才算「已存在」，不再起。
   * 读不到、还在跑只是等（waiting）；身份对不上、旧代不见了是不能再接续（final）。
   */
  const gateOf = async (client: TemporalClient, row: ParkedRetryRow, trail: RedoTrail): Promise<Gate> => {
    const read = await readGenerations(client, row);
    if (!read.ok) return { kind: 'waiting', why: read.why };
    const gens = read.generations;
    for (const known of trail.runs) {
      const seen = gens.find((g) => g.workflowId === known.workflowId);
      if (!seen) return { kind: 'final', why: `旧代 ${known.workflowId} 现在读不到了，身份对不上，不再接续` };
      const runId = runIdOf(seen);
      if (runId === null)
        return { kind: 'waiting', why: `旧代 ${known.workflowId} 这次读不到有效的 run 身份，先不动` };
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
    const alive = gens.slice(0, trail.fromGeneration).filter((g) => g.life !== 'terminated');
    if (alive.length > 0)
      return {
        kind: 'waiting',
        why: `旧代 ${alive.map((g) => g.workflowId).join('、')} 终态未确认（仍在运行）`,
        alive,
      };
    const next = gens[trail.fromGeneration];
    if (next) return { kind: 'exists', workflowId: next.workflowId, generation: next.generation };
    return { kind: 'ready' };
  };

  /** 叫停发出后等旧代这一次执行终止最多 ABANDON_WAIT_MS；读不到状态不算终止，等不到抛 StopUnconfirmedError。 */
  const waitTerminal = async (client: TemporalClient, id: string, runId: string) => {
    const deadline = clock.nowMs() + ABANDON_WAIT_MS;
    let last = '一直没读到状态';
    while (clock.nowMs() < deadline) {
      try {
        if ((await lifeOf(client, id, runId)) === 'terminated') return;
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
    // 任何副作用之前：任务归属（账上的 task id/ref、executor=engine、停着/已放弃）和全部旧代的 run 身份都要核全
    const owned = await verifyOwnership(row);
    if (!owned.ok) return { ok: false, why: `${owned.why}（${workflowId}），没有重做` };
    if (!owned.canAct)
      return {
        ok: false,
        why: `任务现在的状态是 ${owned.state}，不是停着/已放弃（${workflowId}），没有重做`,
      };
    return w.temporal.use(async (client): Promise<CommanderRedoOutcome> => {
      const read = await readGenerations(client, row);
      if (!read.ok) return read;
      const made = trailOf(read.generations, row, workflowId);
      if (!made.ok) return { ok: false, why: made.why };
      const trail = made.trail;
      const runIdFor = (id: string): string => {
        const hit = trail.runs.find((r) => r.workflowId === id);
        if (!hit) throw new Error(`旧代 ${id} 不在已核的身份里`);
        return hit.runId;
      };
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
              const status = await withDeadline((c) => pinned(c, id, runIdFor(id)).query(taskStatusQuery));
              return redoCanStop(status.phase) ? 'parked' : 'running';
            } catch (err) {
              return isWorkflowGone(err) ? 'parked' : 'running';
            }
          },
          abandonParked: async (id) => {
            if (phase === 'idle') {
              // 先记账再叫停：账写不进就不发，回执才能如实写「任务没动」
              await journal({ phase: 'stop-requested', trail });
              ledgered = true;
              // 前面读代次、查姿态、写账都耗时：真正发叫停前最后一刻再读一次任务归属，不复用开头读到的结果
              const last = await verifyOwnership(row);
              if (!last.ok) {
                if (last.kind === 'mismatch') throw new GateFinalError(last.why);
                throw new StopUnconfirmedError(`${last.why}（发叫停前最后一次复核，没有发叫停）`);
              }
              if (!last.canAct)
                throw new GateFinalError(
                  `任务现在的状态是 ${last.state}，不是停着/已放弃，不再叫停（发叫停前最后一次复核，没有发叫停）`,
                );
              phase = 'stop';
              // 本轮先对全部已核停住的旧代发完叫停请求，不等尚未请求的代次；每条都钉住已核 run。
              // 未确认的请求由接续入口重核归属、run 和姿态后有界补齐。
              const failures: string[] = [];
              for (const g of read.generations.filter((x) => x.life === 'running')) {
                try {
                  await withDeadline((c) =>
                    pinned(c, g.workflowId, runIdFor(g.workflowId)).signal(taskAbandonSignal, {
                      by: COMMANDER_ACTOR,
                      reason: '指挥官判重做：先叫停停住的上一代',
                    }),
                  );
                } catch (err) {
                  if (!isWorkflowGone(err)) failures.push(`${g.workflowId}：${errMessage(err)}`);
                }
              }
              if (failures.length > 0)
                throw new StopUnconfirmedError(
                  `叫停请求有 ${failures.length} 条没发成：${failures.join('；')}`,
                );
            }
            await waitTerminal(client, id, runIdFor(id));
          },
          start: async (id) => {
            // 起之前把任务归属和全部旧代的真实终态、run 身份再核一遍，不信前面的等待结果
            const again = await verifyOwnership(row);
            if (!again.ok) {
              if (again.kind === 'mismatch') throw new GateFinalError(again.why);
              throw new StopUnconfirmedError(again.why);
            }
            const gate = await gateOf(client, row, trail);
            if (gate.kind === 'final') throw new GateFinalError(gate.why);
            if (gate.kind === 'exists') {
              existing = { workflowId: gate.workflowId, generation: gate.generation };
              return 'already_exists';
            }
            if (gate.kind !== 'ready') throw new StopUnconfirmedError(gate.why);
            if (!again.canAct)
              throw new GateFinalError(`任务现在的状态是 ${again.state}，不是停着/已放弃，不再起新代`);
            phase = 'old-terminal';
            await journal({
              phase: 'start-requested',
              trail,
              newWorkflowId: id,
              generation: trail.fromGeneration + 1,
            });
            ledgered = true;
            // 写账和前面的远端读都耗时：真正 Start 前最后一刻再读一次任务归属，不复用前面读到的结果
            const last = await verifyOwnership(row);
            if (!last.ok) {
              if (last.kind === 'mismatch') throw new GateFinalError(last.why);
              throw new StopUnconfirmedError(`${last.why}（起新代前最后一次复核，没有发 Start）`);
            }
            if (!last.canAct)
              throw new GateFinalError(
                `任务现在的状态是 ${last.state}，不是停着/已放弃，不再起新代（起新代前最后一次复核，没有发 Start）`,
              );
            phase = 'start';
            const started = await startGeneration(row, last.repo, last.title, id);
            if (started === 'already_exists')
              existing = { workflowId: id, generation: trail.fromGeneration + 1 };
            return started;
          },
        });
      } catch (err) {
        const why = errMessage(err);
        if (err instanceof GateFinalError) {
          // 起新代前核到不能再接续的事实：已经叫停过的才有账可收口，什么都没发就是原样失败
          if (!ledgered) return { ok: false, why };
          await journalBestEffort(journal, { phase: 'given-up', why });
          // 叫停账写了、但发叫停前最后一次复核就被拒：什么都没发出去，回执照实写「任务没动」，不说「叫停已经执行」
          if (phase === 'idle') return { ok: false, why };
          return { ok: false, why, stage: 'final' };
        }
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
    // 每次接续都从现有任务/仓记录重核归属：转本机、任务对不上都拒绝（已核实的事实 → final），读不到只是这一轮不动
    const owned = await verifyOwnership(row);
    if (!owned.ok)
      return { ok: false, stage: owned.kind === 'mismatch' ? 'final' : 'waiting', why: owned.why };
    return w.temporal.use(async (client): Promise<CommanderRedoOutcome> => {
      let gate = await gateOf(client, row, trail);
      // 叫停请求记账后进程崩溃、或部分旧代的信号根本没送到：在同一授权意图内、对账上已核 run 且姿态仍是 parked 的旧代补发叫停。
      // 每次动手前都已重核归属（canAct）和全部旧代身份（gateOf）；旧代在干活、已在收尾、读不到姿态的一律不发；
      // 先记 stop-requested 再发（幂等信号），最多 PARK_TRIAGE_REDO_STOP_TRIES 轮，发完只重读一次、不等待。
      if (gate.kind === 'waiting' && gate.alive && gate.alive.length > 0 && owned.canAct && opts.canSignal) {
        const parked: GenerationView[] = [];
        for (const g of gate.alive) {
          const runId = runIdOf(g);
          if (runId === null)
            return { ok: false, stage: 'waiting', why: `旧代 ${g.workflowId} 的 run 身份未核实，不补发叫停` };
          try {
            const status = await withDeadline((c) => pinned(c, g.workflowId, runId).query(taskStatusQuery));
            if (status.phase === 'parked') parked.push(g);
            else if (status.phase !== 'abandoned')
              return {
                ok: false,
                stage: 'waiting',
                why: `旧代 ${g.workflowId} 现在处于 ${status.phase}，整批不补发叫停`,
              };
          } catch (err) {
            return {
              ok: false,
              stage: 'waiting',
              why: `旧代 ${g.workflowId} 的姿态没查成，整批不补发叫停：${errMessage(err)}`,
            };
          }
        }
        if (parked.length > 0) {
          try {
            await journal({ phase: 'stop-requested', trail });
          } catch (err) {
            return { ok: false, stage: 'waiting', why: `接续账没写进，没有补发叫停：${errMessage(err)}` };
          }
          // 姿态查询和写账都耗时：真正补发前最后一刻再读一次任务归属，不复用开头读到的结果
          const beforeSignal = await verifyOwnership(row);
          if (!beforeSignal.ok)
            return {
              ok: false,
              stage: beforeSignal.kind === 'mismatch' ? 'final' : 'waiting',
              why: `${beforeSignal.why}（补发叫停前最后一次复核，没有发叫停）`,
            };
          if (!beforeSignal.canAct)
            return {
              ok: false,
              stage: 'waiting',
              why: `任务状态已变成 ${beforeSignal.state}，这一轮不补发叫停`,
            };
          const failures: string[] = [];
          for (const g of parked) {
            try {
              await withDeadline((c) =>
                pinned(c, g.workflowId, runIdOf(g) ?? '').signal(taskAbandonSignal, {
                  by: COMMANDER_ACTOR,
                  reason: '指挥官判重做：补发叫停停住的上一代',
                }),
              );
            } catch (err) {
              if (!isWorkflowGone(err)) failures.push(`${g.workflowId}：${errMessage(err)}`);
            }
          }
          if (failures.length > 0) {
            const why = `补发叫停请求有 ${failures.length} 条没发成：${failures.join('；')}`;
            await journalBestEffort(journal, { phase: 'stop-unconfirmed', why });
            return { ok: false, stage: 'stop-unconfirmed', why };
          }
          gate = await gateOf(client, row, trail);
          if (gate.kind === 'waiting') {
            const why = `已补发叫停请求（第 ${pending.stopAttempts + 1} 轮），旧代终态仍未确认：${gate.why}`;
            await journalBestEffort(journal, { phase: 'stop-unconfirmed', why });
            return { ok: false, stage: 'stop-unconfirmed', why };
          }
        }
      }
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
      if (!owned.canAct)
        return {
          ok: false,
          stage: 'final',
          why: `已核实旧代都已终止、新代不存在，但任务现在的状态是 ${owned.state}，不是停着/已放弃，不再动手`,
        };
      if (!opts.canStart)
        return {
          ok: false,
          stage: 'final',
          why: `已核实旧代都已终止、新代不存在，但接续已过 24 小时或起新代已试满 ${PARK_TRIAGE_REDO_START_TRIES} 次，不再发起新的启动`,
        };
      const id = taskWorkflowId({ owner: row.owner, name: row.name }, row.issueNumber, generation);
      try {
        await journal({ phase: 'start-requested', trail, newWorkflowId: id, generation });
      } catch (err) {
        return { ok: false, stage: 'waiting', why: `接续账没写进，没有起新代：${errMessage(err)}` };
      }
      // 读代次和写账都耗时：真正 Start 前最后一刻再读一次任务归属，不复用开头读到的结果
      const last = await verifyOwnership(row);
      if (!last.ok)
        return {
          ok: false,
          stage: last.kind === 'mismatch' ? 'final' : 'waiting',
          why: `${last.why}（起新代前最后一次复核，没有发 Start）`,
        };
      if (!last.canAct)
        return {
          ok: false,
          stage: 'final',
          why: `任务现在的状态是 ${last.state}，不是停着/已放弃，不再起新代（起新代前最后一次复核，没有发 Start）`,
        };
      let started: 'started' | 'already_exists';
      try {
        started = await startGeneration(row, last.repo, last.title, id);
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
    async acceptanceRetry({ task, attempt, why, cause }) {
      const workflowId = `acceptance:${task.taskId}:${task.prNumber}:${task.head}`;
      const unverified = cause === 'unverified';
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
          // unverified：会话回了但裁决读不懂/核不过/没执行成；session：主线头读不到/会话没起成/回答认不出。
          // 两种合用 jobs 里 24 小时 PARK_TRIAGE_SESSION_TRIES 次预算；why（限长）供用满后每轮报告原因，不另建账。
          cause: unverified ? 'unverified' : 'session',
          why: why.slice(0, 500),
        },
        reason: unverified
          ? `验收责任没核完（第 ${attempt} 次，机读或执行失败，不是创始人证据），责任仍 open，下一轮再核`
          : `验收责任会话没起成（第 ${attempt} 次），下一轮再看`,
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
          // workflowId + parkSeq 0 是验收候选的认领键：jobs 凭它认出「已转人」（action=leave）的那条记录。
          workflowId: `acceptance:${task.taskId}:${task.prNumber}:${task.head}`,
          parkSeq: 0,
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
