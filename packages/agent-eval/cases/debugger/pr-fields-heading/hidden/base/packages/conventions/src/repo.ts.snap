// 检查读仓里的文件都经过这一层：真跑时读盘，测试换成内存里的假仓。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoView {
  /** 读仓内文件（相对仓根，/ 分隔）；读不到返回 undefined。 */
  read(rel: string): string | undefined;
  exists(rel: string): boolean;
  isDir(rel: string): boolean;
  /** 列目录下的名字（'' 是仓根）；不是目录或读不到返回 undefined。 */
  list(rel: string): string[] | undefined;
}

export function fsRepo(root: string): RepoView {
  const abs = (rel: string) => join(root, ...rel.split('/').filter(Boolean));
  return {
    read(rel) {
      try {
        return readFileSync(abs(rel), 'utf8');
      } catch {
        return undefined;
      }
    },
    exists: (rel) => existsSync(abs(rel)),
    isDir(rel) {
      try {
        return statSync(abs(rel)).isDirectory();
      } catch {
        return false;
      }
    },
    list(rel) {
      try {
        return readdirSync(abs(rel));
      } catch {
        return undefined;
      }
    },
  };
}
