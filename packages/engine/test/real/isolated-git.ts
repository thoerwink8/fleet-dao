// 目标仓边界测试用的 git 夹具：系统临时目录里再加一层天花板，并丢掉 GIT_DIR 一类重定向。
// 临时目录落在别的仓里时，git 仍会向上找到那个仓；不能把「在 _tmp 里」当成隔离。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserCommandResult, UserExec } from '../../src/real/exec.ts';
import { runChildOk } from '../child.ts';

/** 不继承系统/用户的 git 配置，也不继承 GIT_DIR、GIT_WORK_TREE 等重定向。ceiling 以上不再找仓。 */
export function isolatedGitEnv(ceiling: string, home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANGUAGE: 'C',
  };
}

export function gitIn(env: Record<string, string>, cwd: string, ...args: string[]): string {
  return runChildOk('git', args, { cwd, env, encoding: 'utf8' });
}

/** 父仓有没有被写过：配置、HEAD 文件、引用清单。只看这三样，和「有没有新建 .git」分开断言。 */
export function repoStamp(
  env: Record<string, string>,
  work: string,
  gitDir = join(work, '.git'),
): { config: string; head: string; refs: string } {
  const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  return {
    config: sha256(readFileSync(join(gitDir, 'config'))),
    head: sha256(readFileSync(join(gitDir, 'HEAD'))),
    refs: sha256(gitIn(env, work, 'for-each-ref', '--format=%(refname) %(objectname)')),
  };
}

/** 以夹具环境跑会话 git（不走 localExec，避免把进程里的 GIT_* 重定向带进去）。 */
export function isolatedUserExec(env: Record<string, string>): UserExec {
  return (command) =>
    new Promise((resolve) => {
      const [bin, ...args] = command.argv;
      if (!bin) {
        resolve({
          code: null,
          stdout: Buffer.alloc(0),
          stderr: '空命令',
          timedOut: false,
          aborted: false,
          spawnError: '空命令',
        });
        return;
      }
      const child = spawn(bin, args, {
        cwd: command.cwd,
        env: { ...env, ...(command.env ?? {}) },
        stdio: 'pipe',
      });
      const chunks: Buffer[] = [];
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const finish = (result: UserCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        command.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, command.timeoutMs);
      const onAbort = () => {
        aborted = true;
        child.kill('SIGKILL');
      };
      if (command.signal?.aborted) onAbort();
      else command.signal?.addEventListener('abort', onAbort);
      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      child.on('error', (error) =>
        finish({
          code: null,
          stdout: Buffer.alloc(0),
          stderr,
          timedOut,
          aborted,
          spawnError: error.message,
        }),
      );
      child.on('close', (code) =>
        finish({
          code: timedOut || aborted ? null : code,
          stdout: Buffer.concat(chunks),
          stderr,
          timedOut,
          aborted,
        }),
      );
      child.stdin.on('error', () => undefined);
      child.stdin.end(command.stdin ?? Buffer.alloc(0));
    });
}
