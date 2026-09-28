// 会话脱开引擎进程（发布、重启引擎不碰在跑的会话，specs/169 09-28 凌晨拍板）：执行体的标准输入、输出、错误都接文件，
// 退出码由会话那一侧的外壳写进文件；引擎只是按序号读这些文件。引擎重启了，新引擎照同一个目录从头重读（接回），
// 会话跑完了也读得到它的结局。
// 收发目录（引擎的，归 fleet，0711）里：prompt（提示词，0644）、out（执行体的标准输出，一行一帧，0622）、err（标准错误，0622）、
// exit（外壳写的退出码，0622）、pid（外壳的进程号，0622）、signal（外壳接到 TERM/INT 时追加的时刻和父进程名，0622）、
// reap（引擎收孤儿之前写下的原因，0622）、started（起的时刻）、helper.err（帮手、外壳自己的报错，引擎写）。
// 改这里之前必须知道：
// - 会话以会话用户的身份跑，写不了引擎的文件：out、err、exit、pid、signal、reap 由引擎先建好、给别人写的权限（0622），目录 0711 别人列不出；
//   路径里带着会话编号（UUID），猜不到。会话用户建不了新文件，所以信号记录只能追加进预先建好的 signal。
// - 外壳（WRAPPER）接住 TERM、INT：scope 被收时 systemd 给 scope 里每个进程发 SIGTERM，外壳等执行体退了再写退出码
//   （POSIX：前台命令没结束，trap 不跑），并往 signal 追加一行「信号 时刻 父进程名」。外壳被 SIGKILL 就没有退出码、也没有这一行：
//   读的一方照实报「退出码丢了」（exitLost）、「外壳没有记下接到的信号」，不当成 0、也不当成没人发信号。
// - 序号 = out 里第几行（从 0 起，超长丢掉的行不占号）：同一份文件怎么重读都是同一个号，引擎按它去重。
// - 接回时（attach）不起进程：起的时刻、上一次写输出的时刻从文件读，总时长、停滞照原来的起点算。
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LineSplitter } from './lines.ts';
import type {
  AgentProcessHooks,
  AgentProcessResult,
  AgentProcessSpec,
  ProcessControl,
  SpawnInfo,
} from './process.ts';
import { alive, reapSession, scopeProcCount, scopeUnit, stopScope } from './procs.ts';

export interface DetachedIo {
  /** 这次会话的收发目录（引擎的）。 */
  dir: string;
  /** 接回（引擎重启后）：不起进程，从头重读已有的输出、等它收场。 */
  attach?: boolean;
  /** 多久看一次文件（毫秒），默认 200。 */
  pollMs?: number;
  /** 进程（或 scope）已经没了、退出码文件还是空的，再等这么久才判「退出码丢了」（毫秒），默认 3000。 */
  exitGraceMs?: number;
  /**
   * 放手（引擎停机）：不再读、不再计时、不停会话，这次调用也不再交报告（永远不落定）——会话接着跑，由下一个引擎接回。
   * 和 signal（叫停，要收掉会话）不是一回事。
   */
  release?: AbortSignal;
}

export const IO_FILES = {
  prompt: 'prompt',
  out: 'out',
  err: 'err',
  exit: 'exit',
  pid: 'pid',
  /** 外壳接到 TERM / INT：一行「信号 时刻 父进程名」。空着 = 没接到（或被 SIGKILL，trap 没跑）。 */
  signal: 'signal',
  /** 引擎收孤儿之前写下的原因和时间。空着 = 这次不是收孤儿收的。 */
  reap: 'reap',
  started: 'started',
  helperErr: 'helper.err',
} as const;

/**
 * 会话那一侧的外壳（/bin/sh -c）：记下自己的进程号，接住 TERM、INT，执行体的输入输出接文件，退了写退出码。
 * 参数：输入 输出 错误 退出码 进程号 -- 命令…
 * signal 文件和 pid 在同一目录（会话用户建不了新文件，只追加引擎预先建好的那个）。
 */
export const WRAPPER = [
  'in=$1 out=$2 err=$3 st=$4 pidf=$5',
  'shift 5',
  'echo $$ >>"$pidf"',
  'sig=$(dirname "$pidf")/signal',
  // 挂断信号一律不理（执行体也跟着不理）：引擎、帮手退了都不该带走会话
  "trap '' HUP",
  // 前台命令没退，trap 先记着，退了再写。写不进去不挡退出码。父进程名读不到就写「读不到」，不当成没有信号。
  'note() { comm=$(ps -o comm= -p "$PPID" 2>/dev/null) || true; if [ -z "$comm" ]; then comm=读不到; fi; printf \'%s %s %s\\n\' "$1" "$(date +%s)" "$comm" >>"$sig" 2>/dev/null || true; }',
  "trap 'note TERM' TERM",
  "trap 'note INT' INT",
  '"$@" <"$in" >>"$out" 2>>"$err"',
  'c=$?',
  'printf \'%s\\n\' "$c" >>"$st"',
].join('\n');

const STDERR_TAIL = 16 * 1024;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 引擎建收发目录：目录 0711、提示词 0644、会话要写的几个文件先建好 0622（会话用户写得进、别人读不到内容）。 */
export async function prepareIo(dir: string, prompt: string, startedAt: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o711 });
  await chmod(dir, 0o711);
  const put = async (name: string, content: string, mode: number) => {
    const path = join(dir, name);
    await writeFile(path, content, { mode });
    await chmod(path, mode);
  };
  await put(IO_FILES.prompt, prompt, 0o644);
  for (const name of [
    IO_FILES.out,
    IO_FILES.err,
    IO_FILES.exit,
    IO_FILES.pid,
    IO_FILES.signal,
    IO_FILES.reap,
  ])
    await put(name, '', 0o622);
  await put(IO_FILES.started, `${startedAt}\n`, 0o644);
  await put(IO_FILES.helperErr, '', 0o600);
}

/** 读外壳写的退出码：空的是还没写；写了却认不出照实抛。 */
export function parseExitFile(text: string): number | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (line === undefined) return undefined;
  if (!/^\d{1,3}$/.test(line)) throw new Error(`退出码文件认不出：「${line.slice(0, 40)}」`);
  return Number(line);
}

async function tail(path: string, bytes: number): Promise<string> {
  try {
    const buf = await readFile(path);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8');
  } catch {
    return '';
  }
}

/** 按文件跑一个会话（起，或接回）。形状和管道那一种（runAgentProcess）一样。 */
export function runDetached(
  spec: AgentProcessSpec & { io: DetachedIo },
  launch: (() => { command: string[]; env: Record<string, string>; cwd: string }) | undefined,
  hooks: AgentProcessHooks,
  now: () => Date,
): Promise<AgentProcessResult> {
  const io = spec.io;
  const pollMs = io.pollMs ?? 200;
  const exitGraceMs = io.exitGraceMs ?? 3_000;
  const file = (name: string) => join(io.dir, name);
  return new Promise((resolve) => {
    const t0 = Date.now();
    let startedAt = now().toISOString();
    let startMs = t0;
    const splitter = new LineSplitter();
    let lines = 0;
    let seq = -1;
    let firstLineMs: number | undefined;
    let lastActivity = t0;
    let killed: AgentProcessResult['killed'];
    let hookError: string | undefined;
    let finished = false;
    /** 放手了（io.release）：读到一半的行也不再交出去。 */
    let released = false;
    let offset = 0;
    let exitCode: number | null | undefined;
    let exitSignal: string | null = null;
    let exitLost: string | undefined;
    let goneSince: number | undefined;
    let helperExit: { code: number | null; signal: string | null; at: number } | undefined;
    let childPid: number | undefined;
    let polling = false;
    let lastScopeCheck = 0;
    let lastGone = false;
    const timers: NodeJS.Timeout[] = [];
    const reapErrors: string[] = [];
    let scopeStop: Promise<void> | undefined;
    const record = (err: unknown) => {
      hookError ??= errorText(err);
    };

    const control: ProcessControl = {
      get seq() {
        return seq;
      },
      touch: () => {
        lastActivity = Date.now();
      },
      kill: (reason) => {
        if (killed || exitCode !== undefined || exitLost || finished) return;
        killed = { reason, at: now().toISOString() };
        void terminate();
      },
    };
    const onAbort = () => control.kill('aborted');

    async function sessionPid(): Promise<number | undefined> {
      const text = await readFile(file(IO_FILES.pid), 'utf8').catch(() => '');
      const n = Number(text.split('\n')[0]?.trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }

    async function terminate(): Promise<void> {
      if (spec.scope) {
        // 会话用户的进程引擎发不了信号：整个 scope 经帮手收（systemd 先 SIGTERM、到点 SIGKILL）
        scopeStop ??= stopScope(spec.scope).then((err) => {
          if (err) reapErrors.push(err);
        });
        return;
      }
      // 没有 scope（测试、开发机）：外壳是自己那一组的头（起的时候 detached），按组发信号——只发给外壳，执行体收不到；
      // 到点 SIGKILL
      const pid = (await sessionPid()) ?? childPid;
      if (pid === undefined) return;
      const send = (sig: NodeJS.Signals) => {
        try {
          process.kill(-pid, sig);
        } catch {
          try {
            process.kill(pid, sig);
          } catch {
            // 已经没了
          }
        }
      };
      send('SIGTERM');
      timers.push(setTimeout(() => send('SIGKILL'), spec.limits.killGraceMs));
    }

    function handleLine(line: string) {
      if (released) return;
      lines++;
      seq++;
      if (firstLineMs === undefined) {
        firstLineMs = Date.now() - startMs;
        lastActivity = Math.max(lastActivity, Date.now());
      }
      try {
        hooks.onLine(line, control);
      } catch (err) {
        record(err);
      }
    }

    async function readOut(): Promise<void> {
      let fh: Awaited<ReturnType<typeof open>> | undefined;
      try {
        fh = await open(file(IO_FILES.out), 'r');
        const buf = Buffer.alloc(256 * 1024);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
          for (const line of splitter.push(buf.subarray(0, bytesRead))) handleLine(line);
        }
      } catch (err) {
        record(err);
      } finally {
        await fh?.close().catch(() => undefined);
      }
    }

    /** 会话那一侧还在不在：有 scope 看 scope 里还有没有进程；没有就看外壳的进程号。undefined = 没查成。 */
    async function sessionAlive(): Promise<boolean | undefined> {
      if (spec.scope) {
        const n = scopeProcCount(spec.scope);
        return n === undefined ? undefined : n > 0;
      }
      const pid = await sessionPid();
      if (pid === undefined) return childPid === undefined ? false : helperExit === undefined;
      return alive(pid);
    }

    async function finish(): Promise<void> {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      spec.signal?.removeEventListener('abort', onAbort);
      await readOut();
      for (const line of splitter.end()) handleLine(line);
      let reaped: { stragglers: number; leftovers: number | undefined } = {
        stragglers: 0,
        leftovers: undefined,
      };
      try {
        await scopeStop;
        const r = await reapSession({
          runId: spec.runId,
          ...(spec.scope ? { scope: spec.scope } : {}),
          graceMs: spec.limits.killGraceMs,
        });
        reaped = { stragglers: r.found, leftovers: r.leftovers };
        if (r.error) reapErrors.push(r.error);
      } catch (err) {
        reapErrors.push(errorText(err));
      }
      const stderrTail = [
        await tail(file(IO_FILES.helperErr), 4 * 1024),
        await tail(file(IO_FILES.err), STDERR_TAIL),
      ]
        .filter(Boolean)
        .join('\n')
        .slice(-STDERR_TAIL);
      resolve({
        exitCode: exitCode ?? null,
        signal: exitSignal,
        ...(killed ? { killed } : {}),
        ...(exitLost ? { exitLost } : {}),
        stragglers: reaped.stragglers,
        leftovers: reaped.leftovers,
        ...(reapErrors.length && reaped.leftovers !== 0 ? { reapError: reapErrors.join('；') } : {}),
        stderrTail,
        startedAt,
        endedAt: now().toISOString(),
        wallMs: Date.now() - startMs,
        ...(firstLineMs === undefined ? {} : { firstLineMs }),
        lines,
        droppedLines: splitter.dropped,
        ...(hookError === undefined ? {} : { hookError }),
      });
    }

    async function poll(): Promise<void> {
      if (polling || finished) return;
      polling = true;
      try {
        await readOut();
        const exitText = await readFile(file(IO_FILES.exit), 'utf8').catch((err: NodeJS.ErrnoException) => {
          // 退出码文件本该在（引擎自己建的）：读不成照实记，按丢了处理
          exitLost ??= `退出码文件读不成（${errorText(err)}）`;
          return '';
        });
        try {
          const code = parseExitFile(exitText);
          if (code !== undefined) {
            exitCode = code;
            await finish();
            return;
          }
        } catch (err) {
          exitLost ??= errorText(err);
        }
        // 外壳还没写退出码：会话那一侧没了（帮手退了、scope 空了、进程号没了）就再等一小会儿，还没有就判「丢了」
        // 查在不在（scope 要经 systemctl）最多两秒一次，两次之间沿用上一次的结论
        const t = Date.now();
        if (!helperExit && (t - lastScopeCheck >= 2_000 || exitLost)) {
          lastScopeCheck = t;
          lastGone = (await sessionAlive()) === false;
        }
        const gone = Boolean(helperExit) || lastGone;
        if (gone || exitLost) {
          goneSince ??= t;
          if (t - goneSince >= exitGraceMs) {
            if (helperExit && helperExit.code !== 0 && lines === 0 && !exitLost) {
              // 帮手当场拒了（参数、身份不对），外壳都没跑起来：照帮手的退出码交回，原话在 helper.err
              exitCode = helperExit.code;
              exitSignal = helperExit.signal;
            } else {
              exitLost ??= helperExit
                ? `会话那一侧已经退了（帮手退出码 ${helperExit.code ?? helperExit.signal}），外壳没写退出码（多半是被强杀）`
                : '会话已经不在了，外壳没写退出码（引擎不在的时候被强杀、或者机器重启过）';
            }
            await finish();
            return;
          }
        } else {
          goneSince = undefined;
        }
      } finally {
        polling = false;
      }
    }

    async function start(): Promise<void> {
      if (spec.signal?.aborted) {
        killed = { reason: 'aborted', at: now().toISOString() };
        if (io.attach) void terminate();
        else {
          resolve({
            exitCode: null,
            signal: null,
            killed,
            stragglers: 0,
            leftovers: 0,
            stderrTail: '',
            startedAt,
            endedAt: startedAt,
            wallMs: 0,
            lines: 0,
            droppedLines: 0,
          });
          finished = true;
          return;
        }
      }
      if (io.attach) {
        // 接回：起的时刻、上一次写输出的时刻照文件，计时照原来的起点
        const started = (await readFile(file(IO_FILES.started), 'utf8').catch(() => '')).trim();
        const ms = Date.parse(started);
        if (!Number.isNaN(ms)) {
          startedAt = new Date(ms).toISOString();
          startMs = ms;
        }
        // 先把已有的输出读完（重放）再上计时：不然「一行都没有」的起步超时会在读完之前就把它当成没起来
        await readOut();
        const out = await stat(file(IO_FILES.out)).catch(() => undefined);
        lastActivity = out ? Math.max(startMs, out.mtimeMs) : Date.now();
      } else {
        if (!launch) throw new Error('起会话要给怎么起');
        await prepareIo(io.dir, spec.stdin, startedAt);
        const l = launch();
        const [bin, ...args] = l.command;
        const errFh = await open(file(IO_FILES.helperErr), 'a');
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(bin as string, args, {
            cwd: l.cwd,
            env: l.env,
            // 会话的输入输出都走文件：引擎这边一个管道都不接，引擎退了会话照跑
            stdio: ['ignore', 'ignore', errFh.fd],
            detached: process.platform !== 'win32',
            windowsHide: true,
          });
        } finally {
          await errFh.close().catch(() => undefined);
        }
        child.on('error', (err) => {
          if (child.pid === undefined && !finished) {
            finished = true;
            for (const t of timers) clearTimeout(t);
            resolve({
              exitCode: null,
              signal: null,
              spawnError: err.message,
              stragglers: 0,
              leftovers: 0,
              stderrTail: '',
              startedAt,
              endedAt: now().toISOString(),
              wallMs: Date.now() - t0,
              lines: 0,
              droppedLines: 0,
            });
          }
        });
        child.on('exit', (code, signal) => {
          helperExit = { code, signal, at: Date.now() };
          void poll();
        });
        childPid = child.pid;
        // 引擎退出时不等这个帮手进程（它等会话结束）
        child.unref();
        if (child.pid !== undefined && hooks.onSpawn) {
          const info: SpawnInfo = {
            pid: child.pid,
            runId: spec.runId,
            ...(spec.scope ? { scope: scopeUnit(spec.scope) } : {}),
            startedAt,
          };
          try {
            const r: unknown = hooks.onSpawn(info);
            if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
              Promise.resolve(r).then(undefined, record);
            }
          } catch (err) {
            record(err);
          }
        }
      }
      const elapsed = Date.now() - startMs;
      timers.push(
        setTimeout(
          () => {
            if (firstLineMs === undefined) control.kill('startup_timeout');
          },
          Math.max(0, spec.limits.startupMs - elapsed),
        ),
        setTimeout(() => control.kill('wall_clock_timeout'), Math.max(0, spec.limits.wallClockMs - elapsed)),
        setInterval(() => void poll(), pollMs),
      );
      const idleMs = spec.limits.idleMs;
      if (idleMs !== undefined) {
        const every = Math.max(20, Math.min(1_000, Math.floor(idleMs / 5)));
        timers.push(
          setInterval(() => {
            if (firstLineMs !== undefined && !hooks.busy?.() && Date.now() - lastActivity > idleMs) {
              control.kill('idle_timeout');
            }
          }, every),
        );
      }
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      const letGo = () => {
        released = true;
        if (finished) return;
        finished = true;
        for (const t of timers) clearTimeout(t);
        spec.signal?.removeEventListener('abort', onAbort);
      };
      if (io.release?.aborted) letGo();
      else io.release?.addEventListener('abort', letGo, { once: true });
      void poll();
    }

    start().catch((err: unknown) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      resolve({
        exitCode: null,
        signal: null,
        spawnError: `会话的收发文件没备好：${errorText(err)}`,
        stragglers: 0,
        leftovers: 0,
        stderrTail: '',
        startedAt,
        endedAt: now().toISOString(),
        wallMs: Date.now() - t0,
        lines: 0,
        droppedLines: 0,
      });
    });
  });
}
