// 真执行发布（#3783）：补丁 → 经 outbox 推分支、开 PR。git 用真的（远端是本机裸仓），GitHub 用假的（test/fake-github.ts）。
// 每个用例自己一份远端和镜像。上一例超时后 git 还在跑，也写不进下一例的仓。
// 对应旧坑验收用例：S4（外部动作成功、写回执前崩）、O1（失去所有权后才执行）、GH1（两个请求开同一张单的 PR）、
// GH2（分支在、库里没记录）、GH3（PR 被人手动关）、H1（令牌不进命令行和日志）。
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueStream, opKey } from '@fleet-dao/harness-contract';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { enqueueOp, freezeRealBatch, getOp, listOpsForTask, readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CommandSpec, runCommand } from '../src/command.ts';
import { GitHubUncertainError } from '../src/github-write.ts';
import {
  type PublishCollected,
  type PublishDeps,
  prBody,
  processOutbox,
  publishAction,
  publishBranch,
  recordPublish,
} from '../src/publish.ts';
import { type FakeGitHub, fakeGitHub } from './fake-github.ts';
import { git, makeRepo } from './helpers.ts';

const redact = makeRedactor([]);
const TOKEN = 'ghs_TESTTOKEN0123456789';
let t: TestDb;
let baseSha: string;
let patch: string;
let templateRoot: string;
let templateRemote: string;
let templateMirror: string;

/** 这一例自己的远端、镜像、临时目录。超时后的 git 还在跑也只写这里，下一例看不到。 */
interface CaseBox {
  dir: string;
  remote: string;
  mirrorRoot: string;
  tmpRoot: string;
  aborted: boolean;
  ac: AbortController;
}
let box: CaseBox | undefined;
let gh: FakeGitHub;
let specs: CommandSpec[];
const pending = new Set<Promise<unknown>>();

function watch<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
}

/** 等这一例里还没结束的发布和 git。空了再让下一例建仓、清表。 */
async function settle(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/** 在源仓的临时副本里改文件，抓一份和工人抓补丁同样写法的 diff。用完即删。 */
function makePatch(src: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet2-patch-src-'));
  try {
    git(tmpdir(), 'clone', '-q', src, dir);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
    git(dir, 'add', '-A', '-N');
    return git(dir, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', baseSha, '--');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 只动这一例的远端。用例已结束就抛，避免写到下一例刚建的仓。 */
function gremote(...args: string[]): string {
  if (!box || box.aborted) throw new Error('用例已结束，不再动远端');
  return git(box.remote, ...args);
}

beforeAll(async () => {
  t = await createTestDb();
  const src = makeRepo();
  try {
    baseSha = git(src, 'rev-parse', 'HEAD').trim();
    templateRoot = mkdtempSync(join(tmpdir(), 'fleet2-pub-template-'));
    templateRemote = join(templateRoot, 'remote.git');
    templateMirror = join(templateRoot, 'mirrors', 'o', 'r.git');
    mkdirSync(join(templateRoot, 'mirrors', 'o'), { recursive: true });
    git(tmpdir(), 'clone', '-q', '--bare', src, templateRemote);
    git(tmpdir(), 'clone', '-q', '--bare', src, templateMirror);
    patch = makePatch(src, { 'src/a.txt': 'changed\n', 'src/new.txt': 'hello\n' });
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}, 60_000);
afterAll(async () => {
  await t.close();
  rmSync(templateRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  await settle();
  const dir = mkdtempSync(join(tmpdir(), 'fleet2-pub-case-'));
  const remote = join(dir, 'remote.git');
  const mirrorRoot = join(dir, 'mirrors');
  const tmpRoot = join(dir, 'tmp');
  mkdirSync(join(mirrorRoot, 'o'), { recursive: true });
  mkdirSync(tmpRoot);
  cpSync(templateRemote, remote, { recursive: true });
  cpSync(templateMirror, join(mirrorRoot, 'o', 'r.git'), { recursive: true });
  box = { dir, remote, mirrorRoot, tmpRoot, aborted: false, ac: new AbortController() };
  await t.pg.exec(
    'truncate fleet2.events, fleet2.outbox, fleet2.publish_runs, fleet2.real_batch_items, fleet2.command_receipts restart identity',
  );
  gh = fakeGitHub(remote);
  specs = [];
  await freezeRealBatch(
    t.db,
    'b1',
    [1, 2, 3, 4].map((issue) => ({ repo: 'o/r', issue, baseSha, snapshotAt: new Date() })),
  );
}, 60_000);
afterEach(async () => {
  if (box) box.aborted = true;
  box?.ac.abort();
  await settle();
  // 让超时那一例的后续断言先抛掉，再删目录、再让下一例换仓。
  await new Promise((r) => setImmediate(r));
  await settle();
  if (box) rmSync(box.dir, { recursive: true, force: true });
}, 60_000);

const deps = (over: Partial<PublishDeps> = {}): PublishDeps => {
  const mine = box;
  if (!mine) throw new Error('用例还没有自己的仓');
  return {
    db: t.db,
    github: gh,
    tokenFor: async () => TOKEN,
    mirrorRoot: mine.mirrorRoot,
    tmpRoot: mine.tmpRoot,
    remote: () => mine.remote,
    fencingOf: async () => 3,
    redact,
    retryMs: 0,
    run: (spec) => {
      specs.push(spec);
      const signal = spec.signal ? AbortSignal.any([spec.signal, mine.ac.signal]) : mine.ac.signal;
      return watch(runCommand({ ...spec, signal }));
    },
    ...over,
  };
};

const collected = (over: Partial<PublishCollected> = {}, issue = 1): PublishCollected => ({
  runId: `d${issue}-a1`,
  target: { batchId: 'b1', repo: 'o/r', issue, baseSha, fencing: 3, title: `改一行 ${issue}` },
  verdict: 'unverified',
  outcome: 'completed',
  reasons: ['没有可核验的范围'],
  patch,
  wallMs: 12_000,
  ...over,
});

const record = (over: Partial<PublishCollected> = {}, issue = 1) =>
  watch(recordPublish(t.db, { ...collected(over, issue), model: 'grok-4.7' }));

const runOutbox = (d: PublishDeps) => watch(processOutbox(d));

const ref = (issue = 1) => ({ repo: 'o/r', issue });
const states = async (issue = 1) =>
  (await listOpsForTask(t.db, ref(issue))).map((o) => `${o.kind}:${o.state}`);

describe('外送种类', () => {
  it('旧名和新名指到同一件', () => {
    expect(publishAction('git.push')).toBe('push');
    expect(publishAction('change.push')).toBe('push');
    expect(publishAction('github.pr.open')).toBe('open');
    expect(publishAction('change.pr.open')).toBe('open');
    expect(publishAction('change.merge')).toBeNull();
  });
});

describe('记账：该推的才排推送', () => {
  it('有改动、核验过得去、工人干净交活：ready，排一个 change.push；同一个 runId 重来还是一行一个动作', async () => {
    const run = await record();
    expect(run).toMatchObject({ state: 'ready', branch: 'fleet2/1-d1-a1', fencing: 3, model: 'grok-4.7' });
    await record();
    expect(await states()).toEqual(['change.push:pending']);
    const rows = await t.pg.query('select count(*)::int as n from fleet2.publish_runs');
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it('核验没过、没查成、工人被叫停、没有改动：都不推（held / empty），只留产物', async () => {
    const cases: [Partial<PublishCollected>, string][] = [
      [{ verdict: 'failed' }, 'held'],
      [{ verdict: 'unknown' }, 'held'],
      [{ outcome: 'killed' }, 'held'],
      [{ patch: '' }, 'empty'],
    ];
    for (const [i, [over, want]] of cases.entries()) {
      expect((await record(over, i + 1)).state).toBe(want);
      expect(await states(i + 1)).toEqual([]);
    }
  });

  it('passed 也推', async () => {
    expect((await record({ verdict: 'passed' })).state).toBe('ready');
  });
});

describe('推分支、开 PR', () => {
  it('先推分支再开 PR：提交内容对、PR 正文有关单词和模型、整条链进 issue 流、没碰合并', async () => {
    await record();
    expect(await runOutbox(deps())).toMatchObject({ claimed: 1, done: 1 });
    // 推送做完后排出开 PR 的动作
    expect(await states()).toEqual(['change.push:done', 'change.pr.open:pending']);
    const sha = gremote('rev-parse', 'refs/heads/fleet2/1-d1-a1').trim();
    expect(gremote('show', `${sha}:src/a.txt`)).toBe('changed\n');
    expect(gremote('show', `${sha}:src/new.txt`)).toBe('hello\n');
    expect(gremote('rev-parse', `${sha}^`).trim()).toBe(baseSha);
    expect(gremote('log', '-1', '--format=%s', sha).trim()).toBe('改一行 1');

    expect(await runOutbox(deps())).toMatchObject({ claimed: 1, done: 1 });
    expect(gh.prs).toHaveLength(1);
    const pr = gh.prs[0];
    expect(pr?.headRef).toBe('fleet2/1-d1-a1');
    expect(pr?.body).toContain('Closes #1');
    expect(pr?.body).toContain('grok-4.7');
    expect(pr?.body).toContain('unverified');
    expect(await states()).toEqual(['change.push:done', 'change.pr.open:done']);

    const chain = (await readStream(t.db, issueStream(ref()), 0)).map((e) => e.type);
    expect(chain).toEqual(['publish.pushed', 'publish.pr.opened']);
    // 没有任何合并的调用
    expect(gh.calls.join('\n')).not.toMatch(/merge/i);
  });

  it('S4：开 PR 建成了但响应丢了（超时）→ 记 unknown；重来先查到已有的 PR，不开第二个', async () => {
    await record();
    await runOutbox(deps()); // 推
    gh.loseNextOpenResponse = true;
    expect(await runOutbox(deps())).toMatchObject({ claimed: 1, unknown: 1 });
    expect(gh.prs).toHaveLength(1);
    expect(await states()).toEqual(['change.push:done', 'change.pr.open:unknown']);
    expect(await runOutbox(deps())).toMatchObject({ claimed: 1, done: 1 });
    expect(gh.prs).toHaveLength(1);
    expect(gh.calls.filter((c) => c.startsWith('openPr'))).toHaveLength(1);
    const op = await getOp(t.db, opKey('change.pr.open', ref(), 3, 'd1-a1'));
    expect(op?.result).toMatchObject({ number: gh.prs[0]?.number, opened: false });
  });

  it('GH2：推送已经做过、收尾前崩了 → 重来看到分支在、内容对，不再推第二次', async () => {
    await record();
    await runOutbox(deps());
    // 模拟「推完、写结果前崩了」：动作退回 pending，开 PR 的动作还没排的状态不影响
    await t.pg.exec("update fleet2.outbox set state = 'pending', result = null where kind = 'change.push'");
    expect(specs.filter((s) => s.command.includes('push'))).toHaveLength(1);
    // 这一轮领到两条：重来的推送（看到分支已在、内容对，补记）和排着的开 PR
    expect(await runOutbox(deps())).toMatchObject({ claimed: 2, done: 2 });
    expect(specs.filter((s) => s.command.includes('push'))).toHaveLength(1);
    expect(await states()).toEqual(['change.push:done', 'change.pr.open:done']);
    expect(gh.prs).toHaveLength(1);
  });

  it('O1：这张单已经易手（令牌对不上）→ 动作进 dead，分支没推、PR 没开', async () => {
    await record();
    expect(await runOutbox(deps({ fencingOf: async () => 4 }))).toMatchObject({ dead: 1, done: 0 });
    expect(await states()).toEqual(['change.push:dead']);
    expect(gremote('branch', '--list', 'fleet2/*').trim()).toBe('');
    expect(gh.prs).toHaveLength(0);
  });

  it('读不到所有权令牌：按没做成退避，不当成对得上；不动 GitHub', async () => {
    await record();
    const rep = await runOutbox(
      deps({
        fencingOf: async () => {
          throw new Error('旧库连不上');
        },
      }),
    );
    expect(rep).toMatchObject({ failed: 1, done: 0 });
    expect(await states()).toEqual(['change.push:pending']);
    expect(gremote('branch', '--list', 'fleet2/*').trim()).toBe('');
  });

  it('GH1：这张单已经有别人开着的 PR → 不开第二个，进 dead', async () => {
    await record();
    await runOutbox(deps());
    gh.setOpenPr({ number: 7, headRef: 'fleet/1-旧引擎', body: 'Closes #1' });
    expect(await runOutbox(deps())).toMatchObject({ dead: 1 });
    expect(gh.prs).toHaveLength(1);
    expect(await states()).toEqual(['change.push:done', 'change.pr.open:dead']);
  });

  it('GH3：PR 被人手动关了 → 不再开第二个，进 dead；合了就认', async () => {
    await record();
    await runOutbox(deps());
    await runOutbox(deps());
    gh.closePrByHand(gh.prs[0]?.number ?? 0);
    await t.pg.exec(
      "update fleet2.outbox set state = 'pending', result = null where kind = 'change.pr.open'",
    );
    expect(await runOutbox(deps())).toMatchObject({ dead: 1 });
    expect(gh.prs).toHaveLength(1);
  });

  it('远端同名分支已经有别的内容 → 不覆盖，进 dead', async () => {
    gremote('branch', 'fleet2/1-d1-a1', 'main');
    await record();
    expect(await runOutbox(deps())).toMatchObject({ dead: 1 });
    expect(gremote('rev-parse', 'refs/heads/fleet2/1-d1-a1').trim()).toBe(baseSha);
    expect(await states()).toEqual(['change.push:dead']);
  });

  it('补丁打不上基线 → 进 dead，不推', async () => {
    await record({ patch: 'diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-x\n+y\n' });
    expect(await runOutbox(deps())).toMatchObject({ dead: 1 });
    expect(gremote('branch', '--list', 'fleet2/*').trim()).toBe('');
  });

  it('GitHub 查证超时（没得到答案）→ 记 unknown，下一轮再查；重试到上限进 dead', async () => {
    await record();
    const flaky = {
      ...gh,
      branchSha: async () => {
        throw new GitHubUncertainError('GET ref', '超时');
      },
    };
    expect(await runOutbox(deps({ github: flaky, maxAttempts: 2 }))).toMatchObject({ unknown: 1 });
    expect(await states()).toEqual(['change.push:unknown']);
    expect(await runOutbox(deps({ github: flaky, maxAttempts: 2 }))).toMatchObject({ dead: 1 });
    expect(await states()).toEqual(['change.push:dead']);
  });

  it('H1：令牌和认证头不在任何命令行里，只有推送那一条的环境里有，别的 git 没有', async () => {
    await record();
    await runOutbox(deps());
    expect(specs.length).toBeGreaterThan(3);
    for (const s of specs) {
      expect(s.command.join(' ')).not.toContain(TOKEN);
      expect(s.command.join(' ')).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
    }
    const withAuth = specs.filter((s) => Object.keys(s.trustedEnv ?? {}).includes('GIT_CONFIG_VALUE_0'));
    expect(withAuth).toHaveLength(1);
    expect(withAuth[0]?.command).toContain('push');
    // 家目录指到临时目录：读不到宿主的全局配置和凭据助手
    expect(withAuth[0]?.trustedEnv?.HOME).toContain('fleet2-publish-');
  });

  it('合并、评论没有处理器：领到就进 dead，GitHub 一个调用都不发', async () => {
    await enqueueOp(t.db, {
      opKey: opKey('github.merge', ref(), 3, 'x'),
      kind: 'github.merge',
      ref: ref(),
      fencing: 3,
      payload: {},
    });
    expect(await runOutbox(deps())).toMatchObject({ dead: 1 });
    expect(gh.calls).toEqual([]);
  });

  it('同一个提交号：同样的基线加补丁不管推几次都是同一个提交（操作键稳）', async () => {
    await record({}, 1);
    await runOutbox(deps());
    const a = gremote('rev-parse', 'refs/heads/fleet2/1-d1-a1').trim();
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(publishBranch(1, 'd1-a1')).toBe('fleet2/1-d1-a1');
  });
});

describe('PR 正文', () => {
  it('写关单词、哪单、哪个模型、核验结论和原因', () => {
    const body = prBody({
      repo: 'o/r',
      issue: 9,
      model: 'grok-4.7',
      runId: 'd5-a1',
      verdict: 'passed',
      baseSha,
      wallMs: 61_000,
      reason: '检查退出码 0',
    });
    expect(body.split('\n')[0]).toBe('Closes #9');
    expect(body).toContain('o/r#9');
    expect(body).toContain('grok-4.7');
    expect(body).toContain('passed（检查退出码 0）');
    expect(body).toContain('61 秒');
    expect(body).toContain('没有开自动合并');
  });
});
