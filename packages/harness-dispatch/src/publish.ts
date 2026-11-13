// 真执行的发布（#3783，第 7 片，决定 0124）：工人交回后，内核经 outbox 把补丁推成分支、开 PR。不合并。
// 一条线：交回抓到补丁 → recordPublish（记 publish_runs，该推的排 change.push）→ processOutbox 领到期的动作 →
// 先核所有权令牌（旧库 tasks.fencing，对不上进 dead 不做）→ 执行 → 查证 → 写结果。
// 每一步都先看外面已经有什么再动手（预留、执行、查证）：分支在不在、这个分支有没有 PR、这张单有没有别的开着的 PR。
// 所以崩了重来、响应丢了结果不知道（unknown）、两个领取者撞上，都不会推第二次、开第二个 PR（旧坑 S4、GH1、GH2、GH3）。
// 工人整个过程拿不到任何 GitHub 凭据：补丁只存库里，推送由内核在自己建的临时目录里做，认证头只放进那条 git 命令的环境变量。
// GitHub 上只有推分支和开 PR 两种处理器（change.push / change.pr.open，过渡期仍认旧名）；合并、评论没有。
// forge=local 不连平台，把补丁写成文件；forge=gitlab 直接失败。缺省 forge 按 github。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendToStream } from '@fleet-dao/harness-api';
import {
  type Forge,
  forgeOf,
  issueStream,
  type OutboxKind,
  opKey,
  type TaskRef,
} from '@fleet-dao/harness-contract';
import { makeRedactor, type Redactor } from '@fleet-dao/harness-runner';
import {
  checkFencing,
  claimDueOps,
  completeOp,
  type Db,
  enqueueOp,
  failOp,
  getPublishRun,
  LostClaimError,
  markUnknown,
  type OutboxOp,
  type PublishRun,
  recordPublishRun,
  releaseOp,
} from '@fleet-dao/harness-store';
import { WORKER_BASE_KEYS } from '@fleet-dao/harness-workers';
import { type CommandResult, type CommandSpec, runCommand } from './command.ts';
import { GitHubDefiniteError, type GitHubWriter, type PrInfo } from './github-write.ts';
import type { RealTarget } from './prompt.ts';

/**
 * 装了 GitHub 处理器的种类：新名和过渡期旧名的「推分支、开 PR」。
 * 合并、评论不在里面（装了影子自检就不过）。local / gitlab 在 processOutbox 里另走，不算装了 GitHub 处理器。
 */
export const PUBLISH_KINDS: readonly OutboxKind[] = [
  'change.push',
  'change.pr.open',
  'git.push',
  'github.pr.open',
];

/** 旧名和新名指到同一件外送。合并、评论回 null。 */
export function publishAction(kind: string): 'push' | 'open' | null {
  if (kind === 'git.push' || kind === 'change.push') return 'push';
  if (kind === 'github.pr.open' || kind === 'change.pr.open') return 'open';
  return null;
}

/** 真执行的分支名：fleet2/ 前缀（旧引擎是 fleet/），带单号和运行号，同一次运行永远是同一个名字。 */
export const publishBranch = (issue: number, runId: string): string => `fleet2/${issue}-${runId}`;

/** 核验结论里能推的：过了、或没有可核验的范围（工人交了改动但仓里没给检查命令）。失败和没查成不推，留给人看。 */
const PUBLISHABLE = new Set(['passed', 'unverified']);

/** 确定做不成、重试也没用（补丁打不上、分支名被别人占了、PR 被人关了）：直接进 dead 等人。 */
export class PermanentError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'PermanentError';
  }
}

/** 对面明确拒了（推送被拒），这次一定没生效：退避再试，不当成结果不知道。 */
export class DefiniteError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'DefiniteError';
  }
}

/** 抓到补丁那一刻工作目录交给发布的东西（模型由内核补上）。 */
export interface PublishCollected {
  runId: string;
  target: RealTarget;
  verdict: 'unverified' | 'passed' | 'failed' | 'unknown';
  outcome: string;
  reasons: readonly string[];
  patch: string;
  wallMs: number;
}

export interface RecordPublishInput extends PublishCollected {
  model: string;
}

/**
 * 工人交回后记账：补丁、令牌、模型、核验结论存 publish_runs；该推的（有改动、核验过得去、工人干净交活）同一个事务里排 git.push。
 * 同一个 runId 重来只出一行、一个动作。
 */
export async function recordPublish(db: Db, r: RecordPublishInput): Promise<PublishRun> {
  const { target } = r;
  const empty = r.patch.trim() === '';
  const clean = r.outcome === 'completed';
  const state = empty ? 'empty' : !clean || !PUBLISHABLE.has(r.verdict) ? 'held' : 'ready';
  const reason =
    state === 'empty'
      ? '工人没有改动任何文件，不推'
      : state === 'held'
        ? `不推：结局 ${r.outcome}、核验 ${r.verdict}。${r.reasons.join('；')}`.slice(0, 1000)
        : r.reasons.join('；').slice(0, 1000);
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const { run } = await recordPublishRun(tx, {
      runId: r.runId,
      batchId: target.batchId,
      repo: target.repo,
      issue: target.issue,
      baseSha: target.baseSha,
      fencing: target.fencing,
      model: r.model,
      title: target.title,
      verdict: r.verdict,
      patch: r.patch,
      wallMs: r.wallMs,
      branch: publishBranch(target.issue, r.runId),
      state,
      reason,
    });
    if (run.state === 'ready') {
      const ref = { repo: run.repo, issue: run.issue };
      await enqueueOp(tx, {
        opKey: opKey('change.push', ref, run.fencing, run.runId),
        kind: 'change.push',
        ref,
        fencing: run.fencing,
        payload: { runId: run.runId, forge: 'github' },
      });
    }
    return run;
  });
}

export interface PublishDeps {
  db: Db;
  github: GitHubWriter;
  /** 发布令牌（PUBLISH_PERMISSIONS），推送的认证头用它；只在这个进程里。 */
  tokenFor: (repo: string) => Promise<string>;
  /** 裸镜像根（和影子工作目录同一份）：从这里取基线，不联网。 */
  mirrorRoot: string;
  /** 临时目录放哪。 */
  tmpRoot: string;
  /** 推到哪，默认 GitHub 的 https；测试换成本机裸仓。 */
  remote?: (repo: string) => string;
  /** 这张单现在的所有权令牌（旧库 tasks.fencing，不归新内核回 -1）；读不到抛错。 */
  fencingOf: (ref: TaskRef) => Promise<number>;
  redact: Redactor;
  hostEnv?: Readonly<Record<string, string | undefined>>;
  identity?: { name: string; email: string };
  leaseMs?: number;
  /** 领一次最多几条。 */
  batch?: number;
  /** 失败和结果不知道之后多久再来。 */
  retryMs?: number;
  /** 同一条动作最多领几次，到了进 dead。 */
  maxAttempts?: number;
  gitTimeoutMs?: number;
  run?: (spec: CommandSpec) => Promise<CommandResult>;
  onError?(err: unknown, op?: OutboxOp): void;
  /** 设了就只做这一个 forge，别的领到立刻退回 pending（本机 ADE 不碰 GitHub 那几条）。 */
  onlyForge?: Forge;
}

export interface OutboxReport {
  claimed: number;
  done: number;
  failed: number;
  unknown: number;
  dead: number;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 领到期的外部动作，一条条做完。回这一轮各结局的条数。 */
export async function processOutbox(d: PublishDeps): Promise<OutboxReport> {
  const report: OutboxReport = { claimed: 0, done: 0, failed: 0, unknown: 0, dead: 0 };
  const ops = await claimDueOps(d.db, d.batch ?? 5, d.leaseMs ?? 5 * 60_000);
  report.claimed = ops.length;
  for (const op of ops) {
    const retryMs = d.retryMs ?? 30_000;
    const maxAttempts = d.maxAttempts ?? 8;
    try {
      const forge = forgeOf(op.payload);
      if (d.onlyForge && forge !== d.onlyForge) {
        await releaseOp(d.db, op);
        continue;
      }
      if (forge === 'gitlab') {
        // 面板上的 GitLab 在入队时已经领走做完。这里是内核自动发布，仍然不连 GitLab。
        await failOp(d.db, op, 'gitlab 还没实现', 0, 0);
        report.dead++;
        continue;
      }
      if (forge === 'local') {
        const result = await runLocal(d, op);
        await completeOp(d.db, op, result);
        report.done++;
        continue;
      }
      const action = publishAction(op.kind);
      if (!action) {
        await failOp(d.db, op, `没有 ${op.kind} 的处理器（合并、评论不归内核自动做）`, 0, 0);
        report.dead++;
        continue;
      }
      // 执行前核所有权令牌：这张单已经易手（切回旧系统、被别人拿走）就不做。读不到按没做成退避，不当成对得上。
      // local 在上面已经写完文件，不核 GitHub 令牌。
      let ok: boolean;
      try {
        ok = await checkFencing(d.db, op, d.fencingOf);
      } catch (err) {
        if (err instanceof LostClaimError) throw err;
        await failOp(d.db, op, `读不到所有权令牌：${errMsg(err)}`, retryMs, maxAttempts);
        report.failed++;
        continue;
      }
      if (!ok) {
        report.dead++;
        continue;
      }
      const result = action === 'push' ? await pushOp(d, op) : await openPrOp(d, op);
      await completeOp(d.db, op, result);
      report.done++;
    } catch (err) {
      if (err instanceof LostClaimError) continue; // 租约过了被别人领走：什么都不改
      d.onError?.(err, op);
      try {
        const why = d.redact(errMsg(err)).slice(0, 1000);
        if (err instanceof PermanentError) {
          await failOp(d.db, op, why, 0, 0);
          report.dead++;
        } else if (op.attempts >= (d.maxAttempts ?? 8)) {
          await failOp(d.db, op, why, retryMs, d.maxAttempts ?? 8);
          report.dead++;
        } else if (err instanceof GitHubDefiniteError || err instanceof DefiniteError) {
          // 对面明确拒了，这次一定没生效：退避再试
          await failOp(d.db, op, why, retryMs, d.maxAttempts ?? 8);
          report.failed++;
        } else {
          // 超时、断线、5xx、限流、没领到结果：可能已经生效，记 unknown，下一次领到先查证
          await markUnknown(d.db, op, why, retryMs);
          report.unknown++;
        }
      } catch (settleErr) {
        if (!(settleErr instanceof LostClaimError)) d.onError?.(settleErr, op);
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------- git.push

const MIRROR_UPLOAD_PACK = '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack';

async function pushOp(d: PublishDeps, op: OutboxOp): Promise<Record<string, unknown>> {
  const run = await mustRun(d, String(op.payload.runId ?? ''));
  if (run.state !== 'ready') throw new PermanentError(`产物 ${run.runId} 的状态是 ${run.state}，不推`);
  const ref = { repo: run.repo, issue: run.issue };
  if (run.fencing !== op.fencing) throw new PermanentError('产物和动作的所有权令牌对不上');

  const token = await d.tokenFor(run.repo);
  const redact = composeRedact(d.redact, [token, basicAuth(token)]);
  await mkdir(d.tmpRoot, { recursive: true });
  const home = await mkdtemp(join(d.tmpRoot, 'fleet2-publish-'));
  try {
    const dir = join(home, 'w');
    const commit = await buildCommit(d, run, dir, home, redact);
    let remoteSha = await d.github.branchSha(run.repo, run.branch);
    if (remoteSha === null) {
      const push = await git(
        d,
        dir,
        ['push', '--porcelain', remoteOf(d, run.repo), `HEAD:refs/heads/${run.branch}`],
        { home, token, redact },
      );
      // 退出码非 0 或被杀：不管说了什么，以查证为准（响应丢了不等于没推上）
      remoteSha = await d.github.branchSha(run.repo, run.branch);
      if (remoteSha === null) {
        if (push.ran) {
          throw new DefiniteError(
            `推分支被拒（退出码 ${push.exitCode}）：${redact(push.stderrTail.trim()).slice(-300)}`,
          );
        }
        throw new Error(`推分支没有得到结果：${push.killed ?? push.spawnError ?? '不明'}`);
      }
    }
    if (remoteSha !== commit) {
      throw new PermanentError(
        `分支 ${run.branch} 在 GitHub 上已经有别的内容（${remoteSha.slice(0, 12)}，我们要推的是 ${commit.slice(0, 12)}），不覆盖`,
      );
    }
    // 先排开 PR 的动作再收这条（都是幂等的）：这里崩了重来，会再排一次、同一个键，不出第二条
    await enqueueOp(d.db, {
      opKey: opKey('change.pr.open', ref, run.fencing, run.runId),
      kind: 'change.pr.open',
      ref,
      fencing: run.fencing,
      payload: { runId: run.runId, branch: run.branch, sha: commit, forge: 'github' },
    });
    await appendToStream(d.db, issueStream(ref), 'publish.pushed', {
      runId: run.runId,
      branch: run.branch,
      sha: commit,
      fencing: run.fencing,
      opKey: op.opKey,
    });
    return { branch: run.branch, sha: commit };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** 在内核自己的临时目录里：取基线、打补丁、提交。同样的基线加补丁永远得到同一个提交号（作者、时刻都定死）。 */
async function buildCommit(
  d: PublishDeps,
  run: PublishRun,
  dir: string,
  home: string,
  redact: Redactor,
): Promise<string> {
  if (run.repo.split('/').some((p) => p === '.' || p === '..')) {
    throw new PermanentError(`仓名不合法：${run.repo}`);
  }
  const mirror = join(d.mirrorRoot, `${run.repo}.git`);
  await mkdir(dir, { recursive: true });
  await must('建临时仓', git(d, dir, ['init', '--quiet'], { home, redact }));
  await must(
    '取基线',
    git(d, dir, ['fetch', '--quiet', '--no-tags', MIRROR_UPLOAD_PACK, mirror, run.baseSha], { home, redact }),
  );
  await must('检出基线', git(d, dir, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { home, redact }));
  const applied = await git(d, dir, ['apply', '--index', '--whitespace=nowarn', '-'], {
    home,
    redact,
    stdin: run.patch.endsWith('\n') ? run.patch : `${run.patch}\n`,
  });
  if (!applied.ran || applied.exitCode !== 0) {
    throw new PermanentError(
      `补丁打不上基线 ${run.baseSha.slice(0, 12)}：${redact(applied.stderrTail.trim()).slice(-300)}`,
    );
  }
  const when = run.createdAt.toISOString();
  const who = d.identity ?? { name: 'fleet-dao harness', email: 'harness@fleet-dao.invalid' };
  await must(
    '提交',
    git(
      d,
      dir,
      [
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        `${run.title}\n\n新内核第 ${run.runId} 次运行，模型 ${run.model}，基线 ${run.baseSha.slice(0, 12)}`,
      ],
      {
        home,
        redact,
        extra: {
          GIT_AUTHOR_NAME: who.name,
          GIT_AUTHOR_EMAIL: who.email,
          GIT_COMMITTER_NAME: who.name,
          GIT_COMMITTER_EMAIL: who.email,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_DATE: when,
        },
      },
    ),
  );
  const head = await must('读提交号', git(d, dir, ['rev-parse', 'HEAD'], { home, redact }));
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`读到的提交号不对：${sha.slice(0, 80)}`);
  return sha;
}

// ---------------------------------------------------------------- github.pr.open

async function openPrOp(d: PublishDeps, op: OutboxOp): Promise<Record<string, unknown>> {
  const run = await mustRun(d, String(op.payload.runId ?? ''));
  const branch = String(op.payload.branch ?? '');
  const sha = String(op.payload.sha ?? '');
  if (branch !== run.branch || !/^[0-9a-f]{40}$/.test(sha))
    throw new PermanentError('开 PR 动作的载荷和产物对不上');
  const ref = { repo: run.repo, issue: run.issue };

  const done = async (pr: PrInfo, opened: boolean) => {
    await appendToStream(d.db, issueStream(ref), 'publish.pr.opened', {
      runId: run.runId,
      number: pr.number,
      url: pr.url,
      branch,
      sha,
      opened,
      fencing: run.fencing,
      model: run.model,
      verdict: run.verdict,
    });
    return { number: pr.number, url: pr.url, branch, sha, opened };
  };

  // 已经有以这个分支为头的 PR：开着的就是我们开的（响应丢了的情形），被人关了或合了不再开第二个
  const own = await d.github.prByHead(run.repo, branch);
  if (own) {
    if (own.state === 'open' || own.merged) return done(own, false);
    throw new PermanentError(`PR #${own.number} 已被关掉（没合并），不再开第二个，等人处理：${own.url}`);
  }
  const others = (await d.github.openPrsForIssue(run.repo, run.issue)).filter((p) => p.headRef !== branch);
  if (others.length > 0) {
    throw new PermanentError(
      `${run.repo}#${run.issue} 已经有开着的 PR（${others.map((p) => `#${p.number}`).join('、')}），不开第二个`,
    );
  }
  const onRemote = await d.github.branchSha(run.repo, branch);
  if (onRemote !== sha) {
    if (onRemote === null) throw new Error(`分支 ${branch} 在 GitHub 上还看不到，等下一轮`);
    throw new PermanentError(
      `分支 ${branch} 的内容变了（${onRemote.slice(0, 12)}，期望 ${sha.slice(0, 12)}），不开 PR`,
    );
  }
  const base = await d.github.defaultBranch(run.repo);
  let pr: PrInfo;
  try {
    pr = await d.github.openPr(run.repo, { head: branch, base, title: run.title, body: prBody(run) });
  } catch (err) {
    // 422：同一个头已经有 PR（上一次开成了、响应丢了）→ 查到就认
    if (err instanceof GitHubDefiniteError && err.status === 422) {
      const again = await d.github.prByHead(run.repo, branch);
      if (again) return done(again, false);
    }
    throw err;
  }
  const seen = await d.github.getPr(run.repo, pr.number);
  if (seen.state !== 'open' || seen.headSha !== sha) {
    throw new Error(
      `PR #${pr.number} 开出来了但查证对不上（状态 ${seen.state}，头 ${seen.headSha.slice(0, 12)}）`,
    );
  }
  return done(seen, true);
}

/** PR 正文：关单词、哪单、用了哪个模型、结果如何。不开自动合并，等合并闸和人。 */
export function prBody(
  run: Pick<PublishRun, 'repo' | 'issue' | 'model' | 'runId' | 'verdict' | 'baseSha' | 'wallMs' | 'reason'>,
): string {
  return [
    `Closes #${run.issue}`,
    '',
    '新内核（决定 0124，重写第 7 片）真执行：工人交回后由内核经 outbox 推分支、开 PR。没有开自动合并，由现有合并闸和人决定合不合。',
    '',
    `- 单：${run.repo}#${run.issue}`,
    `- 工人模型：${run.model}`,
    `- 运行：${run.runId}，用时 ${Math.round(run.wallMs / 1000)} 秒`,
    `- 机械核验：${run.verdict}${run.reason ? `（${run.reason.slice(0, 300)}）` : ''}`,
    `- 基线：${run.baseSha}`,
  ].join('\n');
}

// ---------------------------------------------------------------- 小工具

async function mustRun(d: PublishDeps, runId: string): Promise<PublishRun> {
  const run = runId ? await getPublishRun(d.db, runId) : null;
  if (!run) throw new PermanentError(`找不到产物 ${runId || '(空)'}`);
  return run;
}

/** 在已有的 redact 上再叠一层：令牌和认证头换成 ***。 */
function composeRedact(base: Redactor, secrets: string[]): Redactor {
  const extra = makeRedactor(secrets);
  return (s) => base(extra(s));
}

const basicAuth = (token: string): string => Buffer.from(`x-access-token:${token}`).toString('base64');

const remoteOf = (d: PublishDeps, repo: string): string =>
  d.remote ? d.remote(repo) : `https://github.com/${repo}.git`;

/**
 * 内核自己的 git：环境完整自己构造（家目录指到临时目录，没有全局配置、没有凭据助手），只有推送那条带认证头，
 * 头放在环境变量里，不进命令行（谁都能列命令行，H1）；输出过脱敏器。
 */
function git(
  d: PublishDeps,
  cwd: string,
  args: string[],
  o: {
    home: string;
    redact: Redactor;
    token?: string;
    stdin?: string;
    extra?: Record<string, string>;
  },
): Promise<CommandResult> {
  const host = d.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const k of WORKER_BASE_KEYS) {
    const v = host[k];
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    HOME: o.home,
    USERPROFILE: o.home,
    TMPDIR: o.home,
    TEMP: o.home,
    TMP: o.home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...o.extra,
  });
  if (o.token) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth(o.token)}`,
    });
  }
  return (d.run ?? runCommand)({
    command: ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    cwd,
    timeoutMs: d.gitTimeoutMs ?? 5 * 60_000,
    redact: o.redact,
    trustedEnv: env,
    ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
  });
}

function showRemote(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//');
}

/**
 * 本机面板的推送：人已经在工作树里提交，outbox 领到这条才 `git push`。
 * 不动 main，不推 fleet-dao，GitHub / GitLab 不走这里（GitHub 用上面的处理器，GitLab 领到就停）。
 */
async function pushAdeCwd(
  d: PublishDeps,
  cwd: string,
  branch: string,
): Promise<{ branch: string; remote: string }> {
  if (
    branch === '' ||
    branch === 'HEAD' ||
    branch === 'main' ||
    branch === 'master' ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new PermanentError(branch === 'main' || branch === 'master' ? '不动 main' : '这个分支不能推');
  }
  await mkdir(d.tmpRoot, { recursive: true });
  const home = await mkdtemp(join(d.tmpRoot, 'fleet2-ade-push-'));
  const gitArgs = (args: string[]) => ['-c', 'safe.directory=*', ...args];
  try {
    const head = await must(
      '读分支',
      git(d, cwd, gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), { home, redact: d.redact }),
    );
    if (head.stdout.trim() !== branch) throw new PermanentError('分支和载荷对不上');
    const remote = await must(
      '读 origin',
      git(d, cwd, gitArgs(['remote', 'get-url', 'origin']), { home, redact: d.redact }),
    );
    const url = remote.stdout.trim();
    const low = url.toLowerCase();
    if (!url) throw new PermanentError('没有 origin');
    if (low.includes('fleet-dao')) throw new PermanentError('不往 fleet-dao 推');
    if (low.includes('github.com') || low.includes('gitlab'))
      throw new PermanentError('这个远端不走本地推送');
    await must(
      '推送',
      git(d, cwd, gitArgs(['push', '--porcelain', '-u', 'origin', `HEAD:refs/heads/${branch}`]), {
        home,
        redact: d.redact,
      }),
    );
    return { branch, remote: showRemote(url) };
  } catch (err) {
    if (err instanceof PermanentError) throw err;
    throw new PermanentError(err instanceof Error ? err.message : '推送没成');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** 不连平台：补丁、开单、评论、合并各自落一个文件。没有 adeCwd 的空补丁直接失败。 */
async function runLocal(d: PublishDeps, op: OutboxOp): Promise<Record<string, unknown>> {
  const dir = join(d.tmpRoot, 'local-changes');
  await mkdir(dir, { recursive: true });
  const safe = op.opKey.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 140);
  const file = (ext: string) => join(dir, `${safe}${ext}`);
  if (op.kind === 'change.push' || op.kind === 'git.push') {
    const patch = String(op.payload.patch ?? '');
    const adeCwd = typeof op.payload.adeCwd === 'string' ? op.payload.adeCwd : '';
    if (!patch.trim() && !adeCwd) throw new PermanentError('补丁是空的');
    let patchFile = '';
    if (patch.trim()) {
      patchFile = file('.patch');
      await writeFile(patchFile, patch, 'utf8');
    }
    if (!adeCwd) return { patchFile };
    const pushed = await pushAdeCwd(d, adeCwd, String(op.payload.branch ?? ''));
    return { ...(patchFile ? { patchFile } : {}), ...pushed };
  }
  if (op.kind === 'change.pr.open' || op.kind === 'github.pr.open') {
    const side = file('.json');
    await writeFile(side, JSON.stringify(op.payload), 'utf8');
    return { file: side };
  }
  if (op.kind.endsWith('.comment')) {
    const side = file('.comment.txt');
    await writeFile(side, String(op.payload.text ?? op.payload.body ?? ''), 'utf8');
    return { file: side };
  }
  // 旧名 github.* 与新名 change.* 同一后缀。这里不写出合并调用，只把「已经合并」记成文件。
  if (op.kind.endsWith('.merge')) {
    const side = file('.done');
    await writeFile(side, 'recorded\n', 'utf8');
    return { file: side };
  }
  throw new PermanentError(`local 没有 ${op.kind} 的处理器`);
}

const refuseGitHub = (): never => {
  throw new Error('本机这条路不连 GitHub');
};

/** 本机 ADE 用的外送依赖：只处理 forge=local，GitHub 客户端一碰就拒。 */
export function localOutboxDeps(db: Db, tmpRoot: string, redact: Redactor): PublishDeps {
  return {
    db,
    tmpRoot,
    mirrorRoot: tmpRoot,
    redact,
    onlyForge: 'local',
    tokenFor: async () => refuseGitHub(),
    fencingOf: async () => -1,
    github: new Proxy({} as GitHubWriter, { get: () => refuseGitHub }),
  };
}

async function must(what: string, r: Promise<CommandResult>): Promise<CommandResult> {
  const res = await r;
  if (!res.ran || res.exitCode !== 0) {
    throw new Error(
      `${what}没成：${res.spawnError ?? res.killed ?? `退出码 ${res.exitCode}`} ${res.stderrTail.trim().slice(-300)}`,
    );
  }
  return res;
}
