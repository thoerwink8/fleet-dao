// #3926：临时 git 仓上暂存、提交、分支从改动接口读到；推、开 PR、合并只新增 change.* 行。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCockpitApi,
  createLocalGateway,
  LOCAL_TOKEN_HEADER,
  localAuthorize,
} from '@fleet-dao/harness-api';
import { opKey } from '@fleet-dao/harness-contract';
import type { HostProcess, HostSpawnSpec, ProcessHost } from '@fleet-dao/harness-runner';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { enqueueOp, getOp, listOpsForTask, updateAdeSession } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseGhPr, parsePorcelain } from '../src/ade/git.ts';
import { createAdeHandler } from '../src/ade/http.ts';
import { AdeService } from '../src/ade/service.ts';
import type { GitHubWriter } from '../src/github-write.ts';
import { processOutbox } from '../src/publish.ts';

vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'b'.repeat(64);

describe('porcelain 和 CI 解析', () => {
  it('认暂存、未暂存、重命名、未跟踪', () => {
    expect(parsePorcelain(' M a.txt\0')).toEqual([{ path: 'a.txt', staged: null, unstaged: 'modified' }]);
    expect(parsePorcelain('A  b.txt\0')).toEqual([{ path: 'b.txt', staged: 'added', unstaged: null }]);
    expect(parsePorcelain('R  old\0new\0')).toEqual([
      { path: 'new', origPath: 'old', staged: 'renamed', unstaged: null },
    ]);
    expect(parsePorcelain('?? c.txt\0')).toEqual([{ path: 'c.txt', staged: null, unstaged: 'untracked' }]);
  });

  it('认 gh 的检查', () => {
    expect(
      parseGhPr({
        number: 7,
        url: 'https://example.test/7',
        state: 'open',
        statusCheckRollup: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      }),
    ).toEqual({
      number: 7,
      url: 'https://example.test/7',
      state: 'open',
      checks: [{ name: 'ci', state: 'success' }],
    });
    expect(parseGhPr({ state: 'open' })).toBeNull();
  });
});

const host: ProcessHost = {
  kind: 'local',
  start(_spec: HostSpawnSpec): HostProcess {
    throw new Error('这个测试不跑 agent');
  },
  async attach() {
    return false;
  },
};

let t: TestDb;
let root: string;
let svc: AdeService;
let base: string;
const gateways: { close(): Promise<void> }[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function makeRepo(name: string): { dir: string; bare: string } {
  const dir = join(root, name);
  const bare = join(root, `${name}.git`);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare], { windowsHide: true });
  git(dir, 'remote', 'add', 'origin', bare);
  return { dir, bare };
}

beforeAll(async () => {
  t = await createTestDb();
  root = mkdtempSync(join(tmpdir(), 'fleet2-git-panel-'));
  svc = new AdeService({
    db: t.db,
    dataDir: root,
    host,
    flushMs: 20,
    commandFor: () => ['fake'],
    agents: async () => [{ id: 'claude', resume: true, models: ['default'] }],
  });
  const cockpit = createCockpitApi({
    db: t.db,
    authorize: localAuthorize(TOKEN),
    apiPrefix: '/api',
    pollMs: 30,
  });
  const g = createLocalGateway({
    cockpit,
    token: TOKEN,
    status: () => ({
      profile: 'local',
      version: '0',
      listen: '127.0.0.1:0',
      dataDir: root,
      isolation: { level: 'weak', facts: [] },
      externalWrites: { github: false, egressGateway: false },
      hosts: [],
      settings: [],
      ade: true,
    }),
    ade: createAdeHandler(svc, TOKEN, null),
  });
  gateways.push(g);
  const port = await g.listen(0);
  base = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  for (const g of gateways) await g.close();
  await t.close();
  rmSync(root, { recursive: true, force: true });
});

describe('git 面板', () => {
  it('暂存、提交，分支从改动接口读到', async () => {
    const { dir } = makeRepo('stage');
    const ws = await svc.addWorkspace('暂存', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: true,
    });
    writeFileSync(join(s.cwd, 'a.txt'), 'two\n');
    const listed = await fetch(`${base}/api/ade/sessions/${s.id}/changes`, {
      headers: { [LOCAL_TOKEN_HEADER]: TOKEN },
    });
    expect(listed.status).toBe(200);
    const before = (await listed.json()) as {
      branch: string;
      files: { path: string; unstaged: string | null }[];
    };
    expect(before.branch).toBe(`fleet2/${s.id}`);
    expect(before.files).toEqual([expect.objectContaining({ path: 'a.txt', unstaged: 'modified' })]);

    const staged = await fetch(`${base}/api/ade/sessions/${s.id}/git`, {
      method: 'POST',
      headers: { [LOCAL_TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'stage', paths: ['a.txt'] }),
    });
    expect(staged.status).toBe(200);
    const mid = (await staged.json()) as { files: { staged: string | null; unstaged: string | null }[] };
    expect(mid.files[0]).toMatchObject({ staged: 'modified', unstaged: null });

    await svc.gitOp(s.id, { op: 'unstage', paths: ['a.txt'] });
    const back = await svc.changes(s.id);
    expect(back.files[0]).toMatchObject({ staged: null, unstaged: 'modified' });

    const seen = await svc.gitOp(s.id, { op: 'diff', path: 'a.txt' });
    expect(seen).toMatchObject({ path: 'a.txt' });
    if (!('unstaged' in seen)) throw new Error('diff 没有正文');
    expect(seen.unstaged).toContain('two');

    await svc.gitOp(s.id, { op: 'stage', paths: ['a.txt'] });
    await svc.gitOp(s.id, { op: 'commit', message: '改一行' });
    const after = await svc.changes(s.id);
    expect(after.branch).toBe(`fleet2/${s.id}`);
    expect(after.files).toEqual([]);
  });

  it('推、开 PR、合并只新增 change.* 行，local 把分支推到裸仓', async () => {
    const { dir, bare } = makeRepo('push');
    const ws = await svc.addWorkspace('推', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: true,
    });
    writeFileSync(join(s.cwd, 'a.txt'), 'two\n');
    await svc.gitOp(s.id, { op: 'stage', paths: ['a.txt'] });
    await svc.gitOp(s.id, { op: 'commit', message: '改一行' });
    await svc.gitOp(s.id, { op: 'push' });
    await svc.gitOp(s.id, { op: 'pr', title: '看一眼' });
    await svc.gitOp(s.id, { op: 'merge' });

    const ops = await listOpsForTask(t.db, { repo: `local/${ws.id}`, issue: 1 });
    const mine = ops.filter((o) => o.payload.sessionId === s.id);
    expect(mine.map((o) => `${o.kind}:${o.state}`)).toEqual([
      'change.push:done',
      'change.pr.open:done',
      'change.merge:done',
    ]);
    expect(git(bare, 'branch', '--list', `fleet2/${s.id}`)).toContain(`fleet2/${s.id}`);
    const after = await svc.changes(s.id);
    expect(after.ahead).toBe(0);
    expect(after.behind).toBe(0);
  });

  it('在跑或有没提交改动的工作树不删，确认后才删已合并的', async () => {
    const { dir } = makeRepo('trees');
    const ws = await svc.addWorkspace('树', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: true,
    });
    const snap = await svc.changes(s.id);
    const mine = snap.worktrees.find((w) => w.branch === `fleet2/${s.id}`);
    const primary = snap.worktrees.find((w) => w.primary);
    expect(primary?.removable).toBe(false);
    expect(mine?.removable).toBe(true);
    expect(existsSync(s.cwd)).toBe(true);

    const preview = await svc.gitOp(s.id, { op: 'worktree-remove', confirm: false });
    if (!('worktrees' in preview)) throw new Error('预览没有工作树');
    expect(existsSync(s.cwd)).toBe(true);

    await updateAdeSession(t.db, s.id, { status: 'running', runId: 'run-1' });
    await expect(
      svc.gitOp(s.id, { op: 'worktree-remove', paths: [s.cwd], confirm: true }),
    ).rejects.toMatchObject({ status: 409 });
    expect(existsSync(s.cwd)).toBe(true);

    await updateAdeSession(t.db, s.id, { status: 'idle', runId: null });
    writeFileSync(join(s.cwd, 'dirty.txt'), 'x\n');
    await expect(
      svc.gitOp(s.id, { op: 'worktree-remove', paths: [s.cwd], confirm: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(existsSync(s.cwd)).toBe(true);

    git(s.cwd, 'clean', '-q', '-f');
    await svc.gitOp(s.id, { op: 'worktree-remove', paths: [s.cwd], confirm: true });
    expect(existsSync(s.cwd)).toBe(false);
  });

  it('gitlab 直接拒绝，不新增完成的行', async () => {
    const { dir } = makeRepo('gl');
    git(dir, 'remote', 'set-url', 'origin', 'https://gitlab.com/example/widget.git');
    const ws = await svc.addWorkspace('gl', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    await expect(svc.gitOp(s.id, { op: 'push' })).rejects.toMatchObject({ status: 501 });
    const ops = await listOpsForTask(t.db, { repo: `local/${ws.id}`, issue: 1 });
    expect(ops.filter((o) => o.payload.sessionId === s.id)).toEqual([]);
  });

  it('github 只排 change.push，不在这条路上推', async () => {
    const { dir } = makeRepo('gh');
    git(dir, 'checkout', '-q', '-b', 'feature');
    git(dir, 'remote', 'set-url', 'origin', 'https://github.com/example/widget.git');
    const ws = await svc.addWorkspace('gh', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    const out = await svc.gitOp(s.id, { op: 'push' });
    if (!('ops' in out)) throw new Error('没有外送状态');
    expect(out.notice).toBe('已排进 outbox');
    const ops = await listOpsForTask(t.db, { repo: `local/${ws.id}`, issue: 1 });
    const mine = ops.filter((o) => o.payload.sessionId === s.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'change.push', state: 'pending' });
    expect(mine[0]?.payload.adeCwd).toBeUndefined();
  });

  it('gitlab 的行领到仍然 dead', async () => {
    await t.pg.exec('truncate fleet2.outbox');
    const ref = { repo: 'ex/repo', issue: 1 };
    const key = opKey('change.push', ref, 0, 'gl-dead');
    await enqueueOp(t.db, {
      opKey: key,
      kind: 'change.push',
      ref,
      fencing: 0,
      payload: { forge: 'gitlab', patch: 'diff --git a/a b/a\n' },
    });
    await processOutbox({
      db: t.db,
      tmpRoot: root,
      mirrorRoot: root,
      redact: makeRedactor([]),
      tokenFor: async () => 'x',
      fencingOf: async () => 0,
      github: new Proxy({} as GitHubWriter, {
        get: () => () => {
          throw new Error('不该碰 GitHub');
        },
      }),
    });
    expect((await getOp(t.db, key))?.state).toBe('dead');
  });
});
