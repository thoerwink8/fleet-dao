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

describe('pnpm work claim --takeover-pr：受管接手已有 PR 的停下的单', () => {
  const HEAD = 'a'.repeat(40);
  const PR = { number: 50, body: '**需求**：\nCloses #42\n', headRefName: 'fleet/42-tabcdef12' };
  const view = (over: Record<string, unknown> = {}) => ({
    number: 50,
    state: 'OPEN',
    headRefOid: HEAD,
    headRefName: 'fleet/42-tabcdef12',
    isCrossRepository: false,
    ...over,
  });
  const GOOD = {
    status: 200,
    body: {
      ok: true,
      taskId: 't1',
      state: 'running',
      executor: 'local',
      leaseUntil: '2026-10-14T12:00:00.000Z',
    },
  };
  const refusal = (code: string, message: string) => ({ status: 409, body: { error: { code, message } } });

  /** posts 按顺序给每次 POST 的回话（用完重复最后一个）；pulls / view 是 gh 的回话。 */
  function takeoverWorld(
    o: {
      pulls?: unknown[];
      view?: unknown | (() => unknown);
      posts?: ({ status: number; body: unknown } | Error)[];
      label?: GhResult;
    } = {},
  ) {
    const sent: LocalClaimRequest[] = [];
    const gh: string[][] = [];
    const out: string[] = [];
    const err: string[] = [];
    const sleeps: number[] = [];
    const posts = o.posts ?? [GOOD, GOOD];
    const run = (...argv: string[]) =>
      work(argv, {
        gh: async (args) => {
          gh.push(args);
          if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/app' }));
          if (args[0] === 'issue' && args[1] === 'view')
            return ok(JSON.stringify({ title: 'Fix it', state: 'OPEN' }));
          if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(o.pulls ?? [PR]));
          if (args[0] === 'pr' && args[1] === 'view') {
            const v = typeof o.view === 'function' ? (o.view as () => unknown)() : (o.view ?? view());
            return ok(JSON.stringify(v));
          }
          if (args[0] === 'issue' && args[1] === 'edit') return o.label ?? ok();
          return bad(`没想到的 gh：${args.join(' ')}`);
        },
        post: async (body) => {
          sent.push(body);
          const r = posts[Math.min(sent.length - 1, posts.length - 1)];
          if (r instanceof Error) throw r;
          if (!r) throw new Error('没设回话');
          return { status: r.status, text: JSON.stringify(r.body) };
        },
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        takeoverWait: {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          intervalMs: 5,
          attempts: 3,
        },
      });
    return { sent, gh, run, sleeps, text: () => [...out, ...err].join('\n') };
  }
  const args = ['claim', '42', '--takeover-pr', '50', '--head', HEAD];
  const pendingThenOk = [GOOD, refusal('takeover_pending', '原工作流还没确认结束'), GOOD];

  it('成功：精确身份发给后端 → 先登记 → 确认（含一次还没结束）→ 贴标签 → 才说可以继续，沿用原分支不开新 PR', async () => {
    const w = takeoverWorld({ posts: pendingThenOk });
    expect(await w.run(...args)).toBe(0);
    expect(w.sent).toEqual([
      { action: 'claim', repo: 'acme/app', issue: 42, title: 'Fix it', takeoverPr: { pr: 50, head: HEAD } },
      { action: 'takeover_confirm', repo: 'acme/app', issue: 42, takeoverPr: { pr: 50, head: HEAD } },
      { action: 'takeover_confirm', repo: 'acme/app', issue: 42, takeoverPr: { pr: 50, head: HEAD } },
    ]);
    expect(w.sleeps).toEqual([5]);
    expect(w.gh.some((a) => a.join(' ') === 'issue edit 42 --add-label 本机做')).toBe(true);
    expect(w.text()).toContain('fleet/42-tabcdef12');
    expect(w.text()).toContain('不要另开 PR');
  });

  it('【故意造出的失败】普通 claim 仍拒绝同单开放 PR；只给一半参数、短 head 也拒，什么都不发', async () => {
    const plain = takeoverWorld();
    expect(await plain.run('claim', '42')).toBe(1);
    expect(plain.sent).toEqual([]);
    for (const bad of [
      ['claim', '42', '--takeover-pr', '50'],
      ['claim', '42', '--head', HEAD],
      ['claim', '42', '--takeover-pr', '50', '--head', 'abc'],
      ['claim', '42', '--takeover-pr', 'x', '--head', HEAD],
      ['renew', '42', '--takeover-pr', '50', '--head', HEAD],
    ]) {
      const w = takeoverWorld();
      expect(await w.run(...bad)).toBe(1);
      expect(w.sent).toEqual([]);
    }
  });

  it('【故意造出的失败】本机侧身份对不上：换头、串仓（fork）、多 PR、PR 号不是它、分支不受管、缺字段：都拒，什么都不发', async () => {
    const cases: Parameters<typeof takeoverWorld>[0][] = [
      { view: view({ headRefOid: 'b'.repeat(40) }) },
      { view: view({ isCrossRepository: true }) },
      { view: view({ isCrossRepository: undefined }) },
      { view: view({ headRefOid: undefined }) },
      { view: view({ state: 'CLOSED' }) },
      { view: view({ headRefName: 'local/42-x' }) },
      { pulls: [PR, { number: 51, body: '**需求**：\nCloses #42\n', headRefName: 'feat/x' }] },
      { pulls: [{ ...PR, number: 51 }] },
      { pulls: [] },
    ];
    for (const c of cases) {
      const w = takeoverWorld(c);
      expect(await w.run(...args)).toBe(1);
      expect(w.sent).toEqual([]);
      expect(w.gh.some((a) => a[1] === 'edit')).toBe(false);
    }
  });

  it('【故意造出的失败】后端拒绝（活工人、引擎没停、PR 对不上）：原话照报，不确认、不贴标签', async () => {
    const w = takeoverWorld({ posts: [refusal('takeover_refused', '这张任务还有未结束的 run')] });
    expect(await w.run(...args)).toBe(1);
    expect(w.text()).toContain('未结束的 run');
    expect(w.sent).toHaveLength(1);
    expect(w.gh.some((a) => a[1] === 'edit')).toBe(false);
  });

  it('【故意造出的失败】确认一直 pending（原工作流终态晚到）：不贴标签、不说可继续，退出码 1 并写明可重跑', async () => {
    const w = takeoverWorld({ posts: [GOOD, refusal('takeover_pending', '原工作流还没确认结束')] });
    expect(await w.run(...args)).toBe(1);
    expect(w.sent.map((s) => s.action)).toEqual([
      'claim',
      'takeover_confirm',
      'takeover_confirm',
      'takeover_confirm',
    ]);
    expect(w.text()).toContain('交接未完成');
    expect(w.text()).toContain('重跑同一条命令');
    expect(w.text()).not.toContain('接手了 #42');
    expect(w.gh.some((a) => a[1] === 'edit')).toBe(false);
  });

  it('【故意造出的失败】发送已收但回执丢失（断线）：写「结果未知」，责任保留；重跑同一命令复核成功，不新起工人', async () => {
    const lost = takeoverWorld({ posts: [new Error('ECONNRESET')] });
    expect(await lost.run(...args)).toBe(1);
    expect(lost.text()).toContain('结果未知');
    expect(lost.text()).toContain('重跑同一条命令');
    expect(lost.gh.some((a) => a[1] === 'edit')).toBe(false);
    // 重跑：后端把它当同一次接手，只续租并确认
    const again = takeoverWorld({ posts: [GOOD, GOOD] });
    expect(await again.run(...args)).toBe(0);
  });

  it('【故意造出的失败】确认通过后断线 / 贴标签失败：不宣称完成；重跑补上', async () => {
    const dropped = takeoverWorld({ posts: [GOOD, new Error('ECONNRESET')] });
    expect(await dropped.run(...args)).toBe(1);
    expect(dropped.text()).toContain('交接未完成');
    const label = takeoverWorld({ label: bad('HTTP 502') });
    expect(await label.run(...args)).toBe(1);
    expect(label.text()).toContain('没贴上');
    expect(label.text()).not.toContain('接手了 #42');
  });

  it('【故意造出的失败】确认后 PR 又换头：不贴标签、不宣称完成', async () => {
    let n = 0;
    const w = takeoverWorld({ view: () => view(n++ === 0 ? {} : { headRefOid: 'c'.repeat(40) }) });
    expect(await w.run(...args)).toBe(1);
    expect(w.text()).toContain('对不上');
    expect(w.gh.some((a) => a[1] === 'edit')).toBe(false);
  });
});
