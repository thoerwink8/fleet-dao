// 交回的机械核验（讨论稿第五节 1，harness-orchestrator 那一行）：不让模型判，只看三样——
// 工作目录相对基线的 diff 统计、有没有改到允许范围外的路径、检查命令退出码。
// 四态：unverified（没东西可核）、passed、failed、unknown（有探测没跑成）。unknown 永远不当 passed。
import type { Redactor } from '@fleet-dao/harness-runner';
import { type CommandResult, runCommand } from './command.ts';

export type Verdict = 'unverified' | 'passed' | 'failed' | 'unknown';

export interface FileStat {
  path: string;
  /** 二进制文件 numstat 给 -，这里是 null。 */
  added: number | null;
  deleted: number | null;
  untracked?: true;
}

export interface VerifySpec {
  cwd: string;
  /** 基线提交（分支名、标签或哈希）；工人在它上面改。 */
  baseRef: string;
  /** 给了就只许改这些路径（目录前缀、带 * 的通配）；不给就不限。 */
  allowedPaths?: readonly string[];
  /** 一律不许碰的路径，优先于 allowedPaths。 */
  forbiddenPaths?: readonly string[];
  /** 检查命令（argv，不经 shell），退出码 0 才算过。 */
  checkCommand?: readonly string[];
  checkTimeoutMs?: number;
  gitTimeoutMs?: number;
  /** 工人干净退出（退出码 0、没被叫停、起得来）。不干净就不可能 passed。 */
  workerClean: boolean;
  hostEnv?: Readonly<Record<string, string | undefined>>;
  redact: Redactor;
  signal?: AbortSignal;
}

export interface DiffEvidence {
  ran: boolean;
  why?: string;
  files: number;
  added: number;
  deleted: number;
  untracked: number;
  /** 最多列 200 个，超了 truncated。 */
  paths: FileStat[];
  truncated: boolean;
}

export interface ScopeEvidence {
  allowedPaths: string[];
  forbiddenPaths: string[];
  outOfScope: { path: string; why: string }[];
}

export interface CheckEvidence {
  ran: boolean;
  command: string[];
  exitCode: number | null;
  why?: string;
  /** 输出末尾，已脱敏，只做诊断。 */
  tail: string;
}

export interface VerifyReport {
  verdict: Verdict;
  reasons: string[];
  /** 实际跑过的探测。 */
  probes: ('diff' | 'scope' | 'check')[];
  diff: DiffEvidence;
  scope: ScopeEvidence;
  check: CheckEvidence | null;
}

const PATH_LIST_CAP = 200;
const SAFE_REF = /^[0-9A-Za-z][0-9A-Za-z._/@^~{}-]*$/;
// 工人的工作目录里的 git 配置是工人写的：关掉会执行外部程序的几项，只读统计。
// 法国上目录归会话用户、核验以 fleet 跑（#3814），要 safe.directory 才肯读；只读，不写那边的索引
const GIT_SAFE = ['-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off'];

/** 路径匹配：以 / 结尾或没有通配符＝目录前缀（含自身）；带 * ? 的按通配，** 跨目录、* 不跨。 */
export function matchPath(pattern: string, path: string): boolean {
  const pat = pattern.replace(/^\.\//, '');
  if (pat === '') return false;
  if (!/[*?]/.test(pat)) {
    const dir = pat.endsWith('/') ? pat : `${pat}/`;
    return path === pat || path.startsWith(dir);
  }
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i] as string;
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i++;
        if (pat[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

function unsafePath(path: string): string | null {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return '绝对路径';
  if (path.split('/').includes('..')) return '含 ..';
  return null;
}

export function checkScope(
  paths: readonly string[],
  allowed: readonly string[] = [],
  forbidden: readonly string[] = [],
): ScopeEvidence {
  const outOfScope: { path: string; why: string }[] = [];
  for (const path of paths) {
    const unsafe = unsafePath(path);
    if (unsafe) outOfScope.push({ path, why: unsafe });
    else if (forbidden.some((p) => matchPath(p, path))) outOfScope.push({ path, why: '命中禁止路径' });
    else if (allowed.length > 0 && !allowed.some((p) => matchPath(p, path))) {
      outOfScope.push({ path, why: '不在允许范围内' });
    }
  }
  return { allowedPaths: [...allowed], forbiddenPaths: [...forbidden], outOfScope };
}

/** `git diff --numstat -z --no-renames` 的输出：每条 `增\t删\t路径`，以 NUL 分隔。 */
export function parseNumstat(raw: string): FileStat[] {
  const out: FileStat[] = [];
  for (const rec of raw.split('\0')) {
    if (rec === '') continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) throw new Error(`认不出的 numstat 行：${rec.slice(0, 80)}`);
    out.push({
      path: m[3] as string,
      added: m[1] === '-' ? null : Number(m[1]),
      deleted: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return out;
}

const failedWhy = (r: CommandResult): string =>
  r.spawnError
    ? `起不来：${r.spawnError}`
    : r.killed
      ? `被停：${r.killed}`
      : `退出码 ${r.exitCode}${r.stderrTail ? `：${r.stderrTail.trim().slice(-200)}` : ''}`;

async function probeDiff(
  spec: VerifySpec,
  run: (argv: string[], ms: number) => Promise<CommandResult>,
): Promise<DiffEvidence & { all: FileStat[] }> {
  const empty = {
    ran: false,
    files: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    paths: [] as FileStat[],
    truncated: false,
    all: [] as FileStat[],
  };
  if (!SAFE_REF.test(spec.baseRef))
    return { ...empty, why: `基线 ${JSON.stringify(spec.baseRef)} 不是合法的引用名` };
  const ms = spec.gitTimeoutMs ?? 60_000;
  const diff = await run(
    [
      'git',
      ...GIT_SAFE,
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      spec.baseRef,
      '--',
    ],
    ms,
  );
  if (!diff.ran || diff.exitCode !== 0 || diff.truncated) {
    return { ...empty, why: `git diff 没跑成：${diff.truncated ? '输出太大被截断' : failedWhy(diff)}` };
  }
  const others = await run(['git', ...GIT_SAFE, 'ls-files', '--others', '--exclude-standard', '-z'], ms);
  if (!others.ran || others.exitCode !== 0 || others.truncated) {
    return {
      ...empty,
      why: `列未跟踪文件没跑成：${others.truncated ? '输出太大被截断' : failedWhy(others)}`,
    };
  }
  let files: FileStat[];
  try {
    files = parseNumstat(diff.stdout);
  } catch (err) {
    return { ...empty, why: err instanceof Error ? err.message : String(err) };
  }
  const tracked = new Set(files.map((f) => f.path));
  const untracked = others.stdout.split('\0').filter((p) => p !== '' && !tracked.has(p));
  const all: FileStat[] = [
    ...files,
    ...untracked.map((path) => ({ path, added: null, deleted: null, untracked: true as const })),
  ];
  return {
    ran: true,
    files: all.length,
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0),
    untracked: untracked.length,
    paths: all.slice(0, PATH_LIST_CAP),
    truncated: all.length > PATH_LIST_CAP,
    all,
  };
}

/** 把几样探测的结果收成一个判定。纯函数：不看模型、不碰磁盘。 */
export function decideVerdict(input: {
  workerClean: boolean;
  diff: DiffEvidence;
  scope: ScopeEvidence;
  scopeConfigured: boolean;
  check: CheckEvidence | null;
}): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  const { diff, scope, check } = input;
  if (!input.workerClean) reasons.push('工人没有干净地交活（被叫停、超时或退出码不是 0）');
  if (scope.outOfScope.length > 0) {
    reasons.push(`改到了范围外的路径：${scope.outOfScope.map((o) => o.path).join('、')}`);
  }
  if (check?.ran && check.exitCode !== 0) reasons.push(`检查命令退出码 ${check.exitCode}`);
  if (reasons.length > 0) return { verdict: 'failed', reasons };
  if (!diff.ran) reasons.push(`diff 没跑成：${diff.why ?? '原因不明'}`);
  if (check && !check.ran) reasons.push(`检查命令没跑成：${check.why ?? '原因不明'}`);
  if (reasons.length > 0) return { verdict: 'unknown', reasons };
  if (diff.files === 0)
    return { verdict: 'unverified', reasons: ['工作目录相对基线没有任何改动，没东西可核'] };
  if (!input.scopeConfigured && !check) {
    return { verdict: 'unverified', reasons: ['没给允许范围也没给检查命令，只有 diff 统计'] };
  }
  return { verdict: 'passed', reasons: [] };
}

export async function verifyHandback(spec: VerifySpec): Promise<VerifyReport> {
  const run = (argv: string[], timeoutMs: number) =>
    runCommand({
      command: argv,
      cwd: spec.cwd,
      timeoutMs,
      redact: spec.redact,
      ...(spec.hostEnv ? { hostEnv: spec.hostEnv } : {}),
      ...(spec.signal ? { signal: spec.signal } : {}),
    });
  const { all, ...diff } = await probeDiff(spec, run);
  const probes: VerifyReport['probes'] = ['diff'];
  const scopeConfigured = (spec.allowedPaths?.length ?? 0) + (spec.forbiddenPaths?.length ?? 0) > 0;
  const scope = checkScope(
    all.map((f) => f.path),
    spec.allowedPaths,
    spec.forbiddenPaths,
  );
  if (scopeConfigured && diff.ran) probes.push('scope');
  let check: CheckEvidence | null = null;
  if (spec.checkCommand && spec.checkCommand.length > 0) {
    probes.push('check');
    const r = await run([...spec.checkCommand], spec.checkTimeoutMs ?? 10 * 60_000);
    check = {
      ran: r.ran,
      command: [...spec.checkCommand],
      exitCode: r.exitCode,
      ...(r.ran ? {} : { why: failedWhy(r) }),
      tail: r.stdout.slice(-2048) + (r.stderrTail ? `\n${r.stderrTail}` : ''),
    };
  }
  const { verdict, reasons } = decideVerdict({
    workerClean: spec.workerClean,
    diff,
    scope,
    scopeConfigured,
    check,
  });
  return { verdict, reasons, probes, diff, scope, check };
}
