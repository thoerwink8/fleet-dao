// 从 packages/conventions/test/child.ts 抄来（#264 的第一片，只在 packages/github 收口）：测试里真起子进程
// （git、mkfifo）一律走这里：同步地跑，每个子进程自己带上限。
//
// 用这里的用例都是同步的：vitest 的超时对同步用例打断不了，只能等它跑完再量用了多久（vitest-dev/vitest#2920）——
// 真卡死的子进程照样卡住整轮测试，机器一忙、起进程变慢，它又把「慢」报成失败（test-changed 在临时仓里起三十几个
// git 的那条，和引擎的测试一起跑时就这么红过）。所以卡死由这里管：子进程超过上限没退出就杀掉，抛出是哪条命令卡住。
// 起不来、被信号杀掉也抛，不拿 null 退出码冒充「命令失败」——不然期望「失败」的用例会因为根本没跑而通过。
// 同样的一份在 packages/conventions、packages/hygiene、packages/api、packages/engine 的 test/child.ts：各包的测试
// 自成一体，改这份时看一眼那几份（收成一份见 #264）。
import { spawnSync } from 'node:child_process';

/** 一个子进程最多跑多久。只防卡死、不量快慢：正常起一个 git 几十毫秒，满载的机器上也就几秒。 */
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
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export interface ChildBytesResult {
  /** 子进程自己的退出码；非 0 照样交回，由调用方判。 */
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** 按字节交回的 runChild：pack-objects --stdout 的输出是二进制，经 utf8 转成字符串会损坏。 */
export function runChildBytes(
  command: string,
  args: readonly string[],
  options: ChildOptions = {},
): ChildBytesResult {
  const { limitMs = CHILD_LIMIT_MS, ...rest } = options;
  // encoding 不设，stdout/stderr 就是 Buffer；input 是字符串时按 utf8 进管道。
  const r = spawnSync(command, args, { ...rest, timeout: limitMs, killSignal: 'SIGKILL' });
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
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 造提交用的身份：不读这台机器的 git 配置里的名字邮箱，也不签名。 */
export const GIT_ID = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** 在 cwd 里跑 git 造测试数据：退出码不是 0 就抛（带上 git 自己说的），返回去掉首尾空白的标准输出。 */
export function gitIn(cwd: string, ...args: string[]): string {
  const r = runChild('git', [...GIT_ID, '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ').slice(0, 200)} 退出码 ${r.status}：${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}
