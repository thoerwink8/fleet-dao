import { describe, expect, it } from 'vitest';
import {
  engineMasterHealth,
  engineMasterHealthCheck,
  parseLastReleaseAt,
  trainBeatMs,
  trainIsRunning,
} from '../src/engine-master-health.ts';
import { PublicHealthError } from '../src/health.ts';

const NOW = new Date('2026-10-10T08:00:00.000Z');

describe('parseLastReleaseAt / trainIsRunning / trainBeatMs', () => {
  it('认发布历史末行的 release 时刻', () => {
    const text = [
      '2026-10-10T04:29:56Z 4d0dc28ebe29894f135fcefeacb5907d0669fa58 release',
      '2026-10-10T07:42:51Z 6ae542cc8c438df353a80f26b335b054b9cde0a2 release',
      '',
    ].join('\n');
    expect(parseLastReleaseAt(text)?.toISOString()).toBe('2026-10-10T07:42:51.000Z');
  });

  it('发版车 running 才算在走；心跳取 driver.heartbeatAt 或 updatedAt', () => {
    expect(trainIsRunning('{"schema":1,"phase":2,"status":"running"}')).toBe(true);
    expect(trainIsRunning('{"schema":1,"phase":8,"status":"done"}')).toBe(false);
    expect(trainIsRunning('not-json')).toBe(false);
    expect(
      trainBeatMs(
        '{"status":"running","updatedAt":"2026-10-10T07:00:00.000Z","driver":{"heartbeatAt":"2026-10-10T07:10:00.000Z"}}',
      ),
    ).toBe(Date.parse('2026-10-10T07:10:00.000Z'));
  });
});

describe('engineMasterHealth（#1732）', () => {
  it('开着：好', () => {
    expect(
      engineMasterHealth(
        { on: true },
        {
          pauseActive: false,
          pauseMtimeMs: null,
          trainRunning: false,
          trainBeatMs: null,
          lastReleaseAt: null,
          now: NOW,
        },
      ),
    ).toEqual({
      ok: true,
      note: '开着：引擎在接活',
    });
  });

  it('关着且发版暂停中（新鲜标记）：跳过不红', () => {
    expect(
      engineMasterHealth(
        { on: false, why: 'set' },
        {
          pauseActive: true,
          pauseMtimeMs: NOW.getTime() - 10 * 60_000,
          trainRunning: false,
          trainBeatMs: null,
          lastReleaseAt: null,
          now: NOW,
        },
      ),
    ).toMatchObject({ ok: true, note: expect.stringContaining('发版暂停') });
  });

  it('关着且刚发完还在宽限：跳过不红', () => {
    expect(
      engineMasterHealth(
        { on: false, why: 'set' },
        {
          pauseActive: false,
          pauseMtimeMs: null,
          trainRunning: false,
          trainBeatMs: null,
          lastReleaseAt: new Date(NOW.getTime() - 10 * 60_000),
          now: NOW,
        },
      ),
    ).toMatchObject({ ok: true });
  });

  it('关着且不在宽限：红，整体会被拖成 503', () => {
    expect(
      engineMasterHealth(
        { on: false, why: 'set' },
        {
          pauseActive: false,
          pauseMtimeMs: null,
          trainRunning: false,
          trainBeatMs: null,
          lastReleaseAt: new Date(NOW.getTime() - 60 * 60_000),
          now: NOW,
        },
      ),
    ).toEqual({
      ok: false,
      code: 'engine_master_off',
      message: '引擎总开关关着：派单和巡检停着（不在发版宽限里）',
    });
  });

  it('过期暂停标记或假 running：不跳过，红', () => {
    expect(
      engineMasterHealth(
        { on: false, why: 'set' },
        {
          pauseActive: true,
          pauseMtimeMs: NOW.getTime() - 60 * 60_000,
          trainRunning: true,
          trainBeatMs: NOW.getTime() - 60 * 60_000,
          lastReleaseAt: new Date(NOW.getTime() - 60 * 60_000),
          now: NOW,
        },
      ),
    ).toMatchObject({ ok: false, code: 'engine_master_off' });
  });
});

describe('engineMasterHealthCheck', () => {
  it('关着、目录里没有发版现场：抛 PublicHealthError', async () => {
    const check = engineMasterHealthCheck(
      async () => ({ on: false, why: 'set' }),
      () => NOW,
      {
        releasesDir: '/tmp/fleet-engine-master-health-nowhere',
        existsSync: () => false,
        readFileSync: () => {
          throw new Error('不该读');
        },
      },
    );
    await expect(check()).rejects.toBeInstanceOf(PublicHealthError);
    await expect(check()).rejects.toMatchObject({ code: 'engine_master_off' });
  });

  it('开着：回一句说明', async () => {
    const check = engineMasterHealthCheck(
      async () => ({ on: true }),
      () => NOW,
      { existsSync: () => false },
    );
    await expect(check()).resolves.toBe('开着：引擎在接活');
  });
});
