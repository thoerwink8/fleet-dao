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

/** 动手段记到谁名下的那几样（#216）。 */
const OWNER = {
  taskId: '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69',
  tier: 'medium' as const,
  workflowId: 'task:acme/demo#216',
  prNumber: 7,
  branch: 'fleet/216-t0a1b2c3d',
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
        // 起不来不是路由的错（#758）：不进熔断、战绩
        routeOutcome: 'neutral',
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

  it('记到谁名下（#216）：单子、派工档、工作流编号、PR、分支开跑那一行和收场那一笔一模一样（收场整行覆盖，不能冲掉开跑写的）', async () => {
    const { deps, recorded, started, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    try {
      const r = await runOneShot({ ...BASE_INPUT, issueNumber: 216, ...OWNER }, deps);
      expect(r.outcome).toBe('done');
      const owner = { runId: r.runId, segment: 'manual', issueNumber: 216, ...OWNER };
      expect(started).toEqual([{ ...owner, model: 'fake-model', startedAt: r.startedAt }]);
      expect(recorded).toHaveLength(1);
      const { endedAt, outcome, routeOutcome, ...opening } = recorded[0] as NonNullable<(typeof recorded)[0]>;
      expect(opening).toEqual(started[0]);
      expect([endedAt, outcome, routeOutcome]).toEqual([r.endedAt, 'done', 'ok']);
    } finally {
      await cleanup();
    }
  });

  it('没给的（还没开 PR、不在工作流里跑）不写这几列：不拿 0、空串顶', async () => {
    const { deps, recorded, started, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    try {
      await runOneShot(BASE_INPUT, deps);
      for (const row of [started[0], recorded[0]]) {
        for (const key of ['taskId', 'tier', 'workflowId', 'prNumber', 'branch']) {
          expect(row).not.toHaveProperty(key);
        }
      }
    } finally {
      await cleanup();
    }
  });

  it.each([
    ['派工档不在 tier.ts 那三档里', { tier: 'turbo' }, 'tier'],
    ['验收段带了派工档（只有动手分档）', { segment: 'verify', tier: 'fast' }, 'tier'],
    ['对题段带了派工档', { segment: 'scope', tier: 'heavyweight' }, 'tier'],
    ['单子编号不是库里 tasks.id 的样子', { taskId: 'task-1' }, 'taskId'],
    ['PR 号是 0', { prNumber: 0 }, 'prNumber'],
    ['分支是空串', { branch: '' }, 'branch'],
  ])(
    '【故意造出的失败】%s：写进 runs 之前就报 BAD_RUN_INPUT，不起会话、不留一行、不落盘',
    async (_what, bad, field) => {
      const { deps, calls, recorded, started, tmpDir, cleanup } = await fakeDeps({
        scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
      });
      try {
        const input = { ...BASE_INPUT, ...OWNER, runId: 'run-bad', ...bad } as Parameters<
          typeof runOneShot
        >[0];
        const err = await runOneShot(input, deps).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(OneShotError);
        expect(err).toMatchObject({ code: 'BAD_RUN_INPUT' });
        expect((err as Error).message).toContain('记账的字段对不上 runs 的约束');
        expect((err as Error).message).toContain(field);
        expect(calls).toHaveLength(0);
        expect(started).toHaveLength(0);
        expect(recorded).toHaveLength(0);
        await expect(stat(join(tmpDir, 'run-bad'))).rejects.toThrow();
      } finally {
        await cleanup();
      }
    },
  );

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

describe('切号叫停（deps.stop，#59）：结局 org_switch，不是 killed、不算失败', () => {
  const WHY = '切号：会话用户从拼车组织切到独享组织，先停下，切完接着干';

  it('会话跑着时叫停：进程被杀，结局 org_switch，原因写为什么停；runs 收成 org_switch', async () => {
    const stop = new AbortController();
    const { deps, recorded, started, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '', stderr: '', killed: false },
    });
    deps.spawn = (cmd) =>
      new Promise((resolve) => {
        cmd.signal.addEventListener(
          'abort',
          () => resolve({ exitCode: null, stdout: '', stderr: '', killed: true }),
          {
            once: true,
          },
        );
        setTimeout(() => stop.abort(new Error(WHY)), 5);
      });
    deps.stop = stop.signal;
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r.outcome).toBe('org_switch');
      expect(r.failureReason).toBe(`${WHY}（会话被停下）`);
      expect(started).toHaveLength(1);
      // 切号停的不算这条路由的账（#758）：熔断、战绩看不见这一次
      expect(recorded).toEqual([
        expect.objectContaining({
          runId: r.runId,
          outcome: 'org_switch',
          routeOutcome: 'neutral',
          failureReason: `${WHY}（会话被停下）`,
        }),
      ]);
    } finally {
      await cleanup();
    }
  });

  it('起会话之前就叫停了：不起会话、不留开跑那一行，记一笔 org_switch', async () => {
    const stop = new AbortController();
    stop.abort(new Error(WHY));
    const { deps, calls, recorded, started, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    deps.stop = stop.signal;
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r).toMatchObject({
        outcome: 'org_switch',
        exitCode: null,
        failureReason: `${WHY}（还没起会话）`,
      });
      expect(calls).toHaveLength(0);
      expect(started).toHaveLength(0);
      expect(recorded).toEqual([expect.objectContaining({ runId: r.runId, outcome: 'org_switch' })]);
    } finally {
      await cleanup();
    }
  });

  it('【故意造出的失败】内存一直放不下时叫停：先认叫停，回 org_switch（不再回 admission_blocked 让调用方接着等），不查内存', async () => {
    const stop = new AbortController();
    stop.abort(new Error(WHY));
    const { deps, calls, recorded, started, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    let reads = 0;
    deps.memoryAdmission = {
      readText: async () => {
        reads += 1;
        return String(9500 * 1024 * 1024);
      },
      cgroupRoot: '/sys/fs/cgroup',
      slicePath: 'fleet.slice/fleet-agents.slice',
      sliceHighMb: 10_000,
      reservePerSessionMb: 2048,
    };
    deps.stop = stop.signal;
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r).toMatchObject({ outcome: 'org_switch', failureReason: `${WHY}（还没起会话）` });
      expect(reads).toBe(0);
      expect(calls).toHaveLength(0);
      expect(started).toHaveLength(0);
      expect(recorded).toEqual([expect.objectContaining({ runId: r.runId, outcome: 'org_switch' })]);
    } finally {
      await cleanup();
    }
  });

  it('叫停时起会话那一步抛了（插头被杀时拒掉）：还是 org_switch，不当成起不来', async () => {
    const stop = new AbortController();
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '', stderr: '', killed: false },
    });
    deps.spawn = (cmd) =>
      new Promise((_resolve, reject) => {
        cmd.signal.addEventListener('abort', () => reject(new Error('被杀了')), { once: true });
        setTimeout(() => stop.abort(new Error(WHY)), 5);
      });
    deps.stop = stop.signal;
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r).toMatchObject({ outcome: 'org_switch', stderrTail: '被杀了' });
      expect(recorded[0]).toMatchObject({ outcome: 'org_switch' });
    } finally {
      await cleanup();
    }
  });

  it('叫停之后会话自己跑完了（赶在被杀之前交了）：照样是 done；叫停之后报了别的错的：算 org_switch（是我们停的）', async () => {
    const finished = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    const stopA = new AbortController();
    finished.deps.spawn = async () => {
      stopA.abort(new Error(WHY));
      return { exitCode: 0, stdout: '做完了', stderr: '', killed: false };
    };
    finished.deps.stop = stopA.signal;
    const failing = await fakeDeps({ scripted: { exitCode: 1, stdout: '', stderr: '', killed: false } });
    const stopB = new AbortController();
    failing.deps.spawn = async () => {
      stopB.abort(new Error(WHY));
      return { exitCode: 1, stdout: '', stderr: 'SIGTERM', killed: false };
    };
    failing.deps.stop = stopB.signal;
    try {
      expect((await runOneShot(BASE_INPUT, finished.deps)).outcome).toBe('done');
      expect((await runOneShot(BASE_INPUT, failing.deps)).outcome).toBe('org_switch');
    } finally {
      await finished.cleanup();
      await failing.cleanup();
    }
  });

  it('超时先到的算超时（不算切号）', async () => {
    const stop = new AbortController();
    const { deps, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '', stderr: '', killed: false },
    });
    deps.spawn = (cmd) =>
      new Promise((resolve) => {
        cmd.signal.addEventListener(
          'abort',
          () => {
            stop.abort(new Error(WHY));
            resolve({ exitCode: null, stdout: '', stderr: '', killed: true });
          },
          { once: true },
        );
      });
    deps.stop = stop.signal;
    try {
      const r = await runOneShot({ ...BASE_INPUT, timeoutMinutes: 0.0005 }, deps);
      expect(r.outcome).toBe('timeout');
    } finally {
      await cleanup();
    }
  });
});
