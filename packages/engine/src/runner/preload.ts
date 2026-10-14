// 首轮预载（决定 0093）：单子「已知的模块」里列的具体文件，引擎起会话前从工作树读出原文，直接放进提示词，告诉会话「已给你，别再读」。
// 为什么：动手会话第一次改文件之前要花 50–57% 的时间熟悉仓库（3 个 grok 样本读了 11/11/34 个文件、4.7/6.6/17.1 分钟）；
// 单子上已经写了要动哪些文件，读它们这一步引擎替它做掉。
//
// 改这里之前必须知道：
// - 只预载写成具体文件的路径（task-brief.ts 的 asModuleRef 认成 file 的）；目录、通配不展开（展开就是猜，量也没底）。
// - 总量有上限（PRELOAD_MAX_CHARS）：按单子里写的先后放，前面的优先；放不下的那一个截断、后面的不放，截了哪些、没放哪些逐个写明，
//   让会话自己去读，不假装给全了。
// - 读不到的（不在、读失败、二进制）照实写一句，不拿空内容冒充「文件是空的」。不在的多半是这一单要新建的。
// - 纯函数：读文件经调用方（real/task-segment.ts 以会话用户读工作树）交进来。

import { moduleRefsOf } from './task-brief.ts';

/** 预载的总字数上限（提示词里文件原文合计）。 */
export const PRELOAD_MAX_CHARS = 60_000;
/** 最多预载几个文件（单子列的路径上限是 50，读文件一个一条命令，别让起会话前多等太久）。 */
export const PRELOAD_MAX_FILES = 20;
/** 放不下整份时，剩下的额度少于这么多就不截半截了（半截太短没用），整份记成没放。 */
const PRELOAD_MIN_SLICE = 2_000;

export type PreloadRead =
  | { path: string; kind: 'text'; content: string }
  | { path: string; kind: 'absent' }
  | { path: string; kind: 'binary' }
  | { path: string; kind: 'error'; why: string };

/** 「已知的模块」每一项的原文 → 要预载的文件路径（去重，按写的先后，最多 PRELOAD_MAX_FILES 个）。 */
export function preloadPaths(touches: readonly string[]): string[] {
  const out: string[] = [];
  for (const ref of moduleRefsOf(touches).refs) {
    if (ref.kind !== 'file' || out.includes(ref.path)) continue;
    out.push(ref.path);
    if (out.length >= PRELOAD_MAX_FILES) break;
  }
  return out;
}

/** 读回来的字节 → 一条预载记录：带 NUL 的当二进制，不往提示词里放。 */
export function preloadFromBytes(path: string, bytes: Buffer | null): PreloadRead {
  if (bytes === null) return { path, kind: 'absent' };
  if (bytes.includes(0)) return { path, kind: 'binary' };
  return { path, kind: 'text', content: bytes.toString('utf8') };
}

function fence(content: string): string {
  let ticks = '```';
  while (content.includes(ticks)) ticks += '`';
  return ticks;
}

/**
 * 预载那一节（行数组）；一个文件都没读的回空数组（提示词里不出这一节）。
 * max 是文件原文合计的上限；截断按单子里写的先后，前面的优先。
 */
export function renderPreload(reads: readonly PreloadRead[], max = PRELOAD_MAX_CHARS): string[] {
  if (reads.length === 0) return [];
  const body: string[] = [];
  const cut: string[] = [];
  const dropped: string[] = [];
  const notes: string[] = [];
  let left = max;
  for (const r of reads) {
    if (r.kind === 'absent') {
      notes.push(`- \`${r.path}\`：工作树里没有这个文件（多半是这一单要新建的）。`);
      continue;
    }
    if (r.kind === 'binary') {
      notes.push(`- \`${r.path}\`：是二进制文件，没放进来。`);
      continue;
    }
    if (r.kind === 'error') {
      notes.push(`- \`${r.path}\`：引擎没读到（${r.why}），要看自己读。`);
      continue;
    }
    const { content } = r;
    let shown = content;
    if (content.length > left) {
      if (left < PRELOAD_MIN_SLICE) {
        dropped.push(r.path);
        continue;
      }
      shown = content.slice(0, left);
      cut.push(`\`${r.path}\`（共 ${content.length} 字，放了前 ${shown.length} 字）`);
    }
    left -= shown.length;
    const f = fence(shown);
    body.push('', `### \`${r.path}\``, f, shown.replace(/\n$/, ''), f);
  }
  const out = [
    '',
    '## 已给你的文件（别再读）',
    `单子「已知的模块」里列的文件，引擎起会话前从这棵工作树里读出的原文（合计上限 ${max} 字，按单子里写的先后放）。` +
      '下面给全了的文件已经在你手里，不要再读一遍；要改直接改。',
  ];
  if (cut.length > 0) out.push(`- 截了的（后半段没放，用到再读那一段）：${cut.join('；')}。`);
  if (dropped.length > 0)
    out.push(`- 超了总量没放的（要看自己读）：${dropped.map((p) => `\`${p}\``).join('、')}。`);
  out.push(...notes, ...body);
  return out;
}
