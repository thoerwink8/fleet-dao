// 影子派工端到端（#3808）：冻结一批 → 驱动派活（重跑不重派）→ 派工器起假工人改文件 → 补丁进 shadow_runs、工作目录删掉 →
// sweepCompare 拿参照 diff 评分。镜像是本机建的裸仓，git 用真的。
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpawnWorkerInput } from '@fleet-dao/harness-contract';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { freezeBatch, listCompare, sweepCompare } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Dispatcher, enqueueShadowBatch, shadowWorkspaces } from '../src/index.ts';
import { git, makeRepo } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url));
const redact = makeRedactor([]);
let t: TestDb;
let mirrorRoot: string;
let baseSha: string;
let src: string;

beforeAll(async () => {
  t = await createTestDb();
  src = makeRepo();
  mirrorRoot = await mkdtemp(join(tmpdir(), 'fleet2-shadow-mirrors-'));
  git(mirrorRoot, 'clone', '-q', '--bare', src, join(mirrorRoot, 'o', 'r.git'));
  baseSha = git(src, 'rev-parse', 'HEAD').trim();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec(
    'truncate fleet2.events, fleet2.jobs, fleet2.session_tokens, fleet2.projection_checkpoints, fleet2.command_receipts, fleet2.queue_limits, fleet2.shadow_batch_items, fleet2.shadow_runs, fleet2.shadow_compare restart identity',
  );
});

const six = {
  task: '改一行',
  expected: '一个补丁',
  must_do: '跑测试',
  must_not: '不碰部署',
  context: '单正文',
  stop_when: '测试绿',
};
const item = (issue: number) => ({ repo: 'o/r', issue, baseSha, snapshotAt: new Date() });

describe('影子驱动', () => {
  it('一批两张单派两件；重跑不重派；读单失败照抛、那张单下一轮再派', async () => {
    await freezeBatch(t.db, 'b1', [item(1), item(2)]);
    expect(await enqueueShadowBatch(t.db, 'b1', async () => six)).toEqual({ requested: 2, already: 0 });
    expect(await enqueueShadowBatch(t.db, 'b1', async () => six)).toEqual({ requested: 0, already: 2 });

    await freezeBatch(t.db, 'b2', [item(3)]);
    await expect(
      enqueueShadowBatch(t.db, 'b2', async () => {
        throw new Error('GitHub 503');
      }),
    ).rejects.toThrow('GitHub 503');
    expect(await enqueueShadowBatch(t.db, 'b2', async () => six)).toEqual({ requested: 1, already: 0 });
  });

  it('指挥官的 spawn_worker 入参带不进 shadow', () => {
    const parsed = z.object(SpawnWorkerInput).parse({ ...six, shadow: { batchId: 'x' } });
    expect(parsed).not.toHaveProperty('shadow');
  });
});

describe('影子工作目录', () => {
  it('从镜像建到基线、工人改的（含新文件）进 shadow_runs、目录删掉，合并后能评分', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'fleet2-shadow-ws-'));
    const outDir = await mkdtemp(join(tmpdir(), 'fleet2-shadow-out-'));
    const errors: unknown[] = [];
    const d = new Dispatcher({
      db: t.db,
      mcpUrl: 'http://127.0.0.1:4799/mcp',
      command: [process.execPath, FAKE],
      model: 'claude-opus-5-5',
      permissionMode: 'bypassPermissions',
      prepareWorkspace: shadowWorkspaces({ db: t.db, mirrorRoot, tmpRoot, redact }),
      hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: '/h' },
      extraEnv: { FAKE_OUT_DIR: outDir, FAKE_WRITE: 'src/a.txt:changed;src/new.txt:hello' },
      tmpRoot,
      workerBudget: { startupMs: 3_000, totalMs: 20_000, killGraceMs: 200 },
      leaseMs: 5_000,
      heartbeatMs: 50,
      perMinute: 100,
      onError: (err) => errors.push(err),
    });
    await d.init();
    await freezeBatch(t.db, 'b1', [item(1), item(2)]);
    await enqueueShadowBatch(t.db, 'b1', async () => six);
    for (let i = 0; i < 2; i++) {
      await d.poll();
      await d.settled();
    }
    expect(errors).toEqual([]);

    const runs = (
      await t.pg.query<{ issue: number; patch: string; verdict: string }>(
        'select issue, patch, verdict from fleet2.shadow_runs order by issue',
      )
    ).rows;
    expect(runs.map((r) => r.issue)).toEqual([1, 2]);
    for (const r of runs) {
      expect(r.patch).toContain('src/new.txt');
      expect(r.patch).toContain('+changed');
    }
    expect(readdirSync(tmpRoot).filter((f) => f.startsWith('fleet2-shadow-'))).toEqual([]);
    // clone --shared：镜像里不挂工作区
    expect(
      git(join(mirrorRoot, 'o', 'r.git'), 'worktree', 'list')
        .trim()
        .split('\n'),
    ).toHaveLength(1);

    const ref =
      'diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-a\n+changed\n';
    const swept = await sweepCompare(t.db, 'b1', async (_repo, issue) => ({
      pr: 100 + issue,
      sha: baseSha,
      diff: ref,
    }));
    expect(swept).toMatchObject({ scored: 2, waiting: 0 });
    const table = await listCompare(t.db, 'b1');
    expect(table.map((r) => [r.issue, r.score.refOnly, r.score.shadowOnly])).toEqual([
      [1, [], ['src/new.txt']],
      [2, [], ['src/new.txt']],
    ]);
  }, 60_000);

  it('给了 sandbox：建好就交出去、跑完按回执删；抓补丁不往工人的 .git 里写（法国上那边归会话用户）', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'fleet2-shadow-sb-'));
    const steps: string[] = [];
    const prepare = shadowWorkspaces({
      db: t.db,
      mirrorRoot,
      tmpRoot,
      redact,
      sandbox: {
        async adopt(dir) {
          steps.push(`adopt:${existsSync(join(dir, 'src', 'a.txt')) ? 'checked-out' : 'empty'}`);
          return {
            async release() {
              steps.push('release');
              await rm(dir, { recursive: true, force: true });
            },
          };
        },
        async stop() {},
        async runAsWorker() {
          throw new Error('这条用例不以工人身份跑命令');
        },
      },
    });
    await freezeBatch(t.db, 'b3', [item(3)]);
    const ws = await prepare(
      { taskId: 't3', ...six, shadow: { batchId: 'b3', repo: 'o/r', issue: 3, baseSha } },
      { runId: 'r3' },
    );
    writeFileSync(join(ws.cwd, 'src', 'a.txt'), 'changed\n');
    writeFileSync(join(ws.cwd, 'src', 'new.txt'), 'hello\n');
    const gitDir = join(ws.cwd, '.git');
    const snapshot = () =>
      readdirSync(gitDir, { recursive: true })
        .map(String)
        .filter((p) => !statSync(join(gitDir, p)).isDirectory())
        .map((p) => `${p}:${statSync(join(gitDir, p)).mtimeMs}`)
        .sort();
    const before = snapshot();
    await ws.collect?.({ verdict: 'passed', wallMs: 1 });
    expect(snapshot()).toEqual(before);
    const patch = (await t.pg.query<{ patch: string }>('select patch from fleet2.shadow_runs')).rows[0]
      ?.patch;
    expect(patch).toContain('src/new.txt');
    expect(patch).toContain('+changed');
    await ws.cleanup?.();
    expect(steps).toEqual(['adopt:checked-out', 'release']);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('镜像不在就建、缺基线提交就拉；仓名带 .. 的拒', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet2-shadow-newmirror-'));
    const tmpRoot = await mkdtemp(join(tmpdir(), 'fleet2-shadow-ws-'));
    const prepare = shadowWorkspaces({
      db: t.db,
      mirrorRoot: root,
      tmpRoot,
      redact,
      mirrorRemote: () => src,
    });
    const shadow = (sha: string) => ({ batchId: 'b4', repo: 'o/r', issue: 4, baseSha: sha });

    const ws1 = await prepare({ taskId: 't4', ...six, shadow: shadow(baseSha) }, { runId: 'r4' });
    expect(git(ws1.cwd, 'rev-parse', 'HEAD').trim()).toBe(baseSha);
    expect(readdirSync(join(root, 'o'))).toEqual(['r.git']);
    await ws1.cleanup?.();

    writeFileSync(join(src, 'src', 'a.txt'), 'next\n');
    git(src, 'commit', '-q', '-am', 'next');
    const next = git(src, 'rev-parse', 'HEAD').trim();
    const ws2 = await prepare({ taskId: 't5', ...six, shadow: shadow(next) }, { runId: 'r5' });
    expect(git(ws2.cwd, 'rev-parse', 'HEAD').trim()).toBe(next);
    await ws2.cleanup?.();

    await expect(
      prepare({ taskId: 't6', ...six, shadow: { ...shadow(baseSha), repo: 'o/..' } }, { runId: 'r6' }),
    ).rejects.toThrow('仓名不合法');
    await expect(
      prepare({ taskId: 't7', ...six, shadow: shadow('0'.repeat(40)) }, { runId: 'r7' }),
    ).rejects.toThrow('还是没有基线提交');
  }, 60_000);

  it('没带影子目标的请求不建目录', async () => {
    const prepare = shadowWorkspaces({ db: t.db, mirrorRoot, tmpRoot: tmpdir(), redact });
    await expect(prepare({ taskId: 't1', ...six }, { runId: 'r1' })).rejects.toThrow('没带影子目标');
  });
});
