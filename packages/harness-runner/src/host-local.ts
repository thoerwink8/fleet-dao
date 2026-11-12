// local 实现：从 process.ts 原样搬来的起法（行为不变）。POSIX 上自成一个进程组、脱离了组的子孙靠会话标记另外认（procs.ts）；
// Windows 上没有 jobrun 时整棵树交给 taskkill，收完剩几个查不了，照实回 undefined。
import { type ChildProcess, spawn } from 'node:child_process';
import type { HostProcess, HostReap, HostSpawnSpec, ProcessHost } from './host.ts';
import { RUN_MARKER_KEY, runMarker } from './marker.ts';
import { type ProcSnapshot, reapProcSession, runAlive, sessionSnapshot, signalSnapshot } from './procs.ts';

const POSIX = process.platform !== 'win32';

class LocalProcess implements HostProcess {
  readonly #child: ChildProcess;
  readonly #runId: string;
  #snapshot: ProcSnapshot = new Map();

  constructor(spec: HostSpawnSpec) {
    const [bin, ...args] = spec.command;
    this.#runId = spec.runId;
    this.#child = spawn(bin as string, args, {
      cwd: spec.cwd,
      env: { ...spec.env, [RUN_MARKER_KEY]: runMarker(spec.runId) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // 自成一个进程组；脱离了组的子孙靠会话标记另外认
      detached: POSIX,
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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

  stop(mode: 'term' | 'kill') {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    if (!POSIX) {
      // Windows 只在本机跑测试：整棵树一起杀，异步起（A5 禁同步起子进程，会卡住整个内核）
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
        'error',
        () => {},
      );
      return;
    }
    // 第一下叫停前先记下会话现状：根进程一退，子孙就找不到爹了
    if (mode === 'term') this.#snapshot = sessionSnapshot(this.#runId, pid);
    const sig: NodeJS.Signals = mode === 'term' ? 'SIGTERM' : 'SIGKILL';
    signalSnapshot(new Map([...this.#snapshot, ...sessionSnapshot(this.#runId, pid)]), sig);
    try {
      process.kill(-pid, sig);
    } catch {
      // 组已经空了
    }
  }

  reap(graceMs: number): Promise<HostReap> {
    return reapProcSession(this.#runId, graceMs, this.#snapshot);
  }
}

export const localHost: ProcessHost = {
  kind: 'local',
  start: (spec) => new LocalProcess(spec),
  attach: async (runId) => runAlive(runId),
};
