// 被撤的任务重做（驾驶舱「重做」）：同一张单另起一代任务工作流，编号 task:<仓>#<号>:r2。
// 旧的那一代已经终止、记录留着；还在跑就拒绝。接活扫描不走这里（撤掉的单不会自己重来）。
// 不碰工作流代码：编号是起的时候从外面传的，不用 patched()。
import { parseTaskWorkflowId, taskWorkflowId, type WorkflowRepoRef } from '@fleet-dao/shared/workflow-ids';

/** 一张单最多重做到第几代。再往上不再另起，免得编号无限长。 */
export const MAX_TASK_GENERATION = 20;

/** Temporal 的状态名：这几个是已经结束。其余（RUNNING、认不出的）都当还在跑，重做不许在看不清的时候另起。 */
const TERMINATED_STATUS = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
]);

export function generationLife(statusName: string): 'running' | 'terminated' {
  return TERMINATED_STATUS.has(statusName) ? 'terminated' : 'running';
}

export interface GenerationView {
  workflowId: string;
  generation: number;
  life: 'running' | 'terminated';
  /** 这一代自己的记录。重做只读，不许改、不许换成别的对象。 */
  record: unknown;
}

export interface RedoDeps {
  /** 已经有的每一代。空 = 这张单从没起过任务。 */
  list(): Promise<readonly GenerationView[]>;
  /**
   * 用一个新编号起工作流。编号已经有执行（开着或已结束）必须回 already_exists，并且不许换掉那一条的记录。
   */
  start(workflowId: string): Promise<'started' | 'already_exists'>;
}

export type RedoOutcome = { ok: true; workflowId: string; generation: number } | { ok: false; why: string };

/** 顺着 1、2、3… 问到第一个没有的为止。中间缺了、问不清，都不跳过去猜后面。 */
export type GenerationProbe =
  | { life: 'running' | 'terminated'; record: unknown }
  | { life: 'missing' }
  | { life: 'unknown' };

export async function readTaskGenerations(
  repo: WorkflowRepoRef,
  issueNumber: number,
  describe: (workflowId: string) => Promise<GenerationProbe>,
): Promise<{ ok: true; generations: GenerationView[] } | { ok: false; why: string }> {
  const generations: GenerationView[] = [];
  for (let generation = 1; generation <= MAX_TASK_GENERATION; generation++) {
    const workflowId = taskWorkflowId(repo, issueNumber, generation);
    const seen = await describe(workflowId);
    if (seen.life === 'missing') return { ok: true, generations };
    if (seen.life === 'unknown') {
      return { ok: false, why: `查不到上一代是不是还在跑（${workflowId}），没有另起` };
    }
    generations.push({ workflowId, generation, life: seen.life, record: seen.record });
  }
  return { ok: true, generations };
}

export type SeenLife = 'running' | 'closed' | 'missing';

/**
 * 这张单有没有一代还在跑（工作树对账：在跑才算占着树）。第一代没有就停，不去猜后面。
 * 问不清照抛：调用方记没查成，不当成不在跑。
 */
export async function runningTaskWorkflowId(
  repo: WorkflowRepoRef,
  issueNumber: number,
  stateOf: (workflowId: string) => Promise<SeenLife>,
): Promise<string | null> {
  for (let generation = 1; generation <= MAX_TASK_GENERATION; generation++) {
    const id = taskWorkflowId(repo, issueNumber, generation);
    const state = await stateOf(id);
    if (state === 'running') return id;
    if (state === 'missing') return null;
  }
  return null;
}

/**
 * 驾驶舱发信号该打到哪一代：在跑的那一代；都结束了就打到最高的那一代（收不到是 workflow_gone）；
 * 一代都没有，退回第一代的编号（和改重做之前一样）。问不清照抛，不假装打到第一代。
 */
export async function signalTaskWorkflowId(
  repo: WorkflowRepoRef,
  issueNumber: number,
  stateOf: (workflowId: string) => Promise<SeenLife>,
): Promise<string> {
  let highestClosed: string | null = null;
  for (let generation = 1; generation <= MAX_TASK_GENERATION; generation++) {
    const id = taskWorkflowId(repo, issueNumber, generation);
    const state = await stateOf(id);
    if (state === 'running') return id;
    if (state === 'missing') return highestClosed ?? taskWorkflowId(repo, issueNumber, 1);
    highestClosed = id;
  }
  return highestClosed ?? taskWorkflowId(repo, issueNumber, 1);
}

/** 给同一张单起下一代。任何一代还在跑都拒绝；不起新的就不调用 start。 */
export async function redoTask(deps: RedoDeps): Promise<RedoOutcome> {
  const listed = [...(await deps.list())];
  if (listed.length === 0) return { ok: false, why: '没有上一代任务可重做' };

  const running = listed.find((row) => row.life === 'running');
  if (running) return { ok: false, why: `上一代还在跑（${running.workflowId}），先叫停再重做` };

  const sample = listed[0];
  if (!sample) return { ok: false, why: '没有上一代任务可重做' };
  const parsed = parseTaskWorkflowId(sample.workflowId);
  if (!parsed) return { ok: false, why: '没有上一代任务可重做' };

  const byGeneration = new Map(listed.map((row) => [row.generation, row]));
  const max = listed.reduce((acc, row) => Math.max(acc, row.generation), 0);
  for (let generation = 1; generation <= max; generation++) {
    const row = byGeneration.get(generation);
    if (!row) return { ok: false, why: `查不到第 ${generation} 代是不是还在跑，没有另起` };
    if (row.life === 'running') return { ok: false, why: `上一代还在跑（${row.workflowId}），先叫停再重做` };
  }

  const next = max + 1;
  if (next > MAX_TASK_GENERATION) {
    return { ok: false, why: `已经重做到第 ${MAX_TASK_GENERATION} 代，不再另起` };
  }
  const workflowId = taskWorkflowId(parsed.repo, parsed.issueNumber, next);
  const started = await deps.start(workflowId);
  if (started === 'already_exists') {
    return { ok: false, why: `编号 ${workflowId} 已经有记录，没有覆盖旧代，也没另起` };
  }
  return { ok: true, workflowId, generation: next };
}
