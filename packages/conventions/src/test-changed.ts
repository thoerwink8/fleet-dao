// pnpm test:changed 的判法：这次改了哪些文件、跑哪些测试（入口 bin/test-changed.ts）。引擎的交活核对只认会话里跑过它、
// 最后一次通过（specs/164-会话内存与交活测试/）。
// 改动 = 和 origin/main 分叉以来提交了的 + 暂存的 + 没暂存的 + 没跟踪的：会话交活前测的是自己手上的这棵树。
// 跑哪些测试和 CI 按改动跑同一套判法（ci-plan.ts 的 planCi：改到的包和依赖它们的包、测试读的包外文件；根配置、shared、夹具、
// deploy/ 这类改到就全跑）；要全跑、本机又不全跑时先跑的那份也从同一份判法算（ci-plan.ts 的 fallbackUnits），这里不另写
// 「改动落在哪」。两种都带上 CI 每个 PR 都跑的那几份（ci-plan.ts 的 ALWAYS_TESTS），拒跑时也不例外（#740）。
// 改这里之前必须知道：原先定的是直接跑 vitest --changed origin/main，实现时发现两个洞，所以改成按包选——
// ① 基准分支读不到时 vitest 不报错：它调 git 用的 tinyexec 不抛非零退出码，git diff 失败就当「没提交过改动」，只测没提交的，
//   照样退出 0（本机实测：给个不存在的分支名，它只跑了没提交的那一个测试文件）；
// ② 它只顺着 import 找受影响的测试：引擎的工作流测试跑的是 Temporal 打包器按路径打的包，几个命令行测试另起进程跑，测试直接读的
//   文档、迁移、夹具也不在 import 里——改了引擎的工作流代码，它一个工作流测试都不跑。按包选（有 ci-plan.test.ts 扫测试源码兜着
//   「测试读包外文件」的清单）没有这个洞，代价是比按文件多跑一些。
import {
  ALWAYS_TESTS,
  type Fallback,
  fallbackUnits,
  type PackageGraph,
  planCi,
  unitPath,
} from './ci-plan.ts';

/** 和谁比：引擎给会话的树钉好了这个引用（packages/engine/src/real/user-git.ts 的 pinMainline），本机是 git fetch 来的。 */
export const BASE = 'origin/main';

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

/** 要全跑、本机又不全跑时先跑的：fallbackUnits 算出的单元落成交给 vitest 的过滤，hubs、dependents 原样带着给人看。 */
export interface LocalRun extends Fallback {
  /** 交给 vitest run 的过滤：units 的目录，加上 CI 每次都跑的 ALWAYS_TESTS。 */
  paths: string[];
}

interface SelectionCommon {
  /** 为什么这么跑（各文件落到了哪；全跑时是触发全跑的那几条）。 */
  reasons: string[];
  /** CI 还会跑、这里不跑的（给人看，免得以为本机绿了 CI 一定绿）。 */
  ciOnly: string[];
}

/** some：只跑 paths（交给 vitest run 的过滤）；all：全跑，本机不全跑时先跑 local。 */
export type TestSelection =
  | (SelectionCommon & { kind: 'some'; paths: string[] })
  | (SelectionCommon & { kind: 'all'; local: LocalRun });

/**
 * 交给 vitest 的过滤：单元的目录，再加 CI 每次都跑的 ALWAYS_TESTS。
 * 本机不按耗时装箱（CI 是「单元 → 测试文件 → 装台」，bin/ci-plan.ts）：不是 4 核运行机，几台并行跑反而把机器拖满。
 * vitest 的过滤是子串、一个文件只跑一次，所以 agents/ 和 agents/test/ 都在也不重跑；没有测试的包（shared）混在里面也不报错。
 */
function vitestPaths(units: readonly string[]): string[] {
  return [...new Set([...units.map(unitPath), ...ALWAYS_TESTS])];
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
    ...(plan.biome ? ['格式和类型（biome、tsc）'] : []),
    ...(plan.web ? ['演示版打包'] : []),
    ...(plan.e2e ? ['驾驶舱 e2e（pnpm --filter @fleet-dao/web e2e，要真 Postgres，见 packages/web/e2e/README.md）'] : []),
    ...(plan.deploy === 'none'
      ? []
      : [`装机测试（deploy/test/run.sh${plan.deploy === 'ops' ? ' --ops' : ''}）`]),
  ];
  if (!plan.full) return { kind: 'some', paths: vitestPaths(plan.testUnits), reasons: plan.reasons, ciOnly };
  const fallback = fallbackUnits(changed, graph);
  return {
    kind: 'all',
    local: { ...fallback, paths: vitestPaths(fallback.units) },
    reasons: plan.reasons,
    ciOnly,
  };
}

/** 交给 vitest 的参数（不含 vitest 本身）。 */
export function vitestArgs(selection: TestSelection): string[] {
  return selection.kind === 'all' ? ['run'] : ['run', ...selection.paths];
}

// ---- 要全跑时本机跑不跑（创始人的规矩：几个会话同时全跑会把机器拖满，全量交给 CI；只写在 AGENTS.md 里拦不住，
// 三个工人照样在本机跑了全量，所以拦在这个必经的入口上）

/** 退出码：0 过；1 没过（含 vitest 被信号杀掉）；2 没算成要跑什么、参数不对、vitest 起不来；3 本机要全跑、没带 --all，没跑。 */
export const REFUSED_FULL_RUN = 3;

/**
 * 引擎起的会话环境里都带这个标记（@fleet-dao/adapters 的 RUN_MARKER_KEY，engine 的测试核对两边一致）。会话要全跑时照旧全跑：
 * 交活只认 test:changed 最后一次通过，拒跑就永远交不了活；会话在有内存上限的 scope 里，测试进程数按上限算（test-run.ts），
 * 全跑慢一些，拖不垮机器。
 */
export const ENGINE_SESSION_MARKER = 'FLEET_RUN_ID';

export const USAGE_LINE =
  '用法：pnpm test:changed [--all]（不带参数：按改动选测试；要全跑时本机不跑、退出码 3，带 --all 才在本机全跑）';

export type RunDecision =
  | { kind: 'run'; args: string[]; note?: string }
  | { kind: 'refuse'; code: number; lines: string[] };

/** CI 的环境（GitHub Actions 设 CI=true）。 */
function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.CI?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== 'false' && v !== '0';
}

/** 拒跑时打给人看的：本机先跑的那一条命令、依赖 hubs 的（CI 全跑会测到）、真要全跑怎么说。 */
function refuseLines(local: LocalRun): string[] {
  const lines = [
    '要全跑（原因见上面几行：改到了根配置、锁文件、shared 这类），本机不跑全量——几个会话同时全跑会把机器拖满，全量交给 CI。',
    '本机先跑这一条（和 CI 同一份判法，只是不升成全跑：改到的包和依赖它们的、测试读到改动的，再加 CI 每个 PR 都跑的 docs 那几份）：',
    `  pnpm exec vitest run ${local.paths.join(' ')}`,
  ];
  if (typeof local.dependents === 'string') {
    lines.push(`${local.dependents}：CI 全跑会测到。`);
  } else if (local.dependents.length > 0) {
    lines.push(
      `依赖 ${local.hubs.join('、')} 的也要跑——本机不逐个跑，CI 全跑会测到：${local.dependents.join('、')}（想先在本机测哪个：pnpm exec vitest run packages/<包>/）`,
    );
  }
  lines.push('真要在本机全跑：pnpm test:changed --all');
  lines.push(`没跑测试，退出码 ${REFUSED_FULL_RUN}（不是测试没过）。`);
  return lines;
}

/**
 * 跑不跑、跑什么。只在「判出要全跑、没带 --all、不在 CI、不是引擎会话」时拒跑：写明原因、本机先跑的那一条命令
 * （selection.local）、留给 CI 的那些、真要全跑怎么说，退出码 REFUSED_FULL_RUN。带 --all 就全跑（明说了要）。
 */
export function decideRun(input: {
  selection: TestSelection;
  all: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): RunDecision {
  const { selection, env } = input;
  if (input.all) return { kind: 'run', args: ['run'], note: '带了 --all：本机全跑' };
  if (selection.kind === 'some') return { kind: 'run', args: vitestArgs(selection) };
  if (inCi(env)) return { kind: 'run', args: ['run'], note: '在 CI 里：全跑' };
  if (env[ENGINE_SESSION_MARKER]?.trim()) {
    return {
      kind: 'run',
      args: ['run'],
      note: '引擎起的会话：照旧全跑（交活只认它；会话有内存上限，测试进程数按上限算）',
    };
  }
  return { kind: 'refuse', code: REFUSED_FULL_RUN, lines: refuseLines(selection.local) };
}

export interface TestChangedDeps {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  git: GitRun;
  graph: () => PackageGraph | string;
  /** 跑 vitest（参数不含 vitest 本身）：回退出码；被信号杀掉 status 是 null；起不来 error 有值。 */
  vitest: (args: string[]) => { status: number | null; signal?: string | null; error?: Error | undefined };
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 入口的全部逻辑（bin/test-changed.ts 只接上真的 git、仓、vitest）：回进程的退出码，见 REFUSED_FULL_RUN 上面那行。 */
export function testChanged(deps: TestChangedDeps): number {
  const extra = deps.argv.filter((a) => a !== '--all');
  if (extra.length > 0) {
    deps.err(
      `test:changed 没跑成：只收 --all，不收别的参数（给了：${extra.join(' ')}）。跑哪些由改动决定；要单跑几个文件用 pnpm exec vitest run <路径>。${USAGE_LINE}`,
    );
    return 2;
  }
  let changed: string[];
  try {
    changed = changedFiles(deps.git);
  } catch (e) {
    if (!(e instanceof TestChangedError)) throw e;
    deps.err(`test:changed 没跑成：${e.message}`);
    return 2;
  }
  const selection = selectTests(changed, deps.graph());
  deps.out(`和 ${BASE} 比改了 ${changed.length} 个文件（含没提交的）`);
  for (const reason of selection.reasons) deps.out(`- ${reason}`);
  if (selection.ciOnly.length > 0) deps.out(`CI 另外还跑（这里不跑）：${selection.ciOnly.join('、')}`);
  const decision = decideRun({ selection, all: deps.argv.includes('--all'), env: deps.env });
  if (decision.kind === 'refuse') {
    for (const line of decision.lines) deps.err(line);
    return decision.code;
  }
  if (decision.note) deps.out(decision.note);
  deps.out(decision.args.length === 1 ? '跑：全部测试' : `跑：${decision.args.slice(1).join(' ')}`);
  const r = deps.vitest(decision.args);
  if (r.error) {
    deps.err(`test:changed 没跑成：vitest 起不来（${r.error.message}）`);
    return 2;
  }
  if (r.status === null) {
    deps.err(`vitest 被信号 ${r.signal ?? '（不知道哪个）'} 杀掉了：测试没跑完，不算通过`);
    return 1;
  }
  return r.status;
}
