// one-shot.ts 行为测试：起 → 拿 stdout → 记 runs；故意造红：exit 1 / timeout / 空 stdout。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OneShotError, runOneShot } from '../../src/runner/one-shot.ts';
import { fakeDeps } from './helpers.ts';

const BASE_INPUT = {
  segment: 'manual' as const,
  modelId: 'fake-model',
  prompt: '干这件事',
  cwd: '/tmp/fake-worktree',
};

describe('one-shot.ts', () => {
  it('happy path：起 → 拿 stdout → 记一笔 runs，落盘 stdout/stderr/result.json', async () => {
    const { deps, calls, recorded, tmpDir, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r.outcome).toBe('done');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('做完了');
      // spawner 收的是拼好的 argv + brief 当 stdin
      expect(calls).toHaveLength(1);
      expect(calls[0]?.argv).toEqual(['fake-executor', '--model', 'fake-model']);
      expect(calls[0]?.stdin).toContain('干这件事');
      // runs 记了一笔
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.segment).toBe('manual');
      expect(recorded[0]?.model).toBe('fake-model');
      expect(recorded[0]?.outcome).toBe('done');
      // 落盘目录
      const files = await readdir(join(tmpDir, r.runId));
      expect(files.sort()).toEqual(['brief.txt', 'result.json', 'stderr.txt', 'stdout.txt'].sort());
      const meta = JSON.parse(await readFile(join(tmpDir, r.runId, 'result.json'), 'utf8')) as {
        outcome: string;
        exitCode: number;
      };
      expect(meta.outcome).toBe('done');
      expect(meta.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('故意造红：进程 exit 1 → outcome=failed，runs 也记得是 failed，不当 done', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 1, stdout: '', stderr: 'compiler error', killed: false },
    });
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r.outcome).toBe('failed');
      expect(r.exitCode).toBe(1);
      expect(recorded[0]?.outcome).toBe('failed');
    } finally {
      await cleanup();
    }
  });

  it('故意造红：spawner 抛（起不来）→ 抛 SPAWN_FAILED，不一跑就 ok；开跑那一行收成 spawn_failed（不留一行没结束的）', async () => {
    const { deps, recorded, started, cleanup } = await fakeDeps({
      scripted: () => {
        throw new Error('spawn ENOENT');
      },
    });
    try {
      await expect(runOneShot(BASE_INPUT, deps)).rejects.toMatchObject({
        name: 'OneShotError',
        code: 'SPAWN_FAILED',
      });
      // 开跑时留了一行，起不来就把那一行收掉：留着，切号会一直以为它在跑
      expect(started).toHaveLength(1);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        runId: started[0]?.runId,
        outcome: 'spawn_failed',
        failureReason: '起子进程没起成：spawn ENOENT',
      });
    } finally {
      await cleanup();
    }
  });

  it('【故意造出的失败】起不来、开跑那一行也收不上：照样抛 SPAWN_FAILED，原因里两样都写', async () => {
    const { deps, cleanup } = await fakeDeps({
      scripted: () => {
        throw new Error('spawn ENOENT');
      },
    });
    try {
      deps.runs.record = async () => {
        throw new Error('库连不上');
      };
      const err = await runOneShot(BASE_INPUT, deps).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'OneShotError', code: 'SPAWN_FAILED' });
      expect((err as Error).message).toContain('spawn ENOENT');
      expect((err as Error).message).toContain('开跑那一行也没收上（库连不上）');
    } finally {
      await cleanup();
    }
  });

  it('开跑先在 runs 留一行没结束的（带路由、单号、渠道），收场按同一个编号补完', async () => {
    const { deps, recorded, started, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    const order: string[] = [];
    const { start, record } = deps.runs;
    deps.runs.start = async (r) => {
      order.push('start');
      await start(r);
    };
    deps.runs.record = async (r) => {
      order.push('record');
      await record(r);
    };
    deps.spawn = async () => {
      order.push('spawn');
      return { exitCode: 0, stdout: '做完了', stderr: '', killed: false };
    };
    try {
      const r = await runOneShot(
        {
          ...BASE_INPUT,
          routeId: 'claude-carpool:opus-5.5:claude-code',
          issueNumber: 157,
          channel: 'claude-sub',
        },
        deps,
      );
      expect(order).toEqual(['start', 'spawn', 'record']);
      expect(started).toEqual([
        {
          runId: r.runId,
          segment: 'manual',
          issueNumber: 157,
          model: 'fake-model',
          channel: 'claude-sub',
          routeId: 'claude-carpool:opus-5.5:claude-code',
          startedAt: r.startedAt,
        },
      ]);
      expect(recorded[0]).toMatchObject({
        runId: r.runId,
        routeId: 'claude-carpool:opus-5.5:claude-code',
        outcome: 'done',
      });
    } finally {
      await cleanup();
    }
  });

  it('【故意造出的失败】开跑那一行写不进 runs：抛 RUN_START_FAILED，不起会话、不留收场那一笔', async () => {
    const { deps, calls, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    deps.runs.start = async () => {
      throw new Error('runs 开跑那一行写入失败：connection refused');
    };
    try {
      const err = await runOneShot(BASE_INPUT, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OneShotError);
      expect(err).toMatchObject({ code: 'RUN_START_FAILED' });
      expect((err as Error).message).toContain('开跑那一行写不进 runs，没起会话');
      expect((err as Error).message).toContain('connection refused');
      expect(calls).toHaveLength(0);
      expect(recorded).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('【故意造出的失败】收场那一笔写不进 runs：抛错（不回 done），落盘照样写了', async () => {
    const { deps, tmpDir, started, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    deps.runs.record = async () => {
      throw new Error('runs 写入失败：connection reset');
    };
    try {
      await expect(runOneShot(BASE_INPUT, deps)).rejects.toThrow('connection reset');
      const runId = started[0]?.runId as string;
      expect(await readFile(join(tmpDir, runId, 'stdout.txt'), 'utf8')).toBe('做完了');
    } finally {
      await cleanup();
    }
  });

  it('不许续会话：拿 resumeSessionId 来当场抛', async () => {
    const { deps, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: 'x', stderr: '', killed: false },
    });
    try {
      await expect(runOneShot({ ...BASE_INPUT, resumeSessionId: 'abc-123' }, deps)).rejects.toThrow(
        /RESUME_FORBIDDEN|不许续会话/,
      );
    } finally {
      await cleanup();
    }
  });

  it('落盘的 stdout/stderr/result.json 在 runId 目录下，TTL 24h 写在元数据里', async () => {
    const { deps, tmpDir, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: 'x', stderr: '', killed: false },
    });
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      const runDir = join(tmpDir, r.runId);
      const meta = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as {
        cleanupAfter: number;
      };
      // 24h
      expect(meta.cleanupAfter).toBe(24 * 60 * 60 * 1000);
      // 落盘目录真存在
      const s = await stat(runDir);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
