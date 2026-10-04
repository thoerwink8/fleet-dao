// CI 一台测试（.github/workflows/ci.yml 的 test job 矩阵里的一份，test-split.ts 装的箱）：认矩阵、跑完核对。入口 bin/ci-box.ts。
// 改这里之前必须知道：
// - vitest 的位置参数是子串过滤，交给它明确的文件清单也不等于它就正好跑这些（装箱时已按名字把会互相拉上的放在一台，
//   这里是最后一道）：报告里实际跑的文件集合必须正好等于该跑的，多了、少了都红，并写清是哪些——没跑成不许当通过。
// - 命中 PR 缓存的台（ci-cache.ts）：该跑的 = 交接文件里的 run，缓存盖住的 covered 加 run 必须正好是分到的这一台。
// - 这里判「这一台跑全了」，和 ci-plan.ts 一样在 high-risk-paths.json 里（先审后合）。
import { parseState } from './ci-cache.ts';
import { isTestFile, type TestBox } from './test-split.ts';

const SAFE_PATH = /^[^\s\p{Cc}]+$/u;

/** 认矩阵里的那一台（ci.yml 用 toJSON(matrix) 原样交来）。认不出返回一句为什么（调用方判红）。 */
export function parseBox(text: string): TestBox | string {
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return '矩阵里这一台不是 JSON';
  }
  const x = b as Partial<TestBox> | null;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return '矩阵里这一台不是对象';
  if (typeof x.label !== 'string' || x.label === '') return '矩阵里这一台没有名字';
  if (!Array.isArray(x.files) || x.files.length === 0) return `${x.label}：没有文件清单`;
  const seen = new Set<string>();
  for (const f of x.files as unknown[]) {
    if (typeof f !== 'string' || !SAFE_PATH.test(f) || !isTestFile(f)) {
      return `${x.label}：清单里有一项不是测试文件：${JSON.stringify(f)}`;
    }
    if (seen.has(f)) return `${x.label}：清单里 ${f} 出现了两次`;
    seen.add(f);
  }
  if (typeof x.estMs !== 'number' || !Number.isFinite(x.estMs)) return `${x.label}：没有估计耗时`;
  if (typeof x.pg !== 'boolean' || typeof x.temporal !== 'boolean')
    return `${x.label}：pg / temporal 开关认不出`;
  return { label: x.label, files: [...x.files].sort(), estMs: x.estMs, pg: x.pg, temporal: x.temporal };
}

/** 缓存模式（ci-cache.ts 的 plan 步给的）；空 = 没走缓存（主线推送、缓存没开），整台照跑。 */
export const VERIFY_MODES = ['', 'all', 'files', 'none'] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

export interface VerifyInput {
  /** 矩阵里分到这一台的文件。 */
  assigned: readonly string[];
  mode: VerifyMode;
  /** vitest JSON 报告里出现的文件（仓内相对）；mode 是 none 时没跑 vitest，应当是 undefined。 */
  reported: ReadonlySet<string> | undefined;
  /** 缓存交接文件（mode 是 files / none 时要它认哪些是盖住的）。 */
  stateText: string | undefined;
}

export interface VerifyResult {
  ok: boolean;
  /** 对不上的地方，一条一句。 */
  problems: string[];
  /** 对得上时给人看的一句。 */
  lines: string[];
}

const list = (xs: readonly string[]) =>
  `${xs.slice(0, 10).join('、')}${xs.length > 10 ? ` 等 ${xs.length} 个` : ''}`;

/** 实际跑的 == 该跑的；命中缓存的，盖住的 + 跑的 == 分到的。 */
export function verifyRun(input: VerifyInput): VerifyResult {
  const problems: string[] = [];
  const assigned = new Set(input.assigned);
  let shouldRun: Set<string>;
  let covered: string[] = [];
  if (input.mode === '' || input.mode === 'all') {
    shouldRun = assigned;
  } else {
    const state = parseState(input.stateText);
    if (typeof state === 'string') {
      return {
        ok: false,
        problems: [`缓存模式是 ${input.mode}，可交接文件认不出（${state}）：不知道哪些是盖住的`],
        lines: [],
      };
    }
    if (state.mode !== input.mode)
      problems.push(`交接文件里的模式是 ${state.mode}，这一步拿到的是 ${input.mode}`);
    covered = state.covered;
    shouldRun = new Set(input.mode === 'none' ? [] : state.run);
    const both = state.run.filter((f) => covered.includes(f));
    if (both.length > 0) problems.push(`既算盖住又算要跑：${list(both)}`);
    const union = new Set([...covered, ...shouldRun]);
    const lost = [...assigned].filter((f) => !union.has(f)).sort();
    const foreign = [...union].filter((f) => !assigned.has(f)).sort();
    if (lost.length > 0) problems.push(`分到这一台、却既没跑也没被缓存盖住：${list(lost)}`);
    if (foreign.length > 0) problems.push(`缓存交接文件里有不是分到这一台的：${list(foreign)}`);
  }
  if (input.mode === 'none') {
    if (input.reported !== undefined && input.reported.size > 0) {
      problems.push(`缓存说整台都盖住了、不跑 vitest，报告里却跑了 ${input.reported.size} 个文件`);
    }
  } else if (input.reported === undefined) {
    problems.push('没有 vitest 的报告：跑没跑、跑了哪些都不知道');
  } else {
    const reported = input.reported;
    const missing = [...shouldRun].filter((f) => !reported.has(f)).sort();
    const extra = [...reported].filter((f) => !shouldRun.has(f)).sort();
    if (missing.length > 0)
      problems.push(`少跑了 ${missing.length} 个（分到了、报告里没有）：${list(missing)}`);
    if (extra.length > 0) {
      problems.push(
        `多跑了 ${extra.length} 个（报告里有、不该这一台跑，vitest 的子串过滤拉上的？）：${list(extra)}`,
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems, lines: [] };
  return {
    ok: true,
    problems: [],
    lines: [
      `核对过：这一台分到 ${assigned.size} 个测试文件，实际跑了 ${shouldRun.size} 个${covered.length > 0 ? `、缓存盖住 ${covered.length} 个` : ''}，正好对上`,
    ],
  };
}
