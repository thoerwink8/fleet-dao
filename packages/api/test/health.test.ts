import { readFileSync } from 'node:fs';
import { createDb, type Db } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { draftBacklogCheck, notWiredDraftOpener } from '../src/draft-opening.ts';
import { PublicHealthError, runHealthChecks, serviceHealthChecks } from '../src/health.ts';
import { silentLogger } from '../src/log.ts';
import { probeDb, sqlState, withStatementTimeout } from '../src/pg-store.ts';
import type { Logger, Store } from '../src/ports.ts';
import { notConnectedTemporal } from '../src/temporal.ts';
import { errorCode, harness, IDS, write } from './harness.ts';

/** 有一张确认了很久的待开单。 */
const backlogStore = {
  listDraftsToOpen: async () => [{ id: 'd1', confirmedAt: new Date(0).toISOString() }],
} as unknown as Pick<Store, 'listDraftsToOpen'>;

describe('健康检查', () => {
  it('没有外部依赖（内存版）：200', async () => {
    const res = await harness().cockpit.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checks: {} });
  });

  it('连不上库、Temporal 没接上：整体 503，逐项如实报红；内部细节（地址等）只进日志不对外', async () => {
    const internal = 'db.internal.example:5432';
    const h = harness({
      health: [
        {
          name: 'database',
          check: async () => Promise.reject(new Error(`connect ECONNREFUSED ${internal}`)),
        },
        { name: 'temporal', check: () => notConnectedTemporal().check() },
        { name: 'realtime', check: async () => {} },
      ],
    });
    const res = await h.cockpit.request('/healthz');
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(internal);
    expect(JSON.parse(text)).toEqual({
      ok: false,
      checks: {
        database: { ok: false, code: 'unreachable', message: '连不上' },
        temporal: { ok: false, code: 'not_connected', message: 'Temporal 客户端还没接上' },
        realtime: { ok: true },
      },
    });
    expect(h.logs.some((l) => String(l.fields?.error).includes(internal))).toBe(true);
  });

  /** serviceHealthChecks 的一套：库、实时推送、Temporal、GitHub 事件、判断题都好，只看飞书草稿开单这两项。 */
  const services = (draftOpener: { check(): Promise<void>; readonly notWired?: string }) =>
    serviceHealthChecks({
      probeDb: async () => {},
      feed: { probe: async () => {} },
      temporal: { check: async () => {}, checkEngine: async () => {} },
      githubEvents: async () => {},
      draftOpener,
      draftBacklog: draftBacklogCheck(backlogStore, () => new Date()),
      judge: { check: async () => {} },
    });

  it('还没接上的功能报「未接」：整体照样 200，这一项看得到「未接」和单号，积压也不算坏', async () => {
    const h = harness({ health: services(notWiredDraftOpener()) });
    const res = await h.cockpit.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.checks.draft_opener).toEqual({
      ok: true,
      status: 'not_wired',
      message: '飞书草稿开成 issue 还没接上（#91）',
    });
    expect(body.checks.draft_backlog).toEqual({
      ok: true,
      status: 'not_wired',
      message: '飞书草稿开成 issue 还没接上（#91）：确认了的草稿先留在待开单',
    });
  });

  it('接上以后出错照样红：真实现的 check 抛错、积压太久，整体 503', async () => {
    const wired = { check: async () => Promise.reject(new Error('GitHub 连不上 10.0.0.1')) };
    const report = await runHealthChecks(services(wired), silentLogger);
    expect(report.ok).toBe(false);
    expect(report.checks.draft_opener).toEqual({ ok: false, code: 'unreachable', message: '连不上' });
    expect(report.checks.draft_backlog).toMatchObject({ ok: false, code: 'backlog' });
  });

  it('「未接」只认装配时的标记：check 抛的错长得再像（名字、code 叫 not_wired）也照样红，原话不外露', async () => {
    const lookalike = Object.assign(new Error('内部细节 db.internal:5432'), {
      name: 'NotWiredHealth',
      status: 'not_wired',
    });
    const report = await runHealthChecks(
      [
        { name: 'thrown', check: async () => Promise.reject(lookalike) },
        {
          name: 'public',
          check: async () => {
            throw new PublicHealthError('not_wired', '还没做');
          },
        },
      ],
      silentLogger,
    );
    expect(report.ok).toBe(false);
    expect(report.checks.thrown).toEqual({ ok: false, code: 'unreachable', message: '连不上' });
    expect(report.checks.public).toEqual({ ok: false, code: 'not_wired', message: '还没做' });
    expect(JSON.stringify(report)).not.toContain('db.internal');
  });

  it('一项卡住不拖死整个检查：超时就报红', async () => {
    const warnings: string[] = [];
    const log: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
    const report = await runHealthChecks(
      [
        { name: 'slow', check: () => new Promise(() => {}) },
        {
          name: 'public',
          check: async () => {
            throw new PublicHealthError('not_listening', '实时推送没接上');
          },
        },
      ],
      log,
      30,
    );
    expect(report).toEqual({
      ok: false,
      checks: {
        slow: { ok: false, code: 'timeout', message: '0.03 秒没回应' },
        public: { ok: false, code: 'not_listening', message: '实时推送没接上' },
      },
    });
    expect(warnings).toHaveLength(2);
  });

  it('发版脚本里「会随时间自己变红、不退回」的健康项都是后端真报的项（这边改了名，发版脚本的名单跟着改）', () => {
    const script = readFileSync(new URL('../../../deploy/release.sh', import.meta.url), 'utf8');
    const listed = /^DRIFTING_HEALTH_ITEMS="([^"]*)"$/m.exec(script)?.[1]?.trim().split(/\s+/) ?? [];
    expect(listed).toContain('draft_backlog');
    // 判断题「最近一次调用没成」跟着上游自己变红，和换没换版无关
    expect(listed).toContain('judge');
    const names = serviceHealthChecks({
      probeDb: async () => {},
      feed: { probe: async () => {} },
      temporal: { check: async () => {}, checkEngine: async () => {} },
      githubEvents: async () => {},
      draftOpener: { check: async () => {} },
      draftBacklog: async () => {},
      judge: { check: async () => {} },
    }).map((c) => c.name);
    for (const name of listed) expect(names, name).toContain(name);
  });

  it('Temporal 没接上时发信号：503，失败也留操作记录', async () => {
    const h = harness({ workflows: notConnectedTemporal().control });
    const session = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', session, { action: 'pause' }),
    );
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('workflow_unavailable');
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'task.pause',
      ok: false,
      error: 'workflow_unavailable',
    });
  });
});

describe('查库限时', () => {
  it('连接串加上语句超时（写了就不动），postgres.js 真把它当启动参数发给库', async () => {
    const base = 'postgres://fleet@db.internal.example/fleet';
    expect(withStatementTimeout(base)).toBe(`${base}?statement_timeout=5000`);
    expect(withStatementTimeout(`${base}?sslmode=require`)).toBe(
      `${base}?sslmode=require&statement_timeout=5000`,
    );
    expect(withStatementTimeout(`${base}?statement_timeout=1000`)).toBe(`${base}?statement_timeout=1000`);
    // postgres.js 到第一次查询才真连，这里不碰网络。
    const { client, close } = createDb({ url: withStatementTimeout(base) });
    expect(client.options.connection).toMatchObject({ statement_timeout: '5000' });
    await close();
  });

  it('探库超时（语句超时 57014、等锁超时 55P03）报红「查库超时」；别的错原样抛（对外只说连不上）', async () => {
    const failing = (code: string) =>
      ({
        async transaction() {
          // drizzle 把驱动的错误包在 cause 里。
          throw new Error('Failed query', {
            cause: Object.assign(new Error('canceling statement'), { code }),
          });
        },
      }) as unknown as Db;
    for (const code of ['57014', '55P03']) {
      await expect(probeDb(failing(code), 2_000)).rejects.toMatchObject({
        name: 'PublicHealthError',
        code: 'timeout',
      });
    }
    await expect(probeDb(failing('08006'), 2_000)).rejects.toThrow('Failed query');
    expect(sqlState(new Error('x', { cause: { code: '57014' } }))).toBe('57014');
    expect(sqlState(new Error('没有错误码'))).toBeUndefined();
  });
});
