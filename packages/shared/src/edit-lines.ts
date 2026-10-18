// 一次改文件的增删行数（#3140）：适配器记会话过程时写进工具结果条目的 meta.added / meta.removed。
// 各家执行体回的东西不一样，这里只放「怎么数」：
// - claude 的 Edit / MultiEdit 结果带 structuredPatch（unified diff 的块，行首 + 是增、- 是删、空格是上下文）；Write 新建文件没有块，按内容行数算增。
// - cursor 直接给 linesAdded / linesRemoved，不在这里数。
// - grok 的编辑结果带改前改后的文本（oldText / newText），去掉共同的头尾再按行数。
// 数不出的返回 undefined：调用方不写 meta，页面写「没记行数」，不拿 0 顶。

export interface LineCounts {
  added: number;
  removed: number;
}

const lines = (t: string): string[] => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));

/** 改前改后两段文本：去掉共同的头尾行，剩下的就是删和增。 */
export function countTextDiff(oldText: string, newText: string): LineCounts {
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
  return { added: b.length - head - tail, removed: a.length - head - tail };
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
