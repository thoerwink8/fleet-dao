// ProcessHost：起、接回、叫停、按行读、收尸五件事的接口（决定 0125 第 8 条，讨论稿 6.4a 的迁移路径）。
// 实现：host-local.ts（进程组加会话标记，行为不变）、host-jobrun.ts（Windows Job Object，crates/jobrun）、
// host-hostd.ts（宿主帮手 hostd，crates/hostd：脱离会话跑、输出落文件按行号接回，#3871）。
// 三者跑同一套一致性测试（test/host-conformance.test.ts）。runProcess 只认这个接口，不知道下面是哪一种。
import type { Readable, Writable } from 'node:stream';
import { LineSplitter } from './lines.ts';

export interface HostSpawnSpec {
  /** 可执行文件（建议绝对路径）加参数。 */
  command: string[];
  cwd: string;
  /** 整份环境；会话标记由实现加上。 */
  env: Record<string, string>;
  runId: string;
  /**
   * Windows 上参数已经按 CreateProcess 的原样写好（例如 cmd.exe /s /c 外面那层引号）。
   * 再让运行时包一层就会把 .cmd 跑歪。
   */
  windowsVerbatimArguments?: boolean;
}

export interface HostReap {
  /** 收尸前会话里还活着的进程数。 */
  found: number;
  /** 收完还剩几个；undefined = 没查成（不当成收干净了）。 */
  leftovers: number | undefined;
}

/** 一个已经起来的执行体。 */
export interface HostProcess {
  /** 本机进程号；没起来是 undefined（这时 onError 会来）。hostd 实现的起是异步的，进程号晚一点才有，见 onSpawned。 */
  readonly pid: number | undefined;
  /** 进程号晚到的实现（hostd）才有：起好拿到进程号时叫一次（已经有了就立刻叫）。 */
  onSpawned?(cb: (pid: number) => void): void;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  onError(cb: (err: Error) => void): void;
  /** 执行体退了。 */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  /** 输出管道都关了。 */
  onClose(cb: () => void): void;
  /**
   * 叫停：'term' 是礼貌的一下（先记下会话现状），'kill' 是不留情面的一下；可以连着叫，后一下不盖掉前一下的记录。
   * 不阻塞：别的实现里这一步要起子进程，异步做。
   */
  stop(mode: 'term' | 'kill'): void;
  /** 执行体退了以后收掉会话里剩下的，回收前几个、收完几个。 */
  reap(graceMs: number): Promise<HostReap>;
}

export interface ProcessHost {
  readonly kind: 'local' | 'jobrun' | 'hostd';
  /** 起。起不来时 pid 是 undefined、onError 会来。 */
  start(spec: HostSpawnSpec): HostProcess;
  /** 接回：内核重启后这个会话还有进程在吗；true / false，查不了回 undefined。 */
  attach(runId: string): Promise<boolean | undefined>;
}

/** 按行读：每来一整行就交一次；返回的切分器收尾时调 end()。 */
export function readLines(stdout: Readable, onLine: (line: string) => void): LineSplitter {
  const splitter = new LineSplitter();
  stdout.on('data', (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) onLine(line);
  });
  return splitter;
}
