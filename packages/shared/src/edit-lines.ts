// 一次改文件的增删行数（#3140）：适配器记会话过程时写进工具结果条目的 meta.added / meta.removed。
// 各家执行体回的东西不一样，这里只放「怎么数」：
// - claude 的 Edit / MultiEdit 结果带 structuredPatch（unified diff 的块，行首 + 是增、- 是删、空格是上下文）；Write 新建文件没有块，按内容行数算增。
// - cursor 直接给 linesAdded / linesRemoved，不在这里数。
// - grok 的编辑结果带改前改后的文本（oldText / newText），按行做精确差分；计算超限明确未知。
// 数不出的返回 undefined：调用方不写 meta，页面写「没记行数」，不拿 0 顶。

export interface LineCounts {
  added: number;
  removed: number;
}

const lines = (t: string): string[] => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// 统计不能阻塞流读取；限制拆行内存和 LCS 比较量，超限不提供近似数字。
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_DIFF_CELLS = 1_000_000;

/** 精确行差分：相同的中间行也不算修改；超出计算上限返回未知。 */
export function countTextDiff(oldText: string, newText: string): LineCounts | undefined {
  if (oldText === newText) return { added: 0, removed: 0 };
  if (oldText.length > MAX_TEXT_LENGTH || newText.length > MAX_TEXT_LENGTH) return undefined;
  const a = lines(oldText);
  const b = lines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const removed = a.length - head - tail;
  const added = b.length - head - tail;
  if (removed === 0 || added === 0) return { added, removed };
  if (removed * added > MAX_DIFF_CELLS) return undefined;

  // 滚动 DP 求最长公共子序列，只保存较短一侧的一行；差分 = 两边长度各减公共长度。
  const [outer, inner] = removed >= added ? [a, b] : [b, a];
  const outerLength = Math.max(removed, added);
  const innerLength = Math.min(removed, added);
  const common = new Uint32Array(innerLength + 1);
  for (let i = 0; i < outerLength; i++) {
    let diagonal = 0;
    for (let j = 1; j <= innerLength; j++) {
      const previous = common[j] ?? 0;
      common[j] =
        outer[head + i] === inner[head + j - 1] ? diagonal + 1 : Math.max(previous, common[j - 1] ?? 0);
      diagonal = previous;
    }
  }
  const matched = common[innerLength] ?? 0;
  return { added: added - matched, removed: removed - matched };
}

/** claude 的 structuredPatch：每块有 lines 数组，行首 + 增、- 删。认不出形状返回 undefined。 */
export function countStructuredPatch(patch: unknown): LineCounts | undefined {
  if (!Array.isArray(patch)) return undefined;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    const ls = (hunk as { lines?: unknown } | null)?.lines;
    if (!Array.isArray(ls)) return undefined;
    for (const l of ls) {
      if (typeof l !== 'string') return undefined;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

/** 新建文件：整份内容按新增行数。 */
export function countCreatedContent(content: string): LineCounts {
  return { added: lines(content).length, removed: 0 };
}
