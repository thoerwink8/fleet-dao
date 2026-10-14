// 「Mirasim 的 claude 启动命令是不是本工具装的启动器」的判据，单放一个只用 node: 内置的文件：
// agents-sync 也要用它（决定 0092：装了启动器的桌面机不写子代理默认模型键），借这一个文件就不会把迁移器整串依赖带过去。
import { basename } from 'node:path';

/** 启动命令的文件名是新旧两代启动器之一（带不带路径、大小写、Windows 的 .exe 都认） */
export function isManagedLaunch(command: string): boolean {
  const name = basename(command.replaceAll('\\', '/')).toLowerCase();
  return ['reclaude-mirasim', 'reclaude-mirasim.exe', 'mirasim-reclaude', 'mirasim-reclaude.exe'].includes(
    name,
  );
}
