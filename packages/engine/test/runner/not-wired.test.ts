// not-wired.ts：占位 runs 写入不落库、落 JSONL、标 notWired；形状由 zod 钉死，缺字段当场红。

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notWiredRuns, RUNS_NOT_WIRED, RunRecordSchema, RunStartSchema } from '../../src/runner/not-wired.ts';

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

  it('start()：开跑那一行只挡形状、不落盘（收场那一笔才是整行）；形状不合当场红', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-1-nw-'));
    try {
      const w = notWiredRuns({ tmpDir: tmp });
      await w.start({
        runId: 'r-0',
        segment: 'manual',
        model: 'fake-model',
        routeId: 'claude-carpool:opus-5.5:claude-code',
        startedAt: '2026-10-02T01:00:00Z',
      });
      await expect(readdir(join(tmp, 'runs-not-wired'))).rejects.toThrow();
      await expect(
        w.start({
          runId: 'r-0',
          segment: 'fusion',
          model: 'fake-model',
          startedAt: '2026-10-02T01:00:00Z',
        } as unknown as Parameters<typeof w.start>[0]),
      ).rejects.toThrow();
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

  it('记到谁名下的几样（#216）：tasks.id、派工档、工作流编号、PR、分支，开跑那一行和收场那一笔都收、原样留着', () => {
    const start = {
      runId: 'r-216',
      segment: 'manual' as const,
      taskId: '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69',
      issueNumber: 216,
      model: 'm',
      tier: 'heavyweight' as const,
      workflowId: 'task:acme/demo#216',
      prNumber: 7,
      branch: 'fleet/216-t0a1b2c3d',
      startedAt: '2026-10-04T01:00:00Z',
    };
    expect(RunStartSchema.parse(start)).toEqual(start);
    const record = { ...start, endedAt: '2026-10-04T01:30:00Z', outcome: 'done' as const };
    expect(RunRecordSchema.parse(record)).toEqual(record);
  });

  it.each([
    ['派工档不在 tier.ts 那三档里（runs_tier_known 也会拒）', { tier: 'turbo' }, 'tier'],
    ['验收段带了派工档：只有动手分档（决定 0010 第 3 条）', { segment: 'verify', tier: 'fast' }, 'tier'],
    ['对题段带了派工档', { segment: 'scope', tier: 'medium' }, 'tier'],
    ['taskId 不是 uuid（runs.task_id 是 uuid 列）', { taskId: 'task-1' }, 'taskId'],
    ['PR 号是 0（runs_pr_positive 也会拒）', { prNumber: 0 }, 'prNumber'],
    ['分支是空串（读不到就不给，不拿空串顶）', { branch: '' }, 'branch'],
    ['工作流编号是空串', { workflowId: '' }, 'workflowId'],
  ])('【故意造出的失败】%s：开跑、收场两份形状都当场红', (_what, bad, field) => {
    const start = {
      runId: 'r',
      segment: 'manual',
      model: 'm',
      startedAt: '2026-10-04T01:00:00Z',
      ...bad,
    };
    const startErr = RunStartSchema.safeParse(start);
    expect(startErr.success).toBe(false);
    expect(startErr.error?.issues.map((i) => i.path.join('.'))).toContain(field);
    const recordErr = RunRecordSchema.safeParse({
      ...start,
      endedAt: '2026-10-04T01:30:00Z',
      outcome: 'done',
    });
    expect(recordErr.success).toBe(false);
    expect(recordErr.error?.issues.map((i) => i.path.join('.'))).toContain(field);
  });

  it('【故意造出的失败】占位的 start() 也照这份挡：验收段带派工档当场红', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-1-nw-'));
    try {
      const w = notWiredRuns({ tmpDir: tmp });
      await expect(
        w.start({
          runId: 'r-v',
          segment: 'verify',
          model: 'm',
          tier: 'fast',
          startedAt: '2026-10-04T01:00:00Z',
        }),
      ).rejects.toThrow(/只有动手段分档/);
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
