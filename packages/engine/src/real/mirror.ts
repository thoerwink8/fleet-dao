// 从引擎自己的镜像仓打一个 bundle 交给会话用户：会话用户读不到镜像，只能经 bundle 取提交（建树、换检出、并主线后快进）。
// 包落在引擎自己的临时目录，读进内存后就删；经标准输入交给会话用户那边的 git（user-git.ts 的 fetchBundle）。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type GitHub, isGitHubError } from '@fleet-dao/github';
import { PortError } from '../ports.ts';

export type MirrorGitHub = Pick<GitHub, 'fetchMainline' | 'bundleCommits'>;

/**
 * GitHubError → PortError（码和「能不能重试」原样带过 Temporal 边界）。推送的 workflows 权限在引擎里叫
 * WORKFLOWS_PERMISSION；卫生检查拦下的（推分支、写需求文档、开 PR 都会）把命中处整理成稳定的一句（文件:行 规则，
 * 排好序，不带值、不带提交号）：失败分流按「和上一次一字不差」认同一处连续被拦。
 * BEHIND_MAINLINE 在 github 包里不可重试（那一层没法并主线），到引擎这层改成可重试：推分支的端口每次推之前先把
 * 最新主线并进会话的树，撞上它只可能是并完到推之间主线又动了，再来一遍就好。
 */
export function toPortError(error: unknown): unknown {
  if (!isGitHubError(error)) return error;
  if (error.code === 'HYGIENE_BLOCKED') {
    const findings = (
      error.details as { findings?: { path?: unknown; line?: unknown; rule?: unknown }[] } | undefined
    )?.findings;
    const spots = Array.isArray(findings)
      ? findings.map((f) => `${String(f.path)}:${String(f.line)} ${String(f.rule)}`).sort()
      : [];
    return new PortError(
      'HYGIENE_BLOCKED',
      spots.length > 0 ? `卫生检查拦下了要公开的内容：${spots.join('；')}` : error.message,
      { retryable: false, details: error.details },
    );
  }
  if (error.code === 'BEHIND_MAINLINE') {
    return new PortError('BEHIND_MAINLINE', error.message, { retryable: true, details: error.details });
  }
  const code = error.code === 'WORKFLOW_PERMISSION' ? 'WORKFLOWS_PERMISSION' : error.code;
  return new PortError(code, error.message, { retryable: error.retryable, details: error.details });
}

export async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toPortError(error);
  }
}

/** 把 tip（和它的祖先，去掉 exclude 可达的）从镜像打成 bundle 读进内存；ref 是包里挂着 tip 的引用名。 */
export async function bundleFromMirror(
  gh: MirrorGitHub,
  tmpDir: string,
  repo: Parameters<MirrorGitHub['bundleCommits']>[0]['repo'],
  tip: string,
  exclude: string[],
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; ref: string }> {
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const outPath = join(tmpDir, `mirror-${randomUUID()}.bundle`);
  try {
    const made = await mapped(() => gh.bundleCommits({ repo, tips: [tip], exclude, outPath, signal }));
    const ref = made.refs.find((r) => r.tip === tip)?.ref;
    if (!ref) {
      throw new PortError('BUNDLE_INVALID', `镜像打的 bundle 里没有 ${tip.slice(0, 7)} 的引用`, {
        retryable: true,
      });
    }
    return { bytes: await readFile(made.path), ref };
  } finally {
    await rm(outPath, { force: true });
  }
}
