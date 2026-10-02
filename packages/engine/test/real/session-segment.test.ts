// #554-4：sessions.ts 接 runner——三段（对题 / 动手 / 验收）起无头进程（不动 Fusion 的链路）。
//
// 测的：
// 1. brief.segment ∈ {scope | manual | verify}：走 runner 分支；spawner fake 起会话 / 拿 stdout / verdict；runs
//    落 NotWired JSONL（_tmp/runs-not-wired/）。
// 2. brief.segment 没给：不走 runner 分支（就算 segment 端口有依赖也不动 Fusion）。
// 3. 故意造红：blank stdout / exit=1——不能拿它当「done」。
// 4. NotWired 写入：verify 一段跑完时 `_tmp/runs-not-wired/<日期>.jsonl` 出现一行，字段
//    segment / model / startedAt / endedAt / outcome / runId 都要有——缺任何一项都不写、也不当写成了。
// 5. segment 依赖没装（spawner / buildCommand / runs 推个缺）：当场 SEGMENT_NOT_WIRED——不鲁式化。

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import type { LaunchSessionInput, SessionBrief } from '../../src/ports.ts';
import {
  launchSegment,
  SEGMENT_NOT_WIRED_CODE,
  type SegmentPortsDeps,
} from '../../src/real/sessions-segment.ts';
import { notWiredRuns } from '../../src/runner/not-wired.ts';
import type { SpawnCommand, SpawnOutcome } from '../../src/runner/one-shot.ts';

/** 测 Db 走 fake——launchSegment 不用 db（它的占位塞）；给个最小形状的类型满足。 */
const fakeDb = {} as unknown as Db;

/** launchSegment 输入最简形状。 */
function inputFor(segment: SessionBrief['segment'], overrides: Partial<LaunchSessionInput> = {}) {
  const brief: SessionBrief = {
    title: '测单',
    request: '测需求',
    acceptance: ['干成'],
    touches: ['packages/engine/src/real/sessions-segment.ts'],
    feedback: [],
    answers: [],
    ...(segment !== undefined ? { segment } : {}),
  };
  return {
    runId: overrides.runId ?? `test-${Math.random().toString(36).slice(2, 10)}`,
    stage: 'execute' as const,
    ...(overrides.route ?? {
      route: {
        routeId: 'r-1',
        modelId: 'fake-model',
        hostId: 'grok',
        poolId: 'p-1',
        family: 'grok',
        upstreamModel: null,
        runAsUser: null,
      },
    }),
    whyRoute: '',
    taskId: 't-1',
    queuedAt: '2026-10-01T00:00:00Z',
    brief,
    stallSeconds: 30,
    sessionMinutes: 1,
    resources: { memoryHighMb: 1024, memoryMaxMb: 1024, swapMaxMb: 0 },
    launch: { fleetApi: '', fleetToken: '', pathPrepend: [] },
    ...overrides,
  } as unknown as LaunchSessionInput;
}

interface FakeSpec {
  /** 返回的 result。 */
  result?: SpawnOutcome;
  /** 故意抛（起不来）。 */
  throwMessage?: string;
  /** 记下每次 spawn 的 command 供断言。 */
  onCall?: (cmd: SpawnCommand) => void;
}
/** fake Spawner：不调真子进程，把 OneShot 的请求记下来。 */
function fakeSpawn(spec: FakeSpec): (cmd: SpawnCommand) => Promise<SpawnOutcome> {
  return async (cmd) => {
    spec.onCall?.(cmd);
    if (spec.throwMessage) throw new Error(spec.throwMessage);
    if (!spec.result) throw new Error('fakeSpawn 没 result 也没 throw——测试写漏了');
    return spec.result;
  };
}
const fakeBuildCommand = () => ({
  argv: ['echo', 'fake'],
});
function baseDeps(
  workspace: string,
  tmp: string,
): Omit<SegmentPortsDeps, 'db' | 'runs' | 'spawner' | 'buildCommand'> {
  return {
    cwd: workspace,
    tmpDir: tmp,
  };
}

describe('launchSegment（554-4）', () => {
  it('scope 段：fake 起一次、stdout 非空 → judgeScope ok；NotWired JSONL 落一行', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp, now: () => new Date('2026-10-01T05:00:00Z') });
      let prompt = '';
      const outcome = await launchSegment(
        inputFor({ kind: 'scope' }, { runId: 'r-scope', worktreePath: ws }),
        {
          db: fakeDb,
          spawner: fakeSpawn({
            result: { exitCode: 0, stdout: '建单整理稿', stderr: '', killed: false },
            onCall: (c) => {
              prompt = c.stdin;
            },
          }),
          buildCommand: fakeBuildCommand,
          runs,
          ...baseDeps(ws, tmp),
        },
      );
      expect(outcome.verdict.kind).toBe('ok');
      expect(outcome.result.outcome).toBe('done');
      expect(prompt).toContain('测需求');
      // NotWired JSONL：runs-not-wired/<日期>.jsonl 要出现一行带必要字段
      const dir = join(tmp, 'runs-not-wired');
      const files = await readdir(dir);
      expect(files).toContain('2026-10-01.jsonl');
      const line = (await readFile(join(dir, '2026-10-01.jsonl'), 'utf8')).trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const f of ['runId', 'segment', 'model', 'startedAt', 'endedAt', 'outcome']) {
        expect(parsed, `缺 ${f}`).toHaveProperty(f);
      }
      expect(parsed.segment).toBe('scope');
      expect(parsed.outcome).toBe('done');
      expect(parsed.notWired).toBe('runs 表还没建（#556）');
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('manual 段：fake 起一次、stdout 非空 → verdict ok（evidence 由 554-2 补）；JSONL 落一行 segment="manual"', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp, now: () => new Date('2026-10-01T05:00:00Z') });
      const outcome = await launchSegment(
        inputFor(
          { kind: 'manual', branch: 'feat/x', baseSha: 'abc' },
          { runId: 'r-manual', worktreePath: ws },
        ),
        {
          db: fakeDb,
          spawner: fakeSpawn({
            result: { exitCode: 0, stdout: '开了 PR #42', stderr: '', killed: false },
          }),
          buildCommand: fakeBuildCommand,
          runs,
          ...baseDeps(ws, tmp),
        },
      );
      expect(outcome.verdict.kind).toBe('ok');
      const dir = join(tmp, 'runs-not-wired');
      const line = (await readFile(join(dir, '2026-10-01.jsonl'), 'utf8')).trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.segment).toBe('manual');
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('verify 段：stdout 末行写 pass、exit 0 → judgeVerify ok；JSONL 落一行 segment="verify"', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp, now: () => new Date('2026-10-01T05:00:00Z') });
      const outcome = await launchSegment(
        inputFor(
          {
            kind: 'verify',
            prNumber: 42,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            changedFiles: ['packages/engine/src/ports.ts'],
            diffText: '--- a\n+++ b\n',
          },
          { runId: 'r-verify', worktreePath: ws },
        ),
        {
          db: fakeDb,
          spawner: fakeSpawn({
            result: {
              exitCode: 0,
              stdout: '对照「怎么算做完」逐条回 pass / fail。\npass',
              stderr: '',
              killed: false,
            },
          }),
          buildCommand: fakeBuildCommand,
          runs,
          ...baseDeps(ws, tmp),
        },
      );
      expect(outcome.verdict.kind).toBe('ok');
      const dir = join(tmp, 'runs-not-wired');
      const line = (await readFile(join(dir, '2026-10-01.jsonl'), 'utf8')).trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.segment).toBe('verify');
      for (const f of ['runId', 'model', 'startedAt', 'endedAt', 'outcome']) {
        expect(parsed, `缺 ${f}`).toHaveProperty(f);
      }
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('scope 段造红：exit=1 + 非空 stderr → verdict failed，JSONL 落一行 outcome="failed"', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp, now: () => new Date('2026-10-01T05:00:00Z') });
      const outcome = await launchSegment(
        inputFor({ kind: 'scope' }, { runId: 'r-bad-exit', worktreePath: ws }),
        {
          db: fakeDb,
          spawner: fakeSpawn({
            result: { exitCode: 1, stdout: '', stderr: 'no model', killed: false },
          }),
          buildCommand: fakeBuildCommand,
          runs,
          ...baseDeps(ws, tmp),
        },
      );
      expect(outcome.verdict.kind).toBe('failed');
      expect(outcome.result.outcome).toBe('failed');
      const dir = join(tmp, 'runs-not-wired');
      const line = (await readFile(join(dir, '2026-10-01.jsonl'), 'utf8')).trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.outcome).toBe('failed');
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('scope 段造红：exit=0 但 stdout 空 → verdict failed（不许拿空当跑完）', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp, now: () => new Date('2026-10-01T05:00:00Z') });
      const outcome = await launchSegment(
        inputFor({ kind: 'scope' }, { runId: 'r-bad-blank', worktreePath: ws }),
        {
          db: fakeDb,
          spawner: fakeSpawn({
            result: { exitCode: 0, stdout: '', stderr: '', killed: false },
          }),
          buildCommand: fakeBuildCommand,
          runs,
          ...baseDeps(ws, tmp),
        },
      );
      expect(outcome.verdict.kind).toBe('failed');
      expect(outcome.verdict.reason).toContain('stdout 是空的');
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('verify 段造红：exit=0 但 verdictLine 又 pass 又 fail → verdict failed（一句话说不清当没结论）', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp, now: () => new Date('2026-10-01T05:00:00Z') });
      const outcome = await launchSegment(
        inputFor(
          {
            kind: 'verify',
            prNumber: 42,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            changedFiles: ['x.ts'],
            diffText: '--- a\n+++ b\n',
          },
          { runId: 'r-bad-mixed', worktreePath: ws },
        ),
        {
          db: fakeDb,
          spawner: fakeSpawn({
            result: { exitCode: 0, stdout: '看到了 pass，也看到了 fail', stderr: '', killed: false },
          }),
          buildCommand: fakeBuildCommand,
          runs,
          ...baseDeps(ws, tmp),
        },
      );
      expect(outcome.verdict.kind).toBe('failed');
      expect(outcome.verdict.reason).toContain('又 pass 又 fail');
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('spawner 没装 / buildCommand 没装 / runs 没装 → 当场 SEGMENT_NOT_WIRED，不落 runs', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp, now: () => new Date('2026-10-01T05:00:00Z') });
      // 缺 spawner + buildCommand
      await expect(
        launchSegment(inputFor({ kind: 'scope' }, { runId: 'r-no-spawn', worktreePath: ws }), {
          db: fakeDb,
          runs,
          ...baseDeps(ws, tmp),
        }),
      ).rejects.toMatchObject({ code: SEGMENT_NOT_WIRED_CODE });
      // 装 spawner + buildCommand，缺 runs
      await expect(
        launchSegment(inputFor({ kind: 'scope' }, { runId: 'r-no-runs', worktreePath: ws }), {
          db: fakeDb,
          spawner: fakeSpawn({ result: { exitCode: 0, stdout: 'x', stderr: '', killed: false } }),
          buildCommand: fakeBuildCommand,
          ...baseDeps(ws, tmp),
        }),
      ).rejects.toMatchObject({ code: SEGMENT_NOT_WIRED_CODE });
      // 这两个 case 都不该落 JSONL——runs-not-wired/ 还是空的
      const dir = join(tmp, 'runs-not-wired');
      await expect(readdir(dir)).rejects.toThrow();
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('input.brief.segment 没给：launchSegment 当场 BAD_INPUT，不许当 scope 跑', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp });
      await expect(
        launchSegment(
          // 不传 segment
          inputFor(undefined, { runId: 'r-no-segment', worktreePath: ws }),
          {
            db: fakeDb,
            spawner: fakeSpawn({ result: { exitCode: 0, stdout: 'x', stderr: '', killed: false } }),
            buildCommand: fakeBuildCommand,
            runs,
            ...baseDeps(ws, tmp),
          },
        ),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('spawner 自己抛 → launchSegment 抛 OneShotError SPAWN_FAILED，不鲁式化成 outcome', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'fleet-554-4-ws-'));
    const tmp = await mkdtemp(join(tmpdir(), 'fleet-554-4-tmp-'));
    try {
      const runs = notWiredRuns({ tmpDir: tmp });
      await expect(
        launchSegment(inputFor({ kind: 'scope' }, { runId: 'r-spawn-throw', worktreePath: ws }), {
          db: fakeDb,
          spawner: fakeSpawn({ throwMessage: 'unknown command foo' }),
          buildCommand: fakeBuildCommand,
          runs,
          ...baseDeps(ws, tmp),
        }),
      ).rejects.toThrow(/SPAWN_FAILED|起子进程没起成|unknown command foo/);
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
