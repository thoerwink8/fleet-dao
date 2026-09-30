// 一键同步（pnpm agents:sync）：把这台机器的 fleet-dao 检出快进到主线，再跑一遍 agents-sync --apply（规矩、技能、钩子、权限），
// 逐项结果原样打出来。开会话钩子（agents/hooks/session-start.mjs）每次开会话自动做同样的事；这条是「现在就要、看得见」的手动入口。
// 用哪个检出：--repo，否则 ~/.fleet-dao/synced.json 记的（开会话钩子也按它找），再没有就是这个脚本所在的检出。
// 不满足就明说、不同步：git 跑不起来、取不到远端（--offline 才跳过）、检出不在 main 上、AGENTS.md 或 agents/ 有没提交的改动、
// main 和 origin/main 分叉了。这些都不当成「已经是最新」。
// 退出码：0 同步都对；1 前置条件不满足或同步里有 ✗；2 同步里有没查成的；64 用法不对。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type GitResult, readRecord, recordFile } from './position.ts';
import type { Platform } from './targets.ts';

export const NOW_USAGE = `pnpm agents:sync —— 现在就把这台机器同步到主线最新（规矩、技能、钩子、权限），逐项报结果

用法：
  pnpm agents:sync             取远端、把 fleet-dao 检出快进到主线、跑 agents-sync --apply
  pnpm agents:sync --check     只读：不取远端、不快进、不写，只报这台和检出里现有的差在哪
  pnpm agents:sync --offline   不取远端（取不到时用），按检出里现有的主线同步
  pnpm agents:sync --repo <目录>   指定 fleet-dao 检出（默认：~/.fleet-dao/synced.json 记的，再没有就是本脚本所在的检出）

已开着的 AI 会话读的是开场时的规矩，同步完要重开会话才生效。
退出码：0 都对；1 前置条件不满足或有没做成的；2 有没查成的；64 用法不对。
`;

export interface NowDeps {
  home: string;
  platform: Platform;
  /** 本脚本所在的检出 */
  defaultRepo: string;
  /** 在 repo 里跑一条 git（读）：超时 15 秒 */
  git: (repo: string, args: string[]) => GitResult;
  /** 取远端：比读慢，超时另算 */
  fetch: (repo: string) => GitResult;
  /** 用检出里的 agents-sync 跑一遍，输出直接给用户看；返回退出码，跑不起来是错误 */
  sync: (repo: string, mode: '--apply' | '--check') => { status: number | null; error?: Error | undefined };
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface Args {
  mode: '--apply' | '--check';
  offline: boolean;
  repo?: string;
}

function parse(argv: readonly string[]): Args | 'help' | string {
  const out: Args = { mode: '--apply', offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return 'help';
    if (a === '--check') out.mode = '--check';
    else if (a === '--offline') out.offline = true;
    else if (a === '--repo') {
      const v = argv[++i];
      if (!v) return '--repo 后面要跟目录';
      out.repo = v;
    } else return `认不出的参数 ${a}`;
  }
  return out;
}

const short = (sha: string): string => sha.slice(0, 7);
const ok = (r: GitResult): boolean => r.status === 0 && !r.error;

/** 一条 git 为什么没成：超时、起不来，或者第一行输出；Windows 上程序没起来会给很大的退出码 */
function why(r: GitResult): string {
  if (r.error) return (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? '超时' : r.error.message;
  const first = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (first) return first;
  if (typeof r.status === 'number' && r.status > 0x7fffffff)
    return `退出码 ${r.status}（0x${r.status.toString(16).toUpperCase()}，Windows 上程序没起来，多半缺 DLL）`;
  return `退出码 ${r.status}`;
}

/** git 自己没跑起来（起不来、超时、没有退出码），和「git 说这里不是仓」（退出码 128）是两回事 */
const broken = (r: GitResult): boolean =>
  r.error !== undefined || typeof r.status !== 'number' || (r.status !== 0 && r.status !== 128);

export function syncNow(argv: readonly string[], deps: NowDeps): number {
  const args = parse(argv);
  if (args === 'help') {
    deps.stdout(NOW_USAGE);
    return 0;
  }
  if (typeof args === 'string') {
    deps.stderr(`${args}\n\n${NOW_USAGE}`);
    return 64;
  }
  const fail = (msg: string): number => {
    deps.stderr(`一键同步没做：${msg}\n`);
    return 1;
  };

  let repo = args.repo;
  if (repo === undefined) {
    const rec = readRecord(recordFile(deps.home, deps.platform).file);
    if (!rec.ok) return fail(`~/.fleet-dao/synced.json ${rec.why}；用 --repo <fleet-dao 检出> 指定`);
    repo = rec.value?.repo ?? deps.defaultRepo;
  }
  if (!existsSync(join(repo, 'packages', 'agents-sync', 'bin', 'agents-sync')))
    return fail(`${repo} 不是 fleet-dao 检出（没有 packages/agents-sync）；用 --repo <fleet-dao 检出> 指定`);
  const g = (...a: string[]): GitResult => deps.git(repo as string, a);

  if (args.mode === '--apply') {
    const inside = g('rev-parse', '--is-inside-work-tree');
    if (broken(inside)) return fail(`这台的 git 跑不起来（${why(inside)}），没法核对检出 ${repo}`);
    if (!ok(inside) || inside.stdout.trim() !== 'true') return fail(`${repo} 不是 git 仓（${why(inside)}）`);
    if (!args.offline) {
      const f = deps.fetch(repo);
      if (!ok(f))
        return fail(`在 ${repo} 取远端失败（${why(f)}）；网络不通时加 --offline，按检出里现有的主线同步`);
    }
    const origin = g('rev-parse', '-q', '--verify', 'refs/remotes/origin/main^{commit}');
    if (!ok(origin)) return fail(`${repo} 里没有 origin/main`);
    const branch = g('branch', '--show-current').stdout.trim();
    if (branch !== 'main')
      return fail(
        `检出 ${repo} 不在 main 上（在 ${branch || '分离头'}），不拿别的分支同步；到 main 的检出里跑，或用 --repo 指到它`,
      );
    const want = origin.stdout.trim();
    let head = g('rev-parse', 'HEAD').stdout.trim();
    if (head !== want) {
      if (g('status', '--porcelain', '--untracked-files=no').stdout.trim() !== '')
        return fail(`检出 ${repo} 的 main 有没提交的改动，快进不了`);
      const ff = g('merge', '--ff-only', '-q', 'refs/remotes/origin/main');
      if (!ok(ff)) return fail(`检出 ${repo} 的 main 快进不了（${why(ff)}），和 origin/main 分叉了？`);
      head = g('rev-parse', 'HEAD').stdout.trim();
      if (head !== want)
        return fail(`检出 ${repo} 的 main（${short(head)}）和 origin/main（${short(want)}）对不上`);
    }
    if (g('status', '--porcelain', '--', 'AGENTS.md', 'agents').stdout.trim() !== '')
      return fail(`检出 ${repo} 里 AGENTS.md 或 agents/ 有没提交的改动，不拿它们同步`);
    deps.stdout(`检出 ${repo} 在主线 ${short(head)}，开始同步……\n`);
  }

  const r = deps.sync(repo, args.mode);
  if (r.error || r.status === null) {
    deps.stderr(`一键同步没跑成：agents-sync 起不来（${r.error?.message ?? '没有退出码'}）\n`);
    return 1;
  }
  if (r.status === 0) {
    deps.stdout(
      args.mode === '--apply'
        ? '一键同步完成：逐项结果见上面，每家一行。已开着的 AI 会话读的是开场时的规矩，重开会话才生效。\n'
        : '只读检查完成：逐项结果见上面。\n',
    );
    return 0;
  }
  deps.stderr(
    `一键同步没全成（agents-sync 退出码 ${r.status}）：看上面标 ✗ 的（没做成、漂移、缺失）和标 … 的（没查成）几行。\n`,
  );
  return r.status === 2 ? 2 : 1;
}

/** 真的 git：读 15 秒，取远端 60 秒 */
export function realGit(timeoutMs: number): (repo: string, args: string[]) => GitResult {
  return (repo, args) => {
    const r = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
}

/** 真的 agents-sync：用检出里的那份（快进过的主线），输出直接接到终端 */
export function realSync(
  repo: string,
  mode: '--apply' | '--check',
): { status: number | null; error?: Error } {
  const bin = join(repo, 'packages', 'agents-sync', 'bin', 'agents-sync');
  const r = spawnSync(process.execPath, [bin, mode, '--repo', repo], { stdio: 'inherit', windowsHide: true });
  return { status: r.status, ...(r.error ? { error: r.error } : {}) };
}
