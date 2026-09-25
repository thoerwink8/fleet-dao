// 找出、收掉一次会话留下的全部进程（Linux）。
// Claude 的 Bash 工具每条命令都 setsid 自成一组（VPS 实测），只杀执行体自己的进程组收不干净；执行体一退，
// 这些进程又被过继给 init，按父子关系也找不到了。所以三条线一起认：执行体的子孙（它还活着时）、
// 执行体进程组里的、环境里带着会话标记（FLEET_RUN_ID）的。会话放进 scope（fleet-agent-scope）时以 cgroup 为准。
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { SESSION_BASE_KEYS } from './env.ts';

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

/**
 * 会话进 scope 走 fleet-agent-scope（deploy/france/fleet-agent-scope.sh，装在 /usr/local/sbin/，sudoers 只放行引擎用户
 * 以 root 跑它）：会话以会话专用用户的身份跑在 fleet-agents.slice 下自己的 fleet-agent-<编号>.scope 里，
 * setsid、过继都跑不出这个 cgroup。引擎自己建不了系统级 scope，也发不了信号给会话用户的进程，收尸只能经它的 stop。
 */
export const SCOPE_HELPER = '/usr/local/sbin/fleet-agent-scope';

/** 两个会话专用用户，各挂一个账号池（独享号、拼车号）；引擎按选中的账号池挑。 */
export const SESSION_USERS = ['fleet-agent-dedicated', 'fleet-agent-carpool'] as const;
export type SessionUser = (typeof SESSION_USERS)[number];

export interface ScopeLimits {
  /** 形如 1536M。要真封顶，memoryMax 和 memorySwapMax 得一起给：只给前者，超出的部分被换进 swap，会话不会被杀。 */
  memoryHigh?: string;
  memoryMax?: string;
  memorySwapMax?: string;
  tasksMax?: number;
  cpuWeight?: number;
}

export interface CgroupScope {
  /** 会话编号：单元名是 fleet-agent-<id>.scope。只许字母、数字、_ 和 -，最长 63（和帮手脚本同一条规矩）。 */
  id: string;
  user: SessionUser;
  limits?: ScopeLimits;
  /** 帮手脚本，默认 SCOPE_HELPER。 */
  helper?: string;
  /** 调帮手的前缀，默认 ['/usr/bin/sudo', '-n']；测试里给 [] 直接起假帮手。 */
  sudo?: readonly string[];
}

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const SIZE = /^(0|[1-9][0-9]*[KMGT]?)$/;
/** 写上 sudo 命令行的值不许带控制字符（\r、\n……会搅乱 sudo 的日志）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要拦控制字符
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function assertScope(scope: CgroupScope): void {
  if (!SCOPE_ID.test(scope.id))
    throw new Error(`会话编号只许字母、数字、_ 和 -，最长 63 个字符：${scope.id}`);
  if (!SESSION_USERS.includes(scope.user))
    throw new Error(`会话用户只能是 ${SESSION_USERS.join('、')} 之一：${scope.user}`);
  const l = scope.limits ?? {};
  for (const [k, v] of [
    ['memoryHigh', l.memoryHigh],
    ['memoryMax', l.memoryMax],
    ['memorySwapMax', l.memorySwapMax],
  ] as const) {
    if (v !== undefined && !SIZE.test(v)) throw new Error(`${k} 要形如 1536M：${v}`);
  }
  if (l.tasksMax !== undefined && !(Number.isInteger(l.tasksMax) && l.tasksMax > 0))
    throw new Error(`tasksMax 要是正整数：${l.tasksMax}`);
  if (
    l.cpuWeight !== undefined &&
    !(Number.isInteger(l.cpuWeight) && l.cpuWeight >= 1 && l.cpuWeight <= 10_000)
  ) {
    throw new Error(`cpuWeight 要在 1–10000 之间：${l.cpuWeight}`);
  }
}

/**
 * 生产配置下会话必须进 scope：不进就以引擎的身份跑，读得到引擎的配置和凭据。FLEET_ENV 的口径和后端一致
 * （packages/api/src/config.ts：不给、给空、认不出都按 production）；开发机、测试显式设 development / test，
 * 单元测试（VITEST）算测试。
 */
export function assertScopeInProduction(
  scope: CgroupScope | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (scope || env.VITEST || env.FLEET_ENV === 'development' || env.FLEET_ENV === 'test') return;
  throw new Error(
    '生产配置下会话必须进 scope（给 cgroup）：不进就以引擎的身份跑，读得到引擎的配置和凭据。开发机设 FLEET_ENV=development',
  );
}

export function scopeUnit(scope: CgroupScope): string {
  return `fleet-agent-${scope.id}.scope`;
}

function helperCall(scope: CgroupScope): string[] {
  return [...(scope.sudo ?? ['/usr/bin/sudo', '-n']), scope.helper ?? SCOPE_HELPER];
}

/** 起会话的前缀：帮手脚本最后 exec 成会话本身，进程号、stdin/stdout 都还是调用方拿着的那一份。 */
export function scopePrefix(scope: CgroupScope, cwd: string): string[] {
  assertScope(scope);
  if (!cwd.startsWith('/')) throw new Error(`工作目录要写绝对路径：${cwd}`);
  if (CONTROL_CHAR.test(cwd)) throw new Error('工作目录里有控制字符，不写上命令行');
  const l = scope.limits ?? {};
  return [
    ...helperCall(scope),
    'run',
    scope.id,
    '--user',
    scope.user,
    ...(l.memoryHigh ? ['--memory-high', l.memoryHigh] : []),
    ...(l.memoryMax ? ['--memory-max', l.memoryMax] : []),
    ...(l.memorySwapMax ? ['--memory-swap-max', l.memorySwapMax] : []),
    ...(l.tasksMax ? ['--tasks-max', String(l.tasksMax)] : []),
    ...(l.cpuWeight ? ['--cpu-weight', String(l.cpuWeight)] : []),
    '--cwd',
    cwd,
    '--',
  ];
}

/** 帮手脚本只把这几类环境变量放进会话（sudoers 的 env_keep 是同一张表）。 */
export const SCOPE_ENV_KEEP = /^(FLEET_[A-Z0-9_]+|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|GIT_TERMINAL_PROMPT)$/;
/**
 * 能写上命令行的只有这几个执行体开关（值是固定的数字、开关）。命令行 sudo 会记日志，/proc 里别的用户也读得到
 * （VPS 的 /proc 没开 hidepid），按名字猜「像不像凭据」拦不住 DATABASE_URL、JWT 这类，所以只放白名单。
 */
export const SCOPE_ENV_ARGS: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'GROK_DISABLE_AUTOUPDATER',
]);

export interface ScopeLaunch {
  /** 调 sudo 时的环境：FLEET_* 这几类，加 FLEET_SESSION_PATH。 */
  sudoEnv: Record<string, string>;
  /** 白名单里的执行体开关（例如 GROK_DISABLE_AUTOUPDATER）：写成 /usr/bin/env 的参数。 */
  envArgs: string[];
}

/**
 * 把会话环境拆成「经 sudo 的环境传」和「写在命令行上」两份。宿主抄来的基础变量（HOME、USER……）是引擎的，
 * 帮手脚本会给会话用户设它自己的，不往里传；PATH 改走 FLEET_SESSION_PATH；别的变量不在白名单里一律拒——
 * 会话用户的登录态要在它自己家里登好，不从引擎这边传。
 */
export function scopeLaunch(env: Record<string, string>): ScopeLaunch {
  const sudoEnv: Record<string, string> = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' };
  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (SCOPE_ENV_KEEP.test(key)) sudoEnv[key] = value;
    else if (key === 'PATH') sudoEnv.FLEET_SESSION_PATH = value;
    else if (SESSION_BASE_KEYS.has(key.toUpperCase())) continue;
    else if (!SCOPE_ENV_ARGS.has(key)) {
      throw new Error(
        `${key} 进不了会话用户的会话：帮手脚本只放 FLEET_* 这几类环境变量，命令行上只放白名单里的执行体开关——登录态在会话用户家里登好`,
      );
    } else if (CONTROL_CHAR.test(value)) {
      throw new Error(`${key} 的值里有控制字符，不写上命令行`);
    } else envArgs.push(`${key}=${value}`);
  }
  return { sudoEnv, envArgs };
}

/** 收掉整个 scope（systemctl stop：先 SIGTERM，15 秒后 SIGKILL）。scope 已经不在也算收好；出错返回原因。 */
export function stopScope(scope: CgroupScope): Promise<string | undefined> {
  assertScope(scope);
  const [bin, ...args] = [...helperCall(scope), 'stop', scope.id];
  return new Promise((resolve) => {
    execFile(bin as string, args, { encoding: 'utf8', timeout: 60_000 }, (err, _stdout, stderr) => {
      resolve(err ? `${stderr || ''}${err.message}`.trim() : undefined);
    });
  });
}

/** scope 的 cgroup 里还有几个进程。scope 已不在 = 0；查不了（没有 systemctl、读不了 cgroup）= undefined。 */
export function scopeProcCount(scope: CgroupScope): number | undefined {
  const res = spawnSync('systemctl', ['show', '-p', 'ControlGroup', '--value', scopeUnit(scope)], {
    encoding: 'utf8',
    timeout: 10_000,
  });
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
    signalProcs(find(), 'SIGTERM');
    if (scope) {
      // 会话用户的进程引擎发不了信号：经帮手 stop 整个 scope（systemd 先 SIGTERM、15 秒后 SIGKILL，收完才返回）
      const err = await stopScope(scope);
      if (err) errors.push(err);
    }
    if (!(await until(options.graceMs ?? 5_000))) {
      signalProcs(find(), 'SIGKILL');
      await until(2_000);
    }
  }
  const leftovers = remaining();
  // 以清空为准：收干净了，中途帮手报的错不算数
  return { found, leftovers, ...(errors.length && leftovers !== 0 ? { error: errors.join('；') } : {}) };
}
