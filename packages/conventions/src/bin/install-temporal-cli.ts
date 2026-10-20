// 显式安装固定版本 Temporal CLI；测试入口本身不下载。
import { fileURLToPath } from 'node:url';
import { installTemporalCli } from '../temporal-cli-install.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
if (process.argv.length !== 2) {
  console.error('用法：pnpm temporal:install');
  process.exitCode = 2;
} else {
  try {
    const cli = await installTemporalCli(root);
    console.log(
      `Temporal CLI 已准备：CLI=${cli.path} version=${cli.version}（${cli.downloaded ? '已下载并登记' : '已装好，未重下'}）`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
