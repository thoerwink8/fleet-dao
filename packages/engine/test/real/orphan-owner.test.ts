import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRun, startRun } from '@fleet-dao/db';
import { TEST_DB_TIMEOUT_MS } from '@fleet-dao/db/testing';
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import { DETACHED_MARK, HANDOFF_TTL_MS, writeMirasimHandle } from '../../src/real/session-handoff.ts';
import { runChild } from '../child.ts';
import { fakeTrees, NOW } from './fixtures.ts';
import { createOrphanOwner, type OrphanOwner } from './orphan-owner.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

it('测试和清理都超时后，机器核明预期红项，下一例的库、helper 和目录仍独立', () => {
  const tempBase = join(repo, 'packages/engine/_tmp');
  mkdirSync(tempBase, { recursive: true });
  const root = mkdtempSync(join(tempBase, 'orphan-owner-'));
  const initial = lstatSync(root);
  const physical = realpathSync.native(root);
  const removeRoot = () => {
    const current = lstatSync(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      realpathSync.native(root) !== physical ||
      dirname(root) !== tempBase
    )
      throw new Error('子进程测试目录身份变化，拒绝清理');
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const report = join(root, 'vitest.json');
    const eventsPath = join(root, 'events.json');
    writeFileSync(join(root, 'scenario.test.ts'), "import '../../test/fixtures/orphan-owner-timeout.ts';\n");
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default ${JSON.stringify({ test: { include: [`${relative(repo, root).replaceAll('\\', '/')}/scenario.test.ts`], maxWorkers: 1, fileParallelism: false } })};\n`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FLEET_ORPHAN_OWNER_REPORT: eventsPath,
      FAKE_SCOPE_LIST: 'host-control-must-not-leak active\n',
      FAKE_SCOPE_LIST_EXIT: '19',
      FAKE_SCOPE_STOP_EXIT: '17',
    };
    const child = runChild(
      process.execPath,
      [
        join(repo, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        join(root, 'vitest.config.mjs'),
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { cwd: repo, env },
    );
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(1);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      numFailedTests: number;
      numPassedTests: number;
      numPendingTests: number;
      testResults: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
    };
    expect(result.numFailedTests).toBe(1);
    expect(result.numPassedTests).toBe(1);
    expect(result.numPendingTests).toBe(0);
    const cases = result.testResults.flatMap((file) => file.assertionResults);
    expect(cases).toHaveLength(2);
    const first = cases.find((item) => item.title === 'A: controlled test timeout');
    expect(first?.status).toBe('failed');
    expect(first?.failureMessages.join('\n')).toContain('Test timed out in 1000ms');
    expect(first?.failureMessages.join('\n')).toContain('Hook timed out in 300ms');
    expect(cases.find((item) => item.title.startsWith('B:'))?.status).toBe('passed');
    const events = JSON.parse(readFileSync(eventsPath, 'utf8')) as { kind: string }[];
    expect(events.map((event) => event.kind)).toEqual([
      'A-gate-entered',
      'A-aborted',
      'A-cleanup-started',
      'B-began',
      'B-seeded',
      'A-gate-resumed',
      'A-cleanup-finished',
      'B-verified',
    ]);
  } finally {
    removeRoot();
  }
}, 0);

describe('迟到的延迟清扫仍归原 owner', () => {
  const owners = new WeakMap<TestContext, Promise<[OrphanOwner, OrphanOwner]>>();
  beforeEach(async (context) => {
    const pending = (async (): Promise<[OrphanOwner, OrphanOwner]> => {
      const first = await createOrphanOwner();
      try {
        return [first, await createOrphanOwner()];
      } catch (error) {
        await first.close();
        throw error;
      }
    })();
    owners.set(context, pending);
    await pending;
  }, TEST_DB_TIMEOUT_MS);
  afterEach(async (context) => {
    const pending = owners.get(context);
    try {
      if (pending) {
        const pair = await pending;
        for (const owner of pair) await owner.close();
      }
    } finally {
      if (owners.get(context) === pending) owners.delete(context);
    }
  });

  it('已启动 sweep 即使在原库关闭后才恢复，也不能修改下一例的同号 run', async (context) => {
    const pending = owners.get(context);
    if (!pending) throw new Error('测试 owner 未登记');
    const [first, next] = await pending;
    const id = randomUUID();
    const trees = fakeTrees(join(first.root, 'work'));
    const ioRoot = join(first.root, 'io');
    const io = join(ioRoot, id);
    mkdirSync(io, { recursive: true });
    writeFileSync(join(io, DETACHED_MARK), NOW.toISOString());
    writeMirasimHandle(io, {
      runId: id,
      sessionKey: `claude:${id}`,
      taskId: first.taskId,
      acceptedAt: NOW.toISOString(),
    });
    await startRun(first.t.db, {
      id,
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'carpool',
      startedAt: NOW,
    });
    let clock = NOW;
    let fire: (() => void) | undefined;
    let entered: () => void;
    const atStop = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => {
      throw new Error('延迟清扫门控尚未准备');
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const scope = first.scope();
    const reap = first.reaper({
      trees: trees.trees,
      helper: scope.helper,
      sudo: scope.sudo,
      ioRoot,
      now: () => clock,
      later: (fn) => {
        fire = first.delayed(fn);
      },
      stopMirasim: async () => {
        entered();
        await gate;
        return { confirmed: true, detail: 'fixture' };
      },
      log: (message) => {
        if (message === '没人接回的会话那几行 runs 没收上') finish();
      },
    });
    await reap();
    clock = new Date(NOW.getTime() + HANDOFF_TTL_MS);
    fire?.();
    await atStop;
    await first.close();
    await startRun(next.t.db, {
      id,
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'carpool',
      startedAt: NOW,
    });
    release();
    await finished;
    expect(await getRun(next.t.db, id)).toMatchObject({ endedAt: null, outcome: null });
    expect(existsSync(next.root)).toBe(true);
    // 关闭后未启动的回调直接失效，不能在新一例里重开旧清扫。
    let called = false;
    first.delayed(() => {
      called = true;
    })();
    expect(called).toBe(false);
  });
});
