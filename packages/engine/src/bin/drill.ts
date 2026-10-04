// pnpm drill（#452）：立刻跑一轮全流程巡检、等结论、打印每一步几点走完、用了多久（逻辑在 ../drill.ts，跑的是引擎的定时任务
// canary，同一份代码）。在跑着引擎的那台机器上跑（本机演练环境 fleet-local、法国）：只连本机 Temporal，不连库、不碰 GitHub。
// 地址和命名空间读 TEMPORAL_ADDRESS、TEMPORAL_NAMESPACE（默认和引擎一样：127.0.0.1:7243、fleet）。
// 退出码：0 通过；1 断了（停在哪一步照打）；2 巡检自己没跑成，或没查成（连不上 Temporal、没有这个定时任务……）。
import { errMessage } from '@fleet-dao/shared/util';
import { Client, Connection } from '@temporalio/client';
import { runDrill, temporalDrill } from '../drill.ts';
import { configFromEnv } from '../worker.ts';

const USAGE = [
  '用法：pnpm drill（或 node packages/engine/src/bin/drill.ts）',
  '立刻跑一轮全流程巡检（已经有一轮在跑就接上它），等它有结论，打印每一步几点走完、用了多久；断了写清停在哪一步、为什么。',
  '退出码：0 通过；1 断了；2 巡检自己没跑成，或没查成。',
].join('\n');

const print = (line: string) => console.log(line);
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  print(USAGE);
} else if (args.length > 0) {
  console.error(`认不出参数：${args.join(' ')}\n${USAGE}`);
  process.exitCode = 2;
} else {
  const { address, namespace } = configFromEnv(process.env);
  let connection: Connection | undefined;
  try {
    connection = await Connection.connect({ address });
    const client = new Client({ connection, namespace });
    process.exitCode = await runDrill({ ...temporalDrill(client, { print }), print });
  } catch (err) {
    print(`没查成：连不上 Temporal（${address}，命名空间 ${namespace}）：${errMessage(err)}`);
    process.exitCode = 2;
  } finally {
    await connection?.close();
  }
}
