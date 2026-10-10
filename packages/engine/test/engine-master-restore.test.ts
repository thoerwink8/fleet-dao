import {
  ENGINE_MASTER_DISABLE,
  ENGINE_MASTER_ENABLE,
  ENGINE_MASTER_RELEASE_GRACE_MS,
} from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  type EngineMasterRestoreDeps,
  franceReleaseInFlight,
  maybeRestoreStuckEngineMaster,
} from '../src/jobs/engine-master-restore.ts';

const NOW = new Date('2026-10-10T08:00:00.000Z');

function deps(
  over: Partial<EngineMasterRestoreDeps> & { enableResult?: 'enabled' | 'already_on' | 'conflict' } = {},
): {
  d: EngineMasterRestoreDeps;
  enable: ReturnType<typeof vi.fn>;
  logs: string[];
} {
  const logs: string[] = [];
  const enable = vi.fn(async () => over.enableResult ?? 'enabled');
  const d: EngineMasterRestoreDeps = {
    readMasterRow: async () => ({ value: false, updatedBy: 'ops:engine', updatedAt: NOW.toISOString() }),
    latestAudit: async () => ({
      action: ENGINE_MASTER_DISABLE,
      reason: '发版前暂停（release-train，目标 abcdef012345）',
      at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1_000),
    }),
    enable,
    releaseInFlight: () => false,
    now: () => NOW,
    log: (level, message) => {
      logs.push(`${level}:${message}`);
    },
    ...over,
  };
  return { d, enable, logs };
}

describe('franceReleaseInFlight', () => {
  it('有暂停标记或 running 进度：在走', () => {
    expect(
      franceReleaseInFlight('/t', {
        existsSync: (p) => p.endsWith('release-train.paused'),
        readFileSync: () => '',
      }),
    ).toBe(true);
    expect(
      franceReleaseInFlight('/t', {
        existsSync: (p) => p.endsWith('release-train.json'),
        readFileSync: () => '{"status":"running"}',
      }),
    ).toBe(true);
  });

  it('没有现场：不在走', () => {
    expect(franceReleaseInFlight('/t', { existsSync: () => false, readFileSync: () => '' })).toBe(false);
  });
});

describe('maybeRestoreStuckEngineMaster（#1732）', () => {
  it('发版暂停卡住：开回', async () => {
    const { d, enable, logs } = deps();
    await expect(maybeRestoreStuckEngineMaster(d)).resolves.toBe('enabled');
    expect(enable).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes('自动开回'))).toBe(true);
  });

  it('有意关：跳过，不开', async () => {
    const { d, enable } = deps({
      latestAudit: async () => ({
        action: ENGINE_MASTER_DISABLE,
        reason: '今晚先停',
        at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1_000),
      }),
    });
    await expect(maybeRestoreStuckEngineMaster(d)).resolves.toBe('skipped');
    expect(enable).not.toHaveBeenCalled();
  });

  it('发版还在走：跳过', async () => {
    const { d, enable } = deps({ releaseInFlight: () => true });
    await expect(maybeRestoreStuckEngineMaster(d)).resolves.toBe('skipped');
    expect(enable).not.toHaveBeenCalled();
  });

  it('最近一笔是打开：跳过', async () => {
    const { d, enable } = deps({
      latestAudit: async () => ({
        action: ENGINE_MASTER_ENABLE,
        reason: '发版后恢复',
        at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1_000),
      }),
    });
    await expect(maybeRestoreStuckEngineMaster(d)).resolves.toBe('skipped');
    expect(enable).not.toHaveBeenCalled();
  });
});
