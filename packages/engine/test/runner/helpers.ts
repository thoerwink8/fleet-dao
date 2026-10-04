// runner 测试的公共件：fake spawner + fake runs + tmp dir。
// 所有「跑通 / 造红」的判定都靠这两件：起不调真子进程，记不进真库。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord, RunStart, RunsWriter } from '../../src/runner/not-wired.ts';
import type { OneShotDeps, OneShotInput, OneShotSpawner, SpawnOutcome } from '../../src/runner/one-shot.ts';

export interface FakeSpawnCall {
  argv: string[];
  cwd: string;
  stdin: string;
}

/** fake spawner：调一次把 scripted 结果原样交回；同时记下 argv/stdin。 */
export function fakeSpawner(
  scripted: SpawnOutcome | ((call: FakeSpawnCall) => SpawnOutcome | Promise<SpawnOutcome>),
): {
  spawner: OneShotSpawner;
  calls: FakeSpawnCall[];
} {
  const calls: FakeSpawnCall[] = [];
  const spawner: OneShotSpawner = async (cmd) => {
    const call: FakeSpawnCall = { argv: cmd.argv, cwd: cmd.cwd, stdin: cmd.stdin };
    calls.push(call);
    if (typeof scripted === 'function') return scripted(call);
    return scripted;
  };
  return { spawner, calls };
}

/** fake runs：开跑、收场各收进一个数组。真 NotWired 落盘由 #556 那一片再测。 */
export function fakeRuns(): { runs: RunsWriter; recorded: RunRecord[]; started: RunStart[] } {
  const recorded: RunRecord[] = [];
  const started: RunStart[] = [];
  return {
    runs: {
      async start(r: RunStart) {
        started.push(r);
      },
      async record(r: RunRecord) {
        recorded.push(r);
      },
    },
    recorded,
    started,
  };
}

/** 造一份带可控 spawner / runs / tmpDir 的 deps。 */
export async function fakeDeps(opts: {
  scripted: SpawnOutcome | ((call: FakeSpawnCall) => SpawnOutcome | Promise<SpawnOutcome>);
}): Promise<{
  deps: OneShotDeps;
  calls: FakeSpawnCall[];
  recorded: RunRecord[];
  started: RunStart[];
  tmpDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'fleet-554-1-'));
  const { spawner, calls } = fakeSpawner(opts.scripted);
  const { runs, recorded, started } = fakeRuns();
  const deps: OneShotDeps = {
    spawn: spawner,
    buildCommand: (input: OneShotInput) => ({
      argv: ['fake-executor', '--model', input.modelId],
      cwd: input.cwd,
    }),
    runs,
    tmpDir,
  };
  return {
    deps,
    calls,
    recorded,
    started,
    tmpDir,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}
