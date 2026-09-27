// pnpm test:changed 的判法：这次改了哪些文件、跑哪些测试（入口 bin/test-changed.ts）。引擎的交活核对只认会话里跑过它、
// 最后一次通过（specs/164-会话内存与交活测试/）。
// 改动 = 和 origin/main 分叉以来提交了的 + 暂存的 + 没暂存的 + 没跟踪的：会话交活前测的是自己手上的这棵树。
// 跑哪些测试和 CI 按改动跑同一套判法（ci-plan.ts 的 planCi：改到的包和依赖它们的包、测试读的包外文件；根配置、shared、夹具、
// deploy/ 这类改到就全跑），再加上 CI 每个 PR 都跑的 docs job 那两份（ALWAYS_TESTS）。
// 改这里之前必须知道：原先定的是直接跑 vitest --changed origin/main，实现时发现两个洞，所以改成按包选——
// ① 基准分支读不到时 vitest 不报错：它调 git 用的 tinyexec 不抛非零退出码，git diff 失败就当「没提交过改动」，只测没提交的，
//   照样退出 0（本机实测：给个不存在的分支名，它只跑了没提交的那一个测试文件）；
// ② 它只顺着 import 找受影响的测试：引擎的工作流测试跑的是 Temporal 打包器按路径打的包，几个命令行测试另起进程跑，测试直接读的
//   文档、迁移、夹具也不在 import 里——改了引擎的工作流代码，它一个工作流测试都不跑。按包选（有 ci-plan.test.ts 扫测试源码兜着
//   「测试读包外文件」的清单）没有这个洞，代价是比按文件多跑一些。
import { type PackageGraph, planCi } from './ci-plan.ts';

/** 和谁比：引擎给会话的树钉好了这个引用（packages/engine/src/real/user-git.ts 的 pinMainline），本机是 git fetch 来的。 */
export const BASE = 'origin/main';

/** CI 的 docs job 每个 PR 都跑的两份（.github/workflows/ci.yml；test/test-changed.test.ts 核对两边一致）。 */
export const ALWAYS_TESTS: readonly string[] = Object.freeze([
  'packages/conventions/test/doc-pointers.test.ts',
  'agents/test/',
]);

export class TestChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestChangedError';
  }
}

/** 跑一条 git 命令（在仓根）。起不来时 error 有值；status 是退出码（被信号杀掉是 null）。 */
export type GitRun = (args: readonly string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
};

function run(git: GitRun, args: readonly string[], what: string): string {
  const r = git(args);
  if (r.error) throw new TestChangedError(`${what}：git 跑不起来（${r.error.message}）`);
  if (r.status !== 0) {
    const why = r.stderr.trim() || `退出码 ${r.status ?? '（被信号杀掉）'}`;
    throw new TestChangedError(`${what}：git ${args.join(' ')} 没成（${why}）`);
  }
  return r.stdout;
}

const names = (out: string) => out.split('\0').filter((f) => f !== '');

/**
 * 这次改了哪些文件（仓内相对路径，排好序、去重）。git 哪一步没成都抛 TestChangedError，不当成「没改动」：
 * base 读不到（本机没 fetch、引擎的树没钉好）、和 base 没有共同祖先、git 起不来。-z 输出原样的路径（中文文件名不转义）。
 */
export function changedFiles(git: GitRun, base = BASE): string[] {
  if (base.startsWith('-')) throw new TestChangedError(`基准不像分支名：${base}`);
  const verify = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (verify.error) throw new TestChangedError(`认 ${base}：git 跑不起来（${verify.error.message}）`);
  if (verify.status !== 0) {
    throw new TestChangedError(
      `认不出 ${base}：不知道这次改了什么。本机先 git fetch origin；引擎起的会话，树里本该钉好它（没钉好是引擎的毛病，用 fleet blocked 报）`,
    );
  }
  const committed = run(
    git,
    ['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`],
    `算和 ${base} 分叉以来提交了什么`,
  );
  const staged = run(git, ['diff', '--name-only', '-z', '--no-renames', '--cached'], '算暂存了什么');
  const unstaged = run(git, ['diff', '--name-only', '-z', '--no-renames'], '算改了没暂存的');
  const untracked = run(git, ['ls-files', '-z', '--others', '--exclude-standard'], '算没跟踪的新文件');
  return [
    ...new Set([...names(committed), ...names(staged), ...names(unstaged), ...names(untracked)]),
  ].sort();
}

export interface TestSelection {
  /** all：全跑；some：只跑 paths（交给 vitest run 的过滤）。 */
  kind: 'all' | 'some';
  paths: string[];
  /** 为什么这么跑（各文件落到了哪；全跑时是触发全跑的那几条）。 */
  reasons: string[];
  /** CI 还会跑、这里不跑的（给人看，免得以为本机绿了 CI 一定绿）。 */
  ciOnly: string[];
}

/** 跑哪些测试：和 CI 按改动跑同一套判法。依赖图读不出（graph 是一句为什么）照 CI 全跑，不少跑。 */
export function selectTests(changed: readonly string[], graph: PackageGraph | string): TestSelection {
  if (changed.length === 0) {
    return {
      kind: 'some',
      paths: [...ALWAYS_TESTS],
      reasons: ['和 origin/main 比没有改动：只跑 CI 每次都跑的文档检查'],
      ciOnly: [],
    };
  }
  const plan = planCi({ event: 'pull_request', changed, graph });
  const ciOnly = [
    ...(plan.lint ? ['格式和类型（biome、tsc）'] : []),
    ...(plan.web ? ['演示版打包'] : []),
    ...(plan.deploy === 'none'
      ? []
      : [`装机测试（deploy/test/run.sh${plan.deploy === 'ops' ? ' --ops' : ''}）`]),
  ];
  if (plan.full) return { kind: 'all', paths: [], reasons: plan.reasons, ciOnly };
  const paths = [...new Set([...plan.tests.flatMap((s) => s.args), ...ALWAYS_TESTS])];
  return { kind: 'some', paths, reasons: plan.reasons, ciOnly };
}

/** 交给 vitest 的参数（不含 vitest 本身）。 */
export function vitestArgs(selection: TestSelection): string[] {
  return selection.kind === 'all' ? ['run'] : ['run', ...selection.paths];
}
