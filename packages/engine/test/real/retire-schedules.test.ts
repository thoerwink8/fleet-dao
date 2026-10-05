// 引擎起来时删退役的 Temporal 定时任务（real/retire-schedules.ts）：真库（PGlite 上跑真迁移），假的 Temporal 客户端
// （结局由用例定：还在、本来就没有、删的时候出了别的错）。三条路径各故意造一次：删成了要记日志、把之前报过的「删不掉」
// 撤掉；本来就没有什么都不做（不写库、不记日志）；删不掉要照实进 notifications，不当成删掉了。
import { alertByKey } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { Client } from '@temporalio/client';
import { ScheduleNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RetiredSchedule } from '../../src/jobs/retired-schedules.ts';
import { RETIRED_SCHEDULE_ALERT_PREFIX, retireEngineSchedules } from '../../src/real/retire-schedules.ts';

const RETIRED_ID = 'alert-dispatch';
const DEDUPE_KEY = `${RETIRED_SCHEDULE_ALERT_PREFIX}${RETIRED_ID}`;
/** 这几条用例只看 alert-dispatch 一个；完整的名单（含摘出 Temporal 的 8 个）在最后一组里看。 */
const ONLY_ALERT_DISPATCH: RetiredSchedule[] = [{ id: RETIRED_ID, retiredBy: '#445' }];

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

/** 假的删：'ok' 删成、'absent' 回 ScheduleNotFoundError、给个 Error 就是删的时候出了别的错。 */
function fakeClient(outcome: 'ok' | 'absent' | Error): Pick<Client, 'schedule'> {
  return {
    schedule: {
      getHandle(id: string) {
        return {
          async delete() {
            if (outcome === 'ok') return;
            if (outcome === 'absent') throw new ScheduleNotFoundError('没有这个 Schedule', id);
            throw outcome;
          },
        };
      },
    },
  } as unknown as Pick<Client, 'schedule'>;
}

function logSpy(): { log: Parameters<typeof retireEngineSchedules>[2]; calls: [string, string][] } {
  const calls: [string, string][] = [];
  return { log: (level, text) => calls.push([level, text]), calls };
}

describe('退役的定时任务删不掉时要能被人看见（real/retire-schedules.ts）', () => {
  it(
    '【故意造出的失败】Temporal 上还在：删掉，记一行 info 日志',
    async () => {
      const { log, calls } = logSpy();
      await retireEngineSchedules(fakeClient('ok'), t.db, log, ONLY_ALERT_DISPATCH);
      expect(calls).toEqual([['info', `退役的定时任务已删：${RETIRED_ID}（#445 退役）`]]);
      expect(await alertByKey(t.db, DEDUPE_KEY)).toBeNull();
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '删成了：把之前报过的「删不掉」提醒自动撤掉（重试之后补删成功的路径）',
    async () => {
      // 先造一条「删不掉」的提醒（模拟上一次引擎起来时删失败）
      await retireEngineSchedules(
        fakeClient(new Error('上一轮：连不上')),
        t.db,
        undefined,
        ONLY_ALERT_DISPATCH,
      );
      expect(await alertByKey(t.db, DEDUPE_KEY)).toMatchObject({ resolvedAt: null });

      await retireEngineSchedules(fakeClient('ok'), t.db, undefined, ONLY_ALERT_DISPATCH);
      const after = await alertByKey(t.db, DEDUPE_KEY);
      expect(after?.resolvedAt).not.toBeNull();
      expect(after?.resolvedBy).toBe('engine:retire-schedules');
      expect(after?.body).toMatch(/^已撤：「alert-dispatch」删掉了/);
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '【故意造出的失败】Temporal 上本来就没有：什么都不做，不记日志、不写库',
    async () => {
      const { log, calls } = logSpy();
      await retireEngineSchedules(fakeClient('absent'), t.db, log, ONLY_ALERT_DISPATCH);
      expect(calls).toEqual([]);
      expect(await alertByKey(t.db, DEDUPE_KEY)).toBeNull();
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '【故意造出的失败】删的时候出了别的错：记一行 error 日志，进 notifications（daily 级，不当成删掉了）',
    async () => {
      const { log, calls } = logSpy();
      await retireEngineSchedules(
        fakeClient(new Error('14 UNAVAILABLE: 连不上')),
        t.db,
        log,
        ONLY_ALERT_DISPATCH,
      );
      expect(calls).toEqual([['error', `退役的定时任务删不掉：${RETIRED_ID}：14 UNAVAILABLE: 连不上`]]);
      const alert = await alertByKey(t.db, DEDUPE_KEY);
      expect(alert).toMatchObject({
        level: 'daily',
        resolvedAt: null,
        title: `退役的定时任务「${RETIRED_ID}」删不掉`,
      });
      expect(alert?.body).toContain('14 UNAVAILABLE: 连不上');
      expect(alert?.body).toContain('#445');
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '删失败再报一遍：同一个键原地更新，不多出第二条',
    async () => {
      await retireEngineSchedules(
        fakeClient(new Error('第一次：连不上')),
        t.db,
        undefined,
        ONLY_ALERT_DISPATCH,
      );
      await retireEngineSchedules(
        fakeClient(new Error('第二次：还是连不上')),
        t.db,
        undefined,
        ONLY_ALERT_DISPATCH,
      );
      const alert = await alertByKey(t.db, DEDUPE_KEY);
      expect(alert?.body).toContain('第二次：还是连不上');
      expect(alert?.body).not.toContain('第一次');
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '默认名单：摘出 Temporal 的 8 个定时任务（#1072）也一起删；删不掉的提醒写明是「改成了进程内定时器、会和它重复跑一轮」',
    async () => {
      const { log, calls } = logSpy();
      await retireEngineSchedules(fakeClient(new Error('14 UNAVAILABLE: 连不上')), t.db, log);
      expect(calls).toHaveLength(9);
      const moved = await alertByKey(t.db, `${RETIRED_SCHEDULE_ALERT_PREFIX}canary`);
      expect(moved?.body).toContain('#1072 把它改成了引擎进程内的定时器');
      expect(moved?.body).toContain('重复跑一轮');
      // alert-dispatch 的措辞没变
      expect((await alertByKey(t.db, DEDUPE_KEY))?.body).toContain('#445 把它的代码删掉了');
    },
    TEST_DB_TIMEOUT_MS,
  );
});
