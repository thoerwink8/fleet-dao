// 从 packages/github/test/child.ts 的 runChild 抄来（#264，只在 packages/agents-sync 收口）：测试里真起子进程
// 一律走这里：同步地跑，每个子进程自己带上限。
//
// 用这里的用例都是同步的：vitest 的超时对同步用例打断不了，只能等它跑完再量用了多久（vitest-dev/vitest#2920）——
// 真卡死的子进程照样卡住整轮测试，机器一忙、起进程变慢，它又把「慢」报成失败。所以卡死由这里管：子进程超过上限
// 没退出就杀掉，抛出是哪条命令卡住。起不来、被信号杀掉也抛，不拿 null 退出码冒充「命令失败」——不然期望「失败」的
// 用例会因为根本没跑而通过。
// 同样的一份在 packages/conventions、packages/hygiene、packages/api、packages/engine、packages/github 的 test/child.ts：
// 各包的测试自成一体，改这份时看一眼那几份（收成一份见 #264）。
import { spawnSync } from 'node:child_process';

/**
 * Windows 上 node 跑 .ts 入口、用 process.exit 退出时，偶发崩成 0xC0000409（stderr 一行 libuv 的
 * Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)，nodejs/node#56645）：剥类型用的 wasm 还在后台分层编译，
 * 退出时往已经关掉的句柄发消息，退出码丢了（本机并行跑测试时 flow-stats 那条「退出 2」就这么红过，压测一百五十次崩十几次）。
 * 测试起的 node 关掉这层分层编译（--no-wasm-dynamic-tiering，压测零次），退出码才可信；别的系统、别的命令原样。
 */
export function withNodeFlags(command: string, args: readonly string[]): readonly string[] {
  return process.platform === 'win32' && command === process.execPath
    ? ['--no-wasm-dynamic-tiering', ...args]
    : args;
}

/** 一个子进程最多跑多久。只防卡死、不量快慢：正常起一个 git 几十毫秒，满载的机器上也就几秒。 */
export const CHILD_LIMIT_MS = 60_000;

export interface ChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 写进标准输入；不给就是空的（马上读到结尾），子进程不会等输入。 */
  input?: string;
  /** 只有测上限本身的用例改它。 */
  limitMs?: number;
  /** Windows 上不弹控制台窗口。原样交给 spawnSync。 */
  windowsHide?: boolean;
}

export interface ChildResult {
  /** 子进程自己的退出码；非 0 照样交回，由调用方判。 */
  status: number;
  stdout: string;
  stderr: string;
}

export function runChild(command: string, args: readonly string[], options: ChildOptions = {}): ChildResult {
  const { limitMs = CHILD_LIMIT_MS, ...rest } = options;
  const r = spawnSync(command, withNodeFlags(command, args), {
    ...rest,
    encoding: 'utf8',
    timeout: limitMs,
    killSignal: 'SIGKILL',
  });
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
