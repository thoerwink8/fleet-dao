// 发版前开着的总开关，发完却还关着：后端自己开回（#1859、#2084）。
// 不放在 /healthz：那是公开的 GET，不能谁来打一下就把开关打开。
// 发版进行中的那几分钟是定的暂停，等这一趟自己开回，这里不开。
// 发完之后又被关上（设置行的时刻晚于这一趟结束）不开：原因和预计重开时间不在发版进度里，分不清是不是有意关。
// 发版没成、又没停在「恢复」这一步：不开，版本可能没发好。
// 2026-10-14 09:22 CST 监督读到「总开关关着」：进度里这一趟 09:18:33 开始，09:22 还在第 3 步「等收尾」
// （第 4 步 09:31:09 才开始），发版前总开关是开着的。09:33:55 这一趟做完，体检「引擎总开关和发版前一致」通过。
// 那次是发版暂停，发完已经开回，不是误关，也不是发完没开回。判法由 master-restore.test.ts 用这几个时刻钉住。

import type { EngineMasterState } from '@fleet-dao/shared';
import type { Logger, Store } from '@fleet-dao/store';
import { readEngineMaster, setEngineMaster } from './engine-switch.ts';
import { parseTrainState } from './france-release.ts';

/** 谁开的：和命令行那条路一样记成引擎，编号分开，操作记录里认得出是这里补开的。 */
export const MASTER_RESTORE_ACTOR = { kind: 'engine', id: 'ops:master-restore' } as const;

/** 多久看一次。发完没开回要尽快补，不必等下一轮巡检。 */
export const MASTER_RESTORE_EVERY_MS = 60_000;

type TrainOk = Extract<ReturnType<typeof parseTrainState>, { ok: true }>;

export type MasterRestorePlan =
  | { action: 'already_on' }
  /** 这一趟还在走，关着是暂停。reopen 是预计什么时候开回（没有钟点就写这一趟的哪一步）。 */
  | { action: 'wait'; note: string; reopen: string }
  /** 发版前开着，现在就该开着，却还关着。reason 写进操作记录。 */
  | { action: 'turn_on'; reason: string }
  /**
   * 不开。note 是原因；reopen 是预计重开，null 表示进度里没有、要人定，不能编一个时间。
   */
  | { action: 'leave'; note: string; reopen: string | null };

function atMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

/** 发版进度里「引擎总开关和发版前一致」过了没有。没写这一项是 null，不猜它过了。 */
export function trainSwitchCheck(json: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const check = (parsed as { check?: unknown }).check;
  if (check === null || typeof check !== 'object') return null;
  const items = (check as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as { name?: unknown; ok?: unknown };
    if (row.name !== '引擎总开关和发版前一致') continue;
    return typeof row.ok === 'boolean' ? row.ok : null;
  }
  return null;
}

/**
 * 总开关现在关着，要不要由后端开回。
 * 只在「发版前开着、这一趟已经该开回」时 turn_on。拿不准就 leave，不编成该开。
 */
export function masterRestorePlan(input: {
  master: EngineMasterState;
  train: TrainOk | null;
  /** 体检里总开关那一项；这份进度没写是 null。现在的判法不用它决定开不开，测试拿它核对 2026-10-14 那次。 */
  switchCheckOk?: boolean | null;
}): MasterRestorePlan {
  if (input.master.on) return { action: 'already_on' };
  const { train } = input;
  if (train?.beforeMaster !== true || train.phaseIndex === null) {
    return {
      action: 'leave',
      note: '这次关着对不上「发版前开着、发完该开回」：没有这样的发版进度，不自动开',
      reopen: null,
    };
  }
  const idx = train.phaseIndex;
  const offAt = input.master.why === 'set' ? atMs(input.master.at) : null;
  const doneAt = atMs(train.updatedAt);
  const turnedOffAfter = offAt !== null && doneAt !== null && offAt > doneAt;

  if (train.status === 'running' || train.status === 'blocked') {
    if (idx >= 2 && idx < 7) {
      return {
        action: 'wait',
        note: `发版进行中（${train.phase}），总开关按这一趟暂停`,
        reopen: '这一趟发完开回',
      };
    }
    if (idx === 7 && train.status === 'running') {
      return {
        action: 'wait',
        note: `发版正在把总开关开回（${train.phase}）`,
        reopen: '这一步走完',
      };
    }
    if (idx === 7 || idx >= 8) {
      return {
        action: 'turn_on',
        reason: `发版走到${train.phase}（${train.target}），发版前总开关开着，却还关着，按发版前开回`,
      };
    }
    return {
      action: 'leave',
      note: `发版停在${train.phase}，还没暂停总开关，这次关着不是这一趟造成的，不自动开`,
      reopen: null,
    };
  }

  if (train.status === 'aborted' && idx >= 4) {
    return {
      action: 'leave',
      note: `发版中途撤了（${train.phase}），已经动手发过，总开关按规矩保持关`,
      reopen: null,
    };
  }

  if (train.status === 'failed' && idx !== 7) {
    return {
      action: 'leave',
      note: `发版没成（${train.phase}），不在恢复这一步，总开关保持关等人看`,
      reopen: null,
    };
  }

  // done，或 failed/aborted 停在该开回的那一步，或 aborted 在动手前。
  // 发完之后才关的：不是「没开回」，不代开。
  if (turnedOffAfter) {
    const checked = input.switchCheckOk === true ? '发版结束时体检写过总开关已经和发版前一致。' : '';
    return {
      action: 'leave',
      note: `${checked}发完之后总开关又被关上。原因和预计重开时间不在发版进度里，不自动开`,
      reopen: null,
    };
  }
  return {
    action: 'turn_on',
    reason: `发版已结束（${train.target}，${train.phase}），发版前总开关开着，发完还关着，按发版前开回`,
  };
}

export async function masterRestoreOnce(deps: {
  readMaster: () => Promise<EngineMasterState>;
  /** 没有发版进度文件回 null。读失败照抛，调用方记日志、下一轮再试，不开。 */
  readTrain: () => Promise<string | null>;
  turnOn: (reason: string) => Promise<{ changed: boolean; conflict?: boolean }>;
  log: Logger;
}): Promise<MasterRestorePlan> {
  const master = await deps.readMaster();
  if (master.on) return { action: 'already_on' };
  const json = await deps.readTrain();
  if (json === null) {
    return masterRestorePlan({ master, train: null, switchCheckOk: null });
  }
  const parsed = parseTrainState(json);
  if (!parsed.ok) {
    return {
      action: 'leave',
      note: `发版进度认不出（${parsed.why}），分不清这次关着该不该开回，不自动开`,
      reopen: null,
    };
  }
  const plan = masterRestorePlan({
    master,
    train: parsed,
    switchCheckOk: trainSwitchCheck(json),
  });
  if (plan.action !== 'turn_on') return plan;
  const result = await deps.turnOn(plan.reason);
  if (result.conflict) deps.log.warn('总开关刚被别处改过，这一轮没开回');
  else if (result.changed) deps.log.info('发版前开着的总开关发完还关着，已开回', { reason: plan.reason });
  else deps.log.info('总开关已经是开着的，不用再开');
  return plan;
}

/**
 * 正式环境才起：开发环境默认关着，没有法国那份发版进度，不能在这里把总开关打开。
 * 起来先看一眼，之后每分钟一次。返回停下的函数。
 */
export function startMasterRestoreWatch(deps: {
  store: Store;
  readTrain: () => Promise<string | null>;
  log: Logger;
  everyMs?: number;
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await masterRestoreOnce({
        readMaster: () => readEngineMaster(deps.store),
        readTrain: deps.readTrain,
        log: deps.log,
        turnOn: async (reason) => {
          const result = await setEngineMaster(
            deps.store,
            { on: true, by: MASTER_RESTORE_ACTOR },
            { actor: MASTER_RESTORE_ACTOR, reason, via: 'engine', ok: true },
          );
          return { changed: result.changed, conflict: 'conflict' in result && result.conflict === true };
        },
      });
    } catch (err) {
      deps.log.warn('看总开关该不该按发版前开回：这一轮没做成', { error: String(err) });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.everyMs ?? MASTER_RESTORE_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
