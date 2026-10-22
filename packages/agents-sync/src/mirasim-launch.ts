// 「Mirasim 的 claude 启动命令是不是经 reclaude 起」的判据（决定 0092、0112：这样的桌面机不写子代理默认模型键）。
// Mirasim 设了任何 claude 启动命令，settings.json 的 env 里又有改模型的键，就会判 claude 被拦截、不给跟随全局的会话注入平台网关。
// 认三类文件名：reclaude（现在的填法）和还没换掉的两代旧启动器 mirasim-reclaude、reclaude-mirasim。
import { basename } from 'node:path';

/** 启动命令的文件名是 reclaude 或旧启动器之一（带不带路径、大小写、Windows 的 .exe 都认） */
export function isLauncherCommand(command: string): boolean {
  const name = basename(command.replaceAll('\\', '/')).toLowerCase();
  return [
    'reclaude',
    'reclaude.exe',
    'reclaude-mirasim',
    'reclaude-mirasim.exe',
    'mirasim-reclaude',
    'mirasim-reclaude.exe',
  ].includes(name);
}
