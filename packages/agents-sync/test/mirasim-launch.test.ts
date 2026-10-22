// 「启动命令是不是经 reclaude 起」的判据（决定 0092、0112）：reclaude 和旧启动器的文件名都算，别的不算。
import { describe, expect, it } from 'vitest';
import { isLauncherCommand } from '../src/mirasim-launch.ts';

describe('启动命令判据（决定 0092、0112）', () => {
  it.each([
    '/home/x/.local/bin/reclaude',
    'C:\\Users\\x\\.local\\bin\\reclaude.exe',
    'D:\\RECLAUDE.EXE',
    'reclaude',
    '/opt/mirasim-reclaude',
    'C:\\Users\\x\\mirasim-reclaude.exe',
    '/Applications/reclaude-mirasim',
    'D:\\RECLAUDE-MIRASIM.EXE',
  ])('算：%s', (command) => {
    expect(isLauncherCommand(command)).toBe(true);
  });

  it.each([
    'claude',
    'claude.exe',
    '',
    '/usr/local/bin/claude',
    'C:\\tools\\my-claude-wrapper.exe',
    '/opt/mirasim-reclaude-old',
    '/opt/reclaude-old',
    '/opt/reclaude/claude',
  ])('不算：%s', (command) => {
    expect(isLauncherCommand(command)).toBe(false);
  });
});
