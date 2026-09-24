import { describe, expect, it } from 'vitest';
import { PublicHealthError, runHealthChecks } from '../src/health.ts';
import { silentLogger } from '../src/log.ts';
import type { Logger } from '../src/ports.ts';
import { notConnectedTemporal } from '../src/temporal.ts';
import { errorCode, harness, IDS, write } from './harness.ts';

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
        temporal: { ok: false, code: 'not_connected', message: 'Temporal 客户端还没接上（等引擎的 PR）' },
        realtime: { ok: true },
      },
    });
    expect(h.logs.some((l) => String(l.fields?.error).includes(internal))).toBe(true);
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
