// 发布那边的两样事实，排空要用（drain-control.ts）：发布目录在哪（排空请求文件放那）、发布锁此刻有没有人占着。
// 原来这个文件（kill-evidence.ts）还管「会话被信号杀掉时按证据说是谁杀的」（explainKill、cgroup 的 oom_kill 计数），
// 那一块只被老会话端口的看守用，老端口删了（#901）一并删了；失败分流里 KL2/KL3/KL4 认的 oom_killed / engine_stop /
// signal_unexplained 三个码现在没有生产方，规则还在 failure/rules.ts（没动）。

import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** 发布目录（deploy/release.sh 的 RELEASES）：发布锁、自动发布的读数、排空请求都在这。 */
export const RELEASES_DIR = '/srv/fleet-dao-releases';

export interface ReleaseEvidenceDeps {
  /** 发布锁此刻有没有人占着：true 占着、false 空着、undefined 没查成。 */
  releaseLockBusy(): Promise<boolean | undefined>;
  releasesDir: string;
}

/** 发布锁有没有人占着：以共享锁试一下（flock -n -s，读得到锁文件就能试），占着 true、空着 false，别的都算没查成。 */
function flockProbe(lockFile: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('flock', ['-n', '-s', lockFile, 'true'], { stdio: 'ignore' });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 5_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? false : code === 1 ? true : undefined);
    });
  });
}

/** 生产用的读法：真 flock。 */
export function realReleaseEvidence(overrides: Partial<ReleaseEvidenceDeps> = {}): ReleaseEvidenceDeps {
  const releasesDir = overrides.releasesDir ?? RELEASES_DIR;
  return {
    releaseLockBusy: () => flockProbe(join(releasesDir, '.lock')),
    releasesDir,
    ...overrides,
  };
}
