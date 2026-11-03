// jobrun 实现（Windows）：执行体由 crates/jobrun 起在一个 Job Object 里（挂起建进程 → 放进 KILL_ON_JOB_CLOSE 的 Job → 恢复），
// 整棵树一个都跑不出去；叫停是 TerminateJobObject，内核或 jobrun 自己死了也一起收。
// jobrun 是执行体的看守进程：stdin/stdout/stderr、环境、工作目录原样透传，退出码就是执行体的退出码；
// 执行体退出后 Job 里剩的进程数、收完还剩几个、见过的每个进程的（进程号，创建时刻）写进报告文件（crates/jobrun/src/app.rs 的 Report）。
// 进程号复用不误杀：叫停按 Job 成员关系，不按进程号；事后核对和收孤儿按（进程号，创建时刻）一对一，对不上的不碰。
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostProcess, HostReap, HostSpawnSpec, ProcessHost } from './host.ts';
import { RUN_MARKER_KEY, runMarker } from './marker.ts';

/** jobrun 可执行文件：环境变量 FLEET_JOBRUN 优先（装好的桌面软件里由外壳设），其次仓里的 cargo 产物；找不到回 undefined。 */
export function jobrunBinary(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const fromEnv = env.FLEET_JOBRUN?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  for (const profile of ['release', 'debug']) {
    const p = join(root, 'target', profile, 'jobrun.exe');
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** 这个会话的 Job 名：标记里的冒号等字符换掉，再带一段哈希，换名后撞不了。 */
export function jobName(runId: string): string {
  const marker = runMarker(runId);
  const hash = createHash('sha256').update(marker).digest('hex').slice(0, 8);
  return `${marker.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100)}-${hash}`;
}

export function reportPath(runId: string): string {
  return join(tmpdir(), 'fleet-jobrun', `${jobName(runId)}.json`);
}

interface JobReport {
  exit_code: number | null;
  spawn_error: string | null;
  stragglers: number;
  leftovers: number;
}

function readReport(runId: string): JobReport | undefined {
  try {
    return JSON.parse(readFileSync(reportPath(runId), 'utf8')) as JobReport;
  } catch {
    return undefined;
  }
}

/** 跑一下 jobrun 的子命令，等它退出：回退出码和标准输出；起不来回 undefined。异步起，不卡住内核（A5）。 */
function jobrun(bin: string, args: string[]): Promise<{ code: number | null; stdout: string } | undefined> {
  return new Promise((resolve) => {
    let stdout = '';
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    p.on('error', () => resolve(undefined));
    p.on('close', (code) => resolve({ code, stdout }));
  });
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * 收一个会话（procs.ts 的 reapSession 在 Windows 上走这里）：
 * 1. Job 还在（执行体或它的子孙还活着）：数一下、整个 Job 收掉、等它空；
 * 2. Job 已经没了：读看守进程留下的报告，把里面记着的进程按（进程号，创建时刻）核一遍，还活着且对得上的收掉，再数一遍。
 * 没有 jobrun、也没有报告：查不了，leftovers 回 undefined。
 */
export async function jobrunReap(runId: string, graceMs: number): Promise<HostReap> {
  const bin = jobrunBinary();
  if (!bin) return { found: 0, leftovers: undefined };
  const name = jobName(runId);
  const listed = await jobrun(bin, ['list', '--name', name]);
  if (listed?.code === 0) {
    const found = parseJson<{ pids: number[] }>(listed.stdout)?.pids.length ?? 0;
    const killed = await jobrun(bin, ['kill', '--name', name, '--grace-ms', String(graceMs)]);
    const leftovers = killed ? parseJson<{ leftovers: number }>(killed.stdout)?.leftovers : undefined;
    return { found, leftovers };
  }
  const report = readReport(runId);
  if (!report) return { found: 0, leftovers: undefined };
  const path = reportPath(runId);
  await jobrun(bin, ['reap', '--report', path]);
  const until = Date.now() + graceMs;
  let alive: number | undefined;
  do {
    const checked = await jobrun(bin, ['check', '--report', path]);
    alive = checked ? parseJson<{ alive: number }>(checked.stdout)?.alive : undefined;
    if (alive === 0 || alive === undefined) break;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < until);
  return {
    found: report.stragglers,
    leftovers: alive === undefined ? undefined : Math.max(alive, report.leftovers),
  };
}

class JobrunProcess implements HostProcess {
  readonly #child: ChildProcess;
  readonly #runId: string;
  readonly #bin: string;
  readonly #name: string;

  constructor(bin: string, spec: HostSpawnSpec) {
    this.#bin = bin;
    this.#runId = spec.runId;
    this.#name = jobName(spec.runId);
    const report = reportPath(spec.runId);
    mkdirSync(dirname(report), { recursive: true });
    rmSync(report, { force: true });
    this.#child = spawn(bin, ['run', '--name', this.#name, '--report', report, '--', ...spec.command], {
      cwd: spec.cwd,
      env: { ...spec.env, [RUN_MARKER_KEY]: runMarker(spec.runId) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  get pid() {
    return this.#child.pid;
  }
  get stdin() {
    return this.#child.stdin as NonNullable<ChildProcess['stdin']>;
  }
  get stdout() {
    return this.#child.stdout as NonNullable<ChildProcess['stdout']>;
  }
  get stderr() {
    return this.#child.stderr as NonNullable<ChildProcess['stderr']>;
  }
  onError(cb: (err: Error) => void) {
    this.#child.on('error', cb);
  }
  onExit(cb: (code: number | null, signal: string | null) => void) {
    this.#child.on('exit', cb);
  }
  onClose(cb: () => void) {
    this.#child.on('close', () => cb());
  }

  stop(_mode: 'term' | 'kill') {
    // Windows 没有「礼貌的一下」：两种叫停都是整个 Job 一次收掉，连叫也无妨
    void jobrun(this.#bin, ['kill', '--name', this.#name]).then((r) => {
      if (r?.code === 0) return;
      // 还没建好 Job（刚起就叫停）或查不到：杀看守进程本身，它一死 Job 句柄关闭，整棵树跟着没
      const pid = this.#child.pid;
      if (pid === undefined) return;
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
        'error',
        () => {},
      );
    });
  }

  async reap(graceMs: number): Promise<HostReap> {
    const reaped = await jobrunReap(this.#runId, graceMs);
    rmSync(reportPath(this.#runId), { force: true });
    return reaped;
  }
}

/** 没有 jobrun 可执行文件时抛错：调用方要么先 jobrunBinary() 判断，要么让它报出来，不悄悄换成别的实现。 */
export function makeJobrunHost(bin: string | undefined = jobrunBinary()): ProcessHost {
  return {
    kind: 'jobrun',
    start(spec) {
      if (!bin) throw new Error('找不到 jobrun 可执行文件（设 FLEET_JOBRUN，或先 cargo build -p jobrun）');
      return new JobrunProcess(bin, spec);
    },
    async attach(runId) {
      if (!bin) return undefined;
      const listed = await jobrun(bin, ['list', '--name', jobName(runId)]);
      if (!listed) return undefined;
      if (listed.code === 0) return true;
      // 没有这个 Job：看守进程不在了，它的 Job 一关整棵树就没了
      return listed.code === 3 ? false : undefined;
    },
  };
}
