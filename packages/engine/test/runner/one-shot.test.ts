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

  it('故意造红：spawner 抛（起不来）→ spawn_failed / timeout，不一跑就 ok', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: () => {
        throw new Error('spawn ENOENT');
      },
    });
    try {
      await expect(runOneShot(BASE_INPUT, deps)).rejects.toThrow(OneShotError);
      // 起不来不该有 runs（这一笔不是「跑了一次」，是「起都没起」）
      expect(recorded).toHaveLength(0);
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
