// 入口脚本怎么收尾：设 process.exitCode、让事件循环自己走完，不调 process.exit。
// 为什么（决定 0093）：Windows 上 node 在 process.exit 时偶发 libuv 的 UV_HANDLE_CLOSING 断言崩（退出码 3221226505，
// nodejs/node#56645），测试起子进程跑这些入口时就是一条假红（并行压测 150 次崩 13–28 次）。让进程自然退出不走那条路。
// 改这里之前必须知道：自然退出要等事件循环空——入口里还挂着定时器、没关的连接时进程不会退；用到它们的入口自己先关掉。

/** 入口里任何一层要提前退出时抛的：runMain 接住、设退出码，不是错误。 */
export class ExitRequest extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`退出码 ${code}`);
    this.name = 'ExitRequest';
    this.code = code;
  }
}

/** 提前退出（代替 process.exit）：只在 runMain 跑的 main 里用。 */
export function exitWith(code: number): never {
  throw new ExitRequest(code);
}

/**
 * 跑入口：main 回数字就当退出码（不回就是 0）；exitWith 抛的接住、设成它的退出码；别的错照抛（同步的照抛给 node，打栈退出 1；
 * 异步的打出来、退出码 1）。
 */
export function runMain(main: () => number | undefined | Promise<number | undefined>): void {
  const done = (code: number | undefined) => {
    if (code !== undefined) process.exitCode = code;
  };
  const exited = (e: unknown): boolean => {
    if (!(e instanceof ExitRequest)) return false;
    process.exitCode = e.code;
    return true;
  };
  let r: number | undefined | Promise<number | undefined>;
  try {
    r = main();
  } catch (e) {
    if (exited(e)) return;
    throw e;
  }
  if (!(r instanceof Promise)) {
    done(r);
    return;
  }
  r.then(done, (e: unknown) => {
    if (exited(e)) return;
    console.error(e);
    process.exitCode = 1;
  });
}
