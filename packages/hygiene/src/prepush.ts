// git pre-push 钩子的判定（人手推用；引擎推分支走 packages/github 的 push.ts，那边推带 --no-verify、自己扫）。
// 公开仓一推就公开了，CI 只在 PR 上跑太晚，所以主闸在推之前：把要推的提交相对主线新增的行和文件名过一遍规则和名单。
// 退出码和全仓检查一样：0 = 没问题；1 = 查出了，拒推；2 = 没扫全（名单没读到、git 出错），也拒推。
import type { Allow } from './allowlist.ts';
import type { CheckResult } from './check.ts';
import { FIX_HINT } from './check.ts';
import { addedHunks, diffArgs, scanAdded } from './diff.ts';
import { formatFinding } from './scan.ts';
import type { LoadedValues } from './values.ts';

export interface PushedRef {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
}

export type GitSync = (args: string[]) => { code: number; stdout: string; stderr: string };

/** git 空树的编号：远端没有主线可比时，拿它当起点（等于扫整棵树）。 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 钩子从标准输入收到的每一行：<本地引用> <本地提交> <远端引用> <远端提交>。 */
export function parsePushedRefs(stdin: string): PushedRef[] {
  return stdin
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([localRef = '', localOid = '', remoteRef = '', remoteOid = '']) => ({
      localRef,
      localOid,
      remoteRef,
      remoteOid,
    }));
}

/** 远端的主线：refs/remotes/<远端>/HEAD 指的那条，没有就试 main、master。 */
function remoteMainline(git: GitSync, remote: string): string | undefined {
  const head = git(['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const name of ['main', 'master']) {
    const ref = `refs/remotes/${remote}/${name}`;
    if (git(['rev-parse', '-q', '--verify', ref]).code === 0) return ref;
  }
  return undefined;
}

export interface PrePushInput {
  remote: string;
  refs: readonly PushedRef[];
  git: GitSync;
  values: LoadedValues;
  allowlist?: readonly Allow[];
}

export function prePushCheck(input: PrePushInput): CheckResult {
  const { git, values } = input;
  const lines: string[] = [];
  let findings = 0;
  let broken = false;
  const mainline = remoteMainline(git, input.remote);
  for (const ref of input.refs) {
    if (/^0+$/.test(ref.localOid)) continue; // 删远端分支，没有新内容
    let base = EMPTY_TREE;
    if (mainline) {
      const mb = git(['merge-base', ref.localOid, mainline]);
      if (mb.code === 0 && mb.stdout.trim()) base = mb.stdout.trim();
    }
    const args = diffArgs(base, ref.localOid);
    const patch = git(args.patch);
    const names = git(args.names);
    if (patch.code !== 0 || names.code !== 0) {
      broken = true;
      lines.push(
        `推送前卫生检查没扫成：取 ${ref.localRef} 的差异出错（${(patch.stderr || names.stderr).trim()}）`,
      );
      continue;
    }
    const hunks = addedHunks(patch.stdout);
    const found = scanAdded(hunks, names.stdout.split('\0').filter(Boolean), {
      values: values.ok ? values.values : [],
      ...(input.allowlist && { allowlist: input.allowlist }),
    });
    findings += found.length;
    const added = hunks.reduce((n, h) => n + h.text.split('\n').length, 0);
    const from = base === EMPTY_TREE ? '空树' : base.slice(0, 7);
    lines.push(
      `推送前卫生检查：${ref.localRef}（${from}..${ref.localOid.slice(0, 7)}）新增 ${added} 行，查出 ${found.length} 条`,
    );
    lines.push(...found.map(formatFinding));
  }
  if (findings > 0)
    lines.push(
      FIX_HINT,
      '没推。把东西拿掉（改写这几个提交）再推；别用 --no-verify 硬推：公开仓推上去就公开了。',
    );
  if (!values.ok) {
    lines.push(
      `没扫全：${values.reason}。名单放好之前不推（本机放 ~/.fleet-dao/sensitive-values.txt，或用 FLEET_SENSITIVE_VALUES_FILE 指过去）。`,
    );
    return { code: 2, lines };
  }
  if (broken) return { code: 2, lines };
  return { code: findings > 0 ? 1 : 0, lines };
}
