// 测试里真起子进程（命令行入口）一律走这里：同步地跑，每个子进程自己带上限。
//
// 用这里的用例都是同步的，不设 vitest 的超时（describe / it 上 timeout: 0）：vitest 的超时对同步用例打断不了，只能等它
// 跑完再量用了多久（vitest-dev/vitest#2920）——真卡死的子进程照样卡住整轮测试，机器一忙、起一个 node 要装一堆依赖，
// 它又把「慢」报成失败（本机几十个测试进程一起跑时，这里的命令行入口就这么红过）。所以卡死由这里管：子进程超过上限
// 没退出就杀掉，抛出是哪条命令卡住。起不来、被信号杀掉也抛，不拿 null 退出码冒充「命令失败」。
// 同样的一份在 packages/hygiene、packages/engine 的 test/child.ts：各包的测试自成一体，改这份时看一眼那两份。
import { spawnSync } from 'node:child_process';

/** 一个子进程最多跑多久。只防卡死、不量快慢：正常起一个 node 不到一秒，满载的机器上也就几秒。 */
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
  if (r.error !== undefined || r.status === null) {
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
