// not-wired.ts：占位 runs 写入不落库、落 JSONL、标 notWired；形状由 zod 钉死，缺字段当场红。

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notWiredRuns, RUNS_NOT_WIRED, RunRecordSchema } from '../../src/runner/not-wired.ts';

describe('notWiredRuns', () => {
  it('notWired 标记带出去，让健康检查报「未接」', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-1-nw-'));
    try {
      const w = notWiredRuns({ tmpDir: tmp });
      expect(w.notWired).toBe(RUNS_NOT_WIRED);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('record() 落一行 JSONL，形状钉死在 zod schema', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-1-nw-'));
    try {
      const w = notWiredRuns({ tmpDir: tmp, now: () => new Date('2026-10-02T01:23:45Z') });
      await w.record({
        runId: 'r-1',
        segment: 'manual',
        issueNumber: 577,
        model: 'fake-model',
        channel: 'fake-channel',
        startedAt: '2026-10-02T01:00:00Z',
        endedAt: '2026-10-02T01:23:45Z',
        outcome: 'done',
      });
      const dir = join(tmp, 'runs-not-wired');
      const files = await readdir(dir);
      expect(files).toEqual(['2026-10-02.jsonl']);
      const line = (await readFile(join(dir, '2026-10-02.jsonl'), 'utf8')).trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.runId).toBe('r-1');
      expect(parsed.segment).toBe('manual');
      expect(parsed.issueNumber).toBe(577);
      expect(parsed.outcome).toBe('done');
      expect(parsed.notWired).toBe(RUNS_NOT_WIRED);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('形状不合（缺 model / outcome），当场红、不落一行', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-1-nw-'));
    try {
      const w = notWiredRuns({ tmpDir: tmp });
      await expect(
        w.record({
          runId: 'r-2',
          segment: 'scope',
          // 缺 model
          startedAt: 'a',
          endedAt: 'b',
          outcome: 'done',
        } as unknown as Parameters<typeof w.record>[0]),
      ).rejects.toThrow();
      // 不落盘
      await expect(readdir(join(tmp, 'runs-not-wired'))).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('RunRecordSchema 约束：outcome 枚举只收规定几种', () => {
    expect(() =>
      RunRecordSchema.parse({
        runId: 'r',
        segment: 'verify',
        model: 'm',
        startedAt: 'a',
        endedAt: 'b',
        outcome: 'magical',
      }),
    ).toThrow();
  });
});
