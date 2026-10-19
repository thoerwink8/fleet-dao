import { lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/** 报告只落本树普通 _tmp 目录；已有链接/文件不跟随，也不替用户删除。 */
export function localTestDirectory(root: string, prefix: string): string {
  const parent = join(root, '_tmp');
  const check = () => {
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('测试报告目录 _tmp 必须是本树普通目录，拒绝符号链接、junction 或非目录');
    return stat;
  };
  if (!check()) {
    try {
      mkdirSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const before = check();
  if (!before) throw new Error('测试报告目录 _tmp 创建后未确认');
  const directory = mkdtempSync(join(parent, prefix));
  const after = check();
  const child = lstatSync(directory, { throwIfNoEntry: false });
  if (
    !after ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !child?.isDirectory() ||
    child.isSymbolicLink()
  )
    throw new Error('测试报告目录创建期间身份改变，未确认安全写入路径');
  return directory;
}
