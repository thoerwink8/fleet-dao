// 测试里真起子进程（node 命令行入口）一律走这里：同步地跑，每个子进程自己带上限。
//
// 写法照 packages/engine/test/child.ts（#264）。deploy/test 是 node:test 的 .mjs，各处测试自成一体，不引包里那份。
// node:test 的超时对同步用例打断不了（spawnSync 占着事件循环，计时器要等它返回才跑）：真卡死的子进程照样卡住整轮，
// 机器一忙、起进程变慢，只把超时调大也盖不住。卡死由这里管：超过上限没退出就杀掉，抛出是哪条命令卡住。
// 起不来、被信号杀掉也抛，不拿 null 退出码冒充「命令失败」。
import { spawnSync } from 'node:child_process';

/** 一个子进程最多跑多久。只防卡死、不量快慢：正常起一个 node 不到一秒，满载的机器上也就几秒。 */
export const CHILD_LIMIT_MS = 60_000;

/**
 * @typedef {Object} ChildOptions
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [input] 写进标准输入；不给就是空的（马上读到结尾），子进程不会等输入。
 * @property {number} [limitMs] 只有测上限本身的用例改它。
 */

/**
 * @typedef {Object} ChildResult
 * @property {number} status 子进程自己的退出码；非 0 照样交回，由调用方判。
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * 同步跑一条命令。超时、起不来、被信号杀掉都抛错（消息带命令和原因）。
 * 正常退出交回 `{ status, stdout, stderr }`，退出码不是 0 也照样交回。
 * @param {string} command
 * @param {readonly string[]} args
 * @param {ChildOptions} [options]
 * @returns {ChildResult}
 */
export function runChild(command, args, options = {}) {
  const { limitMs = CHILD_LIMIT_MS, ...rest } = options;
  const r = spawnSync(command, args, { ...rest, encoding: 'utf8', timeout: limitMs, killSignal: 'SIGKILL' });
  // status 不是 null：子进程真退出过、拿到了退出码。子进程不读标准输入就退出时，父进程写 input 写到一半会碰上管道
  // 已经关了（Linux 上 EPIPE、Windows 上 EOF），r.error 照样会被设上——这只是写的时序问题，不算「没跑完」。
  // 真没跑完（起不来、超时、被信号杀）才会 status 是 null。
  if (r.status === null) {
    const code = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code;
    const why =
      code === 'ETIMEDOUT'
        ? `${limitMs / 1000} 秒没退出，杀掉了`
        : r.error !== undefined
          ? r.error.message
          : `被信号 ${r.signal} 杀掉了`;
    throw new Error(`子进程没跑完（${[command, ...args].join(' ').slice(0, 200)}）：${why}`);
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
