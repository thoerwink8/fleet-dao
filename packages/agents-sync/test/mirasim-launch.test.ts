// 「启动命令是不是 mirasim-reclaude 启动器」在 agents-sync 和迁移器里各一份（见 src/mirasim-launch.ts 顶上为什么不共用）：
// 这里钉住两份对同一批命令的判断一致，哪边改了另一边没跟上就红。
import { describe, expect, it } from 'vitest';
import { isLauncherCommand } from '../src/mirasim-launch.ts';

const COMMANDS = [
  '/opt/mirasim-reclaude',
  '/Users/x/.fleet-dao/mirasim-reclaude/releases/abc/mirasim-reclaude',
  'C:\\Users\\x\\mirasim-reclaude.exe',
  'D:\\RECLAUDE-MIRASIM.EXE',
  '/Applications/reclaude-mirasim',
  'reclaude-mirasim',
  'claude',
  'claude.exe',
  '',
  '/usr/local/bin/claude',
  'C:\\tools\\my-claude-wrapper.exe',
  '/opt/mirasim-reclaude-old',
  '/opt/mirasim-reclaude/claude',
];

describe('启动器判据两份一致（决定 0092）', () => {
  it('agents-sync 的 isLauncherCommand 和迁移器的 isManagedLaunch 对每条命令判断相同', async () => {
    // 路径不写成字面量 import：tsconfig 只含本包，迁移器那串依赖不进本包的类型检查；测试时装了依赖，照样加载得到
    const migrate = new URL('../../mirasim-reclaude/src/migrate.ts', import.meta.url).href;
    const { isManagedLaunch } = (await import(migrate)) as { isManagedLaunch: (c: string) => boolean };
    for (const command of COMMANDS)
      expect(isLauncherCommand(command), command).toBe(isManagedLaunch(command));
    // 这批里两种结果都有，不是全真或全假凑出来的一致
    expect(COMMANDS.filter(isLauncherCommand)).toHaveLength(6);
  });
});
