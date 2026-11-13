// #3926：临时 git 仓上暂存、提交、分支从改动接口读到；推、开 PR、合并只新增 change.* 行。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { forgeOfRemote, parseGhPr, parsePorcelain } from '../src/ade/git.ts';
import { gitAct, gitSnapshot } from '../src/ade/git-panel.ts';
import type { CmdResult, CmdRun } from '../src/ade/github-ops.ts';
import { gitlabHostsPath, gitlabTokenPath, saveGitlabToken } from '../src/ade/gitlab-hosts.ts';
import {
  type GitlabFetch,
  gitlabCredentialHelper,
  gitlabMergeBody,
  gitlabRunEnv,
} from '../src/ade/gitlab-ops.ts';
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

  it('同一个检查只留开始时间最新的一次，列表里排在后面的旧运行不算', () => {
    expect(
      parseGhPr({
        number: 1,
        state: 'OPEN',
        statusCheckRollup: [
          { name: 'ping', status: 'QUEUED', startedAt: '2026-11-12T20:32:59Z' },
          { name: 'ping', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-12T20:32:50Z' },
          { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-12T20:32:40Z' },
        ],
      })?.checks,
    ).toEqual([
      { name: 'ping', state: 'QUEUED' },
      { name: 'lint', state: 'FAILURE' },
    ]);
  });

  it('forge 看主机名，自建 GitLab 要登记才算', () => {
    expect(forgeOfRemote('https://github.com/a/b.git')).toBe('github');
    expect(forgeOfRemote('git@github.com:a/b.git')).toBe('github');
    expect(forgeOfRemote('https://codeload.github.com/a/b.git')).toBe('github');
    expect(forgeOfRemote('https://gitlab.com/a/b.git')).toBe('gitlab');
    expect(forgeOfRemote('git@gitlab.com:group/app.git')).toBe('gitlab');
    expect(forgeOfRemote('https://gitlab.example.com/g/a.git')).toBe('gitlab');
    expect(forgeOfRemote('https://git.example.com/group/app.git')).toBe('local');
    expect(forgeOfRemote('https://git.example.com/group/app.git', ['git.example.com'])).toBe('gitlab');
    expect(forgeOfRemote('/tmp/repo.git')).toBe('local');
    expect(forgeOfRemote('D:\\repos\\app')).toBe('local');
    expect(forgeOfRemote(null)).toBe('local');
  });

  it('GitLab 只认 merge 和 squash，别的名字原样拒绝', () => {
    const sha = 'a'.repeat(40);
    expect(gitlabMergeBody('merge', sha)).toEqual({ sha, squash: false });
    expect(gitlabMergeBody('squash', sha)).toEqual({ sha, squash: true });
    expect(() => gitlabMergeBody('rebase', sha)).toThrow('GitLab 做不到 rebase');
    expect(() => gitlabMergeBody('REBASE', sha)).toThrow('GitLab 做不到 REBASE');
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
    expect(after.head).toMatch(/^[0-9a-f]{40}$/);
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

  it('squash 合并后工作树算已合并，有没提交的改动或会话在跑仍不删', async () => {
    const { dir } = makeRepo('squash');
    const ws = await svc.addWorkspace('squash', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: true,
    });
    writeFileSync(join(s.cwd, 'b.txt'), 'two\n');
    git(s.cwd, 'add', 'b.txt');
    git(s.cwd, 'commit', '-q', '-m', 'branch');
    const before = await svc.changes(s.id);
    const ahead = before.worktrees.find((w) => w.branch === `fleet2/${s.id}`);
    expect(ahead?.merged).toBe(false);
    expect(ahead?.reason).toContain('还没合并');

    git(dir, 'merge', '--squash', `fleet2/${s.id}`);
    git(dir, 'commit', '-q', '-m', 'squash');
    writeFileSync(join(dir, 'c.txt'), 'later\n');
    git(dir, 'add', 'c.txt');
    git(dir, 'commit', '-q', '-m', 'later');

    const after = await svc.changes(s.id);
    const mine = after.worktrees.find((w) => w.branch === `fleet2/${s.id}`);
    expect(mine?.merged).toBe(true);
    expect(mine?.removable).toBe(true);
    expect(mine?.reason).not.toContain('还没合并');

    writeFileSync(join(s.cwd, 'dirty.txt'), 'x\n');
    const dirty = (await svc.changes(s.id)).worktrees.find((w) => w.branch === `fleet2/${s.id}`);
    expect(dirty?.merged).toBe(true);
    expect(dirty?.removable).toBe(false);
    expect(dirty?.reason).toContain('有没提交的改动');

    git(s.cwd, 'clean', '-q', '-f');
    await updateAdeSession(t.db, s.id, { status: 'running', runId: 'run-squash' });
    const running = (await svc.changes(s.id)).worktrees.find((w) => w.branch === `fleet2/${s.id}`);
    expect(running?.merged).toBe(true);
    expect(running?.removable).toBe(false);
    expect(running?.reason).toContain('还在跑');
  });

  it('GitHub 上 PR 已合并就算已合并，开着的 PR 或没有 PR 不靠这个', async () => {
    const { dir } = makeRepo('pr-merged');
    git(dir, 'remote', 'set-url', 'origin', 'https://github.com/example/widget.git');
    const ws = await svc.addWorkspace('pr-merged', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: true,
    });
    writeFileSync(join(s.cwd, 'b.txt'), 'two\n');
    git(s.cwd, 'add', 'b.txt');
    git(s.cwd, 'commit', '-q', '-m', 'only here');
    const row = await svc.getSession(s.id);
    const look =
      (state: string | null): CmdRun =>
      async () =>
        state
          ? { ran: true, exitCode: 0, stdout: JSON.stringify({ state }), stderrTail: '' }
          : { ran: true, exitCode: 1, stdout: '', stderrTail: 'no pull requests found' };
    const merged = await gitSnapshot({ db: t.db, dataDir: root, run: look('MERGED') }, row);
    const mine = merged.worktrees.find((w) => w.branch === `fleet2/${s.id}`);
    expect(mine?.merged).toBe(true);
    expect(mine?.reason).not.toContain('还没合并');

    const open = await gitSnapshot({ db: t.db, dataDir: root, run: look('OPEN') }, row);
    expect(open.worktrees.find((w) => w.branch === `fleet2/${s.id}`)?.merged).toBe(false);

    const none = await gitSnapshot({ db: t.db, dataDir: root, run: look(null) }, row);
    expect(none.worktrees.find((w) => w.branch === `fleet2/${s.id}`)?.merged).toBe(false);
  });

  const GL = 'https://gitlab.com/example/widget.git';
  const GL_TOKEN = 'glpat-3944-test-token';
  const HEAD = 'a'.repeat(40);

  function mrRow(sha: string, state = 'opened') {
    return {
      iid: 3,
      sha,
      state,
      web_url: 'https://gitlab.com/example/widget/-/merge_requests/3',
      source_branch: 'feature',
    };
  }

  function fakeGitlab(opts: { hasMr?: boolean; mrHead?: string; leak?: boolean }): {
    fetch: GitlabFetch;
    puts: unknown[];
    posts: { n: number };
    tokens: string[];
  } {
    const puts: unknown[] = [];
    const posts = { n: 0 };
    const tokens: string[] = [];
    const fetch: GitlabFetch = async (req) => {
      tokens.push(req.headers['PRIVATE-TOKEN'] ?? '');
      const { method, url } = req;
      if (url.includes('/pipelines')) return { status: 200, json: [{ id: 11, status: 'success' }] };
      if (url.includes('/merge_requests?')) {
        return { status: 200, json: opts.hasMr ? [mrRow(opts.mrHead ?? HEAD)] : [] };
      }
      if (method === 'POST' && url.endsWith('/merge_requests')) {
        posts.n += 1;
        if (opts.leak) return { status: 500, json: { message: GL_TOKEN } };
        return { status: 201, json: mrRow(HEAD) };
      }
      if (method === 'PUT' && url.endsWith('/merge')) {
        puts.push(req.body ? (JSON.parse(req.body) as unknown) : null);
        return { status: 200, json: mrRow(opts.mrHead ?? HEAD, 'merged') };
      }
      if (method === 'GET' && url.includes('/projects/'))
        return { status: 200, json: { default_branch: 'main' } };
      return { status: 500, json: { message: `没想到 ${method} ${url}` } };
    };
    return { fetch, puts, posts, tokens };
  }

  function fakeGit(opts: { head?: string; remote?: string }): { run: CmdRun; calls: string[][] } {
    const calls: string[][] = [];
    const ok = (stdout: string): CmdResult => ({ ran: true, exitCode: 0, stdout, stderrTail: '' });
    const run: CmdRun = async (_cwd, command) => {
      if (command.join(' ').includes(GL_TOKEN)) throw new Error('命令里不该有令牌');
      calls.push([...command]);
      const text = command.join(' ');
      if (text.includes('get-url')) return ok(`${opts.remote ?? GL}\n`);
      if (text.includes('--abbrev-ref')) return ok('feature\n');
      if (command.includes('rev-parse') && command.includes('HEAD')) return ok(`${opts.head ?? HEAD}\n`);
      if (command.includes('push')) return ok('ok\n');
      return { ran: true, exitCode: 1, stdout: '', stderrTail: `没想到 ${text}` };
    };
    return { run, calls };
  }

  async function glWorkspace(name: string, remote = GL) {
    const { dir } = makeRepo(name);
    git(dir, 'checkout', '-q', '-b', 'feature');
    git(dir, 'remote', 'set-url', 'origin', remote);
    const ws = await svc.addWorkspace(name, dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    return { dir, ws, s };
  }

  async function sessionOps(wsId: string, sessionId: string) {
    const ops = await listOpsForTask(t.db, { repo: `local/${wsId}`, issue: 1 });
    return ops.filter((o) => o.payload.sessionId === sessionId);
  }

  function assertNoToken(value: unknown, token = GL_TOKEN) {
    const text = JSON.stringify(value);
    expect(text).not.toContain(token);
    expect(text).not.toContain('gitlab-tokens');
  }

  it('gitlab 走 change.*：开 MR、读流水线、按看到的 head 合并，令牌不进载荷', async () => {
    const { dir, ws, s } = await glWorkspace('gl-walk');
    const ctx = { db: t.db, dataDir: root };
    const missing = await gitAct(ctx, s, { op: 'checks' });
    if (!('pr' in missing)) throw new Error('不是 CI');
    expect(missing).toEqual({ pr: null, reason: '缺 GitLab 令牌' });
    expect(await sessionOps(ws.id, s.id)).toEqual([]);

    await saveGitlabToken(root, 'gitlab.com', GL_TOKEN);
    const tokenFile = gitlabTokenPath(root, 'gitlab.com');
    expect(readFileSync(tokenFile, 'utf8')).toBe(GL_TOKEN);
    expect(resolve(tokenFile).toLowerCase().startsWith(resolve(root).toLowerCase())).toBe(true);
    expect(resolve(tokenFile).toLowerCase().startsWith(resolve(dir).toLowerCase())).toBe(false);
    expect(tokenFile.replaceAll('\\', '/')).toContain('gitlab-tokens/');
    expect(gitlabCredentialHelper()).not.toContain(GL_TOKEN);
    expect(JSON.stringify(gitlabRunEnv(tokenFile))).not.toContain(GL_TOKEN);
    expect(gitlabRunEnv(tokenFile).FLEET2_GITLAB_TOKEN_FILE).toBe(tokenFile);

    const pushed = fakeGit({});
    const pushOut = await gitAct({ ...ctx, run: pushed.run }, s, { op: 'push' });
    if (!('notice' in pushOut)) throw new Error('没有回执');
    expect(pushOut.notice).toBe('已推送');
    expect(pushOut.forge).toBe('gitlab');
    const pushCmd = pushed.calls.find((c) => c.includes('push'));
    expect(
      pushCmd?.some(
        (arg) => arg.startsWith('credential.helper=') && arg.length > 'credential.helper='.length,
      ),
    ).toBe(true);
    expect(pushCmd?.join(' ')).not.toContain(GL_TOKEN);
    expect(pushCmd).toContain('HEAD:refs/heads/feature');

    const opened = fakeGitlab({ hasMr: false });
    const openOut = await gitAct({ ...ctx, gitlab: opened.fetch }, s, { op: 'pr', title: '看一眼' });
    if (!('notice' in openOut)) throw new Error('没有回执');
    expect(openOut.notice).toBe('已开 MR #3');
    expect(opened.posts.n).toBe(1);
    expect(opened.tokens.every((token) => token === GL_TOKEN)).toBe(true);

    const again = fakeGitlab({ hasMr: true });
    const had = await gitAct({ ...ctx, gitlab: again.fetch }, s, { op: 'pr', title: '看一眼' });
    if (!('notice' in had)) throw new Error('没有回执');
    expect(had.notice).toBe('这个分支已经有 MR #3');
    expect(again.posts.n).toBe(0);

    const beforeChecks = (await sessionOps(ws.id, s.id)).length;
    const checks = fakeGitlab({ hasMr: true });
    const seen = await gitAct({ ...ctx, gitlab: checks.fetch }, s, { op: 'checks' });
    if (!('pr' in seen)) throw new Error('不是 CI');
    expect(seen.reason).toBe('');
    expect(seen.pr).toMatchObject({
      number: 3,
      state: 'opened',
      checks: [{ name: '流水线 11', state: 'success' }],
    });
    expect((await sessionOps(ws.id, s.id)).length).toBe(beforeChecks);

    const preview = await gitAct(ctx, s, { op: 'merge' });
    if (!('notice' in preview)) throw new Error('没有回执');
    expect(preview.notice).toBe('还没合并，先确认');
    expect((await sessionOps(ws.id, s.id)).filter((o) => o.kind === 'change.merge')).toEqual([]);

    const localMoved = fakeGitlab({ hasMr: true });
    await expect(
      gitAct({ ...ctx, run: fakeGit({ head: HEAD }).run, gitlab: localMoved.fetch }, s, {
        op: 'merge',
        confirm: true,
        head: 'b'.repeat(40),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(localMoved.puts).toEqual([]);

    const remoteMoved = fakeGitlab({ hasMr: true, mrHead: 'c'.repeat(40) });
    await expect(
      gitAct({ ...ctx, run: fakeGit({ head: HEAD }).run, gitlab: remoteMoved.fetch }, s, {
        op: 'merge',
        confirm: true,
        head: HEAD,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(remoteMoved.puts).toEqual([]);

    const mergesBefore = (await sessionOps(ws.id, s.id)).filter((o) => o.kind === 'change.merge').length;
    const refused = fakeGitlab({ hasMr: true });
    await expect(
      gitAct({ ...ctx, run: fakeGit({}).run, gitlab: refused.fetch }, s, {
        op: 'merge',
        confirm: true,
        head: HEAD,
        method: 'rebase',
      }),
    ).rejects.toThrow('GitLab 做不到 rebase');
    expect(refused.puts).toEqual([]);
    expect(refused.tokens).toEqual([]);
    expect((await sessionOps(ws.id, s.id)).filter((o) => o.kind === 'change.merge').length).toBe(
      mergesBefore,
    );

    const ok = fakeGitlab({ hasMr: true });
    const merged = await gitAct({ ...ctx, run: fakeGit({ head: HEAD }).run, gitlab: ok.fetch }, s, {
      op: 'merge',
      confirm: true,
      head: HEAD,
      method: 'merge',
    });
    if (!('notice' in merged)) throw new Error('没有回执');
    expect(merged.notice).toBe('已合并 MR #3');
    expect(ok.puts).toEqual([{ sha: HEAD, squash: false }]);

    const squashed = fakeGitlab({ hasMr: true });
    const squashOut = await gitAct({ ...ctx, run: fakeGit({ head: HEAD }).run, gitlab: squashed.fetch }, s, {
      op: 'merge',
      confirm: true,
      head: HEAD,
      method: 'squash',
    });
    if (!('notice' in squashOut)) throw new Error('没有回执');
    expect(squashOut.notice).toBe('已合并 MR #3');
    expect(squashed.puts).toEqual([{ sha: HEAD, squash: true }]);

    const mine = await sessionOps(ws.id, s.id);
    expect(
      mine.some((o) => o.kind === 'change.push' && o.state === 'done' && o.payload.forge === 'gitlab'),
    ).toBe(true);
    expect(
      mine.some((o) => o.kind === 'change.pr.open' && o.state === 'done' && o.payload.forge === 'gitlab'),
    ).toBe(true);
    expect(
      mine.some((o) => o.kind === 'change.merge' && o.state === 'done' && o.payload.expectedHead === HEAD),
    ).toBe(true);
    assertNoToken(mine);
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toContain(GL_TOKEN);
    if (existsSync(gitlabHostsPath(root)))
      expect(readFileSync(gitlabHostsPath(root), 'utf8')).not.toContain(GL_TOKEN);
  });

  function githubSession(name: string, remote = 'https://github.com/example/widget.git') {
    const { dir } = makeRepo(name);
    git(dir, 'checkout', '-q', '-b', 'feature');
    git(dir, 'remote', 'set-url', 'origin', remote);
    return dir;
  }

  function fakeGithub(opts: { remote?: string; head?: string; prHead?: string; prState?: string }): {
    run: CmdRun;
    calls: string[][];
  } {
    const calls: string[][] = [];
    let opened = false;
    let merged = false;
    const ok = (stdout: string): CmdResult => ({ ran: true, exitCode: 0, stdout, stderrTail: '' });
    const no = (stderr: string): CmdResult => ({ ran: true, exitCode: 1, stdout: '', stderrTail: stderr });
    const run: CmdRun = async (_cwd, command) => {
      calls.push([...command]);
      const text = command.join(' ');
      if (text.includes('get-url')) return ok(`${opts.remote ?? 'https://github.com/example/widget.git'}\n`);
      if (text.includes('--abbrev-ref')) return ok('feature\n');
      if (command.includes('rev-parse') && command.includes('HEAD'))
        return ok(`${opts.head ?? 'a'.repeat(40)}\n`);
      if (command.includes('push')) {
        if (command.includes('--force') || command.includes('--force-with-lease')) return no('不许强推');
        return ok('ok\n');
      }
      if (command[0] === 'gh' && command[2] === 'view') {
        if (!opened && !opts.prState && !merged) return no('no pull requests found');
        const state = merged ? 'MERGED' : (opts.prState ?? 'OPEN');
        return ok(
          JSON.stringify({
            number: 4,
            url: 'https://github.com/example/widget/pull/4',
            state,
            headRefOid: opts.prHead ?? opts.head ?? 'a'.repeat(40),
            headRefName: 'feature',
          }),
        );
      }
      if (command[0] === 'gh' && command[2] === 'create') {
        opened = true;
        return ok('https://github.com/example/widget/pull/4\n');
      }
      if (command[0] === 'gh' && command[2] === 'merge') {
        merged = true;
        return ok('merged\n');
      }
      return no(`没想到的命令 ${text}`);
    };
    return { run, calls };
  }

  it('github 推送入 outbox 后真推当前分支，不强推、不碰 fleet-dao', async () => {
    const dir = githubSession('gh-push');
    const ws = await svc.addWorkspace('gh-push', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    const fake = fakeGithub({});
    const out = await gitAct({ db: t.db, dataDir: root, run: fake.run }, s, { op: 'push' });
    if (!('notice' in out)) throw new Error('没有回执');
    expect(out.notice).toBe('已推送');
    const push = fake.calls.find((c) => c.includes('push'));
    expect(push).toContain('HEAD:refs/heads/feature');
    expect(push).not.toContain('--force');
    const ops = await listOpsForTask(t.db, { repo: `local/${ws.id}`, issue: 1 });
    const mine = ops.filter((o) => o.payload.sessionId === s.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'change.push', state: 'done' });
    expect(mine[0]?.payload.adeCwd).toBe(s.cwd);

    const blockedDir = githubSession('gh-fleet', 'https://github.com/thoerwink8/fleet-dao.git');
    const blockedWs = await svc.addWorkspace('gh-fleet', blockedDir);
    const blocked = await svc.createSession({
      workspaceId: blockedWs.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    const blockedFake = fakeGithub({ remote: 'https://github.com/thoerwink8/fleet-dao.git' });
    await expect(
      gitAct({ db: t.db, dataDir: root, run: blockedFake.run }, blocked, { op: 'push' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(blockedFake.calls.some((c) => c.includes('push'))).toBe(false);
    const dead = await listOpsForTask(t.db, { repo: `local/${blockedWs.id}`, issue: 1 });
    expect(dead.filter((o) => o.payload.sessionId === blocked.id)[0]?.state).toBe('dead');
  });

  it('github 开 PR 真调用 gh，已有 PR 就不再开', async () => {
    const dir = githubSession('gh-pr');
    const ws = await svc.addWorkspace('gh-pr', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    const fake = fakeGithub({});
    const opened = await gitAct({ db: t.db, dataDir: root, run: fake.run }, s, { op: 'pr', title: '看一眼' });
    if (!('notice' in opened)) throw new Error('没有回执');
    expect(opened.notice).toBe('已开 PR #4');
    expect(fake.calls.some((c) => c[0] === 'gh' && c[2] === 'create')).toBe(true);

    const again = fakeGithub({ prState: 'OPEN' });
    const had = await gitAct({ db: t.db, dataDir: root, run: again.run }, s, { op: 'pr', title: '看一眼' });
    if (!('notice' in had)) throw new Error('没有回执');
    expect(had.notice).toBe('这个分支已经有 PR #4');
    expect(again.calls.some((c) => c[2] === 'create')).toBe(false);
  });

  it('github 合并要确认和看到的 head，对不上就拒', async () => {
    const dir = githubSession('gh-merge');
    const ws = await svc.addWorkspace('gh-merge', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    const head = 'a'.repeat(40);
    const preview = await gitAct({ db: t.db, dataDir: root, run: fakeGithub({}).run }, s, { op: 'merge' });
    if (!('notice' in preview)) throw new Error('没有回执');
    expect(preview.notice).toBe('还没合并，先确认');
    expect(
      (await listOpsForTask(t.db, { repo: `local/${ws.id}`, issue: 1 })).filter(
        (o) => o.kind === 'change.merge',
      ),
    ).toEqual([]);

    await expect(
      gitAct({ db: t.db, dataDir: root, run: fakeGithub({ head }).run }, s, {
        op: 'merge',
        confirm: true,
        head: 'b'.repeat(40),
      }),
    ).rejects.toMatchObject({ status: 409 });

    const remoteMoved = fakeGithub({ head, prHead: 'c'.repeat(40), prState: 'OPEN' });
    await expect(
      gitAct({ db: t.db, dataDir: root, run: remoteMoved.run }, s, { op: 'merge', confirm: true, head }),
    ).rejects.toMatchObject({ status: 409 });
    expect(remoteMoved.calls.some((c) => c[2] === 'merge')).toBe(false);

    const ok = fakeGithub({ head, prState: 'OPEN' });
    const merged = await gitAct({ db: t.db, dataDir: root, run: ok.run }, s, {
      op: 'merge',
      confirm: true,
      head,
    });
    if (!('notice' in merged)) throw new Error('没有回执');
    expect(merged.notice).toBe('已合并 PR #4');
    const mergeCmd = ok.calls.find((c) => c[2] === 'merge');
    expect(mergeCmd).toContain('--match-head-commit');
    expect(mergeCmd).toContain(head);
    expect(mergeCmd).not.toContain('--force');
    const ops = await listOpsForTask(t.db, { repo: `local/${ws.id}`, issue: 1 });
    const mine = ops.filter((o) => o.payload.sessionId === s.id && o.kind === 'change.merge');
    expect(mine.at(-1)).toMatchObject({ state: 'done' });
    expect(mine.at(-1)?.payload.expectedHead).toBe(head);
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

  it('GitLab 把令牌写进错误时，死行里也没有令牌', async () => {
    const { ws, s } = await glWorkspace('gl-leak');
    await saveGitlabToken(root, 'gitlab.com', GL_TOKEN);
    const leak = fakeGitlab({ leak: true });
    await expect(
      gitAct({ db: t.db, dataDir: root, gitlab: leak.fetch }, s, { op: 'pr', title: '漏' }),
    ).rejects.toThrow(/开 MR没成/);
    const mine = await sessionOps(ws.id, s.id);
    const dead = mine.find((o) => o.kind === 'change.pr.open' && o.state === 'dead');
    expect(dead).toBeTruthy();
    const raw = await t.pg.query<{ last_error: string | null; payload: string; result: string | null }>(
      'select last_error, payload::text as payload, result::text as result from fleet2.outbox where op_key = $1',
      [dead?.opKey],
    );
    const stored = JSON.stringify(raw.rows[0] ?? null);
    expect(stored).toContain('***');
    expect(stored).not.toContain(GL_TOKEN);
    expect(stored).not.toContain('gitlab-tokens');
    assertNoToken(mine);
    expect(leak.tokens).toContain(GL_TOKEN);
  });

  it('没登记的自建主机算本地，登记后面板按 GitLab 推', async () => {
    const remote = 'https://git.example.com/group/app.git';
    const { dir } = makeRepo('gl-self');
    git(dir, 'checkout', '-q', '-b', 'feature');
    git(dir, 'remote', 'set-url', 'origin', remote);
    const ws = await svc.addWorkspace('gl-self', dir);
    expect(ws.forge).toBe('local');
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    expect((await gitSnapshot({ db: t.db, dataDir: root }, s)).forge).toBe('local');
    await saveGitlabToken(root, 'git.example.com', GL_TOKEN);
    expect((await gitSnapshot({ db: t.db, dataDir: root }, s)).forge).toBe('gitlab');
    const fake = fakeGit({ remote });
    const out = await gitAct({ db: t.db, dataDir: root, run: fake.run }, s, { op: 'push' });
    if (!('notice' in out)) throw new Error('没有回执');
    expect(out.notice).toBe('已推送');
    expect(out.forge).toBe('gitlab');
    const push = fake.calls.find((c) => c.includes('push'));
    expect(push?.some((arg) => arg.startsWith('credential.helper='))).toBe(true);
    expect(push?.join(' ')).not.toContain(GL_TOKEN);
    assertNoToken(await sessionOps(ws.id, s.id));
    const hostsFile = readFileSync(gitlabHostsPath(root), 'utf8');
    expect(hostsFile).toContain('git.example.com');
    expect(hostsFile).not.toContain(GL_TOKEN);
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toContain(GL_TOKEN);
  });

  it('设置接口只说有没有令牌，不把令牌送回来', async () => {
    const host = 'settings-3944.example';
    const marker = 'panel-3944-settings-test';
    const saved = await fetch(`${base}/api/ade/gitlab-token`, {
      method: 'POST',
      headers: { [LOCAL_TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ host, token: marker }),
    });
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).not.toContain(marker);
    expect(JSON.parse(savedText)).toEqual({ host, hasToken: true });
    const listed = await fetch(`${base}/api/ade/gitlab-hosts`, { headers: { [LOCAL_TOKEN_HEADER]: TOKEN } });
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain(marker);
    const body = JSON.parse(listedText) as { hosts: { host: string; hasToken: boolean; builtin: boolean }[] };
    expect(body.hosts).toContainEqual({ host, hasToken: true, builtin: false });
    expect(body.hosts).toContainEqual(expect.objectContaining({ host: 'gitlab.com', builtin: true }));
    const hostsFile = readFileSync(gitlabHostsPath(root), 'utf8');
    expect(hostsFile).not.toContain(marker);
    const tokenFile = gitlabTokenPath(root, host);
    expect(readFileSync(tokenFile, 'utf8')).toBe(marker);
    expect(resolve(tokenFile).toLowerCase().startsWith(resolve(root).toLowerCase())).toBe(true);
    const gone = await fetch(`${base}/api/ade/gitlab-hosts/${encodeURIComponent(host)}`, {
      method: 'DELETE',
      headers: { [LOCAL_TOKEN_HEADER]: TOKEN },
    });
    expect(gone.status).toBe(200);
    const after = (await gone.json()) as { hosts: { host: string }[] };
    expect(after.hosts.some((row) => row.host === host)).toBe(false);
    expect(existsSync(tokenFile)).toBe(false);
  });
});
