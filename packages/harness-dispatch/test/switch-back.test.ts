// 按状态切回（#3783，讨论稿第五节 3 的切回表）：表里每一行各一条用例，外加 O1/O2 的几条边界。
// 状态是真造出来的：真 PGlite（事件、活、外部动作、产物）、真 git（本机裸仓当远端）、假 GitHub（test/fake-github.ts）。
// 真机演练（法国）另做，命令和输出贴在 PR 里；这里证明每一行的判法和动作对。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendToSession, appendToStream } from '@fleet-dao/harness-api';
import { issueStream } from '@fleet-dao/harness-contract';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { freezeRealBatch, getPublishRun, listOpsForTask, readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PublishCollected, processOutbox, recordPublish } from '../src/publish.ts';
import { realSessionId } from '../src/real-driver.ts';
import { type SwitchBackDeps, switchBack, taskStage } from '../src/switch-back.ts';
import { type FakeGitHub, fakeGitHub } from './fake-github.ts';
import { git, makeRepo } from './helpers.ts';

const redact = makeRedactor([]);
let t: TestDb;
let src: string;
let baseSha: string;
let mirrorRoot: string;
let tmpRoot: string;
let remote: string;
let gh: FakeGitHub;
/** 旧库里这张单现在的令牌；-1 = 已不归新内核 */
let fencing = 3;
let released: { state: string; doing: string }[] = [];

const ref = { repo: 'o/r', issue: 1 };

beforeAll(async () => {
  t = await createTestDb();
  src = makeRepo();
  baseSha = git(src, 'rev-parse', 'HEAD').trim();
  mirrorRoot = await mkdtemp(join(tmpdir(), 'fleet2-sb-mirrors-'));
  await mkdir(join(mirrorRoot, 'o'), { recursive: true });
  git(mirrorRoot, 'clone', '-q', '--bare', src, join(mirrorRoot, 'o', 'r.git'));
  tmpRoot = await mkdtemp(join(tmpdir(), 'fleet2-sb-tmp-'));
  remote = join(await mkdtemp(join(tmpdir(), 'fleet2-sb-remote-')), 'r.git');
  git(tmpdir(), 'clone', '-q', '--bare', src, remote);
}, 60_000);
afterAll(async () => {
  await t.close();
  await rm(tmpRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  await t.pg.exec(
    'truncate fleet2.events, fleet2.outbox, fleet2.publish_runs, fleet2.real_batch_items, fleet2.command_receipts, fleet2.jobs restart identity',
  );
  for (const b of git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')) {
    if (b && b !== 'main') git(remote, 'branch', '-D', b);
  }
  gh = fakeGitHub(remote);
  fencing = 3;
  released = [];
  await freezeRealBatch(t.db, 'b1', [{ ...ref, baseSha, snapshotAt: new Date() }]);
});

const deps = (over: Partial<SwitchBackDeps> = {}): SwitchBackDeps => ({
  db: t.db,
  github: gh,
  fencingOf: async () => fencing,
  release: async (_ref, f, to) => {
    if (f !== fencing) return false;
    fencing = -1;
    released.push(to);
    return true;
  },
  ...over,
});

const publishDeps = () => ({
  db: t.db,
  github: gh,
  tokenFor: async () => 'ghs_T',
  mirrorRoot,
  tmpRoot,
  remote: () => remote,
  fencingOf: async () => fencing,
  redact,
  retryMs: 0,
});

function makePatch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet2-sb-patch-'));
  git(tmpdir(), 'clone', '-q', src, dir);
  writeFileSync(join(dir, 'src/a.txt'), 'changed\n');
  return git(dir, 'diff', '--no-renames', baseSha, '--');
}

const collected = (over: Partial<PublishCollected> = {}): PublishCollected => ({
  runId: 'd1-a1',
  target: { batchId: 'b1', repo: 'o/r', issue: 1, baseSha, fencing: 3, title: '改一行' },
  verdict: 'unverified',
  outcome: 'completed',
  reasons: [],
  patch: makePatch(),
  wallMs: 1000,
  ...over,
});
const record = (over: Partial<PublishCollected> = {}) =>
  recordPublish(t.db, { ...collected(over), model: 'grok-4.7' });

/** 造一条派工请求加一件活（返回请求的事件号，活的键是 spawn:<号>）。 */
async function spawnRequested(jobState: 'pending' | 'claimed' = 'pending'): Promise<number> {
  const ev = await appendToSession(t.db, realSessionId('b1'), 'worker.spawn.requested', {
    taskId: 'task-1',
    real: { batchId: 'b1', repo: 'o/r', issue: 1, baseSha, fencing: 3, title: '改一行' },
  });
  await t.pg.exec(
    jobState === 'claimed'
      ? `insert into fleet2.jobs (queue, key, payload, state, attempts, lease_until, claim_token, claimed_at)
         values ('worker', 'spawn:${ev.id}', '{}', 'claimed', 1, now() + interval '1 minute', 'tok', now())`
      : `insert into fleet2.jobs (queue, key, payload) values ('worker', 'spawn:${ev.id}', '{}')`,
  );
  return ev.id;
}

const jobState = async (id: number) =>
  (await t.pg.query<{ state: string }>(`select state from fleet2.jobs where key = 'spawn:${id}'`)).rows[0]
    ?.state;
const opStates = async () => (await listOpsForTask(t.db, ref)).map((o) => `${o.kind}:${o.state}`);
const releasedEvents = async () =>
  (await readStream(t.db, issueStream(ref), 0)).filter((e) => e.type === 'task.released');

describe('切回表的每一行', () => {
  it('没开始：撤掉活，直接放回旧引擎（重新排队）', async () => {
    const id = await spawnRequested('pending');
    expect((await taskStage(deps(), ref)).stage).toBe('not-started');
    const r = await switchBack(deps(), ref, { why: '演练' });
    expect(r).toMatchObject({ done: true, stage: 'not-started' });
    expect(await jobState(id)).toBe('cancelled');
    expect(released).toEqual([{ state: 'queued', doing: expect.stringContaining('not-started') }]);
    expect(gh.calls).toEqual([]);
    expect((await releasedEvents())[0]?.payload).toMatchObject({
      stage: 'not-started',
      ok: true,
      fencing: 3,
    });
  });

  it('连派工请求都还没写：也是没开始，直接放', async () => {
    expect(await switchBack(deps(), ref)).toMatchObject({ done: true, stage: 'not-started' });
    expect(released).toHaveLength(1);
  });

  it('开始了、没有外部动作（工人在跑）：先叫停等它收尾，确认进程没了才放', async () => {
    const id = await spawnRequested('claimed');
    await appendToStream(t.db, `worker:d${id}-a1`, 'worker.spawned', { model: 'grok-4.7' });
    expect((await taskStage(deps(), ref)).stage).toBe('worker-running');

    const first = await switchBack(deps(), ref);
    expect(first).toMatchObject({ done: false, stage: 'worker-running', action: 'wait' });
    expect(await jobState(id)).toBe('cancelled');
    expect(released).toEqual([]);

    await appendToStream(t.db, `worker:d${id}-a1`, 'worker.settled', { exitCode: 143 });
    const second = await switchBack(deps(), ref);
    expect(second).toMatchObject({ done: true, stage: 'no-external-effect' });
    expect(released).toHaveLength(1);
  });

  it('核验没过的产物（没有外部动作）：直接放，产物标 released 留档', async () => {
    await spawnRequested('pending');
    await record({ verdict: 'failed' });
    expect((await taskStage(deps(), ref)).stage).toBe('no-external-effect');
    expect(await switchBack(deps(), ref)).toMatchObject({ done: true, stage: 'no-external-effect' });
    expect((await getPublishRun(t.db, 'd1-a1'))?.state).toBe('released');
    expect((await getPublishRun(t.db, 'd1-a1'))?.patch).toContain('changed');
  });

  it('有本地提交、没推：撤掉还没做的推送，补丁留在 publish_runs，放回；之后推不出去', async () => {
    await record();
    expect(await opStates()).toEqual(['change.push:pending']);
    expect((await taskStage(deps(), ref)).stage).toBe('local-commit');
    expect(await switchBack(deps(), ref)).toMatchObject({ done: true, stage: 'local-commit' });
    expect(await opStates()).toEqual(['change.push:dead']);
    expect((await getPublishRun(t.db, 'd1-a1'))?.patch).toContain('changed');
    expect(git(remote, 'branch', '--list', 'fleet2*').trim()).toBe('');
    expect(released).toHaveLength(1);
  });

  it('推了分支、没开 PR：分支改名 fleet2-abandoned/…留着，撤掉开 PR 的动作，放回重派', async () => {
    await record();
    await processOutbox(publishDeps()); // 只推：开 PR 的动作排着
    expect(await opStates()).toEqual(['change.push:done', 'change.pr.open:pending']);
    expect((await taskStage(deps(), ref)).stage).toBe('pushed-no-pr');

    const r = await switchBack(deps(), ref);
    expect(r).toMatchObject({ done: true, stage: 'pushed-no-pr' });
    expect(git(remote, 'branch', '--list', 'fleet2-abandoned/*').trim()).toBe('fleet2-abandoned/1-d1-a1');
    expect(git(remote, 'branch', '--list', 'fleet2/*').trim()).toBe('');
    expect(await opStates()).toEqual(['change.push:done', 'change.pr.open:dead']);
    expect(released).toEqual([{ state: 'queued', doing: expect.any(String) }]);
  });

  describe('开了 PR', () => {
    beforeEach(async () => {
      await record();
      await processOutbox(publishDeps());
      await processOutbox(publishDeps());
      expect(gh.prs).toHaveLength(1);
    });

    it('不给选择就不动：要人选「交旧引擎接管」还是「关掉重派」，不开第二个', async () => {
      expect((await taskStage(deps(), ref)).stage).toBe('pr-open');
      const r = await switchBack(deps(), ref);
      expect(r).toMatchObject({ done: false, stage: 'pr-open', action: 'choose' });
      expect(released).toEqual([]);
      expect(gh.prs).toHaveLength(1);
      expect(gh.prs[0]?.state).toBe('open');
    });

    it('选交旧引擎接管：PR 留着开着，单放回成 stopped', async () => {
      const r = await switchBack(deps(), ref, { pr: 'handoff' });
      expect(r).toMatchObject({ done: true, stage: 'pr-open' });
      expect(gh.prs[0]?.state).toBe('open');
      expect(released).toEqual([{ state: 'stopped', doing: expect.stringContaining('交旧引擎接管') }]);
      expect((await releasedEvents())[0]?.payload).toMatchObject({
        pr: { number: gh.prs[0]?.number, choice: 'handoff' },
      });
    });

    it('选关掉重派：PR 关掉（不合并），单放回重新排队', async () => {
      const r = await switchBack(deps(), ref, { pr: 'close' });
      expect(r).toMatchObject({ done: true, stage: 'pr-open' });
      expect(gh.prs[0]).toMatchObject({ state: 'closed', merged: false });
      expect(released).toEqual([{ state: 'queued', doing: expect.any(String) }]);
    });

    it('CI 在跑：等这一轮结果再切，不在半路转手', async () => {
      gh.status = 'pending';
      const r = await switchBack(deps(), ref, { pr: 'close' });
      expect(r).toMatchObject({ done: false, stage: 'ci-running', action: 'wait' });
      expect(released).toEqual([]);
      expect(gh.prs[0]?.state).toBe('open');
      gh.status = 'success';
      expect(await switchBack(deps(), ref, { pr: 'handoff' })).toMatchObject({ done: true });
    });

    it('合了：不回退成没做完，不动任何东西', async () => {
      gh.closePrByHand(gh.prs[0]?.number ?? 0, true);
      const r = await switchBack(deps(), ref, { pr: 'close' });
      expect(r).toMatchObject({ done: false, stage: 'merged', action: 'none' });
      expect(r.done === false && r.why).toContain('revert');
      expect(released).toEqual([]);
    });
  });

  it('外部动作结果未知（领着或 unknown）：不转手，等对账出结论', async () => {
    await record();
    await t.pg.exec(
      "update fleet2.outbox set state = 'unknown', last_error = '超时' where kind = 'change.push'",
    );
    const r = await switchBack(deps(), ref);
    expect(r).toMatchObject({ done: false, stage: 'external-unknown', action: 'wait' });
    expect(released).toEqual([]);
    expect(await opStates()).toEqual(['change.push:unknown']);
  });

  it('补偿失败（分支改名没成）：停下报警，所有权不放；修好后再调一次接着做完', async () => {
    await record();
    await processOutbox(publishDeps());
    gh.failRename = true;
    const r = await switchBack(deps(), ref);
    expect(r).toMatchObject({ done: false, stage: 'pushed-no-pr', action: 'alarm' });
    expect(released).toEqual([]);
    expect(fencing).toBe(3);
    expect((await releasedEvents())[0]?.payload).toMatchObject({ ok: false });

    gh.failRename = false;
    expect(await switchBack(deps(), ref)).toMatchObject({ done: true });
    expect(git(remote, 'branch', '--list', 'fleet2-abandoned/*').trim()).toBe('fleet2-abandoned/1-d1-a1');
    expect(released).toHaveLength(1);
  });

  it('放回旧系统时令牌对不上（别人先动过）：停下报警', async () => {
    await spawnRequested('pending');
    const r = await switchBack(deps({ release: async () => false }), ref);
    expect(r).toMatchObject({ done: false, action: 'alarm' });
  });

  it('已经不归新内核了：没有要切回的', async () => {
    fencing = -1;
    expect(await switchBack(deps(), ref)).toMatchObject({ done: true, stage: 'not-ours' });
    expect(released).toEqual([]);
  });

  it('O1：切回之后，原来排着的外部动作执行前核令牌对不上，进 dead，GitHub 什么都没碰', async () => {
    await record();
    // 只放，不撤动作（模拟切回的同一刻动作已被领走前令牌就变了）
    fencing = -1;
    const rep = await processOutbox(publishDeps());
    expect(rep).toMatchObject({ dead: 1 });
    expect(git(remote, 'branch', '--list', 'fleet2/*').trim()).toBe('');
    expect(gh.calls).toEqual([]);
  });
});
