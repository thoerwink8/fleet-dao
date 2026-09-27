// CI 上按提交扫一段还没进主线的历史：两处用它——.github/workflows/ci.yml 的 hygiene job 扫这个 PR 的 base..head；
// .github/workflows/hygiene-push.yml 扫某个分支上 main 还没有的部分。base、head 收版本号（分支名、SHA 都行），
// 这里自己 rev-parse 成完整提交号——调用方不用先解析，参数像 flag（以 - 开头）也不会被当成 git 的选项。
// 和推送前的闸（prepush.ts）、引擎推分支（packages/github 的 push.ts）同一份判定：historyArgs / scanHistory。
// 执行哪份代码由调用方的检出方式决定（这个文件本身只管判定，不关心自己是不是在 trusted/ 里跑）；git 命令的 cwd
// 由调用方传的 git 决定，要有完整提交历史（CI 工作流里检出时设 fetch-depth: 0，默认浅克隆拿不到 base..head）。
// 退出码和全仓检查一样：0 干净；1 查出了；2 没扫全（base/head 解析不出、git 出错、输出认不出、已知敏感值名单没读到）。
import type { Allow } from './allowlist.ts';
import { type CheckResult, FIX_HINT } from './check.ts';
import { historyArgs, REWRITE_HINT, scanHistory } from './history.ts';
import type { GitSync } from './prepush.ts';
import { formatFinding } from './scan.ts';
import type { LoadedValues } from './values.ts';

export interface CiHistoryInput {
  git: GitSync;
  /** 起点（不含）。分支名、SHA 都行。 */
  base: string;
  /** 终点（含）。分支名、SHA 都行。 */
  head: string;
  values: LoadedValues;
  allowlist?: readonly Allow[];
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** 版本号解析成完整提交号；解析不出、或者长得像 git 的选项（以 - 开头，会被当成参数注进命令行）都算解析不出。 */
function resolve(git: GitSync, rev: string): string | undefined {
  const trimmed = rev.trim();
  if (trimmed === '' || trimmed.startsWith('-')) return undefined;
  const r = git(['rev-parse', '--verify', '--quiet', `${trimmed}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : undefined;
}

export function ciHistoryCheck(input: CiHistoryInput): CheckResult {
  const { git, values } = input;
  const base = resolve(git, input.base);
  const head = resolve(git, input.head);
  if (base === undefined || head === undefined) {
    return {
      code: 2,
      lines: [
        `按提交扫没扫成：base（${input.base || '(空)'}）或 head（${input.head || '(空)'}）解析不出完整的提交号`,
      ],
    };
  }
  const args = historyArgs([`${base}..${head}`]);
  const runs = [git(args.patch), git(args.names), git(args.messages)] as const;
  const failed = runs.find((r) => r.code !== 0);
  if (failed) {
    return {
      code: 2,
      lines: [
        `按提交扫没扫成：取 ${base.slice(0, 7)}..${head.slice(0, 7)} 的提交出错（${failed.stderr.trim()}）`,
      ],
    };
  }
  let scan: ReturnType<typeof scanHistory>;
  try {
    scan = scanHistory(
      { patch: runs[0].stdout, names: runs[1].stdout, messages: runs[2].stdout },
      { values: values.ok ? values.values : [], ...(input.allowlist && { allowlist: input.allowlist }) },
    );
  } catch (e) {
    return { code: 2, lines: [`按提交扫没扫成：${e instanceof Error ? e.message : String(e)}`] };
  }
  // head 得在扫过的提交里；不在，只可能是 base 早就包含它（范围是空的：base 就是 head，或者分支还指着主线上的旧提交、
  // 没有新提交）——和 prepush.ts 一样再核一遍，核不上就算没扫成。
  if (!scan.commits.includes(head)) {
    const unseen = git(['rev-list', '-n', '1', `${base}..${head}`]);
    if (unseen.code !== 0 || unseen.stdout.trim() !== '') {
      return { code: 2, lines: [`按提交扫没扫成：要扫的 ${head.slice(0, 7)} 不在扫过的提交里`] };
    }
  }
  const lines = [
    `按提交扫：${base.slice(0, 7)}..${head.slice(0, 7)} 有 ${scan.commits.length} 个提交，逐个看了新增的 ` +
      `${scan.addedLines} 行、文件名、提交说明和作者，查出 ${scan.findings.length} 条` +
      (scan.binaryHunks > 0 ? `（带 NUL 的 ${scan.binaryHunks} 段是二进制，没看内容、只按文件名判）` : ''),
    ...scan.findings.map(formatFinding),
  ];
  if (scan.findings.length > 0) {
    lines.push(FIX_HINT, `这些提交已经推上去、公开了。${REWRITE_HINT}改完强推这个分支覆盖远端。`);
  }
  if (!values.ok) {
    lines.push(`没扫全：${values.reason}。真实的组织编号、账号靠这份名单才认得出，名单没读到不算干净。`);
    return { code: 2, lines };
  }
  return { code: scan.findings.length > 0 ? 1 : 0, lines };
}
