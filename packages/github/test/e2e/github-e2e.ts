// 真机验收：在巡检仓上走一遍 开 issue → 开分支 → 推一个提交 → 开 PR → 等 CI → 合并 → 更新 issue 进度段 → 关单，
// 每一步都用这个包的真实现、真 GitHub、真凭据，并核对回读（作者、头、合并人、正文、state_reason）。
//
// 在法国 VPS 上以引擎的运行用户跑（凭据只有它读得到）：
//   node packages/github/test/e2e/github-e2e.ts --repo <owner>/fleet-dao-canary [--record <目录>]
// 凭据从 /etc/fleet-dao/github 读（FLEET_GITHUB_APP_DIR 可改）；幂等账用内存里的 Postgres（PGlite，跑真迁移），不碰生产库。
// 只写巡检仓：一张 issue（最后关掉）、一个分支（合并后删掉）、主线上一个改 README 的小提交。别的仓一个字不写。
// --record：把用到的 GitHub 返回脱敏后存成测试夹具（令牌那一类接口一律不录）。
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repos } from '@fleet-dao/db';
import { createTestDb } from '@fleet-dao/db/testing';
import {
  createGitHub,
  type GitHub,
  isBot,
  parseRepoSlug,
  pgLedger,
  pgLocker,
  redact,
  repoSlug,
} from '../../src/index.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repoArg = flag('--repo');
const recordDir = flag('--record');
if (!repoArg) {
  console.error(
    '用法：node packages/github/test/e2e/github-e2e.ts --repo <owner>/fleet-dao-canary [--record <目录>]',
  );
  process.exit(2);
}
const repo = parseRepoSlug(repoArg);
if (!/canary/i.test(repo.name)) {
  console.error(`只许在巡检仓上跑（仓名里要有 canary），现在是 ${repoSlug(repo)}`);
  process.exit(2);
}

// —— 录夹具（脱敏）——
const recorded = new Map<string, unknown>();
function fixtureName(method: string, path: string, data: unknown): string | null {
  const p = path.replace(/^\/repos\/[^/]+\/[^/]+/, '/R');
  if (/access_tokens$/.test(p)) return null; // 令牌，一律不录
  const merged = (data as { merged?: boolean } | null)?.merged;
  const rules: [RegExp, string][] = [
    [/^GET \/R$/, 'repo'],
    [/^GET \/R\/rules\/branches\/.+$/, 'rules'],
    [/^GET \/R\/pulls$/, 'pulls-by-branch'],
    [/^POST \/R\/pulls$/, 'pull-created'],
    [/^GET \/R\/pulls\/\d+$/, merged ? 'pull-merged' : 'pull-open'],
    [/^GET \/R\/commits\/[0-9a-f]+\/check-runs$/, 'check-runs'],
    [/^GET \/R\/commits\/[0-9a-f]+\/status$/, 'commit-status'],
    [/^GET \/R\/commits\/[0-9a-f]+$/, 'commit'],
    [/^GET \/R\/actions\/runs$/, 'workflow-runs'],
    [/^GET \/R\/compare\/.+$/, 'compare'],
    [/^PUT \/R\/pulls\/\d+\/merge$/, 'merge'],
    [/^GET \/R\/issues\/\d+$/, 'issue'],
    [/^PATCH \/R\/issues\/\d+$/, 'issue-patched'],
    [/^POST \/R\/issues\/\d+\/comments$/, 'comment-created'],
    [/^GET \/R\/issues\/\d+\/comments$/, 'comments'],
    [/^GET \/R\/interaction-limits$/, 'interaction-limits'],
    [/^GET \/R\/git\/ref\/heads\/.+$/, 'git-ref'],
    [/^POST \/graphql$/, 'graphql'],
    [/^GET \/users\/.+$/, 'bot-user'],
    [/^GET \/app\/installations\/\d+$/, 'installation'],
    [/^GET \/app\/hook\/deliveries$/, 'deliveries'],
  ];
  const key = `${method} ${p}`;
  for (const [re, name] of rules) if (re.test(key)) return name;
  return null;
}

const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!recordDir) return res;
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const data = await res
      .clone()
      .json()
      .catch(() => null);
    const gql =
      url.pathname === '/graphql' && typeof init?.body === 'string' && init.body.includes('userContentEdits');
    const name =
      url.pathname === '/graphql'
        ? gql
          ? 'issue-edits'
          : null
        : fixtureName(init?.method ?? 'GET', url.pathname, data);
    if (name && data !== null) recorded.set(name, data);
  } catch {
    // 录不成不影响验收
  }
  return res;
};

const idMap = new Map<number, number>();
function sanitize(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    let s = redact(value)
      .replace(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
        'someone@example.invalid',
      )
      .replace(new RegExp(repo.owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'acme')
      .replace(new RegExp(repo.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'widgets');
    if (key === 'node_id' || key === 'id' || key === 'pullRequestId')
      s = s.replace(/^[A-Za-z_]+[A-Za-z0-9_=-]{6,}$/, 'NODE_ID');
    return s;
  }
  if (typeof value === 'number') {
    if (/(^|_)id$|Id$|^id$/.test(key) && value >= 1000) {
      if (!idMap.has(value)) idMap.set(value, 1000 + idMap.size);
      return idMap.get(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'avatar_url' || k === 'gravatar_id') continue;
      out[k] = sanitize(v, k);
    }
    return out;
  }
  return value;
}

// —— 验收 ——
interface StepResult {
  step: string;
  ok: boolean;
  ms: number;
  detail: string;
}
const results: StepResult[] = [];
async function step<T>(
  name: string,
  fn: () => Promise<T>,
  check: (v: T) => string | null = () => null,
): Promise<T> {
  const started = Date.now();
  try {
    const v = await fn();
    const problem = check(v);
    results.push({ step: name, ok: problem === null, ms: Date.now() - started, detail: problem ?? brief(v) });
    console.log(
      `${problem === null ? '✓' : '✗'} ${name}（${Date.now() - started} ms）${problem ? `：${problem}` : ''}`,
    );
    if (problem) throw new Error(`${name}：${problem}`);
    return v;
  } catch (err) {
    if (!results.some((r) => r.step === name)) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ step: name, ok: false, ms: Date.now() - started, detail: msg });
      console.log(`✗ ${name}（${Date.now() - started} ms）：${msg}`);
    }
    throw err;
  }
}
function brief(v: unknown): string {
  const s = JSON.stringify(v) ?? '';
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

const root = mkdtempSync(join(tmpdir(), 'fleet-gh-e2e-'));
const t = await createTestDb();
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

let gh: GitHub | undefined;
let issueNumber: number | undefined;
let exitCode = 0;
const started = new Date();
try {
  await t.db.insert(repos).values({ owner: repo.owner, name: repo.name, testCommand: 'node --test' });
  const github = createGitHub({
    ledger: pgLedger(t.db),
    locker: pgLocker(t.db),
    fetch: recordingFetch,
    stateDir: join(root, 'state'),
    log: {
      info: (m, f) => console.log(`  · ${m}`, f ? JSON.stringify(f) : ''),
      warn: (m, f) => console.log(`  ! ${m}`, f ? JSON.stringify(f) : ''),
      error: (m, f) => console.log(`  ✗ ${m}`, f ? JSON.stringify(f) : ''),
    },
  });
  gh = github;
  const client = github.client;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const branch = `fleet-e2e/github-${stamp}`;

  await step(
    '自检：两个机器人在巡检仓上的权限',
    () => github.selfCheck([repo]),
    (r) => {
      const bad = r.filter((x) => !x.ok);
      return bad.length
        ? bad.map((x) => `${x.role} ${x.why ?? `缺 ${x.missing.join('、')}`}`).join('；')
        : null;
    },
  );

  await step('互动限制：读到期时间（不足 30 天才续）', () => github.renewInteractionLimit({ repo }));

  await step('App 投递日志读得到（只读）', async () => {
    const res = await client.request({
      method: 'GET',
      path: '/app/hook/deliveries',
      auth: { as: 'app', role: 'engine' },
      query: { per_page: 1 },
    });
    return { status: res.status };
  });

  // 1. 开一张 issue（「引擎」机器人）
  const humanPart = `原话：真机验收 ${stamp}（验收脚本自动开的，跑完自己关）\nAI 理解：在 README 末尾加一行时间`;
  const issue = await step(
    '开 issue（引擎）',
    async () => {
      const res = await client.request<{ number: number; user: { login: string; type: string } }>({
        method: 'POST',
        path: `/repos/${repo.owner}/${repo.name}/issues`,
        auth: { as: 'engine', repo },
        body: { title: `巡检：GitHub 包真机验收 ${stamp}`, body: humanPart },
      });
      return res.data;
    },
    (d) => (isBot(github.client.apps.engine, d.user) ? null : `作者是 ${d.user.login}，不是引擎机器人`),
  );
  issueNumber = issue.number;

  // 2. 开分支、提交（引擎建树的做法：从最新主线起，提交身份是「干活的」机器人）
  const identity = await step('查「干活的」机器人的提交身份', () => github.commitIdentity(repo));
  const clone = join(root, 'clone');
  git(root, 'clone', '-q', `https://github.com/${repo.owner}/${repo.name}.git`, clone);
  const tree = join(root, 'tree');
  git(clone, 'worktree', 'add', '-q', '-b', branch, tree, 'origin/main');
  appendFileSync(join(tree, 'README.md'), `\n<!-- 真机验收 ${stamp} -->\n`);
  git(tree, 'add', 'README.md');
  git(
    tree,
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
    'commit',
    '-q',
    '-m',
    `巡检：真机验收 ${stamp}`,
  );
  const head = git(tree, 'rev-parse', 'HEAD');

  // 3. 推（会话外，「干活的」机器人）
  await step(
    '推分支（干活的）',
    () => github.pushBranch({ repo, worktreePath: tree, branch, head }),
    (r) => (r.pushed && r.head === head ? null : `pushed=${r.pushed} head=${r.head}`),
  );
  await step(
    '推两次：第二次什么都不做',
    () => github.pushBranch({ repo, worktreePath: tree, branch, head }),
    (r) => (r.pushed ? '又推了一次' : null),
  );
  await step(
    'A4：提交挂在「干活的」机器人名下',
    async () => {
      const res = await client.request<{ author: { login: string } | null }>({
        method: 'GET',
        path: `/repos/${repo.owner}/${repo.name}/commits/${head}`,
        auth: { as: 'engine', repo },
      });
      return res.data.author?.login ?? null;
    },
    (login) => (login === identity.login ? null : `author=${login}`),
  );

  // 4. 开 PR（「干活的」机器人），再开一次不会多一张
  const pr = await step(
    '开 PR（干活的）',
    () =>
      github.openPr({
        repo,
        branch,
        head,
        title: `巡检：真机验收 ${stamp}`,
        body: {
          requirement: issue.number,
          subtask: 'A README 加一行',
          did: ['README 末尾加一行验收时间（HTML 注释，不影响显示）'],
          verified: ['CI 的 check（node --test）'],
        },
      }),
    (r) => (r.created && r.headMatches ? null : `created=${r.created} headMatches=${r.headMatches}`),
  );
  await step(
    '再开一次：拿回同一张，不开新的',
    () => github.openPr({ repo, branch, head, title: 'x', body: 'x' }),
    (r) => (r.number === pr.number && !r.created ? null : `number=${r.number} created=${r.created}`),
  );

  // 5. 等 CI
  await step(
    '等 CI（按主线规则集里的必过检查）',
    () => github.waitCi({ repo, prNumber: pr.number, head, pollMs: 10_000 }, { heartbeat: () => undefined }),
    (r) => (r.state === 'green' ? null : `${r.state}：${'detail' in r ? r.detail : ''}`),
  );

  // 6. 合并（「引擎」机器人）
  await step(
    '合并（引擎，squash，带头约束）',
    () => github.mergePr({ repo, prNumber: pr.number, expectedHead: head }),
    (r) => (r.merged && r.mergedByEngine && r.branchDeleted ? null : brief(r)),
  );
  await step(
    '合并重试：认下已合并，不再合',
    () => github.mergePr({ repo, prNumber: pr.number, expectedHead: head }),
    (r) => (r.merged && r.alreadyMerged ? null : brief(r)),
  );
  await step(
    '分支已删',
    async () => {
      const out = git(
        root,
        'ls-remote',
        `https://github.com/${repo.owner}/${repo.name}.git`,
        `refs/heads/${branch}`,
      );
      return out;
    },
    (out) => (out ? `远端还在：${out}` : null),
  );

  // 7. 更新 issue 进度段（「引擎」机器人）：人写的部分原样
  const progress = {
    state: 'running',
    current: '写结果文档',
    done: 1,
    total: 1,
    subtasks: [{ key: 'A', title: 'README 加一行', state: 'merged', prNumber: pr.number }],
    docs: {},
  };
  await step(
    '更新 issue 进度段',
    () => github.updateIssueProgress({ repo, issueNumber: issue.number, progress }),
    (r) => (r.outcome === 'written' && r.verified && !r.restoredHumanEdit ? null : brief(r)),
  );
  await step(
    '同样的进度再写：不动',
    () => github.updateIssueProgress({ repo, issueNumber: issue.number, progress }),
    (r) => (r.outcome === 'unchanged' ? null : brief(r)),
  );
  await step(
    '第二版进度（完成）',
    () =>
      github.updateIssueProgress({
        repo,
        issueNumber: issue.number,
        progress: { ...progress, state: 'done', current: '' },
      }),
    (r) => (r.outcome === 'written' && r.verified ? null : brief(r)),
  );
  await step(
    '人写的部分一字没动',
    async () => {
      const res = await client.request<{ body: string }>({
        method: 'GET',
        path: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
        auth: { as: 'engine', repo },
      });
      return res.data.body;
    },
    (body) =>
      body.replace(/\r\n/g, '\n').startsWith(`${humanPart}\n\n<!-- fleet:progress:start`) &&
      body.includes('已完成')
        ? null
        : '正文不对',
  );

  // 8. 关单（写明去向），重试不多发评论
  const closeInput = {
    repo,
    issueNumber: issue.number,
    reason: 'completed' as const,
    comment: `已完成：PR #${pr.number} 已合并（真机验收脚本关单）。`,
  };
  await step(
    '关单（写明去向）',
    () => github.closeIssue(closeInput),
    (r) => (r.commentCreated ? null : brief(r)),
  );
  await step(
    '关单重试：不多发评论',
    () => github.closeIssue(closeInput),
    (r) => (!r.commentCreated && r.alreadyClosed ? null : brief(r)),
  );
  issueNumber = undefined;

  // 9. 对账：合并的 PR 都记了、都是「引擎」合的
  await step(
    '对账：合并的 PR',
    () =>
      github
        .reconciler({ intake: { ingest: async () => ({ verdict: 'duplicate' }) }, pollDeliveryId: () => '' })
        .auditMergedPrs(repoSlug(repo), started),
    (r) => {
      const byOther = r.problems.filter((p) => p.includes('不是「引擎」'));
      return r.outcome === 'ok' && byOther.length === 0 ? null : brief(r);
    },
  );
} catch (err) {
  exitCode = 1;
  if (!(err instanceof Error && results.some((r) => err.message.startsWith(r.step)))) {
    console.log(`✗ 中断：${err instanceof Error ? err.message : String(err)}`);
  }
} finally {
  // 收尾：验收开的 issue 没走到关单就关掉（写明原因）
  if (gh && issueNumber !== undefined) {
    await gh
      .closeIssue({ repo, issueNumber, reason: 'not_planned', comment: '真机验收中途失败，脚本收尾关单。' })
      .catch((e: unknown) => console.log(`  ! 收尾关单失败：${String(e)}`));
  }
  await t.close();
  rmSync(root, { recursive: true, force: true });
}

if (recordDir) {
  mkdirSync(recordDir, { recursive: true });
  for (const [name, data] of recorded) {
    writeFileSync(join(recordDir, `${name}.json`), `${JSON.stringify(sanitize(data), null, 2)}\n`);
  }
  // 录完自查：真账号名、真编号一个都不许留
  for (const name of recorded.keys()) {
    const text = readFileSync(join(recordDir, `${name}.json`), 'utf8');
    const leaks = [
      text.toLowerCase().includes(repo.owner.toLowerCase()) ? '账号名' : '',
      ...[...idMap.keys()].filter((id) => new RegExp(`\\b${id}\\b`).test(text)).map((id) => `编号 ${id}`),
    ].filter(Boolean);
    if (leaks.length) {
      console.log(`✗ 夹具 ${name}.json 没脱干净：${leaks.join('、')}（已删除）`);
      rmSync(join(recordDir, `${name}.json`));
      exitCode = 1;
    }
  }
  console.log(`夹具写到 ${recordDir}（${recorded.size} 个）`);
}

const total = results.reduce((a, r) => a + r.ms, 0);
console.log(
  `\n结果：${results.filter((r) => r.ok).length}/${results.length} 步通过，合计 ${Math.round(total / 1000)} 秒`,
);
console.log(JSON.stringify({ repo: repoSlug(repo), started: started.toISOString(), results }, null, 2));
process.exit(exitCode || (results.every((r) => r.ok) ? 0 : 1));
