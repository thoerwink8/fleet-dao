// 找出、收掉一次会话留下的全部进程（Linux）。
// Claude 的 Bash 工具每条命令都 setsid 自成一组（VPS 实测），只杀执行体自己的进程组收不干净；执行体一退，
// 这些进程又被过继给 init，按父子关系也找不到了。所以三条线一起认：执行体的子孙（它还活着时）、
// 执行体进程组里的、环境里带着会话标记（FLEET_RUN_ID）的。有 systemd scope 时以 cgroup 为准。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** 会话标记的环境变量名：每个会话一个值，子孙进程都继承它，重启后的引擎也能按它认出旧会话的进程。 */
export const RUN_MARKER_KEY = 'FLEET_RUN_ID';

export const HAS_PROC = existsSync('/proc/self/stat');

interface ProcStat {
  ppid: number;
  pgid: number;
}

/** 僵尸（已死、等父进程收尸）当成不在。 */
function readStat(pid: number): ProcStat | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // 进程名在括号里、可能带空格和括号：从最后一个右括号往后数字段
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return { ppid: Number(fields[1]), pgid: Number(fields[2]) };
  } catch {
    return undefined;
  }
}

function allPids(): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

function hasMarker(pid: number, needle: Buffer): boolean {
  let environ: Buffer;
  try {
    environ = readFileSync(`/proc/${pid}/environ`);
  } catch {
    return false; // 别的用户的进程读不了，本来也不归我们管
  }
  // 每条变量以 \0 结尾；要整条匹配，前面必须是开头或上一条的 \0
  for (let at = environ.indexOf(needle); at >= 0; at = environ.indexOf(needle, at + 1)) {
    if (at === 0 || environ[at - 1] === 0) return true;
  }
  return false;
}

export function alive(pid: number): boolean {
  return readStat(pid) !== undefined;
}

/** 会话里现在活着的进程：带会话标记的，加上 rootPid 本身、它的进程组、它的子孙。 */
export function sessionProcs(runId: string, rootPid?: number): number[] {
  if (!HAS_PROC) return [];
  const needle = Buffer.from(`${RUN_MARKER_KEY}=${runId}\0`);
  const children = new Map<number, number[]>();
  const found = new Set<number>();
  for (const pid of allPids()) {
    if (pid === process.pid) continue;
    const stat = readStat(pid);
    if (!stat) continue;
    const siblings = children.get(stat.ppid);
    if (siblings) siblings.push(pid);
    else children.set(stat.ppid, [pid]);
    if (rootPid !== undefined && (pid === rootPid || stat.pgid === rootPid)) found.add(pid);
    else if (hasMarker(pid, needle)) found.add(pid);
  }
  if (rootPid !== undefined) {
    const queue = [rootPid];
    for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
      for (const child of children.get(pid) ?? []) {
        found.add(child);
        queue.push(child);
      }
    }
  }
  return [...found];
}

/** 连同各自的进程组一起发信号。自己所在的组、init 的组不碰。 */
export function signalProcs(pids: Iterable<number>, sig: NodeJS.Signals): void {
  const ownGroup = readStat(process.pid)?.pgid;
  const groups = new Set<number>();
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const pgid = readStat(pid)?.pgid;
    if (pgid !== undefined && pgid > 1 && pgid !== ownGroup) groups.add(pgid);
    try {
      process.kill(pid, sig);
    } catch {
      // 已经没了
    }
  }
  for (const pgid of groups) {
    try {
      process.kill(-pgid, sig);
    } catch {
      // 组已经空了
    }
  }
}

/** systemd scope：会话放进去之后按 cgroup 收尸，setsid、过继都跑不出 cgroup。 */
export interface CgroupScope {
  /** 例如 fleet-agents.slice。 */
  slice: string;
  /** scope 名（不带 .scope），例如 fleet-run-<会话编号>。 */
  unit: string;
  /** 用户级 systemd（systemctl --user），要 XDG_RUNTIME_DIR。 */
  user?: boolean;
}

const UNIT_NAME = /^[A-Za-z0-9:_.\\-]+$/;

function assertUnitNames(scope: CgroupScope): void {
  if (!UNIT_NAME.test(scope.slice) || !UNIT_NAME.test(scope.unit)) {
    throw new Error(`systemd 单元名不合法：${scope.slice} / ${scope.unit}`);
  }
}

/** systemd-run --scope 会 exec 目标命令：进程号、stdin/stdout 都不变。 */
export function scopePrefix(scope: CgroupScope): string[] {
  assertUnitNames(scope);
  return [
    'systemd-run',
    ...(scope.user ? ['--user'] : []),
    '--scope',
    '--quiet',
    '--collect',
    `--slice=${scope.slice}`,
    `--unit=${scope.unit}`,
    '--',
  ];
}

export function scopeKillArgs(scope: CgroupScope, sig: NodeJS.Signals): string[] {
  assertUnitNames(scope);
  return [
    ...(scope.user ? ['--user'] : []),
    'kill',
    '--kill-whom=all',
    `--signal=${sig}`,
    `${scope.unit}.scope`,
  ];
}

/** 给整个 scope 发信号。scope 已经不在（进程全退、被回收）也算成功；出错返回原因。 */
export function killScope(scope: CgroupScope, sig: NodeJS.Signals): string | undefined {
  const res = spawnSync('systemctl', scopeKillArgs(scope, sig), { encoding: 'utf8', timeout: 10_000 });
  if (res.status === 0) return undefined;
  const why = `${res.stderr ?? ''}${res.error ? String(res.error) : ''}`.trim();
  return /not loaded|not found/i.test(why) ? undefined : why || `systemctl 退出码 ${res.status}`;
}

/** scope 的 cgroup 里还有几个进程。scope 已不在 = 0；查不了（没有 systemctl、权限不够）= undefined。 */
export function scopeProcCount(scope: CgroupScope): number | undefined {
  const res = spawnSync(
    'systemctl',
    [...(scope.user ? ['--user'] : []), 'show', '-p', 'ControlGroup', '--value', `${scope.unit}.scope`],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (res.status !== 0) return undefined;
  const path = (res.stdout ?? '').trim();
  if (!path) return 0;
  try {
    return readFileSync(`/sys/fs/cgroup${path}/cgroup.procs`, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : undefined;
  }
}

export interface ReapOptions {
  runId: string;
  scope?: CgroupScope;
  /** 执行体进程号：它的子孙、它的进程组也算。 */
  rootPid?: number;
  /** 另外要一起收的进程（例如杀之前拍下的快照）。 */
  extra?: readonly number[];
  /** SIGTERM 之后等多久再 SIGKILL。 */
  graceMs?: number;
}

export interface ReapResult {
  /** 收尸开始时还活着的会话进程数。 */
  found: number;
  /** 收完还活着的（有 scope 时按 cgroup 数）。不是 0 就是没收干净；undefined = 没查成。 */
  leftovers: number | undefined;
  error?: string;
}

/**
 * 收掉一次会话剩下的进程：先 SIGTERM，宽限期过后 SIGKILL，有 scope 时以 cgroup 清空为准。
 * 引擎重启后拿记下的会话编号和 scope 调它，就能收掉旧会话。
 */
export async function reapSession(options: ReapOptions): Promise<ReapResult> {
  const { runId, scope, rootPid } = options;
  const errors: string[] = [];
  const find = () => {
    const set = new Set(sessionProcs(runId, rootPid));
    for (const pid of options.extra ?? []) if (alive(pid)) set.add(pid);
    return [...set];
  };
  const remaining = (): number | undefined => {
    const procs = HAS_PROC ? find().length : undefined;
    if (!scope) return procs;
    const inScope = scopeProcCount(scope);
    if (inScope === undefined) return procs;
    return Math.max(procs ?? 0, inScope);
  };
  const hit = (sig: NodeJS.Signals) => {
    if (scope) {
      const err = killScope(scope, sig);
      if (err) errors.push(err);
    }
    signalProcs(find(), sig);
  };
  const until = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (remaining() === 0) return true;
      await sleep(100);
    }
    return remaining() === 0;
  };

  const found = remaining();
  if (found === undefined) return { found: 0, leftovers: undefined };
  if (found > 0) {
    hit('SIGTERM');
    if (!(await until(options.graceMs ?? 5_000))) {
      hit('SIGKILL');
      await until(2_000);
    }
  }
  return { found, leftovers: remaining(), ...(errors.length ? { error: errors.join('；') } : {}) };
}
