// 本机领单（决定 0096）：pnpm work claim|renew|done 和两条线共用的「这张单有没有别的 PR 在做」认法（pr-claims.ts）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_CLAIMS_PATH, TASK_EXECUTORS, WEB_API_PREFIX } from '@fleet-dao/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BranchExecutor, issueOfBranch, localBranchPrefix } from '../src/issue-branch.ts';
import type { GhResult } from '../src/issue-new.ts';
import { otherPrOnIssue, prClaimedIssues } from '../src/pr-claims.ts';
import {
  branchSlug,
  CLAIMS_URL_PATH,
  type LocalClaimRequest,
  readClaimsEndpoint,
  work,
} from '../src/work.ts';

describe('零安装区自带的几份和 shared 对得上', () => {
  it('领单路径、执行者取值', () => {
    expect(CLAIMS_URL_PATH).toBe(`${WEB_API_PREFIX}${LOCAL_CLAIMS_PATH}`);
    const executors: readonly BranchExecutor[] = TASK_EXECUTORS;
    expect(executors).toEqual(['engine', 'local']);
  });
});

describe('issueOfBranch：分支的固定前缀', () => {
  it('fleet/<单号>- 是引擎，local/<单号>- 是本机；别的认不出', () => {
    expect(issueOfBranch('fleet/12-tabcdef12')).toEqual({ executor: 'engine', issue: 12 });
    expect(issueOfBranch(`${localBranchPrefix(34)}fix-login`)).toEqual({ executor: 'local', issue: 34 });
    for (const ref of ['rethink/a2', 'local/x-1', 'local/0-a', 'fleet/12', 'main']) {
      expect(issueOfBranch(ref)).toBeNull();
    }
  });
});

const ok = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr });

describe('pr-claims：一张单有没有开着的 PR 在做', () => {
  const pulls = [
    { number: 12, body: '**需求**：\nCloses #7\n', headRef: 'feat/a' },
    { number: 13, body: '**需求**：\nRefs #8\n', headRef: 'slice' },
    { number: 14, body: '', headRef: 'local/9-fix' },
    { number: 15, body: '', headRef: 'fleet/10-tabcdef12' },
  ];

  it('拉单的挂单表：需求栏 Closes / Refs 和固定前缀分支都算', () => {
    expect(prClaimedIssues(pulls)).toEqual(
      new Map([
        [7, 12],
        [8, 13],
        [9, 14],
        [10, 15],
      ]),
    );
  });

  it('开 PR 前的围栏：Closes 和固定前缀算；Refs（母单分片）不算；自己这条分支不算', () => {
    expect(otherPrOnIssue(pulls, 7, null)).toBe(12);
    expect(otherPrOnIssue(pulls, 7, 'feat/a')).toBeNull();
    expect(otherPrOnIssue(pulls, 8, null)).toBeNull();
    expect(otherPrOnIssue(pulls, 9, 'local/9-other')).toBe(14);
    expect(otherPrOnIssue(pulls, 10, null)).toBe(15);
    expect(otherPrOnIssue(pulls, 99, null)).toBeNull();
  });
});

describe('branchSlug：分支名里的短名', () => {
  it('取字母数字，最多 30 个字符；一个都没有用 work', () => {
    expect(branchSlug('Fix login: add captcha')).toBe('fix-login-add-captcha');
    expect(branchSlug('本机领单租约')).toBe('work');
    expect(branchSlug('a'.repeat(40)).length).toBe(30);
  });
});

const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv('GH_REPO', '');
  vi.stubEnv('GITHUB_REPOSITORY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readClaimsEndpoint：法国地址和通行证从本机会话上报的配置读', () => {
  it('读得到就回 url、token', () => {
    const home = mkdtempSync(join(tmpdir(), 'work-home-'));
    dirs.push(home);
    mkdirSync(join(home, '.fleet-dao', 'local-sessions'), { recursive: true });
    writeFileSync(
      join(home, '.fleet-dao', 'local-sessions', 'config.json'),
      JSON.stringify({ url: 'http://fr:8080', token: 't' }),
    );
    expect(readClaimsEndpoint(home)).toEqual({ url: 'http://fr:8080', token: 't' });
  });

  it('【故意造出的失败】没配：抛错写明怎么装，不当成有', () => {
    const home = mkdtempSync(join(tmpdir(), 'work-home-'));
    dirs.push(home);
    expect(() => readClaimsEndpoint(home)).toThrow(/local-sessions install/);
  });
});

/** gh 的回话按命令认；post 记下发给法国的每一条。 */
function world(o: { pulls?: unknown[]; post?: { status: number; body: unknown }; issueState?: string } = {}) {
  const gh: string[][] = [];
  const sent: LocalClaimRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    work(argv, {
      gh: async (args) => {
        gh.push(args);
        if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/app' }));
        if (args[0] === 'issue' && args[1] === 'view') {
          return ok(JSON.stringify({ title: 'Add captcha', state: o.issueState ?? 'OPEN' }));
        }
        if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(o.pulls ?? []));
        if (args[0] === 'issue' && args[1] === 'edit') return ok();
        return bad(`没想到的 gh：${args.join(' ')}`);
      },
      post: async (body) => {
        sent.push(body);
        const r = o.post ?? {
          status: 200,
          body: {
            ok: true,
            taskId: 't1',
            state: 'running',
            executor: 'local',
            leaseUntil: '2026-10-14T12:00:00.000Z',
          },
        };
        return { status: r.status, text: JSON.stringify(r.body) };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return { gh, sent, out, err, run, text: () => [...out, ...err].join('\n') };
}

describe('pnpm work：本机领单、续租、结束', () => {
  it('claim：查过没有别的 PR → 登记进法国 → 贴「本机做」→ 打出分支名 local/<单号>-<短名>', async () => {
    const w = world();
    expect(await w.run('claim', '42')).toBe(0);
    expect(w.sent).toEqual([{ action: 'claim', repo: 'acme/app', issue: 42, title: 'Add captcha' }]);
    expect(w.gh.some((a) => a.join(' ') === 'issue edit 42 --add-label 本机做')).toBe(true);
    expect(w.text()).toContain('local/42-add-captcha');
  });

  it('【故意造出的失败】已经有开着的 PR 在做（Closes 或固定前缀分支）：不登记、不贴标签，退出码 1', async () => {
    const w = world({ pulls: [{ number: 77, body: '', headRefName: 'fleet/42-tabcdef12' }] });
    expect(await w.run('claim', '42')).toBe(1);
    expect(w.sent).toEqual([]);
    expect(w.text()).toContain('#77');
  });

  it('【故意造出的失败】法国说引擎在做（409）：退出码 1，原话照报，不贴标签', async () => {
    const w = world({
      post: { status: 409, body: { error: { code: 'engine_has_it', message: '法国引擎手上有这张单' } } },
    });
    expect(await w.run('claim', '42')).toBe(1);
    expect(w.text()).toContain('法国引擎手上有这张单');
    expect(w.text()).toContain('停下等人的单 claim 会自己接手');
    expect(w.gh.some((a) => a[1] === 'edit')).toBe(false);
  });

  it('【故意造出的失败】法国没回：退出码 1，写「没登记上」，不当成领到了', async () => {
    const w = world();
    const code = await work(['claim', '42'], {
      gh: async (args) =>
        args[0] === 'repo'
          ? ok(JSON.stringify({ nameWithOwner: 'acme/app' }))
          : args[1] === 'view'
            ? ok(JSON.stringify({ title: 'x', state: 'OPEN' }))
            : ok('[]'),
      post: async () => {
        throw new Error('ECONNREFUSED');
      },
      out: (l) => w.out.push(l),
      err: (l) => w.err.push(l),
    });
    expect(code).toBe(1);
    expect(w.text()).toContain('没登记上');
  });

  it('【故意造出的失败】单已关：不领', async () => {
    const w = world({ issueState: 'CLOSED' });
    expect(await w.run('claim', '42')).toBe(1);
    expect(w.sent).toEqual([]);
  });

  it('done：默认记做完；--release 放手并摘「本机做」；--failed 记没做成', async () => {
    const done = world();
    expect(await done.run('done', '42')).toBe(0);
    expect(done.sent).toEqual([{ action: 'finish', repo: 'acme/app', issue: 42, outcome: 'done' }]);

    const released = world({
      post: {
        status: 200,
        body: { ok: true, taskId: 't1', state: 'stopped', executor: 'engine', leaseUntil: null },
      },
    });
    expect(await released.run('done', '42', '--release', '要法国做')).toBe(0);
    expect(released.sent[0]).toEqual({
      action: 'finish',
      repo: 'acme/app',
      issue: 42,
      outcome: 'released',
      reason: '要法国做',
    });
    expect(released.gh.some((a) => a.join(' ') === 'issue edit 42 --remove-label 本机做')).toBe(true);

    const failed = world();
    expect(await failed.run('done', '42', '--failed', '测不过')).toBe(0);
    expect(failed.sent[0]).toMatchObject({ outcome: 'failed', reason: '测不过' });
  });

  it('renew：续租', async () => {
    const w = world();
    expect(await w.run('renew', '42')).toBe(0);
    expect(w.sent).toEqual([{ action: 'renew', repo: 'acme/app', issue: 42 }]);
  });

  it('【故意造出的失败】用法不对：退出码 1，什么也不发', async () => {
    for (const argv of [
      [],
      ['grab', '1'],
      ['claim', 'x'],
      ['done', '1', '--failed', 'a', '--release', 'b'],
    ]) {
      const w = world();
      expect(await w.run(...argv)).toBe(1);
      expect(w.sent).toEqual([]);
    }
  });
});

describe('显式目标仓：work 识仓带上 GH_REPO，对不上就不登记', () => {
  const lease = {
    ok: true,
    taskId: 't1',
    state: 'running',
    executor: 'local',
    leaseUntil: '2026-10-14T12:00:00.000Z',
  };
  async function run(
    argv: string[],
    gh: (args: string[]) => Promise<GhResult>,
    env: Record<string, string | undefined>,
  ) {
    const sent: LocalClaimRequest[] = [];
    const calls: string[][] = [];
    const err: string[] = [];
    const code = await work(argv, {
      env,
      gh: async (args) => {
        calls.push(args);
        return gh(args);
      },
      post: async (body) => {
        sent.push(body);
        return { status: 200, text: JSON.stringify(lease) };
      },
      out: () => {},
      err: (l) => err.push(l),
    });
    return { code, sent, calls, text: () => err.join('\n') };
  }

  it('relay 上显式 GH_REPO：repo view 带位置仓名，claim / renew 登记这一个仓', async () => {
    const gh = async (args: string[]) => {
      if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'thoerwink8/fleet-dao' }));
      if (args[1] === 'view') return ok(JSON.stringify({ title: 'Add captcha', state: 'OPEN' }));
      if (args[0] === 'pr') return ok('[]');
      if (args[1] === 'edit') return ok();
      return bad(`没想到的 gh：${args.join(' ')}`);
    };
    const env = { GH_REPO: 'thoerwink8/fleet-dao' };
    const claim = await run(['claim', '42'], gh, env);
    expect(claim.code).toBe(0);
    expect(claim.calls[0]).toEqual(['repo', 'view', 'thoerwink8/fleet-dao', '--json', 'nameWithOwner']);
    expect(claim.sent).toEqual([
      { action: 'claim', repo: 'thoerwink8/fleet-dao', issue: 42, title: 'Add captcha' },
    ]);
    const renew = await run(['renew', '42'], gh, env);
    expect(renew.code).toBe(0);
    expect(renew.sent).toEqual([{ action: 'renew', repo: 'thoerwink8/fleet-dao', issue: 42 }]);
  });

  it('【故意造出的失败】回了另一个仓、gh 没读成、目标仓非法：不登记，也不把没读到当成这个仓', async () => {
    const mismatch = await run(
      ['claim', '42'],
      async (args) =>
        args[0] === 'repo' ? ok(JSON.stringify({ nameWithOwner: 'acme/app' })) : bad('不该问到'),
      { GH_REPO: 'thoerwink8/fleet-dao' },
    );
    expect(mismatch.code).toBe(1);
    expect(mismatch.sent).toEqual([]);
    expect(mismatch.text()).toContain('不改记到回的那个仓');
    expect(mismatch.text()).not.toContain('acme/app 已');

    const unread = await run(['renew', '42'], async () => bad('HTTP 502'), {
      GH_REPO: 'thoerwink8/fleet-dao',
    });
    expect(unread.code).toBe(1);
    expect(unread.sent).toEqual([]);
    expect(unread.text()).toContain('没读成');

    const empty = await run(['claim', '42'], async () => ok('{}'), { GH_REPO: 'thoerwink8/fleet-dao' });
    expect(empty.code).toBe(1);
    expect(empty.sent).toEqual([]);
    expect(empty.text()).toContain('认不出');

    const illegal = await run(['claim', '42'], async () => ok(JSON.stringify({ nameWithOwner: 'o/r' })), {
      GH_REPO: 'not a repo',
    });
    expect(illegal.code).toBe(1);
    expect(illegal.sent).toEqual([]);
    expect(illegal.calls).toEqual([]);
    expect(illegal.text()).toContain('不是 owner/name');
  });
});
