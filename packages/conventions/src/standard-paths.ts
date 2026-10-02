// 改标准的路径（人闸第四类，design 第五节「人闸第四类：改标准」）：packages/conventions/standard-paths.json 的读法和匹配。
// 和先审后合的清单（merge-gates.ts 的 parseRiskPaths / riskyFiles）是两份东西：这份没有 kind、有 section，路径还可以带通配。
// 纯判断，不碰网络；读不到、认不出由调用方判「没查成」，不当成「没碰到」。
//
// 改这里之前必须知道：
// - 通配的规矩写在清单自己的说明里：以 / 结尾是目录（下面所有文件都算）；带 * 的是通配，* 不跨目录，** 跨；别的是单个文件。
//   `agents/**/*.md` 也匹配 `agents/x.md`（** 后面跟 / 时可以是零层目录）。
// - 改名的新旧名字都算（从标准目录挪出去也是碰了它）。
// - 路径级别的判法分不出「只改了 AGENTS.md 的本仓段」：清单里带 section 的条目命中时一并带回 section，由人看一眼点继续；
//   宁可多拦一次，不漏一次改标准。

import type { ChangedFile } from './merge-gates.ts';

/** 改标准的路径清单在仓里的位置。 */
export const STANDARD_PATHS_FILE = 'packages/conventions/standard-paths.json';

export interface StandardPath {
  /** 以 / 结尾是目录；带 * 的是通配；否则是单个文件。仓内相对路径。 */
  path: string;
  why: string;
  /** 只有文件里的这一段算标准（例如 AGENTS.md 的「通用段」）；路径判不出段，命中时带给人看。 */
  section?: string;
}

export interface StandardFile {
  file: string;
  rule: string;
  why: string;
  section?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 读清单：认不出返回一句为什么；空清单也算认不出——一条都没有等于不拦。 */
export function parseStandardPaths(text: string): StandardPath[] | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `不是合法的 JSON（${e instanceof Error ? e.message : String(e)}）`;
  }
  const paths = isObject(raw) ? raw.paths : undefined;
  if (!Array.isArray(paths)) return '没有 paths 列表';
  if (paths.length === 0) return 'paths 是空的（一条都没有等于什么都不拦）';
  const out: StandardPath[] = [];
  for (const [i, item] of paths.entries()) {
    const at = `paths 第 ${i + 1} 条`;
    if (!isObject(item) || typeof item.path !== 'string' || typeof item.why !== 'string') {
      return `${at} 认不出（要有 path、why 两个字符串）`;
    }
    const path = item.path.trim();
    if (
      !path ||
      path === '/' ||
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      path.includes('\\')
    ) {
      return `${at} 的 path「${item.path}」不是仓内相对路径（不以 / 开头、不带 .. 和反斜杠）`;
    }
    if (path.endsWith('/') && path.includes('*')) {
      return `${at}（${path}）又是目录又带通配：目录写成 dir/，通配写成 dir/**`;
    }
    if (path.split('/').some((seg) => seg.includes('**') && seg !== '**')) {
      return `${at}（${path}）的 ** 要单独占一层目录（a/**/b 或 a/**），不能贴着别的字`;
    }
    if (!item.why.trim()) return `${at}（${path}）没写为什么`;
    if (item.section !== undefined && (typeof item.section !== 'string' || !item.section.trim())) {
      return `${at}（${path}）的 section 要是非空字符串`;
    }
    out.push({
      path,
      why: item.why.trim(),
      ...(typeof item.section === 'string' ? { section: item.section.trim() } : {}),
    });
  }
  return out;
}

const REGEX_SPECIAL = /[\\^$.|?+()[\]{}]/g;

// 一条通配 → 正则：双星跨目录，单星不跨；双星后面紧跟斜杠时可以是零层目录。
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else {
      out += ch.replace(REGEX_SPECIAL, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

const globCache = new Map<string, RegExp>();

/** 这个文件名落不落在这一条里。 */
export function matchesStandardPath(name: string, rule: Pick<StandardPath, 'path'>): boolean {
  const { path } = rule;
  if (path.endsWith('/')) return name.startsWith(path);
  if (!path.includes('*')) return name === path;
  let re = globCache.get(path);
  if (!re) {
    re = globToRegExp(path);
    globCache.set(path, re);
  }
  return re.test(name);
}

/** 改到的文件里落进清单的（改名的新旧名字都算）；同一个文件名只报一次。 */
export function standardFiles(files: readonly ChangedFile[], list: readonly StandardPath[]): StandardFile[] {
  const hits: StandardFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const name of [f.filename, ...(f.previous ? [f.previous] : [])]) {
      if (seen.has(name)) continue;
      const rule = list.find((r) => matchesStandardPath(name, r));
      if (!rule) continue;
      seen.add(name);
      hits.push({
        file: name,
        rule: rule.path,
        why: rule.why,
        ...(rule.section === undefined ? {} : { section: rule.section }),
      });
    }
  }
  return hits;
}
