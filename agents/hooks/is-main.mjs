// 判「这个文件是被 node 直接跑的，不是被 import 的」：钩子被测试或别的钩子 import 时不执行入口。
// 优先用 Node 自带的 import.meta.main；旧 Node 没有它时比真实路径——入口路径和模块路径可能一边经过软链接
// （macOS 的 /var → /private/var、软链进来的家目录），只比字面路径会判成「不是入口」，钩子就一声不响什么都不做。
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} p */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * @param {{ url: string, main?: boolean }} meta 调用方的 import.meta
 * @returns {boolean}
 */
export function isMainModule(meta) {
  if (typeof meta.main === 'boolean') return meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(real(entry)) === norm(real(fileURLToPath(meta.url)));
}
