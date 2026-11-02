// 真执行端到端（#3783，第 7 片）：冻结真执行批次 → 认领（旧系统手上有的不抢）→ 派工 → 假工人改文件 → 抓补丁记 publish_runs →
// 内核经 outbox 推分支、开 PR（不合并）。PGlite 跑真迁移，真 git（本机裸仓当 GitHub 远端和镜像），假工人，假 GitHub 写口。
// 和影子的分界也在这里验：真执行的批次影子驱动不碰，真执行请求不写 shadow_runs，影子请求在没开真执行的内核里照旧。
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueStream } from '@fleet-dao/harness-contract';
import { makeRedactor } from '@fleet-dao/harness-runner';
import {
  activeBatches,
  freezeBatch,
  freezeRealBatch,
  listOpsForTask,
  readStream,
} from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import type { ShadowProbes } from '@fleet-dao/harness-workers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKernel, NotShadowRequestError, shadowWorkspaces } from '../src/index.ts';
import type { AcquireResult } from '../src/task-claim.ts';
import { type FakeGitHub, fakeGitHub } from './fake-github.ts';
import { git, makeRepo } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url));
const redact = makeRedactor([]);
const pass: ShadowProbes = {
  noWriteAccess: async () => 'pass',
  realHandlersAbsent: async () => 'pass',
  egressRulesPresent: async () => 'pass',
};
const six = (issue: number) => ({
  task: `做 o/r#${issue}：改一行 ${issue}`,
  expected: '一个补丁',
  must_do: '跑测试',
  must_not: '不碰部署',
  context: '单正文',
  stop_when: '测试绿',
});

let t: TestDb;
let mirrorRoot: string;
let remote: string;
let baseSha: string;
let gh: FakeGitHub;
beforeAll(async () => {
  t = await createTestDb();
  const src = makeRepo();
  mirrorRoot = await mkdtemp(join(tmpdir(), 'fleet2-real-mirrors-'));
  await mkdir(join(mirrorRoot, 'o'), { recursive: true });
  git(mirrorRoot, 'clone', '-q', '--bare', src, join(mirrorRoot, 'o', 'r.git'));
  remote = join(await mkdtemp(join(tmpdir(), 'fleet2-real-remote-')), 'r.git');
  git(tmpdir(), 'clone', '-q', '--bare', src, remote);
  baseSha = git(src, 'rev-parse', 'HEAD').trim();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec(
    'truncate fleet2.events, fleet2.jobs, fleet2.session_tokens, fleet2.projection_checkpoints, fleet2.command_receipts, fleet2.queue_limits, fleet2.shadow_batch_items, fleet2.shadow_runs, fleet2.shadow_compare, fleet2.real_batch_items, fleet2.publish_runs, fleet2.outbox restart identity',
  );
  for (const b of git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')) {
    if (b && b !== 'main') git(remote, 'branch', '-D', b);
  }
  gh = fakeGitHub(remote);
});

async function kernel(
  over: { mode?: string; held?: number[]; noPublish?: boolean; fencingNow?: number } = {},
) {
  const errors: string[] = [];
  const acquired: number[] = [];
  const k = createKernel({
    db: t.db,
    redact,
    apiPort: 0,
    dispatcher: {
      command: [process.execPath, FAKE],
      model: 'grok-4.7',
      permissionMode: 'bypassPermissions',
      hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: '/h' },
      extraEnv: {
        FAKE_OUT_DIR: await mkdtemp(join(tmpdir(), 'fleet2-real-out-')),
        FAKE_WRITE: 'src/a.txt:changed;src/new.txt:hello',
        ...(over.mode ? { FAKE_MODE: over.mode } : {}),
      },
      tmpRoot: await mkdtemp(join(tmpdir(), 'fleet2-real-tmp-')),
      workerBudget: { startupMs: 3_000, totalMs: 20_000, killGraceMs: 200 },
      leaseMs: 5_000,
      heartbeatMs: 50,
      perMinute: 100,
    },
    mirrorRoot,
    workRoot: await mkdtemp(join(tmpdir(), 'fleet2-real-ws-')),
    workerHome: '/h',
    egressPort: 7344,
    probes: pass,
    taskFor: async (item) => six(item.issue),
    readMerged: async () => undefined,
    onSilence: () => {},
    onError: (step, err) => errors.push(`${step}：${err instanceof Error ? err.message : String(err)}`),
    ...(over.noPublish
      ? {}
      : {
          publish: {
            acquire: async (ref, title): Promise<AcquireResult> => {
              if (over.held?.includes(ref.issue)) {
                return { ok: false, code: 'held', why: '旧引擎在做' };
              }
              acquired.push(ref.issue);
              expect(title).toBe(`改一行 ${ref.issue}`);
              return { ok: true, taskId: `t${ref.issue}`, fencing: 5, created: true };
            },
            model: 'grok-4.7',
            heldPauseMs: 0,
            outbox: {
              github: gh,
              tokenFor: async () => 'ghs_T',
              remote: () => remote,
              fencingOf: async () => over.fencingNow ?? 5,
              retryMs: 0,
            },
          },
        }),
  });
  return { k, errors, acquired };
}

/** 跑到没有新活：每轮 tick 后等工人收完，再多跑几轮让 outbox 把推送和开 PR 做完。 */
async function drain(k: Awaited<ReturnType<typeof kernel>>['k'], rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await k.tick();
    await k.dispatcher?.settled();
  }
}

describe('真执行一整条', () => {
  it('两张单各推一个分支、各开一个 PR；旧系统手上有的那张不抢、不派', async () => {
    const { k, errors, acquired } = await kernel({ held: [3] });
    await k.start();
    try {
      await freezeRealBatch(
        t.db,
        'r1',
        [1, 2, 3].map((issue) => ({ repo: 'o/r', issue, baseSha, snapshotAt: new Date() })),
      );
      const first = await k.tick();
      expect(first.real).toMatchObject({
        batches: 1,
        requested: 2,
        skipped: [{ issue: 3, why: '旧引擎在做' }],
      });
      await k.dispatcher?.settled();
      await drain(k);

      expect(errors).toEqual([]);
      expect(acquired.sort()).toEqual([1, 2]);
      // 3 号没派：没有派工请求，也没有任何产物和动作
      const reqs = await readStream(t.db, 'session:real-r1', 0);
      expect(
        reqs
          .filter((e) => e.type === 'worker.spawn.requested')
          .map((e) => (e.payload.real as { issue: number }).issue)
          .sort(),
      ).toEqual([1, 2]);
      expect(await listOpsForTask(t.db, { repo: 'o/r', issue: 3 })).toEqual([]);

      // 两个 PR，头分支各自 fleet2/<单>-<运行>，正文关各自的单、记模型
      expect(gh.prs).toHaveLength(2);
      for (const pr of gh.prs) {
        const issue = Number(/^fleet2\/(\d+)-/.exec(pr.headRef)?.[1]);
        expect([1, 2]).toContain(issue);
        expect(pr.body).toContain(`Closes #${issue}`);
        expect(pr.body).toContain('grok-4.7');
        const sha = git(remote, 'rev-parse', `refs/heads/${pr.headRef}`).trim();
        expect(git(remote, 'show', `${sha}:src/a.txt`).trim()).toBe('changed');
        expect(git(remote, 'show', `${sha}:src/new.txt`).trim()).toBe('hello');
      }
      // 整条链：请求（带令牌）→ 交回 → 推 → 开 PR
      for (const issue of [1, 2]) {
        const chain = (await readStream(t.db, issueStream({ repo: 'o/r', issue }), 0)).map((e) => e.type);
        expect(chain).toEqual(['publish.pushed', 'publish.pr.opened']);
        expect(
          (await listOpsForTask(t.db, { repo: 'o/r', issue })).map(
            (o) => `${o.kind}:${o.state}:${o.fencing}`,
          ),
        ).toEqual(['git.push:done:5', 'github.pr.open:done:5']);
      }
      const handbacks = reqs.filter((e) => e.type === 'handback.recorded');
      expect(handbacks).toHaveLength(2);
      // 影子那边一行都没有；批次也不在影子的在途名单里
      const shadow = await t.pg.query<{ n: number }>('select count(*)::int as n from fleet2.shadow_runs');
      expect(shadow.rows[0]?.n).toBe(0);
      expect(await activeBatches(t.db)).toEqual([]);
      // 没有任何合并的调用
      expect(gh.calls.join('\n')).not.toMatch(/merge/i);
    } finally {
      await k.stop();
    }
  }, 120_000);

  it('旧系统手上有的单这一轮没派，下一轮它放手了再派（没记回执，不会漏）', async () => {
    const held = [1];
    const { k } = await kernel({ held });
    await k.start();
    try {
      await freezeRealBatch(t.db, 'r1', [{ repo: 'o/r', issue: 1, baseSha, snapshotAt: new Date() }]);
      expect((await k.tick()).real).toMatchObject({ requested: 0, skipped: [{ issue: 1 }] });
      held.pop();
      expect((await k.tick()).real).toMatchObject({ requested: 1, skipped: [] });
    } finally {
      await k.stop();
    }
  });

  it('工人没干净交活（退出码 1）：产物记 held，不推、不开 PR', async () => {
    const { k } = await kernel({ mode: 'exit1' });
    await k.start();
    try {
      await freezeRealBatch(t.db, 'r1', [{ repo: 'o/r', issue: 1, baseSha, snapshotAt: new Date() }]);
      await k.tick();
      await k.dispatcher?.settled();
      await drain(k, 3);
      const runs = await t.pg.query<{ state: string; verdict: string; reason: string }>(
        'select state, verdict, reason from fleet2.publish_runs',
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({ state: 'held' });
      expect(await listOpsForTask(t.db, { repo: 'o/r', issue: 1 })).toEqual([]);
      expect(gh.prs).toEqual([]);
    } finally {
      await k.stop();
    }
  }, 60_000);

  it('令牌在派工之后变了（单被切走）：交回照记，但推送执行前核令牌对不上，进 dead，分支没推', async () => {
    const { k } = await kernel({ fencingNow: 6 });
    await k.start();
    try {
      await freezeRealBatch(t.db, 'r1', [{ repo: 'o/r', issue: 1, baseSha, snapshotAt: new Date() }]);
      await k.tick();
      await k.dispatcher?.settled();
      await drain(k, 3);
      expect(
        (await listOpsForTask(t.db, { repo: 'o/r', issue: 1 })).map((o) => `${o.kind}:${o.state}`),
      ).toEqual(['git.push:dead']);
      expect(git(remote, 'branch', '--list', 'fleet2/*').trim()).toBe('');
      expect(gh.prs).toEqual([]);
    } finally {
      await k.stop();
    }
  }, 60_000);
});

describe('和影子的分界', () => {
  it('没开真执行的内核：真执行请求建不出工作目录（不认 real），不会悄悄当影子跑', async () => {
    const prepare = shadowWorkspaces({ db: t.db, mirrorRoot, tmpRoot: tmpdir(), redact });
    await expect(
      prepare(
        {
          taskId: 'x',
          ...six(1),
          real: { batchId: 'r1', repo: 'o/r', issue: 1, baseSha, fencing: 1, title: 't' },
        },
        { runId: 'd1-a1' },
      ),
    ).rejects.toBeInstanceOf(NotShadowRequestError);
  });

  it('开了真执行，影子批次照旧：影子请求仍进 shadow_runs，不排推送', async () => {
    const { k } = await kernel();
    await k.start();
    try {
      await freezeBatch(t.db, 'b1', [{ repo: 'o/r', issue: 9, baseSha, snapshotAt: new Date() }]);
      await k.tick();
      await k.dispatcher?.settled();
      const runs = await t.pg.query<{ n: number }>('select count(*)::int as n from fleet2.shadow_runs');
      expect(runs.rows[0]?.n).toBe(1);
      expect(
        (await t.pg.query<{ n: number }>('select count(*)::int as n from fleet2.outbox')).rows[0]?.n,
      ).toBe(0);
    } finally {
      await k.stop();
    }
  }, 60_000);
});
