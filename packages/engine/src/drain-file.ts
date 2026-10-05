// 排空状态写成文件（FLEET_ENGINE_STATE_DIR/drain.json）：发布脚本等排空时读它报「还在等谁、截止到几点」，演练读它核对
// 「排空时没起新会话」。引擎起来就写一份（cordon 为空），排空开始、登记、交回时当场改写，排空的这段每 everyMs 再写一次。
// 改这里之前必须知道：
// - 读的人（deploy/release.sh 的 engine_drain_status）拿 pid 和 systemd 的 MainPID 比：对不上就是上一个进程留下的旧文件，不信，
//   当成「这个引擎不会排空」。所以写不进去不能悄悄算了：记一条日志（同一种错只记一次），发布脚本那边照实说读不到。
// - 先写临时文件再改名，读的人不会读到半截。

import { rename, writeFile } from 'node:fs/promises';
import { errMessage } from '@fleet-dao/shared/util';
import { drainStatus, type EngineDrain } from './drain.ts';

export interface DrainStatusFileOptions {
  drain: EngineDrain;
  file: string;
  pid: number;
  /** 排空的这段多久重写一次（发布脚本据此看出引擎还活着、没卡住）。 */
  everyMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** 测试用：换掉真写文件。 */
  write?: (file: string, text: string) => Promise<void>;
}

export const DRAIN_STATUS_EVERY_MS = 10_000;

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, file);
}

/** 起一个写状态文件的：先写一份，之后有变化就写、排空的这段按时写。flush 等手上这一次写完；stop 不再写。 */
export function startDrainStatusFile(o: DrainStatusFileOptions): { flush(): Promise<void>; stop(): void } {
  const now = o.now ?? (() => Date.now());
  const write = o.write ?? writeAtomic;
  const everyMs = o.everyMs ?? DRAIN_STATUS_EVERY_MS;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  let lastError = '';
  let pending = false;
  const writeOnce = () => {
    if (stopped || pending) return chain;
    pending = true;
    chain = chain.then(async () => {
      pending = false;
      const status = drainStatus(o.drain, { pid: o.pid, nowMs: now() });
      try {
        await write(o.file, `${JSON.stringify(status, null, 1)}\n`);
        if (lastError) o.log?.(`排空状态又写得进 ${o.file} 了`);
        lastError = '';
      } catch (error) {
        const why = errMessage(error);
        if (why !== lastError) {
          lastError = why;
          o.log?.(`排空状态写不进 ${o.file}（发布脚本看不到排空进度，会当成这个引擎不会排空）：${why}`);
        }
      }
    });
    return chain;
  };
  const unsubscribe = o.drain.onChange(() => void writeOnce());
  const timer = setInterval(() => {
    if (o.drain.stopping()) void writeOnce();
  }, everyMs);
  timer.unref?.();
  void writeOnce();
  return {
    flush: () => chain,
    stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
