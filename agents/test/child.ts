// 从 packages/engine/test/child.ts 抄来（#264，只在 agents/test 收口）：测试里真起子进程（git、node、sh）一律走这里：
// 同步地跑，每个子进程自己带上限。
//
// 用这里的用例都是同步的，不设 vitest 的超时（describe / it 上 timeout: 0）：vitest 的超时对同步用例打断不了，只能等它
// 跑完再量用了多久（vitest-dev/vitest#2920）——真卡死的子进程照样卡住整轮测试，机器一忙、起进程变慢，它又把「慢」报成
// 失败。所以卡死由这里管：子进程超过上限没退出就杀掉，抛出是哪条命令卡住。起不来、被信号杀掉也抛，不拿 null 退出码
// 冒充「命令失败」。
// 同样的一份在 packages/engine、packages/agents-sync 等包的 test/child.ts：各包的测试自成一体，改这份时看一眼那几份。
// runChildOk：退出码不是 0 就抛（带上 stderr），成功返回去掉首尾空白的标准输出。
import { spawnSync } from 'node:child_process';

/** 一个子进程最多跑多久。只防卡死、不量快慢：正常起一个 node 或 sh 不到一秒，满载的机器上也就几秒。 */
export const CHILD_LIMIT_MS = 60_000;

export interface ChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 写进标准输入；不给就是空的（马上读到结尾），子进程不会等输入。 */
  input?: string;
  /** 只有测上限本身的用例改它。 */
  limitMs?: number;
}

export interface ChildResult {
  /** 子进程自己的退出码；非 0 照样交回，由调用方判。 */
  status: number;
  stdout: string;
  stderr: string;
  /** 子进程的 pid。它已经退出了：要一个「一定死了的 pid」的用例拿它用（rules/stop.rules.test.ts 登记掉线的工人）。 */
  pid: number;
}

export function runChild(command: string, args: readonly string[], options: ChildOptions = {}): ChildResult {
  const { limitMs = CHILD_LIMIT_MS, ...rest } = options;
  const r = spawnSync(command, args, { ...rest, encoding: 'utf8', timeout: limitMs, killSignal: 'SIGKILL' });
  // status 不是 null：子进程真退出过、拿到了退出码。子进程不读标准输入就退出时，父进程写 input 写到一半会碰上管道
  // 已经关了（Linux 上 EPIPE、Windows 上 EOF），r.error 照样会被设上——这只是写的时序问题，不算「没跑完」。
  // 真没跑完（起不来、超时、被信号杀）才会 status 是 null。
  if (r.status === null) {
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    const why =
      code === 'ETIMEDOUT'
        ? `${limitMs / 1000} 秒没退出，杀掉了`
        : r.error !== undefined
          ? r.error.message
          : `被信号 ${r.signal} 杀掉了`;
    throw new Error(`子进程没跑完（${[command, ...args].join(' ').slice(0, 200)}）：${why}`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, pid: r.pid };
}

/**
 * 从 execFileSync 迁过来的选项。encoding 为 utf8 时交回字符串（runChild 本来就按 utf8 读）。
 * stdio 不传也是 pipe。maxBuffer 是 execFile 的输出上限，spawn 没有这一项，卡死由 runChild 的时间上限管。
 */
export interface ChildOkOptions extends ChildOptions {
  encoding?: 'utf8';
  stdio?: 'pipe';
  maxBuffer?: number;
}

/** 退出码不是 0 就抛（带上 stderr），成功返回去掉首尾空白的标准输出。 */
export function runChildOk(command: string, args: readonly string[], options: ChildOkOptions = {}): string {
  const r = runChild(command, args, toChildOptions(options));
  if (r.status !== 0) {
    throw new Error(`${[command, ...args].join(' ').slice(0, 200)} 退出码 ${r.status}：${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

function toChildOptions(options: ChildOkOptions): ChildOptions {
  const out: ChildOptions = {};
  if (options.cwd !== undefined) out.cwd = options.cwd;
  if (options.env !== undefined) out.env = options.env;
  if (options.input !== undefined) out.input = options.input;
  if (options.limitMs !== undefined) out.limitMs = options.limitMs;
  return out;
}
