// 起一个装配档案（#3858）：内核起 → 档案补起的东西 → 打"起好了"那行日志；停的时候先让内核等工人收尾，再收档案的东西。
import { createKernel } from '../kernel.ts';
import { type Assembly, log } from './config.ts';

export async function runAssembly(a: Assembly, opts: { signals: boolean }) {
  const kernel = createKernel(a.kernel);
  const apiPort = await kernel.start();
  await a.afterStart?.(apiPort);
  log({ started: true, apiPort, ...a.startedFields(apiPort) });

  let stopping: Promise<void> | undefined;
  const stop = (signal = 'stop'): Promise<void> => {
    stopping ??= (async () => {
      log({ stopping: signal });
      await kernel.stop();
      await a.close();
    })();
    return stopping;
  };
  if (opts.signals) {
    const exit = (signal: string) => void stop(signal).then(() => process.exit(0));
    process.on('SIGTERM', () => exit('SIGTERM'));
    process.on('SIGINT', () => exit('SIGINT'));
  }
  return { kernel, apiPort, stop };
}
