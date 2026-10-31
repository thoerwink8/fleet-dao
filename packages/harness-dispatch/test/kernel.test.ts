// 新内核进程（#3811）：一轮里派影子、领活、评分、静默报警；一步出错不挡别的步。PGlite 跑真迁移，假工人，真 git。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { freezeBatch, listCompare } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import type { ShadowProbes } from '@fleet-dao/harness-workers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKernel } from '../src/index.ts';
import { git, makeRepo } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url));
const redact = makeRedactor([]);
const pass: ShadowProbes = {
  noWriteAccess: async () => 'pass',
  realHandlersAbsent: async () => 'pass',
  egressRulesPresent: async () => 'pass',
};
const six = {
  task: '改一行',
  expected: '一个补丁',
  must_do: '跑测试',
  must_not: '不碰部署',
  context: '单正文',
  stop_when: '测试绿',
};
const REF =
  'diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-a\n+changed\n';

let t: TestDb;
let mirrorRoot: string;
let baseSha: string;
beforeAll(async () => {
  t = await createTestDb();
  const src = makeRepo();
  mirrorRoot = await mkdtemp(join(tmpdir(), 'fleet2-kernel-mirrors-'));
  git(mirrorRoot, 'clone', '-q', '--bare', src, join(mirrorRoot, 'o', 'r.git'));
  baseSha = git(src, 'rev-parse', 'HEAD').trim();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec(
    'truncate fleet2.events, fleet2.jobs, fleet2.session_tokens, fleet2.projection_checkpoints, fleet2.command_receipts, fleet2.queue_limits, fleet2.shadow_batch_items, fleet2.shadow_runs, fleet2.shadow_compare restart identity',
  );
});

async function kernel(over: { merged?: boolean; taskFails?: boolean } = {}) {
  const errors: string[] = [];
  const silences: string[] = [];
  const k = createKernel({
    db: t.db,
    redact,
    apiPort: 0,
    dispatcher: {
      command: [process.execPath, FAKE],
      model: 'claude-opus-5-5',
      permissionMode: 'bypassPermissions',
      hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: '/h' },
      extraEnv: {
        FAKE_OUT_DIR: await mkdtemp(join(tmpdir(), 'fleet2-kernel-out-')),
        FAKE_WRITE: 'src/a.txt:changed',
      },
      tmpRoot: await mkdtemp(join(tmpdir(), 'fleet2-kernel-tmp-')),
      workerBudget: { startupMs: 3_000, totalMs: 20_000, killGraceMs: 200 },
      leaseMs: 5_000,
      heartbeatMs: 50,
      perMinute: 100,
    },
    mirrorRoot,
    workRoot: await mkdtemp(join(tmpdir(), 'fleet2-kernel-ws-')),
    workerHome: '/h',
    egressPort: 7344,
    probes: pass,
    taskFor: async () => {
      if (over.taskFails) throw new Error('读单失败');
      return six;
    },
    readMerged: async (_repo, issue) =>
      over.merged === false ? undefined : { pr: 100 + issue, sha: baseSha, diff: REF },
    onSilence: (b) => silences.push(b),
    onError: (step, err) => errors.push(`${step}：${err instanceof Error ? err.message : String(err)}`),
  });
  return { k, errors, silences };
}

describe('新内核一轮', () => {
  it('派影子 → 起工人 → 补丁落库 → 下一轮评分；全收完的批次不再读', async () => {
    const { k, errors } = await kernel();
    await k.start();
    try {
      await freezeBatch(t.db, 'b1', [{ repo: 'o/r', issue: 1, baseSha, snapshotAt: new Date() }]);
      const first = await k.tick();
      expect(first).toMatchObject({ batches: 1, requested: 1, claimed: 1 });
      await k.dispatcher?.settled();
      const second = await k.tick();
      expect(second).toMatchObject({ batches: 1, requested: 0, scored: 1 });
      expect((await listCompare(t.db, 'b1')).map((r) => r.score.identical)).toEqual([true]);
      expect((await k.tick()).batches).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await k.stop();
    }
  }, 60_000);

  it('读单失败只记错，领活、静默检查照跑；冻结一整天没产物报静默', async () => {
    const { k, errors, silences } = await kernel({ taskFails: true });
    await k.start();
    try {
      const old = new Date(Date.now() - 2 * 24 * 3_600_000);
      await freezeBatch(t.db, 'b1', [{ repo: 'o/r', issue: 1, baseSha, snapshotAt: old }]);
      const r = await k.tick();
      expect(r).toMatchObject({ batches: 1, requested: 0, claimed: 0, silent: ['b1'] });
      expect(silences).toEqual(['b1']);
      expect(errors).toEqual(['派影子 b1：读单失败']);
    } finally {
      await k.stop();
    }
  });
});
