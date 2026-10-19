// 准备检查只登记已安装 CLI，不下载、不起服务端、不占测试执行槽。
import { fileURLToPath } from 'node:url';
import { prepareTemporalCli, registerTemporalCli } from '../temporal-test-cli.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2);
try {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--cli' || !args[1])) {
    throw new Error('用法：pnpm test:temporal [--cli <已安装的固定版本CLI绝对路径>]');
  }
  const cli = args.length === 0 ? prepareTemporalCli(root) : registerTemporalCli(root, args[1] as string);
  console.log(`Temporal preparation 通过：CLI=${cli.path} version=${cli.version}（未启动服务端）`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
