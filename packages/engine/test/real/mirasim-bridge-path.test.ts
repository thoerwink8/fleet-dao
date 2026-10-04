// 引擎起 Mirasim 会话要跑的桥接脚本（adapters 的 bridge.ts）的路径（#901 ⑥）：经 adapters 的 exports 子路径取，不再伸进 adapters 的目录。
// 钉的是三件事：取到的是真文件、是真实路径（不是 node_modules 里的符号链接，会话用户的 node 读的是真文件）、
// 子路径没登记在 exports 里就当场报错（不会悄悄拿到别的东西）。
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIRASIM_BRIDGE_SCRIPT } from '../../src/real/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('桥接脚本路径（DEFAULT_MIRASIM_BRIDGE_SCRIPT）', () => {
  it('指向 adapters 包里真有的 bridge.ts，读得到', () => {
    expect(basename(DEFAULT_MIRASIM_BRIDGE_SCRIPT)).toBe('bridge.ts');
    accessSync(DEFAULT_MIRASIM_BRIDGE_SCRIPT, constants.R_OK);
    // 就是 adapters 源码里那份（和仓里的位置对得上），不是别处的同名文件
    expect(DEFAULT_MIRASIM_BRIDGE_SCRIPT).toBe(
      realpathSync(join(here, '../../../adapters/src/mirasim/bridge.ts')),
    );
    expect(readFileSync(DEFAULT_MIRASIM_BRIDGE_SCRIPT, 'utf8')).toContain('node:readline');
  });

  it('是真实路径：再 realpath 一次不变（不经 node_modules 里的符号链接）', () => {
    expect(realpathSync(DEFAULT_MIRASIM_BRIDGE_SCRIPT)).toBe(DEFAULT_MIRASIM_BRIDGE_SCRIPT);
    expect(DEFAULT_MIRASIM_BRIDGE_SCRIPT.split(/[\\/]/)).not.toContain('node_modules');
  });

  it('【故意造出的失败】adapters 的 exports 没登记的子路径：解析当场抛 ERR_PACKAGE_PATH_NOT_EXPORTED，不会悄悄拿到别的文件', () => {
    const require = createRequire(import.meta.url);
    expect(() => require.resolve('@fleet-dao/adapters/mirasim-bridge-gone')).toThrow(
      expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
    );
    // 绕过 exports 直接指文件也不行（exports 把 src/ 下没登记的路径封装了）
    expect(() => require.resolve('@fleet-dao/adapters/src/mirasim/bridge.ts')).toThrow(
      expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
    );
  });
});
