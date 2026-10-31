// 影子工作目录（#3808）：从本机的裸镜像 `<镜像根>/<仓>.git` 以 `clone --shared` 建一个自带 .git 的检出，停在批次的基线，跑完删掉。
// 镜像不在就从 GitHub 匿名建、缺基线提交就拉（#3811）：只读、不带令牌，所以只认公开仓；私有仓建不成就按「工作环境没建成」退避重试。
// 不用 `worktree add`：那样工作区的管理目录（索引、HEAD）在镜像里，法国上工人以会话用户跑、写不了镜像（#3814）。
// 给了 sandbox 就把建好的目录交给会话用户，跑完按回执删；内核以 fleet 读它要 safe.directory，抓补丁用内核自己的临时索引，不写那边。
// 终局交回记完后抓补丁（含新文件）写 fleet2.shadow_runs：补丁只存库里，分支不建、不推，任何自动流程不消费。
// git 都经 runCommand（runProcess），走无凭据的工人环境；补丁那一步在工人改过的目录里跑，关 fsmonitor、不跑外部 diff。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Redactor } from '@fleet-dao/harness-runner';
import { type Db, recordShadowRun } from '@fleet-dao/harness-store';
import type { AdoptedDir, WorkerSandbox } from '@fleet-dao/harness-workers';
import { type CommandResult, type CommandSpec, runCommand } from './command.ts';
import type { Workspace } from './dispatcher.ts';
import type { SpawnRequest } from './prompt.ts';

const GIT_SAFE = [
  '-c',
  'safe.directory=*',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=off',
  '-c',
  'core.hooksPath=/dev/null',
];
/** owner/repo，和 GitHub 的仓名字符集一样；不许 .. 这类跳出镜像根的写法。 */
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface ShadowWorkspaceOptions {
  db: Db;
  /** 裸镜像的根目录：`<根>/<owner>/<repo>.git`。不在就建、缺基线提交就拉（#3811）。 */
  mirrorRoot: string;
  /** 镜像从哪拉，默认 GitHub 的匿名 https（只读，不带令牌：只认公开仓）；测试换成本机路径。 */
  mirrorRemote?: (repo: string) => string;
  /** 建镜像、拉镜像的时限，默认 15 分钟。 */
  fetchTimeoutMs?: number;
  /** 临时工作目录放哪。 */
  tmpRoot: string;
  redact: Redactor;
  /** 工人以会话用户跑（法国）：建好的目录交出去、跑完按回执删。 */
  sandbox?: WorkerSandbox;
  timeoutMs?: number;
  /** 补丁最多存多少字符，超了不存、进 onError。 */
  maxPatchChars?: number;
  run?: (spec: CommandSpec) => Promise<CommandResult>;
}

export class NotShadowRequestError extends Error {
  constructor(taskId: string) {
    super(`派工请求 ${taskId} 没带影子目标：影子内核只做批次驱动派的活`);
    this.name = 'NotShadowRequestError';
  }
}

export function shadowWorkspaces(o: ShadowWorkspaceOptions) {
  const run = o.run ?? runCommand;
  const timeoutMs = o.timeoutMs ?? 120_000;
  const git = (cwd: string, args: string[], env?: Record<string, string>, ms = timeoutMs) =>
    run({
      command: ['git', ...GIT_SAFE, ...args],
      cwd,
      timeoutMs: ms,
      redact: o.redact,
      maxOutputChars: o.maxPatchChars ?? 2_000_000,
      ...(env ? { env } : {}),
    });
  const must = async (what: string, r: Promise<CommandResult>) => {
    const res = await r;
    if (!res.ran || res.exitCode !== 0) {
      throw new Error(
        `${what}没成：${res.spawnError ?? res.killed ?? `退出码 ${res.exitCode}`} ${res.stderrTail.trim().slice(-300)}`,
      );
    }
    return res;
  };
  const remote = o.mirrorRemote ?? ((repo: string) => `https://github.com/${repo}.git`);
  const fetchMs = o.fetchTimeoutMs ?? 15 * 60_000;
  const hasCommit = async (mirror: string, sha: string) => {
    const r = await git(mirror, ['cat-file', '-e', `${sha}^{commit}`]);
    return r.ran && r.exitCode === 0;
  };

  /** 镜像不在就建（先建到临时名再改名，半截的不留在正名上）；缺基线提交就拉一次各分支，拉完还没有就报错。 */
  async function ensureMirror(repo: string, sha: string): Promise<string> {
    if (!REPO.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
      throw new Error(`仓名不合法：${repo}`);
    }
    const mirror = join(o.mirrorRoot, `${repo}.git`);
    if (!existsSync(mirror)) {
      await mkdir(dirname(mirror), { recursive: true });
      const part = `${mirror}.part-${randomUUID().slice(0, 8)}`;
      try {
        await must(
          '建镜像',
          git(o.mirrorRoot, ['clone', '--quiet', '--bare', remote(repo), part], undefined, fetchMs),
        );
        await rename(part, mirror);
      } finally {
        await rm(part, { recursive: true, force: true });
      }
    }
    if (await hasCommit(mirror, sha)) return mirror;
    await must(
      '拉镜像',
      git(
        mirror,
        ['fetch', '--quiet', '--prune', remote(repo), '+refs/heads/*:refs/heads/*'],
        undefined,
        fetchMs,
      ),
    );
    if (!(await hasCommit(mirror, sha))) throw new Error(`镜像 ${repo} 拉过了还是没有基线提交 ${sha}`);
    return mirror;
  }

  return async function prepareWorkspace(req: SpawnRequest, ctx: { runId: string }): Promise<Workspace> {
    const target = req.shadow;
    if (!target) throw new NotShadowRequestError(req.taskId);
    const mirror = await ensureMirror(target.repo, target.baseSha);
    await mkdir(o.tmpRoot, { recursive: true });
    const dir = join(o.tmpRoot, `fleet2-shadow-${ctx.runId}-${randomUUID().slice(0, 8)}`);
    let adopted: AdoptedDir | undefined;
    const drop = async () => {
      if (adopted) await adopted.release();
      else await rm(dir, { recursive: true, force: true });
    };
    try {
      await must(
        '建影子工作目录',
        git(o.tmpRoot, ['clone', '--quiet', '--shared', '--no-checkout', mirror, dir]),
      );
      await must('检出基线', git(dir, ['checkout', '--quiet', '--detach', target.baseSha]));
      if (o.sandbox) adopted = await o.sandbox.adopt(dir);
    } catch (err) {
      await drop().catch(() => {});
      throw err;
    }
    return {
      cwd: dir,
      baseRef: target.baseSha,
      async collect({ verdict, wallMs }) {
        // 新文件先记成「打算加」，diff 才看得见。工人的 .git 一个字节都不写（法国上归会话用户、写不了）：
        // 索引用拷到内核临时目录的一份；add 也会写对象（-N 写空 blob，本机实测），对象库换成临时目录的，
        // 工人的对象库（连同它 alternates 指的镜像）只读着当备用库
        const scratch = await mkdtemp(join(tmpdir(), 'fleet2-patch-'));
        try {
          const index = join(scratch, 'index');
          await copyFile(join(dir, '.git', 'index'), index);
          // 对象库目录不在 git 就认不出这是仓（实测 not a git repository）
          await mkdir(join(scratch, 'objects'));
          const env = {
            GIT_INDEX_FILE: index,
            GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: join(dir, '.git', 'objects'),
          };
          await must('登记新文件', git(dir, ['add', '-A', '-N'], env));
          const diff = await must(
            '抓补丁',
            git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', target.baseSha, '--'], env),
          );
          if (diff.truncated) throw new Error(`补丁超过 ${o.maxPatchChars ?? 2_000_000} 字符，没存`);
          await recordShadowRun(o.db, {
            runId: ctx.runId,
            batchId: target.batchId,
            repo: target.repo,
            issue: target.issue,
            baseSha: target.baseSha,
            verdict,
            patch: diff.stdout,
            wallMs,
          });
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      },
      cleanup: drop,
    };
  };
}
