// 停下等人的单按规则续一次（#3294）：只续「认不出按临时的办」「自动合并没挂上」；停下之后法国发了新版、或现读 PR 已能合才续；
// 同一原文引擎续过的不再续；额度、体量、人闸、轮数用尽一律不续。真装配读 current 链接的那一段用临时目录。
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduleResult } from '@fleet-dao/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  judgeParked,
  ParkedRetryFailedError,
  type ParkedRetryDeps,
  type ParkedRetryRow,
  type ParkedSnapshot,
  retryParkedTasks,
  runParkedRetryJob,
} from '../src/jobs/parked-retry.ts';
import { readCurrentRelease } from '../src/real/parked-retry.ts';
import { type ContinueCommand, PARKED_RETRY_ACTOR, type ParkKind } from '../src/task-contract.ts';

const PARKED_AT = '2026-10-19T03:00:00.000Z';
const HEAD = 'a'.repeat(40);
const ROW: ParkedRetryRow = {
  taskId: 't-3208',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  issueNumber: 3208,
  workflowId: 'task-thoerwink8-fleet-dao-3208',
};

function snap(kind: ParkKind, over: Partial<NonNullable<ParkedSnapshot['park']>> = {}): ParkedSnapshot {
  return {
    phase: 'parked',
    prNumber: 3210,
    park: {
      kind,
      seq: 2,
      at: PARKED_AT,
      title: '自动合并没挂上',
      head: HEAD,
      retriedBefore: false,
      ...over,
    },
  };
}

const after = (minutes: number) => ({
  sha: 'b'.repeat(40),
  at: new Date(Date.parse(PARKED_AT) + minutes * 60_000),
});

function fakeDeps(over: Partial<ParkedRetryDeps> & { snaps?: Record<string, ParkedSnapshot | 'gone'> } = {}) {
  const sent: { workflowId: string; command: ContinueCommand }[] = [];
  const audits: Parameters<ParkedRetryDeps['audit']>[0][] = [];
  const reads: { prNumber: number; expectedHead: string }[] = [];
  const finished: ScheduleResult[] = [];
  const snaps = over.snaps ?? { [ROW.workflowId as string]: snap('unarmed') };
  const deps: ParkedRetryDeps = {
    tasks: async () => [ROW],
    status: async (id) => snaps[id] ?? 'gone',
    release: async () => null,
    mergeReady: async (_repo, prNumber, expectedHead) => {
      reads.push({ prNumber, expectedHead });
      return { ready: false, why: '必过检查还没全绿' };
    },
    continueTask: async (workflowId, command) => {
      sent.push({ workflowId, command });
      return 'sent';
    },
    audit: async (entry) => {
      audits.push(entry);
    },
    runs: {
      start: async () => 7,
      finish: async (_id, result) => {
        finished.push(result);
      },
    },
    now: () => new Date('2026-10-19T12:00:00Z'),
    log: () => {},
    ...over,
  };
  return { deps, sent, audits, reads, finished };
}

describe('judgeParked：续不续（纯判断）', () => {
  it('额度超预算、体量超预算、改标准等人闸、轮数用尽、别的：一律不续，发了新版也不续', () => {
    for (const kind of ['quota', 'size', 'standard', 'rounds', 'other'] as const) {
      expect(judgeParked(snap(kind), after(60)).kind, kind).toBe('skip');
    }
  });

  it('认不出按临时的办、自动合并没挂上：停下之后发了新版就续', () => {
    for (const kind of ['transient', 'unarmed'] as const) {
      const v = judgeParked(snap(kind), after(60));
      expect(v.kind, kind).toBe('continue');
      if (v.kind === 'continue') expect(v.why).toContain('之后法国发了新版 bbbbbbbbbbbb');
    }
  });

  it('新版在停下之前发的不算；有 PR 和头就要现读 PR', () => {
    expect(judgeParked(snap('unarmed'), after(-5))).toEqual({ kind: 'check-pr', prNumber: 3210, head: HEAD });
    expect(judgeParked(snap('unarmed'), null)).toEqual({ kind: 'check-pr', prNumber: 3210, head: HEAD });
    expect(judgeParked({ ...snap('transient', { head: null }), prNumber: null }, null).kind).toBe('skip');
  });

  it('同一原文引擎续过（retriedBefore）、没在停、老历史没记停法：不续', () => {
    expect(judgeParked(snap('unarmed', { retriedBefore: true }), after(60)).kind).toBe('skip');
    expect(judgeParked({ ...snap('unarmed'), phase: 'merge' }, after(60)).kind).toBe('skip');
    expect(judgeParked({ phase: 'parked', prNumber: 3210 }, after(60)).kind).toBe('skip');
  });
});

describe('retryParkedTasks：过一遍停着的单', () => {
  it('#3208 的样子：停在「自动合并没挂上」（GitHub 回 unstable），之后法国发了新版 → 带停下编号发一次继续，操作记录写明引擎续的、为什么', async () => {
    const { deps, sent, audits, reads } = fakeDeps({ release: async () => after(90) });
    const got = await retryParkedTasks(deps);
    expect(got.continued).toHaveLength(1);
    expect(reads).toEqual([]);
    expect(sent).toEqual([
      {
        workflowId: ROW.workflowId,
        command: { by: PARKED_RETRY_ACTOR, parkSeq: 2, note: expect.stringContaining('引擎续的') },
      },
    ]);
    expect(sent[0]?.command.note).toContain('自动合并没挂上');
    expect(sent[0]?.command.note).toContain('法国发了新版');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.why).toBe(sent[0]?.command.note);
    expect(audits[0]?.park.seq).toBe(2);
  });

  it('没发新版：现读 PR 必过全绿、头没变、可以合才续；读的是停下时的头', async () => {
    const ready = fakeDeps({
      mergeReady: async () => ({ ready: true, why: '必过检查全绿' }),
    });
    const got = await retryParkedTasks(ready.deps);
    expect(got.continued.map((c) => c.why)).toEqual([expect.stringContaining('现读 PR #3210：必过检查全绿，可以合')]);

    const notReady = fakeDeps();
    expect((await retryParkedTasks(notReady.deps)).continued).toEqual([]);
    expect(notReady.reads).toEqual([{ prNumber: 3210, expectedHead: HEAD }]);
    expect(notReady.sent).toEqual([]);
  });

  it('额度超预算、体量超预算、改标准等人闸：发了新版、PR 也能合，照样不续，也不去读 PR', async () => {
    for (const kind of ['quota', 'size', 'standard'] as const) {
      const f = fakeDeps({
        snaps: { [ROW.workflowId as string]: snap(kind) },
        release: async () => after(60),
        mergeReady: async () => ({ ready: true, why: '必过检查全绿' }),
      });
      const got = await retryParkedTasks(f.deps);
      expect(got.continued, kind).toEqual([]);
      expect(f.sent, kind).toEqual([]);
      expect(f.reads, kind).toEqual([]);
    }
  });

  it('同一原文已续过一次再停下：不再续，交人', async () => {
    const f = fakeDeps({
      snaps: { [ROW.workflowId as string]: snap('unarmed', { retriedBefore: true }) },
      release: async () => after(60),
    });
    expect((await retryParkedTasks(f.deps)).continued).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it('一张出错不挡别的：记进 problems；工作流已经没了、没记工作流编号的略过', async () => {
    const other: ParkedRetryRow = { ...ROW, taskId: 't-2', issueNumber: 3257, workflowId: 'wf-3257' };
    const f = fakeDeps({
      tasks: async () => [
        { ...ROW, workflowId: null },
        { ...ROW, taskId: 't-gone', workflowId: 'wf-gone' },
        ROW,
        other,
      ],
      snaps: { [ROW.workflowId as string]: snap('unarmed'), 'wf-3257': snap('transient') },
      release: async () => after(30),
      continueTask: async (workflowId) => {
        if (workflowId === ROW.workflowId) throw new Error('Temporal 连不上');
        return 'sent';
      },
    });
    const got = await retryParkedTasks(f.deps);
    expect(got.listed).toBe(4);
    expect(got.scanned).toBe(2);
    expect(got.continued.map((c) => c.workflowId)).toEqual(['wf-3257']);
    expect(got.problems).toEqual([expect.stringContaining('thoerwink8/fleet-dao#3208 没判成：Temporal 连不上')]);
  });
});

describe('runParkedRetryJob：一轮的结局', () => {
  it('续了：记 ok，found 是续了几张', async () => {
    const f = fakeDeps({ release: async () => after(30) });
    await runParkedRetryJob(f.deps);
    expect(f.finished).toEqual([
      { outcome: 'ok', scanned: 1, found: 1, why: expect.stringContaining('续了 1 张') },
    ]);
  });

  it('有一张没判成：记 partial；列不出来：记 failed 并抛', async () => {
    const partial = fakeDeps({
      release: async () => after(30),
      continueTask: async () => {
        throw new Error('超时');
      },
    });
    await runParkedRetryJob(partial.deps);
    expect(partial.finished[0]).toMatchObject({ outcome: 'partial' });

    const failed = fakeDeps({
      tasks: async () => {
        throw new Error('库连不上');
      },
    });
    await expect(runParkedRetryJob(failed.deps)).rejects.toBeInstanceOf(ParkedRetryFailedError);
    expect(failed.finished[0]).toMatchObject({ outcome: 'failed', why: expect.stringContaining('库连不上') });
  });
});

describe('readCurrentRelease：法国在用的版本', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('current 指向提交号：回提交号和链接切过去的时刻；目录、链接不在回 null', async () => {
    dir = await mkdtemp(join(tmpdir(), 'parked-retry-'));
    expect(await readCurrentRelease(join(dir, 'nope'))).toBeNull();
    expect(await readCurrentRelease(dir)).toBeNull();
    const sha = 'c'.repeat(40);
    const before = Date.now() - 5_000;
    await symlink(sha, join(dir, 'current'));
    const got = await readCurrentRelease(dir);
    expect(got?.sha).toBe(sha);
    expect(got?.at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('current 指的不是提交号：null（认不出不当成发了新版）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'parked-retry-'));
    await symlink('somewhere', join(dir, 'current'));
    expect(await readCurrentRelease(dir)).toBeNull();
  });
});
