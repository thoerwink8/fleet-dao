// 影子工作目录（#3808）：从本机的裸镜像 `<镜像根>/<仓>.git` 以 `worktree add --detach` 建到批次的基线，跑完删掉。
// 终局交回记完后抓补丁（含新文件）写 fleet2.shadow_runs：补丁只存库里，分支不建、不推，任何自动流程不消费。
// git 都经 runCommand（runProcess），走无凭据的工人环境；补丁那一步在工人改过的目录里跑，关 fsmonitor、不跑外部 diff。
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Redactor } from '@fleet-dao/harness-runner';
import { type Db, recordShadowRun } from '@fleet-dao/harness-store';
import { type CommandResult, type CommandSpec, runCommand } from './command.ts';
import type { Workspace } from './dispatcher.ts';
import type { SpawnRequest } from './prompt.ts';

const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-c', 'core.hooksPath=/dev/null'];

export interface ShadowWorkspaceOptions {
  db: Db;
  /** 裸镜像的根目录：`<根>/<owner>/<repo>.git`，由部署先拉好（只读 GitHub）。 */
  mirrorRoot: string;
  /** 临时工作目录放哪。 */
  tmpRoot: string;
  redact: Redactor;
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
  const git = (cwd: string, args: string[]) =>
    run({
      command: ['git', ...GIT_SAFE, ...args],
      cwd,
      timeoutMs,
      redact: o.redact,
      maxOutputChars: o.maxPatchChars ?? 2_000_000,
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

  return async function prepareWorkspace(req: SpawnRequest, ctx: { runId: string }): Promise<Workspace> {
    const target = req.shadow;
    if (!target) throw new NotShadowRequestError(req.taskId);
    const mirror = join(o.mirrorRoot, `${target.repo}.git`);
    await mkdir(o.tmpRoot, { recursive: true });
    const dir = join(o.tmpRoot, `fleet2-shadow-${ctx.runId}-${randomUUID().slice(0, 8)}`);
    await must(
      '建影子工作目录',
      git(o.tmpRoot, ['--git-dir', mirror, 'worktree', 'add', '--detach', dir, target.baseSha]),
    );
    return {
      cwd: dir,
      baseRef: target.baseSha,
      async collect({ verdict, wallMs }) {
        // 新文件先记成「打算加」，diff 才看得见；这个目录跑完就删，动它的索引不碍事
        await must('登记新文件', git(dir, ['add', '-A', '-N']));
        const diff = await must(
          '抓补丁',
          git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', target.baseSha, '--']),
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
      },
      async cleanup() {
        await git(o.tmpRoot, ['--git-dir', mirror, 'worktree', 'remove', '--force', dir]);
        await rm(dir, { recursive: true, force: true });
        await git(o.tmpRoot, ['--git-dir', mirror, 'worktree', 'prune']);
      },
    };
  };
}
