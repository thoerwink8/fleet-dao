// hostd 实现（#3871，讨论稿 6.4a）：执行体由宿主帮手 hostd（crates/hostd）起，脱离会话跑，输出落在 hostd 的文件里，按行号读。
// 内核或连接断了，执行体照跑；重连后按 runId 和已收下的行号接着读，不漏不重。
// 本机：内核起 `hostd --stdio` 当子进程说 stdio 帧；SSH 远端：把 launch 换成 `ssh -T <别名> fleet2-hostd --stdio`，其余不变（#3856）。
// 帧的定义在 harness-contract（hostd-frames.ts），Rust 一侧照同一份样例帧对拍。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  HOSTD_PROTOCOL_VERSION,
  type HostdFrame,
  parseHostdFrame,
} from '@fleet-dao/harness-contract/hostd-frames';
import type { HostProcess, HostReap, HostSpawnSpec, ProcessHost } from './host.ts';
import { LineSplitter } from './lines.ts';
import { RUN_MARKER_KEY, runMarker } from './marker.ts';

type RequestFrame = Extract<
  HostdFrame,
  { type: 'hello' | 'spawn' | 'attach' | 'read' | 'stdin' | 'stop' | 'reap' | 'status' | 'forget' }
>;
/** 请求去掉 id（连接替它编号）。 */
type RequestBody = RequestFrame extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;
type Response = Extract<
  HostdFrame,
  { type: 'welcome' | 'spawned' | 'attached' | 'lines' | 'state' | 'ok' | 'reaped' }
>;

export class HostdError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HostdError';
    this.code = code;
  }
}

/** hostd 说的协议版本和我们的不一样：拒用，不降级。 */
export class HostdVersionError extends HostdError {
  constructor(message: string) {
    super('version_mismatch', message);
    this.name = 'HostdVersionError';
  }
}

/** hostd 可执行文件：环境变量 FLEET_HOSTD 优先（装好的桌面软件里由外壳设），其次仓里的 cargo 产物；找不到回 undefined。 */
export function hostdBinary(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const exe = process.platform === 'win32' ? 'hostd.exe' : 'hostd';
  const fromEnv = env.FLEET_HOSTD?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  for (const profile of ['release', 'debug']) {
    const p = join(root, 'target', profile, exe);
    if (existsSync(p)) return p;
  }
  return undefined;
}

interface RunSink {
  out(stream: 'stdout' | 'stderr' | 'pty', line: number, text: string): void;
  exit(code: number | null, signal: string | null): void;
  /** 连接没了（hostd 退了、管道断了）；执行体没事，可以重连接回。 */
  lost(why: Error): void;
}

/** 到一个 hostd 的一条 stdio 连接：握手、请求按编号对回复、推送的行和结局按 runId 分发。 */
class HostdConnection {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  readonly #sinks = new Map<string, RunSink>();
  #next = 1;
  #stderrTail = '';
  #closed: Error | undefined;
  /** 握手完成：回 hostd 报的信息；版本不对时拒。 */
  readonly ready: Promise<Extract<HostdFrame, { type: 'welcome' }>>;

  constructor(launch: string[]) {
    const [bin, ...args] = launch;
    this.#child = spawn(bin as string, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child.stderr?.on('data', (c: Buffer) => {
      this.#stderrTail = (this.#stderrTail + c.toString('utf8')).slice(-2_000);
    });
    this.#child.stdin?.on('error', () => {});
    const splitter = new LineSplitter();
    this.#child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of splitter.push(chunk)) this.#onLine(line);
    });
    this.#child.on('error', (err) => this.#close(err));
    this.#child.on('close', (code) =>
      this.#close(
        new Error(`hostd 退出了（${code}）${this.#stderrTail ? `：${this.#stderrTail.trim()}` : ''}`),
      ),
    );
    this.ready = this.#handshake();
    // 没人等 ready 时（比如起不来）也别当成未处理的拒绝
    this.ready.catch(() => {});
  }

  async #handshake() {
    const r = await this.request({ type: 'hello', protocol: HOSTD_PROTOCOL_VERSION, client: 'fleet-kernel' });
    if (r.type !== 'welcome' || r.protocol !== HOSTD_PROTOCOL_VERSION) {
      this.close();
      throw new HostdVersionError(
        `hostd 说协议 ${r.type === 'welcome' ? r.protocol : '?'}，这边只认 ${HOSTD_PROTOCOL_VERSION}：拒用`,
      );
    }
    return r;
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  #onLine(line: string) {
    const parsed = parseHostdFrame(line);
    if (!parsed.ok) {
      this.#close(new Error(`hostd 发来读不懂的帧（${parsed.why}）`));
      this.#child.kill();
      return;
    }
    const f = parsed.frame;
    if (f.type === 'out') this.#sinks.get(f.runId)?.out(f.stream, f.line, f.text);
    else if (f.type === 'exit') {
      this.#sinks.get(f.runId)?.exit(f.code, f.signal);
      this.#sinks.delete(f.runId);
    } else if (f.type === 'error') {
      const p = f.id === null ? undefined : this.#pending.get(f.id);
      if (p && f.id !== null) {
        this.#pending.delete(f.id);
        p.reject(
          f.code === 'version_mismatch'
            ? new HostdVersionError(f.message)
            : new HostdError(f.code, f.message),
        );
      }
    } else if ('id' in f) {
      const p = this.#pending.get(f.id);
      if (p) {
        this.#pending.delete(f.id);
        p.resolve(f as Response);
      }
    }
  }

  #close(why: Error) {
    if (this.#closed) return;
    this.#closed = why;
    for (const p of this.#pending.values()) p.reject(why);
    this.#pending.clear();
    const sinks = [...this.#sinks.values()];
    this.#sinks.clear();
    for (const s of sinks) s.lost(why);
  }

  request(body: RequestBody): Promise<Response> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin?.write(`${JSON.stringify({ ...body, id })}\n`, (err) => {
        if (err) {
          this.#pending.delete(id);
          reject(err);
        }
      });
    });
  }

  watch(runId: string, sink: RunSink) {
    this.#sinks.set(runId, sink);
  }

  unwatch(runId: string) {
    this.#sinks.delete(runId);
  }

  /** 礼貌地关：关掉 hostd 的 stdin，它就退；执行体不受影响。 */
  close() {
    this.#child.stdin?.end();
    this.#close(new Error('连接已关'));
  }
}

type Mode =
  | { kind: 'start'; spec: HostSpawnSpec }
  | { kind: 'resume'; after: { stdout: number; stderr: number } };

const REATTACH_TRIES = 5;

class HostdProcess implements HostProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** 已经交出去的行数（两路各数各的）；内核存下它，重启后用 resumeProcess 从这里接。 */
  readonly cursor: { stdout: number; stderr: number };
  #pid: number | undefined;
  readonly #host: HostdProcessHost;
  readonly #runId: string;
  readonly #errorCbs: ((err: Error) => void)[] = [];
  readonly #exitCbs: ((code: number | null, signal: string | null) => void)[] = [];
  readonly #closeCbs: (() => void)[] = [];
  readonly #spawnedCbs: ((pid: number) => void)[] = [];
  readonly #lineCbs: ((stream: 'stdout' | 'stderr', line: number, text: string) => void)[] = [];
  #exited = false;
  /** 起好了（spawn 回了、或是接回的）：stdin、stop、reap 都排在它后面。 */
  readonly #started: Promise<void>;
  #startedOk: () => void = () => {};
  #startedFail: (err: Error) => void = () => {};

  constructor(host: HostdProcessHost, runId: string, mode: Mode) {
    this.#host = host;
    this.#runId = runId;
    this.cursor = mode.kind === 'resume' ? { ...mode.after } : { stdout: 0, stderr: 0 };
    const decoder = new StringDecoder('utf8');
    this.#started = new Promise<void>((resolve, reject) => {
      this.#startedOk = resolve;
      this.#startedFail = reject;
    });
    this.#started.catch(() => {});
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        const data = decoder.write(chunk);
        this.#afterStart(async () => {
          if (data) await this.#request({ type: 'stdin', runId, data, end: false });
        }).then(() => cb(), cb);
      },
      final: (cb) => {
        const rest = decoder.end();
        this.#afterStart(() => this.#request({ type: 'stdin', runId, data: rest, end: true })).then(
          () => cb(),
          cb,
        );
      },
    });
    void this.#begin(mode);
  }

  get pid() {
    return this.#pid;
  }

  async #request(body: RequestBody): Promise<Response> {
    return (await this.#host.connect()).request(body);
  }

  #afterStart<T>(fn: () => Promise<T>): Promise<T> {
    return this.#started.then(fn);
  }

  async #begin(mode: Mode) {
    try {
      if (mode.kind === 'start') {
        const { spec } = mode;
        const r = await this.#request({
          type: 'spawn',
          runId: this.#runId,
          command: spec.command,
          cwd: spec.cwd,
          env: { ...spec.env, [RUN_MARKER_KEY]: runMarker(spec.runId) },
        });
        if (r.type === 'spawned') {
          this.#pid = r.pid;
          for (const cb of this.#spawnedCbs) cb(r.pid);
        }
      }
      this.#startedOk();
      await this.#attach();
    } catch (err) {
      this.#fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async #attach() {
    const conn = await this.#host.connect();
    conn.watch(this.#runId, {
      out: (stream, line, text) => this.#onOut(stream, line, text),
      exit: (code, signal) => this.#finish(code, signal),
      lost: () => void this.#reattach(),
    });
    // 回复里的结局不用管：它早就结束的话，exit 帧会跟着输出一起推过来
    await conn.request({
      type: 'attach',
      runId: this.#runId,
      after: { stdout: this.cursor.stdout, stderr: this.cursor.stderr },
    });
  }

  /** 连接丢了：重新连一个 hostd，从已交出去的行号接着读。几次都不成才当成看不到结局。 */
  async #reattach() {
    for (let i = 1; i <= REATTACH_TRIES && !this.#exited; i++) {
      try {
        await new Promise((r) => setTimeout(r, 100 * i));
        await this.#attach();
        return;
      } catch (err) {
        if (err instanceof HostdVersionError) break;
      }
    }
    if (!this.#exited) this.#finish(null, 'lost');
  }

  #onOut(stream: 'stdout' | 'stderr' | 'pty', line: number, text: string) {
    if (stream === 'pty') return;
    // 重连后同一行不会再来（接的是行号之后），这里再守一道：不是下一行就丢，不重复交
    if (line !== this.cursor[stream] + 1) return;
    this.cursor[stream] = line;
    for (const cb of this.#lineCbs) cb(stream, line, text);
    (stream === 'stdout' ? this.stdout : this.stderr).write(`${text}\n`);
  }

  /** 收尾：exit 回调（没起来的不叫，和本机起不来时一样只有 error 和 close）、再收流、流收完叫 close。 */
  #finish(code: number | null, signal: string | null, notifyExit = true) {
    if (this.#exited) return;
    this.#exited = true;
    if (notifyExit) for (const cb of this.#exitCbs) cb(code, signal);
    let open = 2;
    const done = () => {
      if (--open === 0) for (const cb of this.#closeCbs) cb();
    };
    this.stdout.once('end', done);
    this.stderr.once('end', done);
    this.stdout.end();
    this.stderr.end();
  }

  #fail(err: Error) {
    if (this.#exited) return;
    this.#startedFail(err);
    for (const cb of this.#errorCbs) cb(err);
    // 没起来（或接不回）：流收掉，close 照来，调用方不会卡在等管道；起来过的补一个「看不到结局」的 exit
    this.#finish(null, 'lost', this.#pid !== undefined);
  }

  onError(cb: (err: Error) => void) {
    this.#errorCbs.push(cb);
  }
  onExit(cb: (code: number | null, signal: string | null) => void) {
    this.#exitCbs.push(cb);
  }
  onClose(cb: () => void) {
    this.#closeCbs.push(cb);
  }
  /** 起好、拿到进程号时叫一次（起是异步的，pid 起初是 undefined）。 */
  onSpawned(cb: (pid: number) => void) {
    if (this.#pid !== undefined) cb(this.#pid);
    else this.#spawnedCbs.push(cb);
  }
  /** 每交出一行就叫一次，带行号：内核据此把「事件落库」和「游标前进」排成先后（重启后从落库的最后一行接）。 */
  onLine(cb: (stream: 'stdout' | 'stderr', line: number, text: string) => void) {
    this.#lineCbs.push(cb);
  }

  stop(mode: 'term' | 'kill') {
    void this.#afterStart(() => this.#request({ type: 'stop', runId: this.#runId, mode })).catch(() => {});
  }

  async reap(graceMs: number): Promise<HostReap> {
    await this.#started;
    const r = await this.#request({ type: 'reap', runId: this.#runId, graceMs });
    if (r.type !== 'reaped') throw new HostdError('bad_reply', `reap 得到 ${r.type}`);
    return { found: r.found, leftovers: r.leftovers ?? undefined };
  }
}

/** hostd 起的一个执行体：除了 HostProcess 的，还有已交出的行数（游标）和带行号的逐行回调，内核据此存档、重启后接回。 */
export interface HostdRun extends HostProcess {
  readonly cursor: { stdout: number; stderr: number };
  onLine(cb: (stream: 'stdout' | 'stderr', line: number, text: string) => void): void;
  onSpawned(cb: (pid: number) => void): void;
}

export interface HostdHostOptions {
  /** 起 hostd 的命令：本机是 [hostd, '--stdio', '--state-dir', 目录]；SSH 远端是 ['ssh', '-T', 别名, 'fleet2-hostd', '--stdio']。 */
  launch: string[];
}

export class HostdProcessHost implements ProcessHost {
  readonly kind = 'hostd' as const;
  readonly #launch: string[];
  #conn: Promise<HostdConnection> | undefined;
  #shut = false;

  constructor(opts: HostdHostOptions) {
    this.#launch = opts.launch;
  }

  /** 当前的连接；没有或断了就重起一个 hostd 并握手（版本不对拒用）。并发来的几个调用共用同一个新连接。 */
  connect(): Promise<HostdConnection> {
    if (this.#shut) return Promise.reject(new Error('host 已关'));
    const fresh = async () => {
      const c = new HostdConnection(this.#launch);
      await c.ready;
      return c;
    };
    const next = (this.#conn ?? Promise.reject(new Error('还没有连接'))).then(
      (c) => (c.closed ? fresh() : c),
      () => fresh(),
    );
    this.#conn = next;
    return next;
  }

  start(spec: HostSpawnSpec): HostdRun {
    return new HostdProcess(this, spec.runId, { kind: 'start', spec });
  }

  /** 内核重启后接回：从已经收下的行数（两路各自）之后接着推，不漏不重。 */
  resume(runId: string, after: { stdout: number; stderr: number }): HostdRun {
    return new HostdProcess(this, runId, { kind: 'resume', after });
  }

  /** 这个会话还有进程在吗：true / false；hostd 说不准（或连不上）回 undefined。 */
  async attach(runId: string): Promise<boolean | undefined> {
    try {
      const r = await (await this.connect()).request({ type: 'status', runId });
      if (r.type !== 'state') return undefined;
      if (!r.known) return false;
      if (r.exit) return false;
      return r.alive ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 删掉这个 runId 在 hostd 那边的输出和记录（已经结束了才行）。 */
  async forget(runId: string): Promise<void> {
    await (await this.connect()).request({ type: 'forget', runId });
  }

  /** 关连接（hostd 退出；执行体不受影响）。 */
  async close(): Promise<void> {
    this.#shut = true;
    const c = this.#conn;
    this.#conn = undefined;
    if (c) (await c.catch(() => undefined))?.close();
  }
}

/** 没有 hostd 可执行文件时抛错：调用方先 hostdBinary() 判断，不悄悄换成别的实现。 */
export function makeHostdHost(opts?: {
  bin?: string | undefined;
  stateDir?: string | undefined;
  launch?: string[] | undefined;
}): HostdProcessHost {
  if (opts?.launch) return new HostdProcessHost({ launch: opts.launch });
  const bin = opts?.bin ?? hostdBinary();
  if (!bin) throw new Error('找不到 hostd 可执行文件（设 FLEET_HOSTD，或先 cargo build -p hostd）');
  return new HostdProcessHost({
    launch: [bin, '--stdio', ...(opts?.stateDir ? ['--state-dir', opts.stateDir] : [])],
  });
}
