// 额度这一轮顺手读渠道模型名册：没到间隔不读；读失败、抛了，都不改额度的结局，也不报额度提醒。
import type { PoolQuotaResult, QuotaReport } from '@fleet-dao/adapters/quota';
import type { PoolQuotaSnapshot, ScheduleResult } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  type ChannelModelRosterResult,
  QuotaReadFailedError,
  type QuotaReadJobDeps,
  runQuotaReadJob,
} from '../src/jobs/quota-read.ts';
import { quotaReadJob } from '../src/real/quota-read.ts';

const NOW = new Date('2026-10-08T08:00:00Z');

const quotaOk = (poolId: string): PoolQuotaResult => ({
  ok: true,
  poolId,
  channelId: 'c',
  reader: 'claude-usage',
  startedAt: NOW.toISOString(),
  durationMs: 1,
  notes: [],
  windows: [],
});

function deps(over: Partial<QuotaReadJobDeps> = {}): {
  deps: QuotaReadJobDeps;
  finished: ScheduleResult[];
  raised: string[];
} {
  const finished: ScheduleResult[] = [];
  const raised: string[] = [];
  const base: QuotaReadJobDeps = {
    loadConfig: async () => ({ pools: [{ poolId: 'claude-solo' }] }) as never,
    read: async (): Promise<QuotaReport> => ({
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      results: [quotaOk('claude-solo')],
    }),
    save: async (_s: PoolQuotaSnapshot) => undefined,
    lastReadOk: async () => new Map(),
    raise: async (a) => {
      raised.push(a.key);
    },
    resolve: async () => undefined,
    runs: {
      start: async () => 1,
      finish: async (_id, result) => {
        finished.push(result);
      },
    },
    now: () => NOW,
    log: () => undefined,
  };
  return { deps: { ...base, ...over }, finished, raised };
}

describe('额度任务里的渠道模型名册', () => {
  it('没接上名册时不读，额度照旧成功', async () => {
    const world = deps();
    const run = await runQuotaReadJob(world.deps);
    expect(run.outcome).toBe('ok');
    expect(world.finished[0]?.outcome).toBe('ok');
  });

  it('没到间隔不读；到了才读、才记，失败也不报额度提醒', async () => {
    const saved: ChannelModelRosterResult[] = [];
    let reads = 0;
    const quiet = deps({
      modelRoster: {
        due: async () => false,
        read: async () => {
          reads += 1;
          return [];
        },
        save: async (results) => {
          saved.push(...results);
          return { unstored: [], newModelIds: [] };
        },
        notifyNewModels: async () => undefined,
      },
    });
    expect((await runQuotaReadJob(quiet.deps)).outcome).toBe('ok');
    expect(reads).toBe(0);

    const due = deps({
      modelRoster: {
        due: async () => true,
        read: async () => [
          { ok: false, channelId: 'xai', error: { code: 'no_credentials', message: '没登录' } },
        ],
        save: async (results) => {
          saved.push(...results);
          return { unstored: [], newModelIds: [] };
        },
        notifyNewModels: async () => undefined,
      },
    });
    expect((await runQuotaReadJob(due.deps)).outcome).toBe('ok');
    expect(saved).toEqual([
      { ok: false, channelId: 'xai', error: { code: 'no_credentials', message: '没登录' } },
    ]);
    expect(due.raised).toEqual([]);
  });

  it('名册这一步抛了，额度这一轮仍算成功', async () => {
    const logs: string[] = [];
    const world = deps({
      log: (level, message) => {
        logs.push(`${level}:${message}`);
      },
      modelRoster: {
        due: async () => {
          throw new Error('库断了');
        },
        read: async () => [],
        save: async () => ({ unstored: [], newModelIds: [] }),
        notifyNewModels: async () => undefined,
      },
    });
    expect((await runQuotaReadJob(world.deps)).outcome).toBe('ok');
    expect(logs).toContain('error:渠道模型表这一轮没记上');
  });

  it('入库了新模型：同一轮只推一条普通通知，列出模型名', async () => {
    const notices: { key: string; title: string; body: string }[] = [];
    const world = deps({
      modelRoster: {
        due: async () => true,
        read: async () => [{ ok: true, channelId: 'mirasim', models: ['grok-4.7', 'claude-opus-5[1m]'] }],
        save: async () => ({ unstored: [], newModelIds: ['grok-4.7', 'opus-5'] }),
        notifyNewModels: async (n) => {
          notices.push(n);
        },
      },
    });
    expect((await runQuotaReadJob(world.deps)).outcome).toBe('ok');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe('发现 2 个新模型，已入目录、默认关着');
    expect(notices[0]?.body).toContain('grok-4.7');
    expect(notices[0]?.body).toContain('opus-5');
    expect(world.raised).toEqual([]);
  });

  it('没有新模型就不推通知；通知推不出去也不改额度结局', async () => {
    const none: string[] = [];
    const quiet = deps({
      modelRoster: {
        due: async () => true,
        read: async () => [],
        save: async () => ({ unstored: [], newModelIds: [] }),
        notifyNewModels: async (n) => {
          none.push(n.key);
        },
      },
    });
    await runQuotaReadJob(quiet.deps);
    expect(none).toEqual([]);

    const logs: string[] = [];
    const broken = deps({
      log: (level, message) => {
        logs.push(`${level}:${message}`);
      },
      modelRoster: {
        due: async () => true,
        read: async () => [],
        save: async () => ({ unstored: [], newModelIds: ['grok-4.7'] }),
        notifyNewModels: async () => {
          throw new Error('通知库断了');
        },
      },
    });
    expect((await runQuotaReadJob(broken.deps)).outcome).toBe('ok');
    expect(logs).toContain('error:新模型入库的通知没推出去');
  });

  it('额度配置读不到时名册仍尝试，结局仍是额度没跑成', async () => {
    let reads = 0;
    const world = deps({
      loadConfig: async () => {
        throw new Error('quota.json 认不出');
      },
      modelRoster: {
        due: async () => true,
        read: async () => {
          reads += 1;
          return [{ ok: true, channelId: 'cursor', models: ['composer-2.5'] }];
        },
        save: async () => ({ unstored: [], newModelIds: [] }),
        notifyNewModels: async () => undefined,
      },
    });
    await expect(runQuotaReadJob(world.deps)).rejects.toBeInstanceOf(QuotaReadFailedError);
    expect(reads).toBe(1);
    expect(world.finished[0]?.outcome).toBe('failed');
  });

  it('接线给了名册命令才挂上这一步', () => {
    const bare = quotaReadJob({ db: {} as never })();
    expect(bare.modelRoster).toBeUndefined();
    const wired = quotaReadJob({
      db: {} as never,
      modelRoster: {
        commands: { cursor: ['cursor'], grok: ['grok'] },
        runCommand: async () => ({ code: 0, stdout: '', stderr: '', killed: false }),
      },
    })();
    expect(wired.modelRoster).toBeDefined();
  });
});
