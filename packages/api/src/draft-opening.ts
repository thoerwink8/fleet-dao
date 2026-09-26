// 飞书草稿开单：确认了的草稿 → 开 GitHub issue、建任务行、拉起需求工作流（DraftOpener，真实现由引擎那边接，见 ports.ts）。
// 确认时当场开一次、最多等几秒；没成的留在「待开单」，这里每分钟补开一轮，按次数退避。开单接上之前一律没成、留着，不丢。
// 时限自己掐，不指望实现理会 signal：到点没回就记「开单超时」、算没成；那次调用留在 inflight 里直到真的结束，
// 期间这张草稿不开第二次。一直开不成由健康检查（draft_opener、draft_backlog）报红。
import { clip } from './feishu-records.ts';
import { issueTitle } from './feishu-views.ts';
import { PublicHealthError } from './health.ts';
import {
  type DraftOpener,
  DraftOpenerUnavailableError,
  type DraftOpenRequest,
  type DraftOpenResult,
  type DraftRecord,
  type Logger,
  type Store,
} from './ports.ts';

/** 健康检查里「未接」那一句（公网看得到）。 */
export const DRAFT_OPENER_NOT_WIRED = '飞书草稿开成 issue 还没接上（#91）';

/**
 * 开单还没接上时的去处：一律如实没成（草稿留在待开单），不装作开成了。带着 notWired 标记：健康检查据此报「未接」、
 * 不把整体拖红（serviceHealthChecks）；check 本身照旧报红，万一被直接调也不会装作好了。真开单记在 #91。
 */
export function notWiredDraftOpener(): DraftOpener {
  const why = '飞书草稿开单还没接上（开 issue、拉起需求工作流那一步，等 #91）';
  return {
    notWired: DRAFT_OPENER_NOT_WIRED,
    async open() {
      throw new DraftOpenerUnavailableError(why);
    },
    async check() {
      throw new PublicHealthError('not_wired', why);
    },
  };
}

/** 确认时当场等开单最多这么久（网关等确认 15 秒）；没等到先回「已确认、待开单」，这次调用在后台接着跑。 */
export const DRAFT_OPEN_CONFIRM_WAIT_MS = 8_000;
/** 一次开单最多等这么久：到点记「开单超时」、算没成，按次数退避后再补。 */
export const DRAFT_OPEN_CALL_LIMIT_MS = 30_000;
/** 最早一张待开单等了这么久还没开成：健康检查（draft_backlog）报红。 */
export const DRAFT_BACKLOG_ALERT_MS = 15 * 60_000;
const RETRY_EVERY_MS = 60_000;
/** 第 n 次没成之后隔 2^(n-1) 分钟再试，最多隔 30 分钟。 */
const MAX_BACKOFF_MS = 30 * 60_000;
const BATCH = 50;

/**
 * opened = 开成了；failed = 没成（原因记在草稿上）；pending = 没等到结果（这次调用在后台接着跑）；
 * skipped = 不用开（已经开成、没确认、草稿不在），或上一次调用超时后还挂着（不开第二次）。
 */
export type DraftOpenOutcome = 'opened' | 'failed' | 'pending' | 'skipped';

export interface DraftOpenLimits {
  /** 确认时等多久（DRAFT_OPEN_CONFIRM_WAIT_MS）。 */
  confirmWaitMs: number;
  /** 一次开单最多等多久（DRAFT_OPEN_CALL_LIMIT_MS）。 */
  callLimitMs: number;
}

export interface DraftOpenRunner {
  /**
   * 给这张草稿开单（确认了、还没任务的才开；开之前重读草稿），最多等 waitMs（默认是确认时的时限）。
   * 这张草稿已经在开：不调第二次，等那一次。开单这一步的失败记在草稿上、不往外抛；库出错照样抛。
   */
  openOne(draftId: string, waitMs?: number): Promise<DraftOpenOutcome>;
  /** 补开一轮：待开单的草稿里到了重试时刻的逐个开（ignoreBackoff = 不管退避，例如进程刚起来）。 */
  runPending(ignoreBackoff?: boolean): Promise<{ opened: number; failed: number }>;
  /** 定时补开；返回停止函数。 */
  start(everyMs?: number): () => void;
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** 等 done 最多 ms 毫秒；没等到就是 pending（done 照样跑完）。 */
function within<T>(done: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms);
  });
  return Promise.race([done, deadline]).finally(() => clearTimeout(timer));
}

interface Flight {
  done: Promise<DraftOpenOutcome>;
  /** 实现到点没回、已经记了「开单超时」：调用还挂着，这张草稿不开第二次，也不再干等。 */
  overdue: boolean;
}

export function createDraftOpenRunner(deps: {
  store: Store;
  opener: DraftOpener;
  log: Logger;
  now: () => Date;
  limits?: Partial<DraftOpenLimits> | undefined;
}): DraftOpenRunner {
  const { store, log } = deps;
  const confirmWaitMs = deps.limits?.confirmWaitMs ?? DRAFT_OPEN_CONFIRM_WAIT_MS;
  const callLimitMs = deps.limits?.callLimitMs ?? DRAFT_OPEN_CALL_LIMIT_MS;
  /** 每张草稿正在跑的那次开单。超时了也留着，直到调用真的结束：同一张草稿不同时开两次。 */
  const inflight = new Map<string, Flight>();

  async function fail(draft: DraftRecord, why: string, level: 'warn' | 'error' = 'warn'): Promise<'failed'> {
    // 同一个原因只在第一次记日志（没接上时每分钟都会失败一遍）；一直开不成由健康检查报红。
    if (why !== draft.opening.error)
      log[level]('草稿待开单：开单这一步没成，留着稍后补开', { draftId: draft.id, error: why });
    await store.recordDraftOpenFailure({ draftId: draft.id, error: clip(why, 1000) });
    return 'failed';
  }

  async function record(draft: DraftRecord, opened: DraftOpenResult): Promise<DraftOpenOutcome> {
    const recorded = await store.recordDraftOpened({ draftId: draft.id, taskId: opened.taskId });
    if (recorded === 'task_not_found') {
      return fail(draft, `开单回的任务 ${opened.taskId} 在库里找不到`, 'error');
    }
    if (recorded === 'not_pending') return 'skipped';
    log.info('草稿开成了任务', { draftId: draft.id, taskId: opened.taskId, issueNumber: opened.issueNumber });
    return 'opened';
  }

  /** 开单要交出去的东西，按重读过的草稿现查仓和人；查不到就记没成。 */
  async function requestFor(draft: DraftRecord): Promise<DraftOpenRequest | 'failed'> {
    const repo = draft.repoId === undefined ? null : await store.getRepo(draft.repoId);
    if (!repo) return fail(draft, `草稿放的仓 ${draft.repoId ?? '（没选）'} 在库里找不到`, 'error');
    const [proposer, confirmer] = await Promise.all([
      store.getUser(draft.proposedBy),
      draft.confirmedBy === undefined ? null : store.getUser(draft.confirmedBy),
    ]);
    if (!proposer || !confirmer) return fail(draft, '草稿的提出人或确认人在库里找不到', 'error');
    return {
      draftId: draft.id,
      repo,
      title: issueTitle(draft.understanding),
      rawText: draft.rawText,
      understanding: draft.understanding,
      proposedBy: { userId: proposer.id, name: proposer.displayName },
      confirmedBy: { userId: confirmer.id, name: confirmer.displayName },
    };
  }

  function launch(draftId: string): Flight {
    const flight: Flight = { overdue: false, done: Promise.resolve('skipped') };
    const release = () => {
      if (inflight.get(draftId) === flight) inflight.delete(draftId);
    };
    const run = async (): Promise<DraftOpenOutcome> => {
      // 重读：手上的可能是一分钟前列出来的，这期间可能已经开成了。
      const draft = await store.getDraft(draftId);
      if (draft?.status !== 'confirmed' || draft.taskId !== undefined) return 'skipped';
      const request = await requestFor(draft);
      if (request === 'failed') return 'failed';
      const abort = new AbortController();
      const call = deps.opener.open(request, abort.signal);
      const first = await within(
        call.then(
          (opened) => ({ opened }),
          (error: unknown) => ({ error }),
        ),
        callLimitMs,
      );
      if (first === 'pending') {
        flight.overdue = true;
        abort.abort(new Error('开单超时'));
        const failed = fail(draft, `开单超时：${callLimitMs / 1000} 秒没回`);
        // 调用还挂着：它真结束之前这张草稿不开第二次。后来开成了照样记上；后来报错只记日志（超时已经算过一次没成）。
        void failed
          .catch(() => undefined)
          .then(() => call)
          .then(
            (opened) => record(draft, opened),
            (error: unknown) => log.warn('超时的那次开单后来报错了', { draftId, error: String(error) }),
          )
          .catch((error: unknown) =>
            log.error('超时的那次开单后来开成了，记任务时出错', { draftId, error: String(error) }),
          )
          .finally(release);
        return failed;
      }
      if ('error' in first) {
        const err = first.error;
        return fail(
          draft,
          err instanceof DraftOpenerUnavailableError
            ? err.message
            : `开单出错：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return record(draft, first.opened);
    };
    flight.done = run().finally(() => {
      if (!flight.overdue) release();
    });
    inflight.set(draftId, flight);
    return flight;
  }

  async function openOne(draftId: string, waitMs = confirmWaitMs): Promise<DraftOpenOutcome> {
    const flying = inflight.get(draftId);
    // 上一次超时了还挂着：已经记过没成，不开第二次，也不干等。
    if (flying?.overdue) return 'skipped';
    const flight = flying ?? launch(draftId);
    const outcome = await within(flight.done, waitMs);
    if (outcome === 'pending') {
      // 没等到：这次调用在后台接着跑，之后出了库的错没人接，记一笔。
      flight.done.catch((error: unknown) =>
        log.error('开单这一步出错（多半是库连不上），草稿留在待开单', { draftId, error: String(error) }),
      );
    }
    return outcome;
  }

  async function runPending(ignoreBackoff = false) {
    const now = deps.now().getTime();
    let opened = 0;
    let failed = 0;
    for (const draft of await store.listDraftsToOpen(BATCH)) {
      const tried = draft.opening.triedAt === undefined ? undefined : Date.parse(draft.opening.triedAt);
      if (!ignoreBackoff && tried !== undefined && tried + backoffMs(draft.opening.attempts) > now) continue;
      // 等到这次调用有结果（到点就是超时）；多留一倍给记结果的那几下库。
      const outcome = await openOne(draft.id, callLimitMs * 2);
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
      let warned = false;
      const tick = (ignoreBackoff: boolean) => {
        if (stopped) return;
        if (running) {
          // 上一轮还没跑完（每张最多等两倍时限）：跳过这一轮，一轮只提一次。
          if (!warned) log.warn('补开待开单：上一轮还没跑完，这一轮跳过');
          warned = true;
          return;
        }
        running = true;
        runPending(ignoreBackoff)
          .catch((err) =>
            log.error('补开待开单的草稿时出错（多半是库连不上），下一轮再试', { error: String(err) }),
          )
          .finally(() => {
            running = false;
            warned = false;
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

/**
 * 健康检查 draft_backlog：最早一张待开单等了超过 alertAfterMs 还没开成就报红（开单一直不通，人要知道）。
 * 库读不到、确认时刻认不出照样报红，不当成「没有积压」。
 */
export function draftBacklogCheck(
  store: Pick<Store, 'listDraftsToOpen'>,
  now: () => Date,
  alertAfterMs = DRAFT_BACKLOG_ALERT_MS,
): () => Promise<void> {
  return async () => {
    const [oldest] = await store.listDraftsToOpen(1);
    if (!oldest) return;
    const confirmedAt = oldest.confirmedAt === undefined ? Number.NaN : Date.parse(oldest.confirmedAt);
    if (Number.isNaN(confirmedAt)) throw new Error(`待开单的草稿 ${oldest.id} 的确认时刻认不出`);
    const waited = now().getTime() - confirmedAt;
    if (waited > alertAfterMs) {
      throw new PublicHealthError(
        'backlog',
        `最早一张待开单已经等了 ${Math.floor(waited / 60_000)} 分钟还没开成`,
      );
    }
  };
}
