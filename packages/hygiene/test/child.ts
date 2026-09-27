// 测试里真起子进程（git、命令行入口）一律走这里：同步地跑，每个子进程自己带上限。
//
// 用这里的用例都是同步的，不设 vitest 的超时（describe / it 上 timeout: 0，钩子第二个参数 0）：vitest 的超时对同步
// 用例打断不了，只能等它跑完再量用了多久（vitest-dev/vitest#2920）——真卡死的 git 照样卡住整轮测试，机器一忙、几十个
// git 慢一点，它又把「慢」报成失败（ci-history 就这么红过）。所以卡死由这里管：子进程超过上限没退出就杀掉，抛出是
// 哪条命令卡住。起不来、被信号杀掉也抛，不拿 null 退出码冒充「命令失败」——不然期望「失败」的用例会因为根本没跑而通过。
// 同样的 runChild 在 packages/api、packages/engine 的 test/child.ts 各有一份：各包的测试自成一体（卫生检查的测试不借
// 别的包的代码），改这份时看一眼那两份。
import { spawnSync } from 'node:child_process';
import type { GitSync } from '../src/prepush.ts';

/** 一个子进程最多跑多久。只防卡死、不量快慢：正常一个 git 几十毫秒，满载的机器上也就一两秒。 */
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
  const r = runChild('git', [...GIT_ID, '-c', 'core.autocrlf=false', ...args], { cwd });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ').slice(0, 200)} 退出码 ${r.status}：${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

/** 交给被测判定函数的 git：退出码、输出原样交回，由判定函数自己判。cwd 用函数给，临时仓在 beforeAll 里才建。 */
export function gitSyncIn(cwd: () => string): GitSync {
  return (args) => {
    const r = runChild('git', args, { cwd: cwd() });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}
