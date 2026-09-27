// 组织临时被切走又切回（#335）：一张单子在真 Temporal 测试服务端上走，选路用真的（real/store-ports.ts 接 PGlite 真库）、读会话
// 用户挂的组织用真的读法（real/session-org.ts，reclaude org list 的替身按次数答）。人手动把会话用户切到独享、又切回拼车
// （09-27 21:53–21:55 帅位在法国的切号实验）：单子不挂起等人，自己等过去、切回来接着派拼车做完；提醒里写着前后两次读数，
// 切回来自己撤；独享整池暂停（创始人 09-27 夜拍的临时开关）照旧。改之前这一下选路回「派不出」，单子挂起等人点「继续」。
import { auditLog, notifications, upsertAlert } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type SubtaskResult, WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, type FakeWorld } from '../src/fakes.ts';
import type { PickRouteResult, WaitTiming } from '../src/ports.ts';
import type { UserExec } from '../src/real/exec.ts';
import { ORG_DRIFT_ALERT, orgDriftReporter } from '../src/real/org-switch.ts';
import { sessionOrgReader } from '../src/real/session-org.ts';
import { createStorePorts, poolHoldKey } from '../src/real/store-ports.ts';
import { spec, subtaskInput, useEnv, withWorker } from './helpers.ts';
import { NOW, orgListText, world as seedCatalog } from './real/fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await seedCatalog(t.db);
  // 真实的样子：独享池挂在独享组织上、拼车池挂在拼车组织上；法国现在独享整池暂停着
  await t.client.query(`update pools set org_kind = 'solo' where id = 'claude-solo'`);
  await upsertAlert(t.db, {
    dedupeKey: poolHoldKey('claude-solo'),
    level: 'decision',
    taskId: null,
    title: '账号池 claude-solo 整池暂停：法国暂时不用独享号',
    body: '创始人 2026-09-27 夜拍',
  });
});

const currentEnv = useEnv();

describe('组织临时被切走又切回（#335）：单子自己恢复', { timeout: 60_000 }, () => {
  it('选路等着（不挂起等人），切回来接着派拼车、做完；提醒写着前后两次读数，切回来自己撤；独享暂停照旧', async () => {
    const env = currentEnv();
    let clock = NOW.getTime();
    const now = () => new Date(clock);
    // reclaude org list 的替身：第 1 次（路由探针那一轮）是拼车；人手动切到独享，第 2、3 次读到独享；切回来以后都是拼车。
    // 每读一次过 30 秒（选路没定下来就隔 30 秒再选）
    let reads = 0;
    const exec: UserExec = async () => {
      reads += 1;
      clock += 30_000;
      const org = reads === 1 || reads > 3 ? 'carpool' : 'solo';
      return {
        code: 0,
        stderr: '',
        timedOut: false,
        aborted: false,
        stdout: Buffer.from(orgListText(org)),
      };
    };
    const sessionOrg = sessionOrgReader({
      exec,
      user: 'fleet-agent-carpool',
      reclaude: ['/home/fleet-agent-carpool/.local/bin/reclaude'],
      ttlMs: 0,
      now,
      onEvent: orgDriftReporter({ db: t.db, user: 'fleet-agent-carpool', machine: '法国', now }),
    });
    const store = createStorePorts({ db: t.db, now, draw: () => 0.5, log: () => {}, sessionOrg });
    expect(await sessionOrg({ by: '路由探针' })).toEqual({ ok: true, org: 'carpool' });

    const picks: PickRouteResult[] = [];
    const fake = createFakeWorld();
    const world: FakeWorld = {
      ...fake,
      ports: {
        ...fake.ports,
        async pickRoute(input, ctx) {
          const r = await store.pickRoute(input, ctx);
          picks.push(r);
          return r;
        },
      },
    };
    const input = subtaskInput(spec('a'));
    const result = (await withWorker(env, world, async (q) =>
      (
        await env.client.workflow.start(WORKFLOW_TYPES.subtask, {
          taskQueue: q,
          workflowId: `sub-test-${input.taskId}`,
          args: [input],
        })
      ).result(),
    )) as SubtaskResult;

    expect(result.state).toBe('merged');
    // 写码那一步：两次「这会儿定不下来」（隔 30 秒再选），第三次读回拼车照常派拼车；审查那一步照常派拼车。
    // 一次「派不出」都没有（改之前第一次就是派不出，单子挂起等人）
    expect(picks.map((p) => (p.ok ? `派 ${p.route.routeId}` : p.waitFor))).toEqual([
      'slot',
      'slot',
      '派 carpool',
      '派 carpool',
    ]);
    const first = picks[0];
    expect(!first?.ok && first?.detail).toContain('会话用户挂的组织这会儿定不下来，过一会儿再选');
    expect(fake.callsOf('startSession').map((c) => [c.input.stage, c.input.route.routeId])).toEqual([
      ['execute', 'carpool'],
      ['review', 'carpool'],
    ]);
    // 没挂起、没报「卡住」：自己等过去了；等的那一会儿记成等空位一类、写着为什么
    expect(fake.alerts.filter((a) => a.level === 'stuck')).toEqual([]);
    const waits = fake.timings.filter((x): x is WaitTiming => x.kind === 'wait');
    expect(waits.some((w) => w.waitFor === 'slot' && w.detail.includes('引擎没切过号'))).toBe(true);

    // 提醒：带前后两次读数（几点、谁读的、读到哪个），切回来自己撤、写明为什么
    const rows = await t.db.select().from(notifications);
    const drift = rows.find((n) => n.dedupeKey === ORG_DRIFT_ALERT);
    expect(drift?.title).toBe('会话用户挂的组织变了，引擎没切过号：拼车 → 独享');
    expect(drift?.resolvedAt).not.toBeNull();
    expect(drift?.body).toMatch(/^已撤：读数回到了拼车/);
    expect(drift?.body).toContain('09-25 16:00:30 路由探针读到拼车');
    expect(drift?.body).toContain('09-25 16:01:00 选路读到独享');
    // 独享暂停照旧：没派过它，暂停也没被撤
    expect(rows.find((n) => n.dedupeKey === poolHoldKey('claude-solo'))?.resolvedAt).toBeNull();
    // 操作记录：一条变动、一条定下来
    const audits = (await t.db.select().from(auditLog))
      .filter((a) => a.action.startsWith('session-org.'))
      .map((a) => a.action);
    expect(audits).toEqual(['session-org.drift', 'session-org.settle']);
  });
});
