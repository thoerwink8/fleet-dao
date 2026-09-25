// git pre-push 钩子的判定（人手推用；引擎推分支走 packages/github 的 push.ts，那边推带 --no-verify、自己扫）。
// 公开仓一推就公开了，CI 只在 PR 上跑太晚，所以主闸在推之前：远端还没有的提交逐个过规则和名单（history.ts）——
// 推上去的是整段历史，先加后删的东西照样在里面。「远端还没有」按本地记着的所有远端分支（refs/remotes/*）算：
// 只认这次的远端名的话，推到网址、推到没 fetch 过的远端名会把早就公开的历史整段重扫、必被拒，还叫人去改写主线。
// 钩子参数里的远端（可能是带令牌的网址）不用、也不打印。
// 退出码和全仓检查一样：0 = 没问题；1 = 查出了，拒推；2 = 没扫全（名单没读到、git 出错、输出认不出），也拒推。
import type { Allow } from './allowlist.ts';
import type { CheckResult } from './check.ts';
import { FIX_HINT } from './check.ts';
import { historyArgs, REWRITE_HINT, scanHistory } from './history.ts';
import { formatFinding } from './scan.ts';
import type { LoadedValues } from './values.ts';

export interface PushedRef {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
}

export type GitSync = (args: string[]) => { code: number; stdout: string; stderr: string };

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

export interface PrePushInput {
  refs: readonly PushedRef[];
  git: GitSync;
  values: LoadedValues;
  allowlist?: readonly Allow[];
}

const isZero = (oid: string) => /^0+$/.test(oid);

export function prePushCheck(input: PrePushInput): CheckResult {
  const { git, values } = input;
  const pushed = input.refs.filter((ref) => !isZero(ref.localOid)); // 本地提交全 0 是删远端分支，没有新内容
  if (pushed.length === 0) return { code: 0, lines: [] };
  // 远端这几个分支现在的头：本地有这个提交就一起排除（没 fetch 过的远端分支不在 refs/remotes 里）。
  const known = pushed
    .map((ref) => ref.remoteOid)
    .filter((oid) => !isZero(oid) && git(['rev-parse', '-q', '--verify', `${oid}^{commit}`]).code === 0);
  const published = ['--not', '--remotes', ...known];
  const args = historyArgs([...pushed.map((ref) => ref.localOid), ...published]);
  const runs = [git(args.patch), git(args.names), git(args.messages)] as const;
  const refs = pushed.map((ref) => ref.localRef).join('、');
  const failed = runs.find((r) => r.code !== 0);
  if (failed) {
    return { code: 2, lines: [`推送前卫生检查没扫成：取 ${refs} 要推的提交出错（${failed.stderr.trim()}）`] };
  }
  let scan: ReturnType<typeof scanHistory>;
  try {
    scan = scanHistory(
      { patch: runs[0].stdout, names: runs[1].stdout, messages: runs[2].stdout },
      { values: values.ok ? values.values : [], ...(input.allowlist && { allowlist: input.allowlist }) },
    );
  } catch (e) {
    return {
      code: 2,
      lines: [`推送前卫生检查没扫成：${e instanceof Error ? e.message : String(e)}`],
    };
  }
  // 要推的每个头都得在扫过的提交里；不在，只可能是远端早就有它了——再核一遍，核不上就算没扫成。
  for (const ref of pushed) {
    const head = git(['rev-parse', '-q', '--verify', `${ref.localOid}^{commit}`]).stdout.trim();
    if (scan.commits.includes(head)) continue;
    const unseen = git(['rev-list', '-n', '1', head || ref.localOid, ...published]);
    if (unseen.code !== 0 || unseen.stdout.trim() !== '') {
      return {
        code: 2,
        lines: [
          `推送前卫生检查没扫成：要推的 ${ref.localRef}（${ref.localOid.slice(0, 7)}）不在扫过的提交里`,
        ],
      };
    }
  }
  const noRemoteRefs =
    git(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/']).stdout.trim() === '';
  const notes = [
    ...(scan.binaryHunks > 0 ? [`带 NUL 的 ${scan.binaryHunks} 段是二进制，没看内容、只按文件名判`] : []),
    ...(noRemoteRefs ? ['本地没记着任何远端分支，整段历史都扫了'] : []),
  ];
  const lines = [
    `推送前卫生检查：${refs} 有 ${scan.commits.length} 个提交远端还没有，逐个看了新增的 ${scan.addedLines} 行、` +
      `文件名、提交说明和作者，查出 ${scan.findings.length} 条${notes.length > 0 ? `（${notes.join('；')}）` : ''}`,
    ...scan.findings.map(formatFinding),
  ];
  if (scan.findings.length > 0)
    lines.push(FIX_HINT, `没推。${REWRITE_HINT}别用 --no-verify 硬推：公开仓推上去就公开了。`);
  if (!values.ok) {
    lines.push(
      `没扫全：${values.reason}。名单放好之前不推（本机放 ~/.fleet-dao/sensitive-values.txt，或用 FLEET_SENSITIVE_VALUES_FILE 指过去）。`,
    );
    return { code: 2, lines };
  }
  return { code: scan.findings.length > 0 ? 1 : 0, lines };
}
