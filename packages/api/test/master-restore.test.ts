// 发版前开着的总开关，发完还关着时后端自己开回（#2084）。
// 2026-10-14 09:22 CST 监督读到「总开关关着」：这一趟 09:18:33 开始（01:18:33Z），
// 第 3 步「等收尾」记在 01:18:38Z，第 4 步「发版」01:31:09Z 才开始，所以 09:22（01:22Z）还在等收尾。
// 09:33:55 做完，体检「引擎总开关和发版前一致」通过。下面用这几个时刻钉住：当时是暂停，不是误关，也不是发完没开回。
import type { EngineMasterState } from '@fleet-dao/shared';
import { type Logger, type Store, silentLogger } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { parseTrainState } from '../src/france-release.ts';
import {
  MASTER_RESTORE_ACTOR,
  masterRestoreOnce,
  masterRestorePlan,
  startMasterRestoreWatch,
  trainSwitchCheck,
} from '../src/master-restore.ts';

const SHA = 'f6836a151394decfa170c56da9bba690c0ae6ffb';
/** 这一趟做完的时刻（release-train.json 的 updatedAt）。 */
const DONE_AT = '2026-10-14T01:33:55.944Z';
/** 第 3 步记下的时刻：总开关在这一步被发版暂停。 */
const PAUSED_AT = '2026-10-14T01:18:38.038Z';

function train(over: Record<string, unknown> = {}) {
  const parsed = parseTrainState(
    JSON.stringify({
      status: 'done',
      phase: 8,
      before: { master: true },
      target: { kind: 'sha', value: SHA },
      updatedAt: DONE_AT,
      ...over,
    }),
  );
  if (!parsed.ok) throw new Error(parsed.why);
  return parsed;
}

function off(at: string): EngineMasterState {
  return { on: false, why: 'set', at, by: 'engine' };
}

const on = (): EngineMasterState => ({ on: true, at: DONE_AT, by: 'engine' });

describe('这一次关着该不该开回（#2084）', () => {
  it('2026-10-14 09:22：发版进行到第 3 步，关着是这一趟的暂停，不开', () => {
    // 09:22 CST = 01:22Z。第 4 步 01:31:09Z 才开始，所以当时的进度是 running、phase 3。
    const during = train({ status: 'running', phase: 3, updatedAt: '2026-10-14T01:22:00.000Z' });
    expect(masterRestorePlan({ master: off(PAUSED_AT), train: during })).toEqual({
      action: 'wait',
      note: '发版进行中（第 3 步「等收尾」），总开关按这一趟暂停',
      reopen: '这一趟发完开回',
    });
  });

  it('09:33 做完且体检通过、总开关已经开着：不动', () => {
    expect(masterRestorePlan({ master: on(), train: train(), switchCheckOk: true })).toEqual({
      action: 'already_on',
    });
  });

  it('做完了、关的时刻仍是暂停那一下：按发版前开回', () => {
    expect(masterRestorePlan({ master: off(PAUSED_AT), train: train(), switchCheckOk: false })).toEqual({
      action: 'turn_on',
      reason:
        '发版已结束（提交 f6836a151394，第 8 步「派清单」），发版前总开关开着，发完还关着，按发版前开回',
    });
  });

  it('发完之后才关的：不开，预计重开时间不编', () => {
    expect(
      masterRestorePlan({
        master: off('2026-10-14T02:00:00.000Z'),
        train: train(),
        switchCheckOk: true,
      }),
    ).toEqual({
      action: 'leave',
      note: '发版结束时体检写过总开关已经和发版前一致。发完之后总开关又被关上。原因和预计重开时间不在发版进度里，不自动开',
      reopen: null,
    });
    const withoutCheck = masterRestorePlan({
      master: off('2026-10-14T02:00:00.000Z'),
      train: train(),
    });
    expect(withoutCheck.action).toBe('leave');
    if (withoutCheck.action === 'leave') expect(withoutCheck.note).not.toContain('体检写过');
  });

  it('没在恢复这一步就失败、或已经动手发过再撤：保持关', () => {
    expect(
      masterRestorePlan({ master: off(PAUSED_AT), train: train({ status: 'failed', phase: 5 }) }),
    ).toEqual({
      action: 'leave',
      note: '发版没成（第 5 步「等部署」），不在恢复这一步，总开关保持关等人看',
      reopen: null,
    });
    expect(
      masterRestorePlan({ master: off(PAUSED_AT), train: train({ status: 'aborted', phase: 5 }) }),
    ).toEqual({
      action: 'leave',
      note: '发版中途撤了（第 5 步「等部署」），已经动手发过，总开关按规矩保持关',
      reopen: null,
    });
  });

  it('停在恢复：正在走就等，卡住或这一步失败了就开回', () => {
    expect(
      masterRestorePlan({ master: off(PAUSED_AT), train: train({ status: 'running', phase: 7 }) }),
    ).toEqual({
      action: 'wait',
      note: '发版正在把总开关开回（第 7 步「恢复」）',
      reopen: '这一步走完',
    });
    expect(
      masterRestorePlan({ master: off(PAUSED_AT), train: train({ status: 'blocked', phase: 7 }) }).action,
    ).toBe('turn_on');
    expect(
      masterRestorePlan({ master: off(PAUSED_AT), train: train({ status: 'failed', phase: 7 }) }).action,
    ).toBe('turn_on');
  });

  it('对不上「发版前开着、发完该开回」：不开', () => {
    expect(masterRestorePlan({ master: off(PAUSED_AT), train: null })).toMatchObject({
      action: 'leave',
      reopen: null,
    });
    expect(
      masterRestorePlan({ master: off(PAUSED_AT), train: train({ before: { master: false } }) }),
    ).toMatchObject({ action: 'leave', reopen: null });
    expect(
      masterRestorePlan({ master: off(PAUSED_AT), train: train({ status: 'running', phase: 1 }) }),
    ).toMatchObject({ action: 'leave', reopen: null });
  });
});

describe('读进度再决定开不开', () => {
  const doneJson = JSON.stringify({
    status: 'done',
    phase: 8,
    before: { master: true },
    target: { kind: 'sha', value: SHA },
    updatedAt: DONE_AT,
    check: {
      at: '2026-10-14T01:33:55.942Z',
      ok: true,
      items: [
        { name: '引擎总开关和发版前一致', ok: true },
        { name: '各仓接活开关没被动过', ok: true },
      ],
    },
  });

  it('体检那一项：写了才认，没写不猜它过了', () => {
    expect(trainSwitchCheck(doneJson)).toBe(true);
    expect(trainSwitchCheck(JSON.stringify({ status: 'done', check: { items: [] } }))).toBeNull();
    expect(trainSwitchCheck('不是 JSON')).toBeNull();
    expect(
      trainSwitchCheck(JSON.stringify({ check: { items: [{ name: '引擎总开关和发版前一致', ok: 'yes' }] } })),
    ).toBeNull();
  });

  it('09:22 那种进行中：不开', async () => {
    let turned = 0;
    const plan = await masterRestoreOnce({
      readMaster: async () => off(PAUSED_AT),
      readTrain: async () =>
        JSON.stringify({
          status: 'running',
          phase: 3,
          before: { master: true },
          updatedAt: '2026-10-14T01:22:00.000Z',
        }),
      turnOn: async () => {
        turned += 1;
        return { changed: true };
      },
      log: silentLogger,
    });
    expect(plan.action).toBe('wait');
    expect(turned).toBe(0);
  });

  it('做完还关着、关的时刻不晚于这一趟结束：开一次', async () => {
    const reasons: string[] = [];
    const plan = await masterRestoreOnce({
      readMaster: async () => off(PAUSED_AT),
      readTrain: async () => doneJson,
      turnOn: async (reason) => {
        reasons.push(reason);
        return { changed: true };
      },
      log: silentLogger,
    });
    expect(plan.action).toBe('turn_on');
    expect(reasons).toEqual([
      '发版已结束（提交 f6836a151394，第 8 步「派清单」），发版前总开关开着，发完还关着，按发版前开回',
    ]);
  });

  it('已经开着：不读进度、不开', async () => {
    let reads = 0;
    const plan = await masterRestoreOnce({
      readMaster: async () => on(),
      readTrain: async () => {
        reads += 1;
        return doneJson;
      },
      turnOn: async () => {
        throw new Error('不该开');
      },
      log: silentLogger,
    });
    expect(plan).toEqual({ action: 'already_on' });
    expect(reads).toBe(0);
  });

  it('进度认不出、或文件没有：不开；读失败照抛，留给下一轮', async () => {
    const unread = await masterRestoreOnce({
      readMaster: async () => off(PAUSED_AT),
      readTrain: async () => '不是 JSON',
      turnOn: async () => {
        throw new Error('不该开');
      },
      log: silentLogger,
    });
    expect(unread).toMatchObject({ action: 'leave', reopen: null });
    const missing = await masterRestoreOnce({
      readMaster: async () => off(PAUSED_AT),
      readTrain: async () => null,
      turnOn: async () => {
        throw new Error('不该开');
      },
      log: silentLogger,
    });
    expect(missing.action).toBe('leave');
    await expect(
      masterRestoreOnce({
        readMaster: async () => off(PAUSED_AT),
        readTrain: async () => {
          throw new Error('EACCES');
        },
        turnOn: async () => ({ changed: true }),
        log: silentLogger,
      }),
    ).rejects.toThrow('EACCES');
  });
});

describe('正式环境的那一轮', () => {
  function storeOf(master: EngineMasterState, put: Store['putSetting']): Store {
    return {
      listSettings: async () =>
        !master.on && master.why === 'never_set'
          ? []
          : [
              {
                key: 'engine.master',
                value: master.on,
                version: 4,
                updatedAt: master.at,
                updatedBy: master.by ?? null,
              },
            ],
      putSetting: put,
    } as unknown as Store;
  }

  async function until(ready: () => boolean) {
    for (let i = 0; i < 50 && !ready(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('发完还关着：经设置那条路开回，操作记录写引擎、via 是 engine', async () => {
    const audits: { reason: string | undefined; via: string; actorId: string; action: string }[] = [];
    const store = storeOf(off(PAUSED_AT), async (_row, audit) => {
      audits.push({
        reason: audit.reason,
        via: audit.via,
        actorId: audit.actor.id,
        action: audit.action,
      });
      return 'ok';
    });
    const stop = startMasterRestoreWatch({
      store,
      readTrain: async () =>
        JSON.stringify({
          status: 'done',
          phase: 8,
          before: { master: true },
          target: { kind: 'sha', value: SHA },
          updatedAt: DONE_AT,
        }),
      log: silentLogger,
      everyMs: 60_000,
    });
    try {
      await until(() => audits.length > 0);
      expect(audits).toEqual([
        {
          reason:
            '发版已结束（提交 f6836a151394，第 8 步「派清单」），发版前总开关开着，发完还关着，按发版前开回',
          via: 'engine',
          actorId: MASTER_RESTORE_ACTOR.id,
          action: 'engine.master.enable',
        },
      ]);
    } finally {
      stop();
    }
  });

  it('已经开着，或进度读失败：不开，读失败只记一笔', async () => {
    let puts = 0;
    const warnings: string[] = [];
    const log: Logger = {
      info() {},
      error() {},
      warn(msg) {
        warnings.push(msg);
      },
    };
    const stopOn = startMasterRestoreWatch({
      store: storeOf(on(), async () => {
        puts += 1;
        return 'conflict';
      }),
      readTrain: async () => {
        throw new Error('不该读');
      },
      log,
      everyMs: 60_000,
    });
    const stopBad = startMasterRestoreWatch({
      store: storeOf(off(PAUSED_AT), async () => {
        puts += 1;
        return 'conflict';
      }),
      readTrain: async () => {
        throw new Error('EACCES');
      },
      log,
      everyMs: 60_000,
    });
    try {
      await until(() => warnings.length > 0);
      expect(puts).toBe(0);
      expect(warnings.some((m) => m.includes('这一轮没做成'))).toBe(true);
    } finally {
      stopOn();
      stopBad();
    }
  });
});
