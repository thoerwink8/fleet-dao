// pnpm check 的判法（入口 bin/check.ts）：本机默认只做「改到的」，--all 才全量测试。
// 四样：格式（biome）、类型（tsc -b）、测试（默认 = pnpm test:changed 的判法，相对 origin/main、含未提交改动；--all = vitest run 全部）、
// 卫生检查。四样都跑完再统一判红：一样红不跳过后面的；每样报耗时和结论。
// 任何一样没跑成（起不来、被信号杀掉、test:changed 没算出改到什么或本机拒跑全量）都算红、写明原因，不当成通过。
// 全量测试和 CI 重复、本机要 8 分钟以上，所以不是默认；CI 自己按改动并行跑，不走这里。
// --all 的测试首轮红了会把失败的文件单独重跑一次（withRetry）：忙机偶发超时、Windows EPERM 不算红，但救回的文件会列在汇总里。

export const CHECK_USAGE = '用法：pnpm check [--all]（默认只测改到的；--all 本机全量 vitest run）';

export interface StepRun {
  status: number | null;
  signal?: string | null | undefined;
  error?: Error | undefined;
  /** 首轮失败、单独重跑后通过的测试文件（withRetry 填）：这一步算过，但必须原样列在输出里，不静默吞掉。 */
  rescued?: readonly string[] | undefined;
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
  /** 首轮失败、重跑通过的测试文件。 */
  rescued?: readonly string[];
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

/** vitest --reporter=json 的结果里失败的测试文件，换成相对 root 的 / 路径，排好序去重。认不出结果返回一句为什么。 */
export function failedFilesFromJson(text: string, root: string): string[] | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return `结果文件不是 JSON（${e instanceof Error ? e.message : String(e)}）`;
  }
  const results = (data as { testResults?: unknown } | null)?.testResults;
  if (!Array.isArray(results)) return '结果文件里没有 testResults';
  const base = `${root.replaceAll('\\', '/').replace(/\/+$/, '')}/`;
  const out = new Set<string>();
  for (const r of results as { name?: unknown; status?: unknown }[]) {
    if (r.status !== 'failed' || typeof r.name !== 'string') continue;
    const n = r.name.replaceAll('\\', '/');
    out.add(n.startsWith(base) ? n.slice(base.length) : n);
  }
  return [...out].sort();
}

export interface RetryDeps {
  /** 首轮（整批）。 */
  run: () => StepRun;
  /** 首轮红了之后，读出失败的测试文件（仓内相对路径）；读不出返回一句为什么。 */
  failedFiles: () => string[] | string;
  /** 只跑这几个文件。 */
  rerun: (files: string[]) => StepRun;
  out: (line: string) => void;
}

/**
 * --all 全量测试的重跑（只本机）：忙机上 vitest 偶发 5 秒超时、Windows EPERM 会误红。首轮红了，把失败的测试文件单独重跑一次，
 * 重跑仍红才算红；重跑救回的文件记进 rescued（check 把它们列在输出里，不静默吞掉）。
 * 只在「跑完了、退出码非 0、读得出失败的是哪几个文件」时才重跑：起不来、被信号杀掉、读不出失败清单（崩了没写结果）原样红，不拿重跑冒充。
 * CI 不走这里。
 */
export function withRetry(d: RetryDeps): StepRun {
  const first = d.run();
  if (first.error || first.status === null || first.status === 0) return first;
  const files = d.failedFiles();
  if (typeof files === 'string') {
    d.out(`\n\n没法重跑：读不出首轮失败的是哪些测试文件（${files}），按首轮结果算红`);
    return first;
  }
  if (files.length === 0) {
    d.out(`\n\n没法重跑：首轮红了，但结果里没有失败的测试文件（可能是启动、配置或全局错误），按首轮结果算红`);
    return first;
  }
  const list = files.map((f) => `  ${f}`).join('\n');
  d.out(`\n\n首轮有 ${files.length} 个测试文件失败，单独重跑一次（重跑仍红才算红）：\n${list}`);
  const second = d.rerun(files);
  if (second.status === 0 && !second.error) return { status: 0, rescued: files };
  return second;
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
    let rescued: readonly string[] = [];
    try {
      const run = step.run();
      j = judge(run, notRunCodes);
      rescued = run.rescued ?? [];
      if (rescued.length > 0)
        j = { verdict: j.verdict, detail: `通过（${rescued.length} 个文件首轮失败、重跑通过，见下）` };
    } catch (e) {
      j = { verdict: 'not-run', detail: `没跑成：${e instanceof Error ? e.message : String(e)}` };
    }
    const ms = deps.now() - t0;
    results.push({ name: step.name, verdict: j.verdict, ms, detail: j.detail, rescued });
  }
  deps.out(`\n== 汇总（${parsed.all ? '--all 全量测试' : '只测改到的，全量加 --all'}） ==`);
  for (const r of results) {
    const mark = r.verdict === 'pass' ? 'OK  ' : r.verdict === 'fail' ? '红  ' : '没跑成';
    deps.out(`${mark} ${r.name}  ${(r.ms / 1000).toFixed(1)}s  ${r.detail}`);
  }
  const rescuedAll = results.flatMap((r) => (r.rescued ?? []).map((f) => `${r.name}：${f}`));
  if (rescuedAll.length > 0) {
    deps.out(
      '\n首轮失败、重跑通过的测试文件（可能是忙机超时或 Windows EPERM，也可能是真有偶发问题，请留意）：',
    );
    for (const l of rescuedAll) deps.out(`  ${l}`);
  }
  const bad = results.filter((r) => r.verdict !== 'pass');
  if (bad.length > 0) {
    deps.err(`pnpm check 没过：${bad.map((r) => `${r.name}（${r.detail}）`).join('；')}`);
    return 1;
  }
  deps.out('pnpm check 全部通过');
  return 0;
}
