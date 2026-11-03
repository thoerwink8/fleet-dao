// Windows 上把一个文件收紧到只有当前用户可读写（#3858）：icacls 去掉继承，只授权给当前用户。
// 起子进程只走 harness-runner（runCommand 是它上面的薄壳）；posix 用 0600，在 harness-api 的 ensureLocalToken 里已经做了。
import type { Redactor } from '@fleet-dao/harness-runner';
import { runCommand } from '../command.ts';
import type { Env } from './config.ts';

export async function restrictToCurrentUserWindows(file: string, env: Env, redact: Redactor): Promise<void> {
  const name = env.USERNAME;
  if (!name) throw new Error('取不到当前用户名，没法把令牌文件收紧到只有本用户可读');
  const user = env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
  const r = await runCommand({
    command: ['icacls', file, '/inheritance:r', '/grant:r', `${user}:F`],
    cwd: process.cwd(),
    timeoutMs: 15_000,
    hostEnv: env,
    redact,
  });
  if (!r.ran || r.exitCode !== 0) {
    throw new Error(
      `icacls 没把令牌文件收紧到只有本用户可读（退出码 ${r.exitCode ?? '无'}）：${r.stdout.slice(-300)}`,
    );
  }
}
