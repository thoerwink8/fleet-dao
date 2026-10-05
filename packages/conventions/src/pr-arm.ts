// 挂自动合并的判法（全仓审查第 2 路清单 1、7 号）：PR 改到的文件碰没碰改标准的路径（standard-paths.ts）、先审后合的路径
// （merge-gates.ts 的 riskyFiles），以及「我开的、检查全绿、没挂自动合并、没碰改标准」的开着的 PR（开会话钩子兜底用）。
// 判路径不在这里另写：用那两份清单自己的读法和匹配。
//
// 改这里之前必须知道：
// - 只 import 不带第三方依赖的模块：开会话钩子在同步专用检出（~/.fleet-dao/origin-main，没装 node_modules）里直接
//   `node` 跑 bin/pr-idle.ts，引了 @fleet-dao/shared 这类工作区包就跑不起来。
// - 三态：gh 没跑成、输出认不出、文件列表是空的，一律抛错（调用方报「没查成」、非 0 退出），不当成「没碰」「没有」。
// - 改到的文件从 GitHub 现读（REST 的 PR 文件列表，带改名前的名字和改动内容），和合并闸读的是同一份；不用本地 git diff
//   猜（本地的 origin/main 可能旧、分支可能没推全）。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ChangedFile,
  parseRiskPaths,
  RISK_PATHS_FILE,
  type RiskPath,
  riskyFiles,
} from './merge-gates.ts';
import {
  parseStandardPaths,
  STANDARD_PATHS_FILE,
  type StandardPath,
  standardFiles,
} from './standard-paths.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑 gh（测试里换替身）。 */
export type Gh = (args: string[]) => RunResult;

/** 真跑 gh：找不到 gh 记成 127，超时、被杀记成 1，都带上原因。 */
export function liveGh(cwd: string, timeoutMs = 60_000): Gh {
  return liveCommand('gh', cwd, timeoutMs);
}

/** 真跑 git（pnpm pr:open 读分支上的提交说明用）：同 liveGh 的三态。 */
export function liveGit(cwd: string, timeoutMs = 60_000): Gh {
  return liveCommand('git', cwd, timeoutMs);
}

function liveCommand(command: string, cwd: string, timeoutMs: number): Gh {
  return (args) => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
    if (r.error) {
      const e = r.error as NodeJS.ErrnoException;
      return { code: e.code === 'ENOENT' ? 127 : 1, stdout: r.stdout ?? '', stderr: e.message };
    }
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

export const reasonOf = (r: RunResult): string =>
  `退出码 ${r.code}：${(r.stderr.trim() || r.stdout.trim() || '（gh 什么也没说）').replace(/\s+/g, ' ').slice(0, 300)}`;

export interface PathLists {
  standard: StandardPath[];
  risk: RiskPath[];
}

/** 读仓根的两份清单；读不到、认不出就抛错（一条都判不了，不当成「什么都没碰」）。 */
export function loadPathLists(root: string): PathLists {
  const read = (file: string): string => {
    try {
      return readFileSync(join(root, file), 'utf8');
    } catch (e) {
      throw new Error(`读不到 ${file}（${e instanceof Error ? e.message : String(e)}）`);
    }
  };
  const standard = parseStandardPaths(read(STANDARD_PATHS_FILE));
  if (typeof standard === 'string') throw new Error(`${STANDARD_PATHS_FILE} 认不出：${standard}`);
  const risk = parseRiskPaths(read(RISK_PATHS_FILE));
  if (typeof risk === 'string') throw new Error(`${RISK_PATHS_FILE} 认不出：${risk}`);
  return { standard, risk };
}

/** 一行 [filename, status, previous_filename, patch] 的 JSON（gh api --jq 吐的那种）→ ChangedFile。 */
function fileOf(line: string): ChangedFile {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`PR 文件列表里有一行认不出：${line.slice(0, 120)}`);
  }
  if (!Array.isArray(raw) || typeof raw[0] !== 'string' || !raw[0] || typeof raw[1] !== 'string') {
    throw new Error(`PR 文件列表里有一行认不出：${line.slice(0, 120)}`);
  }
  const [filename, status, previous, patch] = raw as [string, string, unknown, unknown];
  return {
    filename,
    status,
    ...(typeof previous === 'string' && previous ? { previous } : {}),
    ...(typeof patch === 'string' ? { patch } : {}),
  };
}

/** PR 改到的文件（GitHub 现读、翻页取全）。没跑成、认不出、一个文件都没有，都抛错。 */
export function prFiles(gh: Gh, pr: number): ChangedFile[] {
  const r = gh([
    'api',
    '--paginate',
    `repos/{owner}/{repo}/pulls/${pr}/files`,
    '--jq',
    '.[] | [.filename, .status, .previous_filename, .patch] | @json',
  ]);
  if (r.code !== 0) throw new Error(`没查成 PR #${pr} 改了哪些文件（gh api ${reasonOf(r)}）`);
  const files = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(fileOf);
  if (files.length === 0) throw new Error(`没查成 PR #${pr} 改了哪些文件：GitHub 回的列表是空的`);
  return files;
}

export interface PathVerdict {
  /** 碰到的改标准路径（文件名）。 */
  standard: string[];
  /** 碰到的先审后合路径（不含先合后审的）。 */
  review: string[];
  /** 碰到的先合后审路径（合并后补审）。 */
  afterMerge: string[];
}

export function judgePaths(files: readonly ChangedFile[], lists: PathLists): PathVerdict {
  const risky = riskyFiles(files, lists.risk);
  return {
    standard: standardFiles(files, lists.standard).map((h) => h.file),
    review: risky.filter((h) => !h.afterMerge).map((h) => h.file),
    afterMerge: risky.filter((h) => h.afterMerge).map((h) => h.file),
  };
}

export const listOf = (files: readonly string[], max = 3): string =>
  files.slice(0, max).join('、') + (files.length > max ? ` 等 ${files.length} 个` : '');

// —— 开着、绿了、没挂自动合并的 PR（开会话钩子兜底）——

export interface IdlePr {
  number: number;
  title: string;
}

interface ListedPr {
  number: number;
  title: string;
  isDraft: boolean;
  autoMergeRequest: unknown;
  statusCheckRollup: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** statusCheckRollup 全绿：至少一项，检查都跑完且成功（跳过、中性也算），提交状态都是成功。认不出的一项算不绿。 */
export function allGreen(rollup: unknown): boolean {
  if (!Array.isArray(rollup) || rollup.length === 0) return false;
  return rollup.every((c) => {
    if (!isObject(c)) return false;
    if (c.__typename === 'CheckRun')
      return c.status === 'COMPLETED' && ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(String(c.conclusion));
    if (c.__typename === 'StatusContext') return c.state === 'SUCCESS';
    return false;
  });
}

function listedOf(raw: unknown): ListedPr[] {
  if (!Array.isArray(raw)) throw new Error('gh pr list 的输出不是列表');
  return raw.map((p, i) => {
    if (
      !isObject(p) ||
      typeof p.number !== 'number' ||
      typeof p.title !== 'string' ||
      typeof p.isDraft !== 'boolean'
    )
      throw new Error(`gh pr list 第 ${i + 1} 条认不出（要有 number、title、isDraft）`);
    return p as unknown as ListedPr;
  });
}

/**
 * 当前 gh 账号开的、开着的 PR 里：不是草稿、检查全绿、没挂自动合并、没碰改标准路径的。
 * gh 没跑成、输出认不出、某个候选的文件没查成，都抛错（钩子报「没查成」，不冒充「没有」）。
 */
export function idlePrs(gh: Gh, lists: PathLists): IdlePr[] {
  const r = gh([
    'pr',
    'list',
    '--author',
    '@me',
    '--state',
    'open',
    '--limit',
    '50',
    '--json',
    'number,title,isDraft,autoMergeRequest,statusCheckRollup',
  ]);
  if (r.code !== 0) throw new Error(`gh pr list ${reasonOf(r)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    throw new Error(`gh pr list 的输出认不出：${r.stdout.trim().slice(0, 80)}`);
  }
  const candidates = listedOf(raw).filter(
    (p) => !p.isDraft && p.autoMergeRequest == null && allGreen(p.statusCheckRollup),
  );
  return candidates
    .filter((p) => judgePaths(prFiles(gh, p.number), lists).standard.length === 0)
    .map((p) => ({ number: p.number, title: p.title }));
}
