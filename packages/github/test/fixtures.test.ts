// 录好的真返回（test/fixtures/github，真机验收时 --record 录的，已脱敏）回放一遍：
// 假服务的形状是照着理解写的，这里拿 GitHub 真回的东西走同一段代码，证明解析与判断对得上真世界。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateChecks } from '../src/checks.ts';
import { type AppRole, isBot } from '../src/credentials.ts';
import { createGitHub } from '../src/github.ts';
import { CommentSchema, EditsSchema, IssueSchema } from '../src/issues.ts';
import { memoryLedger } from '../src/ledger.ts';
import { PullSchema } from '../src/pulls.ts';
import { testApps } from './fake-github.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'github');
const fx = (name: string): unknown => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
const repo = { owner: 'acme', name: 'widgets' };

/** 真机器人的短名（夹具里的作者就是它们）。 */
function realApps() {
  const apps = testApps();
  return {
    agent: { ...apps.agent, slug: 'fleet-dao-agent' },
    engine: { ...apps.engine, slug: 'fleet-dao-engine' },
  } satisfies Record<AppRole, unknown>;
}

type Route = [method: string, path: RegExp, body: unknown, status?: number];

/** 按路径回放夹具；令牌那两个接口现编（夹具里一律不录令牌）。 */
function replay(routes: Route[]) {
  const calls: { method: string; path: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname });
    const reply = (status: number, body: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (/\/installation$/.test(url.pathname)) return reply(200, { id: 1 });
    if (/access_tokens$/.test(url.pathname)) {
      return reply(201, {
        token: 'ghs_replayreplayreplay',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: {},
      });
    }
    for (const [m, re, body, status] of routes) {
      if (m === method && re.test(url.pathname)) return reply(status ?? 200, body);
    }
    return reply(404, { message: `回放里没有 ${method} ${url.pathname}` });
  };
  const gh = createGitHub({
    ledger: memoryLedger({ repos: [{ id: 'r1', ...repo }] }),
    apps: realApps(),
    apiUrl: 'https://api.github.test',
    fetch: fetchImpl,
    now: () => new Date('2026-09-25T12:00:00Z'),
    sleep: async () => {},
    env: {},
  });
  return { gh, calls };
}

describe('夹具脱敏（公开仓）', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  const RULES: [string, RegExp][] = [
    ['邮箱', /[A-Za-z0-9._%+\-[\]]+@(?!example\.invalid\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
    ['IP', /\b(?!192\.0\.2\.)(?:\d{1,3}\.){3}\d{1,3}\b/g],
    ['令牌', /\b(?:ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9_]{8,}|\bgithub_pat_[A-Za-z0-9_]+/g],
    ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./g],
    ['App 的 client_id', /"client_id":\s*"(?!Iv1\.CLIENT_ID")[^"]+"/g],
    ['头像地址（带账号编号）', /avatars\.githubusercontent\.com/g],
  ];
  const leaks = (text: string) =>
    RULES.flatMap(([label, re]) => [...text.matchAll(re)].map((m) => `${label}：${m[0].slice(0, 60)}`));

  it('录了东西（没扫到不能当干净）', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it('每个文件都干净；作者只有占位账号、我们的两个机器人和 GitHub 自己的账号', () => {
    const allowed = new Set([
      'acme',
      'fleet-dao-agent[bot]',
      'fleet-dao-engine[bot]',
      'fleet-dao-engine',
      'fleet-dao-agent',
      'github',
      'web-flow',
    ]);
    const problems = files.flatMap((f) => {
      const text = readFileSync(join(DIR, f), 'utf8');
      const logins = [...text.matchAll(/"login":\s*"([^"]+)"/g)]
        .map((m) => m[1] ?? '')
        .filter((l) => !allowed.has(l));
      return [...leaks(text), ...logins.map((l) => `陌生账号 ${l}`)].map((p) => `${f} ${p}`);
    });
    expect(problems).toEqual([]);
  });

  it('故意放进去的违规样本都拦得住', () => {
    const samples = [
      'mail me: someone@corp.example.com',
      'host 10.2.3.4',
      'token ghs_abcdefghijklmnop',
      '"client_id": "Iv23liAbCdEf"',
      'https://avatars.githubusercontent.com/u/1?v=4',
    ];
    for (const s of samples) expect(leaks(s), s).not.toEqual([]);
  });
});

describe('真返回回放', () => {
  it('仓的事实与主线规则：默认分支、必过检查、只许 squash', async () => {
    const { gh } = replay([
      ['GET', /^\/repos\/acme\/widgets$/, fx('repo')],
      ['GET', /\/rules\/branches\/main$/, fx('rules')],
    ]);
    expect(await gh.deps.facts.get(repo)).toMatchObject({ defaultBranch: 'main', private: false });
    expect(await gh.deps.facts.branchRules(repo, 'main')).toEqual({
      requiredChecks: ['check'],
      mergeMethods: ['squash'],
    });
  });

  it('等 CI：真的 PR、检查、提交状态 → 绿', async () => {
    const pr = PullSchema.parse(fx('pull-open'));
    const { gh } = replay([
      ['GET', /\/rules\/branches\/main$/, fx('rules')],
      ['GET', /^\/repos\/acme\/widgets$/, fx('repo')],
      ['GET', /\/pulls\/\d+$/, fx('pull-open')],
      ['GET', /\/check-runs$/, fx('check-runs')],
      ['GET', /\/status$/, fx('commit-status')],
    ]);
    const res = await gh.waitCi({ repo, prNumber: pr.number, head: pr.head.sha });
    expect(res).toMatchObject({ state: 'green', checks: [{ name: 'check', state: 'success', attempts: 1 }] });
  });

  it('检查的形状：同一组数据直接判也是绿', () => {
    const runs = (fx('check-runs') as { check_runs: unknown[] }).check_runs;
    const statuses = (fx('commit-status') as { statuses: unknown[] }).statuses;
    expect(evaluateChecks(['check'], runs as never, statuses as never).overall).toBe('green');
  });

  it('合并重试：真的已合并 PR（引擎合的）→ 认下；分支已经没了（真 404）→ 当删掉了', async () => {
    const merged = PullSchema.parse(fx('pull-merged'));
    const { gh, calls } = replay([
      ['GET', /^\/repos\/acme\/widgets$/, fx('repo')],
      ['GET', /\/pulls\/\d+$/, fx('pull-merged')],
      ['GET', /\/git\/ref\/heads\//, fx('git-ref'), 404],
    ]);
    const res = await gh.mergePr({ repo, prNumber: merged.number, expectedHead: merged.head.sha });
    expect(res).toMatchObject({
      merged: true,
      alreadyMerged: true,
      mergedByEngine: true,
      branchDeleted: true,
    });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('issue、评论、编辑历史的形状；编辑历史最老的一条是原始正文，最新的一条就是现在的正文', () => {
    const issue = IssueSchema.parse(fx('issue'));
    expect(issue).toMatchObject({ state: 'closed', state_reason: 'completed' });
    const comment = CommentSchema.parse(fx('comment-created'));
    expect(comment.body).toMatch(/<!-- fleet:close:[0-9a-f]{16} -->$/);
    expect(isBot(realApps().engine, comment.user)).toBe(true);
    expect(CommentSchema.array().parse(fx('comments-list'))).toHaveLength(1);
    const edits =
      EditsSchema.parse((fx('issue-edits') as { data: unknown }).data).repository.issue?.userContentEdits
        .nodes ?? [];
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits[0]?.diff).toBe(issue.body);
    expect(edits.at(-1)?.diff).not.toContain('fleet:progress:start');
    // GraphQL 里机器人的 login 不带 [bot]，类型是 Bot
    expect(edits[0]?.editor).toMatchObject({ __typename: 'Bot', login: 'fleet-dao-engine' });
  });

  it('对账：真的 PR 列表 + 单张读（合并人）', async () => {
    const { gh } = replay([
      ['GET', /\/pulls$/, fx('pulls-list')],
      ['GET', /\/pulls\/\d+$/, fx('pull-merged')],
    ]);
    const report = await gh
      .reconciler({ intake: { ingest: async () => ({ verdict: 'duplicate' }) }, pollDeliveryId: () => '' })
      .auditMergedPrs('acme/widgets', new Date('2026-09-24T00:00:00Z'));
    expect(report.outcome).toBe('ok');
    expect(report.scanned).toBe(2);
    expect(report.problems.filter((p) => p.includes('不是「引擎」'))).toEqual([]);
  });

  it('投递日志：真的失败投递（ping 证书对不上）会被重投', async () => {
    const { gh, calls } = replay([
      ['GET', /^\/app\/hook\/deliveries$/, fx('deliveries')],
      ['POST', /^\/app\/hook\/deliveries\/\d+\/attempts$/, {}, 202],
    ]);
    const report = await gh
      .reconciler({ intake: { ingest: async () => ({ verdict: 'duplicate' }) }, pollDeliveryId: () => '' })
      .redeliverFailed(new Date(0));
    expect(report).toMatchObject({ outcome: 'ok', checked: 1, recovered: 1 });
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/attempts'))).toHaveLength(1);
  });

  it('自检：真的安装权限表', async () => {
    const { gh } = replay([['GET', /^\/app\/installations\/\d+$/, fx('installation')]]);
    const [, engine] = await gh.selfCheck([repo]);
    expect(engine).toMatchObject({ role: 'engine', ok: true, missing: [] });
  });

  it('机器人身份：提交邮箱用机器人的用户编号', async () => {
    const { gh } = replay([['GET', /^\/users\//, fx('bot-user')]]);
    const id = await gh.commitIdentity(repo);
    expect(id.email).toBe(`${id.userId}+fleet-dao-agent[bot]@users.noreply.github.com`);
    expect((fx('commit') as { author: { login: string } }).author.login).toBe('fleet-dao-agent[bot]');
  });

  it('互动限制：真的返回，离到期还早 → 不动', async () => {
    const { gh, calls } = replay([['GET', /interaction-limits$/, fx('interaction-limits')]]);
    expect(await gh.renewInteractionLimit({ repo })).toMatchObject({ action: 'fresh' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('合并接口的真回执', () => {
    expect(fx('merge')).toMatchObject({ merged: true, sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});
