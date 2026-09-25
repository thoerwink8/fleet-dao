// 飞书里确认的草稿 → 开 GitHub issue、建任务行、拉起需求工作流（TaskIntake，真实现由引擎那边接，见 ports.ts）。
// 确认时当场试一次（有时限）；没成的草稿留在「待开单」，这里定时补开，按次数退避。开单接上之前一律没成、留着，不丢。
import { clip } from './feishu-records.ts';
import { issueTitle } from './feishu-views.ts';
import {
  type DraftRecord,
  IntakeUnavailableError,
  type Logger,
  type Store,
  type TaskIntake,
} from './ports.ts';

/** 开单还没接上时的去处：一律如实没成（草稿留在待开单），不装作开成了。 */
export function notWiredTaskIntake(): TaskIntake {
  return {
    async open() {
      throw new IntakeUnavailableError('开单还没接上（等引擎接 GitHub 与需求工作流，#28 / #43）');
    },
  };
}

/** 确认时当场等开单最多这么久（网关给确认 15 秒）；过了就先回「已确认、待开单」，后台接着补。 */
export const INTAKE_CONFIRM_WAIT_MS = 8_000;
const INTAKE_RETRY_WAIT_MS = 30_000;
const RETRY_EVERY_MS = 60_000;
/** 第 n 次没成之后隔 2^(n-1) 分钟再试，最多隔 30 分钟。 */
const MAX_BACKOFF_MS = 30 * 60_000;
const BATCH = 50;

export type IntakeOutcome = 'opened' | 'failed' | 'skipped';

export interface IntakeRunner {
  /** 给这张草稿开单（确认了、还没任务的才开）。开单这一步的失败记在草稿上、不往外抛；库出错照样抛。 */
  openOne(draft: DraftRecord, timeoutMs?: number): Promise<IntakeOutcome>;
  /** 补开一轮：待开单的草稿里到了重试时刻的逐个开（ignoreBackoff = 不管退避，例如进程刚起来）。 */
  runPending(ignoreBackoff?: boolean): Promise<{ opened: number; failed: number }>;
  /** 定时补开；返回停止函数。 */
  start(everyMs?: number): () => void;
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

export function createIntakeRunner(deps: {
  store: Store;
  intake: TaskIntake;
  log: Logger;
  now: () => Date;
}): IntakeRunner {
  const { store, log } = deps;
  /** 同一张草稿同一时刻只开一次：确认和补开撞上时，后来的等前一个的结果。 */
  const inflight = new Map<string, Promise<IntakeOutcome>>();

  async function fail(draft: DraftRecord, why: string, level: 'warn' | 'error' = 'warn'): Promise<'failed'> {
    // 同一个原因只在第一次记日志（没接上时每分钟都会失败一遍）。
    if (why !== draft.intake.error)
      log[level]('草稿待开单：开单这一步没成，留着稍后补开', { draftId: draft.id, error: why });
    await store.recordIntakeFailure({ draftId: draft.id, error: clip(why, 1000) });
    return 'failed';
  }

  async function attempt(draft: DraftRecord, timeoutMs: number): Promise<IntakeOutcome> {
    if (draft.status !== 'confirmed' || draft.taskId !== undefined) return 'skipped';
    const repo = draft.repoId === undefined ? null : await store.getRepo(draft.repoId);
    if (!repo) return fail(draft, `草稿放的仓 ${draft.repoId ?? '（没选）'} 在库里找不到`, 'error');
    const [proposer, confirmer] = await Promise.all([
      store.getUser(draft.proposedBy),
      draft.confirmedBy === undefined ? null : store.getUser(draft.confirmedBy),
    ]);
    if (!proposer || !confirmer) return fail(draft, '草稿的提出人或确认人在库里找不到', 'error');
    let opened: { taskId: string; issueNumber: number };
    try {
      opened = await deps.intake.open(
        {
          draftId: draft.id,
          repo,
          title: issueTitle(draft.understanding),
          rawText: draft.rawText,
          understanding: draft.understanding,
          proposedBy: { userId: proposer.id, name: proposer.displayName },
          confirmedBy: { userId: confirmer.id, name: confirmer.displayName },
        },
        AbortSignal.timeout(timeoutMs),
      );
    } catch (err) {
      return fail(
        draft,
        err instanceof IntakeUnavailableError
          ? err.message
          : `开单出错：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const recorded = await store.recordIntake({ draftId: draft.id, taskId: opened.taskId });
    if (recorded === 'task_not_found') {
      return fail(draft, `开单回的任务 ${opened.taskId} 在库里找不到`, 'error');
    }
    if (recorded === 'ok') {
      log.info('草稿开成了任务', {
        draftId: draft.id,
        taskId: opened.taskId,
        issueNumber: opened.issueNumber,
      });
      return 'opened';
    }
    return 'skipped';
  }

  function openOne(draft: DraftRecord, timeoutMs = INTAKE_CONFIRM_WAIT_MS): Promise<IntakeOutcome> {
    const running = inflight.get(draft.id);
    if (running) return running;
    const p = attempt(draft, timeoutMs).finally(() => inflight.delete(draft.id));
    inflight.set(draft.id, p);
    return p;
  }

  async function runPending(ignoreBackoff = false) {
    const now = deps.now().getTime();
    let opened = 0;
    let failed = 0;
    for (const draft of await store.listPendingIntakes(BATCH)) {
      const tried = draft.intake.triedAt === undefined ? undefined : Date.parse(draft.intake.triedAt);
      if (!ignoreBackoff && tried !== undefined && tried + backoffMs(draft.intake.attempts) > now) continue;
      const outcome = await openOne(draft, INTAKE_RETRY_WAIT_MS);
      if (outcome === 'opened') opened += 1;
      else if (outcome === 'failed') failed += 1;
    }
    return { opened, failed };
  }

  return {
    openOne,
    runPending,
    start(everyMs = RETRY_EVERY_MS) {
      let stopped = false;
      let running = false;
      const tick = (ignoreBackoff: boolean) => {
        if (stopped || running) return;
        running = true;
        runPending(ignoreBackoff)
          .catch((err) =>
            log.error('补开待开单的草稿时出错（多半是库连不上），下一轮再试', { error: String(err) }),
          )
          .finally(() => {
            running = false;
          });
      };
      // 进程刚起来（例如开单刚接上、发了新版）先不管退避全试一遍。
      tick(true);
      const timer = setInterval(() => tick(false), everyMs);
      timer.unref?.();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
