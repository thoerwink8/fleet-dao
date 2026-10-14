// 「Mirasim 的 claude 启动命令是不是 mirasim-reclaude 启动器」的判据（决定 0092：装了启动器的桌面机不写子代理默认模型键）。
// 和 packages/mirasim-reclaude/src/migrate.ts 的 isManagedLaunch 是同一个判据、各一份，两处要一起改：
// 同步工具是零安装、开会话钩子必经的一步，不能 import 别的包的文件（那份缺了整个同步就崩）；
// mirasim-reclaude 也不能反过来引这里（agents-sync 已依赖它，会成环）。两份结果一致由 test/mirasim-launch.test.ts 钉着。
import { basename } from 'node:path';

/** 启动命令的文件名是新旧两代启动器之一（带不带路径、大小写、Windows 的 .exe 都认） */
export function isLauncherCommand(command: string): boolean {
  const name = basename(command.replaceAll('\\', '/')).toLowerCase();
  return ['reclaude-mirasim', 'reclaude-mirasim.exe', 'mirasim-reclaude', 'mirasim-reclaude.exe'].includes(
    name,
  );
}
