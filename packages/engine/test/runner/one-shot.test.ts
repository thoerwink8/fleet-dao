// one-shot.ts 行为测试：起 → 拿 stdout → 记 runs；故意造红：exit 1 / timeout / 空 stdout。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  USAGE_NOTE_MASTER_OFF,
  USAGE_NOTE_MEMORY,
  USAGE_NOTE_SPAWN_FAILED,
  USAGE_SESSION_UNREAD,
} from '@fleet-dao/shared';
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
  it('attach 无来源读取能力明确拒绝，不调用驱动或记账（#3652）', async () => {
    const { deps, calls, started, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: 'x', stderr: '', killed: false },
    });
    try {
      await expect(
        runOneShot(
          {
            ...BASE_INPUT,
            runId: 'original-run',
            detach: { attach: { startedAt: new Date().toISOString() } },
          },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'BAD_RUN_INPUT' });
      expect([calls.length, started.length, recorded.length]).toEqual([0, 0, 0]);
    } finally {
      await cleanup();
    }
  });
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
          // 开跑那一行带工作目录（#2357：每小时对账认树里有没有没结束的会话，原先读 session_runs 的这一列）
          worktreePath: BASE_INPUT.cwd,
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
      expect(started).toEqual([
        { ...owner, model: 'fake-model', worktreePath: BASE_INPUT.cwd, startedAt: r.startedAt },
      ]);
      expect(recorded).toHaveLength(1);
      const { endedAt, outcome, routeOutcome, usageNote, ...opening } = recorded[0] as NonNullable<
        (typeof recorded)[0]
      >;
      expect(opening).toEqual(started[0]);
      expect([endedAt, outcome, routeOutcome, usageNote]).toEqual([
        r.endedAt,
        'done',
        'ok',
        USAGE_SESSION_UNREAD,
      ]);
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

  it('续会话按入参：给了 resumeSessionId 原样交给 Spawner；不给、给空串都开新会话', async () => {
    const { deps, calls, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: 'x', stderr: '', killed: false },
    });
    try {
      const resumed = await runOneShot({ ...BASE_INPUT, runId: 'run-r1', resumeSessionId: 'abc-123' }, deps);
      expect(resumed.outcome).toBe('done');
      await runOneShot({ ...BASE_INPUT, runId: 'run-r2' }, deps);
      await runOneShot({ ...BASE_INPUT, runId: 'run-r3', resumeSessionId: '  ' }, deps);
      expect(calls.map((c) => c.resumeSessionId)).toEqual(['abc-123', undefined, undefined]);
    } finally {
      await cleanup();
    }
  });

  it('把续会话判定写进 runs：续上的记期望会话号，没续上的记原因', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: {
        exitCode: 0,
        stdout: 'x',
        stderr: '',
        killed: false,
        facts: { sessionId: 'cursor:real-1' },
      },
    });
    try {
      await runOneShot(
        { ...BASE_INPUT, runId: 'run-resume-recorded', resumeSessionId: 'cursor:previous-1' },
        deps,
      );
      await runOneShot(
        { ...BASE_INPUT, runId: 'run-new-recorded', resumeReason: '上一段没记下会话号' },
        deps,
      );
      expect(recorded[0]).toMatchObject({ resumeSessionId: 'cursor:previous-1' });
      expect(recorded[1]).toMatchObject({ resumeReason: '上一段没记下会话号' });
    } finally {
      await cleanup();
    }
  });

  it('起因、摘要、所属回合（#3140）：开跑那一行和收场那一笔都带，摘要截到 500 字；不给就不带键', async () => {
    const { deps, recorded, started, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: 'x', stderr: '', killed: false },
    });
    try {
      await runOneShot(
        {
          ...BASE_INPUT,
          runId: 'run-cause',
          cause: 'retry',
          causeSummary: '上游 503 '.repeat(200),
          roundSeq: 3,
        },
        deps,
      );
      await runOneShot({ ...BASE_INPUT, runId: 'run-plain' }, deps);
      expect(started[0]).toMatchObject({ cause: 'retry', roundSeq: 3 });
      expect(started[0]?.causeSummary).toHaveLength(500);
      expect(recorded[0]).toMatchObject({ cause: 'retry', roundSeq: 3 });
      expect(recorded[1]).not.toHaveProperty('cause');
      expect(recorded[1]).not.toHaveProperty('causeSummary');
      expect(recorded[1]).not.toHaveProperty('roundSeq');
    } finally {
      await cleanup();
    }
  });

  it('老历史借 route.why 的内部标记带的新会话原因，仍拆回 resumeReason 和真正的 routeWhy', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: 'x', stderr: '', killed: false },
    });
    try {
      await runOneShot(
        {
          ...BASE_INPUT,
          runId: 'run-legacy-marker',
          routeWhy: `fleet-resume-new:${JSON.stringify({ reason: '没记会话号', routeWhy: '价低' })}`,
        },
        deps,
      );
      expect(recorded[0]).toMatchObject({ resumeReason: '没记会话号', routeWhy: '价低' });
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

/** 确定没发出模型调用：四样 token 和花费都是 0。 */
const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

describe('没会话号的用量（#2689）：确定没调用的记 0，读不准的写「读不到」', () => {
  it('总开关关、还没起会话：记 0 用量，原因写总开关关', async () => {
    const stop = new AbortController();
    stop.abort(new Error('引擎总开关：总开关关着；这一段没起会话'));
    const { deps, calls, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '不该跑', stderr: '', killed: false },
    });
    deps.stop = stop.signal;
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r.outcome).toBe('org_switch');
      expect(calls).toHaveLength(0);
      expect(recorded[0]).toMatchObject({ ...ZERO_USAGE, usageNote: USAGE_NOTE_MASTER_OFF });
    } finally {
      await cleanup();
    }
  });

  it('内存不够、没起会话：记 0 用量，原因写内存不够', async () => {
    const { deps, calls, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '不该跑', stderr: '', killed: false },
    });
    deps.memoryAdmission = {
      readText: async () => String(9500 * 1024 * 1024),
      cgroupRoot: '/sys/fs/cgroup',
      slicePath: 'fleet.slice/fleet-agents.slice',
      sliceHighMb: 10_000,
      reservePerSessionMb: 2048,
    };
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r.outcome).toBe('admission_blocked');
      expect(calls).toHaveLength(0);
      expect(recorded[0]).toMatchObject({ ...ZERO_USAGE, usageNote: USAGE_NOTE_MEMORY });
    } finally {
      await cleanup();
    }
  });

  it('起会话失败：记 0 用量，原因写起会话失败', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: () => {
        throw new Error('spawn ENOENT');
      },
    });
    try {
      await expect(runOneShot(BASE_INPUT, deps)).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
      expect(recorded[0]).toMatchObject({
        outcome: 'spawn_failed',
        ...ZERO_USAGE,
        usageNote: USAGE_NOTE_SPAWN_FAILED,
      });
    } finally {
      await cleanup();
    }
  });

  it('起会话是否成功读不准（没有会话号、也没有用量）：不记 0，原因写会话号没拿到', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    try {
      const r = await runOneShot(BASE_INPUT, deps);
      expect(r.outcome).toBe('done');
      expect(recorded[0]?.usageNote).toBe(USAGE_SESSION_UNREAD);
      expect(recorded[0]?.inputTokens).toBeUndefined();
      expect(recorded[0]?.outputTokens).toBeUndefined();
      expect(recorded[0]?.costUsd).toBeUndefined();
      expect(recorded[0]?.sessionId).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('有会话号、用量也读到了：不记 0，也不写「会话号没拿到」', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: {
        exitCode: 0,
        stdout: '做完了',
        stderr: '',
        killed: false,
        facts: {
          sessionId: 'claude:403c41e2-8629-410a-8d7a-d61f65add9be',
          usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 },
        },
      },
    });
    try {
      await runOneShot(BASE_INPUT, deps);
      expect(recorded[0]).toMatchObject({
        sessionId: 'claude:403c41e2-8629-410a-8d7a-d61f65add9be',
        inputTokens: 3,
        outputTokens: 4,
      });
      expect(recorded[0]?.usageNote).toBeUndefined();
      expect(recorded[0]?.inputTokens).not.toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('执行体明确说明没拿到会话号时，把具体原因接在用量说明里', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: {
        exitCode: 0,
        stdout: '做完了',
        stderr: '',
        killed: false,
        facts: { sessionIdWhy: 'Grok 没有 end 帧，输出没有报告 sessionId' },
      },
    });
    try {
      await runOneShot(BASE_INPUT, deps);
      expect(recorded[0]?.usageNote).toContain('Grok 没有 end 帧');
      expect(recorded[0]?.inputTokens).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
