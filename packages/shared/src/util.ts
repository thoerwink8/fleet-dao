// 共用小工具（#901 ①，方案 specs/901-项目瘦身与提速/重构方案.md 第 1 节）。
// 只从子路径 `@fleet-dao/shared/util` 引，不在 index.ts 的 `export *` 里：index 会带出 zod 和全部接口约定。
// 改这里之前必须知道：
// - 这个文件**不许有任何 import**，不碰 node: 内置、process、Date.now()、Math.random()——Temporal 工作流沙箱里也要能 bundle、
//   能重放（shared/test/util.test.ts 钉住）；
// - 零安装区（conventions、hygiene、agents-sync、mirasim-reclaude、adapters/src/mirasim/bridge.ts）不许 import 它，
//   那些地方在没有 node_modules 的环境里跑（conventions/test/package-boundaries.test.ts 钉住）；
// - 每个函数都是「全仓逐字相同的写法」收来的，语义和原来一字不差；写法不同的（数组也放行的 asRecord、叫停时 resolve 的 sleep、
//   不判 instanceof 的 `(err as Error).message`）故意没收。

/** 要给人看的出错原因：Error 取 message，其它（字符串、对象、undefined）转成文字，不吞成空。 */
export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 是不是「一个对象」：排除 null 和数组（外部来的 JSON 里数组不算对象，认不出就走「认不出」那条路）。 */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** isRecord 的「拿到对象或 null」版（同样排除数组）。 */
export const asRecord = (v: unknown): Record<string, unknown> | null => (isRecord(v) ? v : null);

/**
 * 睡 ms 毫秒。用全局 setTimeout（不用 node:timers/promises）：vitest 的假时钟只认全局定时器。
 * 工作流里别用它，用 @temporalio/workflow 的 sleep。
 */
export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 可以被叫停打断的睡眠：叫停时 reject（原因取 signal.reason，没有就是「被叫停了」）；已经叫停的直接 reject。 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('被叫停了'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('被叫停了'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
