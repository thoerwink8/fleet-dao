// /healthz 的 judge 项（判断题）：没配报「未接」；配置起不来、最近一次真调用没成报红（原因只进日志）；调通了是绿的。
// 「未接」只认默认位置上没有配置文件这一种，别的读不成都是红——每条故意造一次。库是内存里的真迁移，后端不出网。
import type { Stats } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runHealthChecks } from '../src/health.ts';
import { JUDGE_NOT_WIRED, judgeHealthCheck } from '../src/judge-health.ts';
import type { Logger } from '../src/ports.ts';
import { judgeCatalog, judgeMachine, makeFakeBackend, recordJudgeCall } from './judge-fixture.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await judgeCatalog(t.db);
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const machine = () => {
  const m = judgeMachine();
  cleanups.push(m.cleanup);
  return m;
};

/** 跑一次只有 judge 这一项的健康检查，连日志一起交回。 */
async function report(check: ReturnType<typeof judgeHealthCheck>) {
  const logs: string[] = [];
  const keep = (message: string, fields?: Record<string, unknown>) => {
    logs.push(`${message} ${JSON.stringify(fields ?? {})}`);
  };
  const log: Logger = { info: keep, warn: keep, error: keep };
  const r = await runHealthChecks(
    [{ name: 'judge', check: () => check.check(), ...(check.notWired ? { notWired: check.notWired } : {}) }],
    log,
  );
  return { item: r.checks.judge, ok: r.ok, logs, text: JSON.stringify(r) };
}

const missing = join(tmpdir(), 'fleet-api-judge-nowhere', 'jev.json');

describe('/healthz 的 judge 项', () => {
  it('默认位置上没有配置文件：未接（整体照样好）', async () => {
    const check = judgeHealthCheck({ db: {} as Db, location: { path: missing, explicit: false } });
    expect(check.notWired).toBe(JUDGE_NOT_WIRED);
    const r = await report(check);
    expect(r.item).toEqual({ ok: true, status: 'not_wired', message: JUDGE_NOT_WIRED });
    expect(r.ok).toBe(true);
  });

  it('配好了、还没调过：好', async () => {
    const r = await report(
      judgeHealthCheck({ db: t.db, location: machine().location, makeBackend: makeFakeBackend }),
    );
    expect(r.item).toEqual({ ok: true });
  });

  it('最近一次真调用没成：红，对外一句中性的话，原因（哪道题、为什么、上游原文）只进日志；调成了就绿', async () => {
    const check = judgeHealthCheck({ db: t.db, location: machine().location, makeBackend: makeFakeBackend });
    await recordJudgeCall(t.db, {
      ok: false,
      reason: 'auth',
      detail: 'HTTP 401 invalid api key',
      latencyMs: 4,
    });
    const bad = await report(check);
    expect(bad.item).toEqual({ ok: false, code: 'judge_failing', message: '判断题最近一次调用没成' });
    expect(bad.text).not.toContain('401');
    expect(
      bad.logs.some((l) => l.includes('error-next') && l.includes('auth') && l.includes('HTTP 401')),
    ).toBe(true);
    await recordJudgeCall(t.db, {
      ok: true,
      answers: { 'error-next': { option: 'retry', confidence: 0.9 } },
      model: 'jev-1.13.0',
      latencyMs: 5,
      inputTokens: 100,
      tokensEstimated: false,
    });
    expect((await report(check)).item).toEqual({ ok: true });
  });

  it('FLEET_JEV_CONFIG 明写的文件不在：红，不是未接', async () => {
    const check = judgeHealthCheck({ db: t.db, location: { path: missing, explicit: true } });
    expect(check.notWired).toBeUndefined();
    const r = await report(check);
    expect(r.item).toEqual({ ok: false, code: 'judge_config', message: '判断题的配置起不来' });
    expect(r.logs.some((l) => l.includes('FLEET_JEV_CONFIG'))).toBe(true);
  });

  it('配置文件查不了（权限不够）：红，不当成没配', async () => {
    const denied = (path: string): Stats => {
      throw Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), { code: 'EACCES' });
    };
    const check = judgeHealthCheck({ db: t.db, location: { path: missing, explicit: false }, stat: denied });
    expect(check.notWired).toBeUndefined();
    expect((await report(check)).item).toEqual({
      ok: false,
      code: 'judge_config',
      message: '判断题的配置起不来',
    });
  });

  it('后端起来时有配置、后来没了：红', async () => {
    const m = machine();
    const check = judgeHealthCheck({ db: t.db, location: m.location, makeBackend: makeFakeBackend });
    rmSync(m.path);
    const r = await report(check);
    expect(r.item).toEqual({ ok: false, code: 'judge_config', message: '判断题的配置起不来' });
    expect(r.logs.some((l) => l.includes('后端起来时有配置文件'))).toBe(true);
  });

  it('后端起不来、判断阶段没开着的路由：红，原因只进日志（不带钥匙的值）', async () => {
    const r = await report(judgeHealthCheck({ db: t.db, location: machine().location }));
    // 不注入假后端：真的 backendForRoute 读到钥匙后在「测试里不许真调 TypeSafe」这一步拒——走的是生产那条路。
    expect(r.item).toEqual({ ok: false, code: 'judge_config', message: '判断题的配置起不来' });
    expect(r.logs.join('\n')).not.toContain('k-api-test');
    await t.client.query(`update stage_policy_routes set enabled = false where stage = 'judge'`);
    const noRoute = await report(
      judgeHealthCheck({ db: t.db, location: machine().location, makeBackend: makeFakeBackend }),
    );
    expect(noRoute.item).toMatchObject({ ok: false, code: 'judge_config' });
    expect(noRoute.logs.some((l) => l.includes('调度台的判断阶段没有开着的路由'))).toBe(true);
  });

  it('查调用记录出错：红「连不上」，不当成还没调过', async () => {
    let selects = 0;
    const flaky = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'select' && ++selects === 2)
          throw new Error('canceling statement due to statement timeout');
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    const r = await report(
      judgeHealthCheck({ db: flaky, location: machine().location, makeBackend: makeFakeBackend }),
    );
    expect(r.item).toEqual({ ok: false, code: 'unreachable', message: '连不上' });
  });
});
