// 被撤的任务重做：同一张单另起一代，编号 task:<仓>#<号>:r2。
// 判断放这里，驾驶舱后端和引擎引同一份。驾驶舱后端不依赖引擎包：
// 依赖引擎的包在引擎一改时就要重测，而改引擎只该测引擎自己（conventions 的 ci-plan）。
// 旧的那一代已经终止、记录留着。还在跑但只是停在 parked：调用方先叫停，等它终止再另起。
// 真在跑就拒绝，不叫停。没给叫停口子时，任何还在跑的都拒绝（和以前一样）。
// 接活扫描不走这里（撤掉的单不会自己重来）。
// 不碰工作流代码：编号是起的时候从外面传的，不用 patched()。
import { errMessage } from './util.ts';
import { parseTaskWorkflowId, taskWorkflowId, type WorkflowRepoRef } from './workflow-ids.ts';

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
  /**
   * 这一代的工作流还在 Temporal 里。停在等人（phase=parked）或已经在收尾放弃（phase=abandoned）回 parked；
   * 真在干活、被人暂停、或看不清，回 running。只问，不叫停。
   * 和 abandonParked 一起给；缺一个就当没有，任何还在跑的都拒绝。
   */
  posture?(workflowId: string): Promise<'parked' | 'running'>;
  /**
   * 把停着等人的那一代叫停，并等到工作流终止。没停下来就抛错，调用方不另起。
   * 只在 posture 对所有还在跑的都回了 parked 之后才调。
   */
  abandonParked?(workflowId: string): Promise<void>;
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

function stillRunning(workflowId: string): RedoOutcome {
  return { ok: false, why: `上一代还在跑（${workflowId}），先叫停再重做` };
}

/**
 * 这一代可以先叫停再重做：停着等人（parked），或已经在收尾放弃（abandoned，工作树还在收）。
 * 真在干活（动手、等 CI、被人暂停）不是，重做照旧拒绝。
 */
export function redoCanStop(phase: unknown): boolean {
  return phase === 'parked' || phase === 'abandoned';
}

/**
 * 给同一张单起下一代。真在跑的一代拒绝，不起新的就不调用 start。
 * 还在跑但只是停在 parked，或已经在收尾放弃：先全部问清，再叫停，等终止后才另起。中间有一代问不清或真在跑，一台都不叫停。
 */
export async function redoTask(deps: RedoDeps): Promise<RedoOutcome> {
  const listed = (await deps.list()).map((row) => ({ ...row }));
  if (listed.length === 0) return { ok: false, why: '没有上一代任务可重做' };

  const running = listed.filter((row) => row.life === 'running');
  const posture = deps.posture;
  const abandonParked = deps.abandonParked;
  const canStop = posture !== undefined && abandonParked !== undefined;
  // 没给叫停口子时，和以前一样：任何还在跑的当场拒绝，不去问后面的代数缺不缺。
  const firstRunning = running[0];
  if (firstRunning && !canStop) return stillRunning(firstRunning.workflowId);

  const sample = listed[0];
  if (!sample) return { ok: false, why: '没有上一代任务可重做' };
  const parsed = parseTaskWorkflowId(sample.workflowId);
  if (!parsed) return { ok: false, why: '没有上一代任务可重做' };

  const parked: GenerationView[] = [];
  for (const row of running) {
    if (!posture) return stillRunning(row.workflowId);
    if ((await posture(row.workflowId)) !== 'parked') return stillRunning(row.workflowId);
    parked.push(row);
  }

  const byGeneration = new Map(listed.map((row) => [row.generation, row]));
  const max = listed.reduce((acc, row) => Math.max(acc, row.generation), 0);
  for (let generation = 1; generation <= max; generation++) {
    const row = byGeneration.get(generation);
    if (!row) return { ok: false, why: `查不到第 ${generation} 代是不是还在跑，没有另起` };
  }

  for (const row of parked) {
    if (!abandonParked) return stillRunning(row.workflowId);
    await abandonParked(row.workflowId);
    row.life = 'terminated';
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

/**
 * 受管起代的账（任务行锁里的起代意图）。驾驶舱、task 命令、指挥官的重做都套 fenceRedo，和受管纠正抢同一行。
 * begin 落意图（会接手结果未知的旧意图）；bind 在起 Temporal 之前绑目标代数，回 false 不许起；
 * settle 交这一次明确看到存在的最高代数（没有是 null），核不清已绑目标就抛错不结。
 */
export interface StartFencePorts {
  begin(): Promise<{ ok: true; intent: string } | { ok: false; why: string }>;
  bind(intent: string, workflowId: string, generation: number): Promise<boolean>;
  settle(intent: string, claimed: number | null, outcome: string): Promise<void>;
}

export interface StartFenceHooks {
  /** 真要起某一代之前调；抛错就不起。 */
  beforeStart(workflowId: string): Promise<void>;
  /** 列代问清了：1..generation 每一代都在 Temporal 里（明确看到存在，那几代的起代结果已定）。 */
  observed(generation: number): void;
}

export class StartSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartSupersededError';
  }
}

/**
 * 套着受管起代意图重做。结果明确才结算：
 * - 列代时明确看到存在的最高代数，核清不高于它的旧目标（列代在接手之后，旧意图已绑不了新目标）；
 * - 绑了目标、起的那一步正常回来（起成或编号已存在），这一代也是明确的；
 * - 绑了目标之后抛错（超时、连不上、进程退出）：这一代结果未知，不结，意图挂着，纠正一直拒绝，下次重做再核清。
 * 结算没写进或核不清：起代结果照实交回，意图挂着（保守）。
 */
export async function fenceRedo(
  ports: StartFencePorts,
  redo: (hooks: StartFenceHooks) => Promise<RedoOutcome>,
): Promise<RedoOutcome> {
  const begun = await ports.begin();
  if (!begun.ok) return begun;
  let bound: number | null = null;
  let seen = 0;
  const settle = (claimed: number | null, outcome: string) => ports.settle(begun.intent, claimed, outcome);
  let outcome: RedoOutcome;
  try {
    outcome = await redo({
      async beforeStart(workflowId) {
        const generation = parseTaskWorkflowId(workflowId)?.generation;
        if (generation === undefined)
          throw new StartSupersededError(`认不出要起的编号 ${workflowId}，没有起`);
        if (!(await ports.bind(begun.intent, workflowId, generation)))
          throw new StartSupersededError('这次起代意图已被后来的起代接手或已经结算，没有再起');
        bound = generation;
      },
      observed(generation) {
        if (Number.isSafeInteger(generation) && generation > seen) seen = generation;
      },
    });
  } catch (err) {
    if (err instanceof StartSupersededError) return { ok: false, why: err.message };
    // 还没绑目标：没走到起，这一次明确没起；看到的代数照样能核清旧目标
    if (bound === null) await settle(seen || null, `not_started ${errMessage(err)}`).catch(() => undefined);
    throw err;
  }
  const claimed = Math.max(bound ?? 0, seen) || null;
  try {
    await settle(claimed, outcome.ok ? `started ${outcome.workflowId}` : `not_started ${outcome.why}`);
  } catch (err) {
    if (outcome.ok) return outcome;
    return { ok: false, why: `${outcome.why}；起代没有结算（${errMessage(err)}）` };
  }
  return outcome;
}
