// pnpm check 的判法（入口 bin/check.ts）：本机默认只做「改到的」，--all 才全量测试。
// 四样：格式（biome）、类型（tsc -b）、测试（默认 = pnpm test:changed 的判法，相对 origin/main、含未提交改动；--all = vitest run 全部）、
// 卫生检查。四样都跑完再统一判红：一样红不跳过后面的；每样报耗时和结论。
// 任何一样没跑成（起不来、被信号杀掉、test:changed 没算出改到什么或本机拒跑全量）都算红、写明原因，不当成通过。
// 全量测试和 CI 重复、本机要 8 分钟以上，所以不是默认；CI 自己按改动并行跑，不走这里。

export const CHECK_USAGE = '用法：pnpm check [--all]（默认只测改到的；--all 本机全量 vitest run）';

export interface StepRun {
  status: number | null;
  signal?: string | null | undefined;
  error?: Error | undefined;
}

export interface Step {
  name: string;
  /** 真的去跑（子进程输出直通终端）。 */
  run: () => StepRun;
}

export type StepVerdict = 'pass' | 'fail' | 'not-run';

export interface StepResult {
  name: string;
  verdict: StepVerdict;
  ms: number;
  detail: string;
}

/** 解析参数：只收 --all；pnpm 可能把分隔的 `--` 原样传进来，去掉。 */
export function parseCheckArgs(argv: readonly string[]): { all: boolean } | { error: string } {
  let all = false;
  const extra: string[] = [];
  for (const a of argv) {
    if (a === '--') continue;
    if (a === '--all') all = true;
    else extra.push(a);
  }
  if (extra.length > 0) return { error: `不认识的参数：${extra.join(' ')}。${CHECK_USAGE}` };
  return { all };
}

/** 一样的结论：退出码 0 过；起不来、被信号杀掉没跑成；其余退出码红。test:changed 的 2、3 是「没算成 / 本机拒跑全量」，也是没跑成。 */
export function judge(
  r: StepRun,
  notRunCodes: readonly number[] = [],
): { verdict: StepVerdict; detail: string } {
  if (r.error) return { verdict: 'not-run', detail: `没跑成：起不来（${r.error.message}）` };
  if (r.status === null)
    return { verdict: 'not-run', detail: `没跑成：被信号 ${r.signal ?? '（不知道哪个）'} 杀掉` };
  if (r.status === 0) return { verdict: 'pass', detail: '通过' };
  if (notRunCodes.includes(r.status))
    return { verdict: 'not-run', detail: `没跑成：退出码 ${r.status}（原因见上面输出）` };
  return { verdict: 'fail', detail: `没过：退出码 ${r.status}` };
}

export interface CheckDeps {
  argv: readonly string[];
  /** 按是否全量给出四样的步骤；notRunCodes 是该步里「没跑成」的退出码。 */
  steps: (all: boolean) => { step: Step; notRunCodes?: readonly number[] }[];
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 回进程退出码：0 四样都过；1 有没过的或没跑成的；2 参数不对。 */
export function check(deps: CheckDeps): number {
  const parsed = parseCheckArgs(deps.argv);
  if ('error' in parsed) {
    deps.err(`check 没跑成：${parsed.error}`);
    return 2;
  }
  const results: StepResult[] = [];
  for (const { step, notRunCodes } of deps.steps(parsed.all)) {
    deps.out(`\n== ${step.name} ==`);
    const t0 = deps.now();
    let j: { verdict: StepVerdict; detail: string };
    try {
      j = judge(step.run(), notRunCodes);
    } catch (e) {
      j = { verdict: 'not-run', detail: `没跑成：${e instanceof Error ? e.message : String(e)}` };
    }
    const ms = deps.now() - t0;
    results.push({ name: step.name, verdict: j.verdict, ms, detail: j.detail });
  }
  deps.out(`\n== 汇总（${parsed.all ? '--all 全量测试' : '只测改到的，全量加 --all'}） ==`);
  for (const r of results) {
    const mark = r.verdict === 'pass' ? 'OK  ' : r.verdict === 'fail' ? '红  ' : '没跑成';
    deps.out(`${mark} ${r.name}  ${(r.ms / 1000).toFixed(1)}s  ${r.detail}`);
  }
  const bad = results.filter((r) => r.verdict !== 'pass');
  if (bad.length > 0) {
    deps.err(`pnpm check 没过：${bad.map((r) => `${r.name}（${r.detail}）`).join('；')}`);
    return 1;
  }
  deps.out('pnpm check 全部通过');
  return 0;
}
