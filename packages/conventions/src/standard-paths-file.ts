// 读仓里「改标准的路径」清单（packages/conventions/standard-paths.json）：跟着 conventions 包一起发布，从包自己的目录里读，
// 不依赖谁的工作目录。引擎的临时指挥官整理待办用它认「涉及改标准路径的单」（#1338）。认不出、读不到都抛：不当成「没有标准路径」。
import { readFile } from 'node:fs/promises';
import { parseStandardPaths, type StandardPath } from './standard-paths.ts';

const FILE = new URL('../standard-paths.json', import.meta.url);

export async function loadStandardPaths(): Promise<StandardPath[]> {
  const parsed = parseStandardPaths(await readFile(FILE, 'utf8'));
  if (typeof parsed === 'string') throw new Error(`改标准的路径清单认不出：${parsed}`);
  return parsed;
}
