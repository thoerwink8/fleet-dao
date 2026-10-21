// 显式准备：下载/校验一次，不起服务端；各业务用例只消费 existing-path。
import { installTestServer } from '../temporal-test-server.ts';

try {
  if (process.argv.length !== 2) throw new Error('用法：pnpm test:temporal-server');
  console.log(`Temporal time-skipping preparation 通过：${await installTestServer()}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
