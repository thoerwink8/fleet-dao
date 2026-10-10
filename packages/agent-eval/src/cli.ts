// 命令行：pnpm agent-eval [--case <名>] [--scenario <名>] [--model haiku|sonnet|opus|all] [--effort <档>] [--repeat N] [--dry-run] [--out <目录>]
// --effort 盖过定义里的 effort（low、medium、high、xhigh、max），换档之前先试 effort 用；不给就照定义。
// 退出码：全跑成了是 0（不管过不过）；有没跑成的是 2；参数不对、没选出题是 1。一次只跑一个会话，不并行。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ALL_CASES } from './cases/index.ts';
import { type AgentDefinition, loadAgentDefinitions } from './definitions.ts';
import {
  buildSessionArgs,
  claudeCommand,
  displayArgs,
  EFFORT_LEVELS,
  type EffortLevel,
  type Launcher,
  MODEL_IDS,
  MODEL_KEYS,
  type ModelKey,
  realLauncher,
} from './launcher.ts';
import { renderReport } from './report.ts';
import { type CaseResult, runCase } from './runner.ts';
import type { EvalCase } from './types.ts';
import { REPO_ROOT, SKIPPED_SCENARIOS } from './types.ts';

export const USAGE =
  '用法：pnpm agent-eval [--case <名>] [--scenario <名>] [--model haiku|sonnet|opus|all] [--effort low|medium|high|xhigh|max] [--repeat N] [--dry-run] [--out <目录>]';

export interface CliArgs {
  caseName: string | undefined;
  scenario: string | undefined;
  models: ModelKey[];
  /** 盖过定义里的 effort；不给是 undefined（照定义）。 */
  effort: EffortLevel | undefined;
  dryRun: boolean;
  repeat: number;
  out: string | undefined;
  help: boolean;
}

export class UsageError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const a: CliArgs = {
    caseName: undefined,
    scenario: undefined,
    models: [...MODEL_KEYS],
    effort: undefined,
    dryRun: false,
    repeat: 1,
    out: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} 后面要跟值`);
      return v;
    };
    if (flag === '--case') a.caseName = value();
    else if (flag === '--scenario') a.scenario = value();
    else if (flag === '--out') a.out = value();
    else if (flag === '--repeat') {
      const v = value();
      if (!/^[1-9][0-9]*$/.test(v)) throw new UsageError(`--repeat 要正整数：${v}`);
      a.repeat = Number(v);
    } else if (flag === '--effort') {
      const v = value();
      if (!(EFFORT_LEVELS as readonly string[]).includes(v))
        throw new UsageError(`--effort 只认 ${EFFORT_LEVELS.join('、')}：${v}`);
      a.effort = v as EffortLevel;
    } else if (flag === '--dry-run') a.dryRun = true;
    else if (flag === '--help' || flag === '-h') a.help = true;
    else if (flag === '--model') {
      const v = value();
      if (v === 'all') a.models = [...MODEL_KEYS];
      else if ((MODEL_KEYS as readonly string[]).includes(v)) a.models = [v as ModelKey];
      else throw new UsageError(`--model 只认 haiku、sonnet、opus、all：${v}`);
    } else throw new UsageError(`不认识的参数：${flag}`);
  }
  return a;
}

export function selectCases(all: readonly EvalCase[], a: Pick<CliArgs, 'caseName' | 'scenario'>): EvalCase[] {
  const picked = all.filter(
    (c) =>
      (!a.caseName || c.id === a.caseName || c.name === a.caseName) &&
      (!a.scenario || c.scenario === a.scenario),
  );
  if (picked.length === 0)
    throw new UsageError(`没有选出题：--case ${a.caseName ?? '（空）'} --scenario ${a.scenario ?? '（空）'}`);
  return picked;
}

/** 要起几次会话：每题每模型一次，加上用 LLM 打分的题每次再一次裁判会话。 */
export function sessionCount(
  cases: readonly EvalCase[],
  models: readonly ModelKey[],
  repeat = 1,
): { run: number; judge: number } {
  return {
    run: cases.length * models.length * repeat,
    judge: cases.filter((c) => c.usesJudge).length * models.length * repeat,
  };
}

export function dryRunLines(
  cases: readonly EvalCase[],
  models: readonly ModelKey[],
  defs: ReadonlyMap<string, AgentDefinition>,
  command: string,
  repeat = 1,
  effort?: EffortLevel,
): string[] {
  const lines = ['子代理能力探查（--dry-run：只列，不起会话）', `命令：${command}`];
  const total = cases.length * models.length;
  let n = 0;
  for (const c of cases) {
    for (const m of models) {
      n++;
      const def = defs.get(c.agent);
      lines.push(
        `[${n}/${total}] ${c.id} · ${c.agent} · ${MODEL_IDS[m]}${c.usesJudge ? ' · 加一次裁判会话' : ''}`,
      );
      lines.push(
        `  目录：临时目录（${c.source.kind === 'repo' ? `git archive ${c.source.commit} 的快照` : '夹具拷贝'}）`,
      );
      lines.push(
        def
          ? `  参数：${displayArgs(buildSessionArgs(def, MODEL_IDS[m], effort)).join(' ')}`
          : `  参数：没找到定义 ${c.agent}`,
      );
      lines.push(`  stdin：提示词 ${c.prompt.length} 字；限时 10 分钟`);
    }
  }
  const s = sessionCount(cases, models, repeat);
  lines.push(
    `合计：${cases.length} 道题 × ${models.length} 个模型${repeat > 1 ? ` × ${repeat} 遍` : ''} = ${s.run} 次被测会话，加 ${s.judge} 次裁判会话，共 ${s.run + s.judge} 次，一次一个、不并行`,
  );
  for (const k of SKIPPED_SCENARIOS) lines.push(`不做：${k.scenario}（${k.agent}）：${k.reason}`);
  return lines;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface CliDeps {
  launch?: Launcher;
  cases?: readonly EvalCase[];
  definitionsDir?: string;
  repoRoot?: string;
  now?: () => Date;
  log?: (line: string) => void;
  err?: (line: string) => void;
}

export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  let args: CliArgs;
  let cases: EvalCase[];
  try {
    args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return 0;
    }
    cases = selectCases(deps.cases ?? ALL_CASES, args);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n${USAGE}`);
      return 1;
    }
    throw e;
  }
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  let defs: Map<string, AgentDefinition>;
  try {
    defs = new Map(
      loadAgentDefinitions(deps.definitionsDir ?? join(repoRoot, '.claude', 'agents')).map((d) => [
        d.name,
        d,
      ]),
    );
  } catch (e) {
    err(`读不到或认不出子代理定义：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const command = claudeCommand();
  if (args.dryRun) {
    for (const l of dryRunLines(cases, args.models, defs, command, args.repeat, args.effort)) log(l);
    return 0;
  }

  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const outDir = resolve(args.out ?? join(repoRoot, '_tmp', 'agent-eval', stamp(startedAt)));
  mkdirSync(outDir, { recursive: true });
  const results: CaseResult[] = [];
  const write = () => {
    writeFileSync(
      join(outDir, 'results.json'),
      `${JSON.stringify({ startedAt: startedAt.toISOString(), models: args.models, effort: args.effort ?? null, skipped: SKIPPED_SCENARIOS, results }, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'report.md'),
      renderReport(results, {
        startedAt: startedAt.toISOString(),
        models: args.models,
        effort: args.effort ?? null,
      }),
    );
  };
  const total = cases.length * args.models.length * args.repeat;
  for (const c of cases) {
    for (const m of args.models) {
      for (let attempt = 1; attempt <= args.repeat; attempt++) {
        log(
          `[${results.length + 1}/${total}] ${c.id} · ${MODEL_IDS[m]}${args.repeat > 1 ? ` · 第 ${attempt} 遍` : ''} …`,
        );
        const r = await runCase(c, m, {
          launch: deps.launch ?? realLauncher,
          defs,
          command,
          outDir,
          attempt,
          ...(args.effort === undefined ? {} : { effort: args.effort }),
        });
        results.push(r);
        log(
          `  ${r.status === 'pass' ? '过' : r.status === 'fail' ? '没过' : r.status === 'model-mismatch' ? '模型对不上' : '没跑成'}：${r.reason.slice(0, 200)}`,
        );
        write();
      }
    }
  }
  write();
  const notRun = results.filter((r) => r.status === 'not-run' || r.status === 'model-mismatch').length;
  log(
    `跑完：${results.length} 条，过 ${results.filter((r) => r.pass).length}，没过 ${results.filter((r) => r.status === 'fail').length}，没跑成 ${notRun}。结果在 ${outDir}`,
  );
  return notRun > 0 ? 2 : 0;
}
