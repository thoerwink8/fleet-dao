// design 拆分的对照清单（#139 这一片）：packages/<包> 和 docs/design/<模块>.md 的对应关系
// 记在 docs/design/map.json。本片只提供纯函数：清单文件还不进仓、检查还不接 pnpm check。
// 真跑时读盘（fsRepo），测试用内存假仓（memRepo）。
import type { RepoView } from './repo.ts';

/** 对照清单的仓内路径。后面的片把这份文件放进仓、把检查接进 pnpm check。 */
export const DESIGN_MAP_PATH = 'docs/design/map.json';

const DESIGN_PREFIX = 'docs/design/';

export interface DesignMapProblem {
  /** true = 没查成（读不到清单、清单认不出、列不出包目录），不能当成通过；false = 清单和包、设计文件对不上。 */
  notQueried: boolean;
  text: string;
}

/** 读并校验对照清单，返回包名 → 设计文件路径。
 *  读不到、不是合法 JSON、顶层不是对象、某个值不是字符串，都抛带原因的错（调用方落成「没查成」，不当成空清单）。
 *  不在这里对包目录和设计文件在不在：那是 checkDesignMap 的事，对不上是问题，不是没查成。 */
export function readDesignMap(repo: RepoView): Record<string, string> {
  const text = repo.read(DESIGN_MAP_PATH);
  if (text === undefined) throw new Error(`没查成：读不到 ${DESIGN_MAP_PATH}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`没查成：${DESIGN_MAP_PATH} 不是合法 JSON。`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`没查成：${DESIGN_MAP_PATH} 顶层不是对象。`);
  }
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`没查成：${DESIGN_MAP_PATH} 里「${key}」的值不是字符串。`);
    }
    map[key] = value;
  }
  return map;
}

/** 值必须是 docs/design/ 下的 .md。含空段、.、.. 的不算：真盘上 .. 会逃出这个目录。 */
function isDesignDocPath(path: string): boolean {
  if (!path.startsWith(DESIGN_PREFIX) || !path.endsWith('.md')) return false;
  const rest = path.slice(DESIGN_PREFIX.length);
  if (rest === '') return false;
  return rest.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** packages/ 下的目录名。列不出来抛错（调用方落成「没查成」，不当成没有包）。文件不算包。 */
function packageDirs(repo: RepoView): string[] {
  const names = repo.list('packages');
  if (names === undefined) throw new Error('没查成：列不出 packages/ 下的目录。');
  const dirs: string[] = [];
  for (const name of names) {
    if (name !== '' && repo.isDir(`packages/${name}`)) dirs.push(name);
  }
  dirs.sort();
  return dirs;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 清单和 packages/ 下的目录、设计文件是否一致。一致返回空数组。
 *  包没有对应键、清单里多了键、设计文件不存在、值不在 docs/design/ 下或不是 .md，各返回一条点出名的问题。
 *  读不到清单、清单认不出、列不出 packages/ 下的目录，返回「没查成」，不静默当成空清单。 */
export function checkDesignMap(repo: RepoView): DesignMapProblem[] {
  let map: Record<string, string>;
  try {
    map = readDesignMap(repo);
  } catch (e) {
    return [{ notQueried: true, text: e instanceof Error ? e.message : String(e) }];
  }
  let packages: string[];
  try {
    packages = packageDirs(repo);
  } catch (e) {
    return [{ notQueried: true, text: e instanceof Error ? e.message : String(e) }];
  }

  const problems: DesignMapProblem[] = [];
  const entries = Object.entries(map).sort((a, b) => byName(a[0], b[0]));
  const keySet = new Set(entries.map(([name]) => name));
  for (const name of packages) {
    if (!keySet.has(name)) {
      problems.push({
        notQueried: false,
        text: `包 ${name} 没有对应设计文件：packages/${name} 是目录，${DESIGN_MAP_PATH} 里没有这个键。`,
      });
    }
  }
  const pkgSet = new Set(packages);
  for (const [name] of entries) {
    if (!pkgSet.has(name)) {
      problems.push({
        notQueried: false,
        text: `清单里多了键 ${name}：packages/${name} 不是目录。`,
      });
    }
  }
  for (const [name, path] of entries) {
    if (!isDesignDocPath(path)) {
      problems.push({
        notQueried: false,
        text: `包 ${name} 的值不在 docs/design/ 下或不是 .md：${path}。`,
      });
      continue;
    }
    if (!repo.exists(path) || repo.isDir(path)) {
      problems.push({
        notQueried: false,
        text: `设计文件不存在：包 ${name} 指向 ${path}，仓里没有这个文件。`,
      });
    }
  }
  return problems;
}
